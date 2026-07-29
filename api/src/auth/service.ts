import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { jwtVerify } from 'jose';
import type { Request, Response } from 'express';
import type { LoadedRuntime } from '../config/load.js';
import type { AppDatabase } from '../db/index.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logging/logger.js';
import { createId, createOpaqueToken } from '../utils/ids.js';
import { isIpInCidrs, normalizeIpAddress, parseCidr, type CidrRule } from './cidr.js';

export type AuthMethod = 'local' | 'header' | 'apiKey';

export interface AuthenticatedIdentity {
  username: string;
  groups: string[];
  authMethod: AuthMethod;
  userId: string | null;
  sessionId: string | null;
  csrfToken: string;
  role: 'read' | 'readwrite';
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string | null;
  session_version: number | string;
}

interface SessionRow {
  id: string;
  user_id: string;
  auth_method: AuthMethod;
  csrf_token: string;
  session_version: number | string;
  expires_at_ms: number | string;
}

const normalizeUsername = ({ username }: { username: string }) => username.trim().toLowerCase();
const normalizeSet = ({ values }: { values: string[] }) => new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));

const safeEqual = ({ left, right }: { left: string; right: string }) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const safeTokenEqual = ({ supplied, expected }: { supplied: string; expected: string }) => (
  timingSafeEqual(
    createHash('sha256').update(supplied).digest(),
    createHash('sha256').update(expected).digest()
  )
);

export class AuthService {
  private readonly trustedCidrs: CidrRule[];
  private readonly allowedUsers: Set<string>;
  private readonly allowedGroups: Set<string>;
  private readonly sessionCookieName: string;
  private localUserId: string | null = null;

  constructor(
    private readonly runtime: LoadedRuntime,
    private readonly db: AppDatabase,
    private readonly logger: Logger
  ) {
    this.trustedCidrs = runtime.config.auth.header.trustedCidrs.map((value) => parseCidr({ value }));
    this.allowedUsers = normalizeSet({ values: runtime.config.auth.header.allowedUsers });
    this.allowedGroups = normalizeSet({ values: runtime.config.auth.header.allowedGroups });
    this.sessionCookieName = runtime.config.publicBaseUrl.startsWith('https://')
      ? '__Host-cryptotracker_sid'
      : 'cryptotracker_sid';
  }

  async synchronizeLocalUser() {
    if (!this.runtime.config.auth.local.enabled) return;
    const username = normalizeUsername({ username: this.runtime.config.auth.local.username });
    const password = this.runtime.secrets.localPassword!;
    const existing = await this.db.one<UserRow>({
      sql: 'SELECT id, username, password_hash, session_version FROM app_user WHERE username = ?',
      parameters: [username]
    });
    const now = Date.now();
    if (!existing) {
      const id = createId({ prefix: 'usr' });
      await this.db.run({
        sql: `
          INSERT INTO app_user(id, username, password_hash, session_version, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, 0, ?, ?)
        `,
        parameters: [id, username, await argon2.hash(password, { type: argon2.argon2id }), now, now]
      });
      this.localUserId = id;
      return;
    }
    this.localUserId = existing.id;
    const matches = existing.password_hash
      ? await argon2.verify(existing.password_hash, password)
      : false;
    if (matches) return;
    await this.db.transaction({
      task: async (executor) => {
        await executor.run({
          sql: `
            UPDATE app_user
            SET password_hash = ?, session_version = session_version + 1, updated_at_ms = ?
            WHERE id = ?
          `,
          parameters: [await argon2.hash(password, { type: argon2.argon2id }), now, existing.id]
        });
        await executor.run({
          sql: 'DELETE FROM sessions WHERE user_id = ?',
          parameters: [existing.id]
        });
      }
    });
    this.logger.info({
      caller: 'auth::synchronizeLocalUser',
      loggerKey: 'AUTH_LOCAL_PASSWORD_SYNCHRONIZED',
      message: 'Configured local password changed; existing local sessions were invalidated.',
      context: { username }
    });
  }

  private cookieOptions() {
    const secure = this.runtime.config.publicBaseUrl.startsWith('https://');
    return {
      secure,
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      maxAge: this.runtime.config.auth.local.sessionTtlMinutes * 60_000
    };
  }

  async login({
    username,
    password,
    req,
    res,
    correlationId
  }: {
    username: string;
    password: string;
    req: Request;
    res: Response;
    correlationId: string;
  }) {
    const normalized = normalizeUsername({ username });
    const user = await this.db.one<UserRow>({
      sql: 'SELECT id, username, password_hash, session_version FROM app_user WHERE username = ?',
      parameters: [normalized]
    });
    const valid = Boolean(
      this.runtime.config.auth.local.enabled
      && user?.password_hash
      && await argon2.verify(user.password_hash, password)
    );
    if (!valid || !user) {
      this.logger.warn({
        caller: 'auth::login',
        loggerKey: 'AUTH_LOCAL_LOGIN_DENIED',
        message: 'Local login failed.',
        correlationId,
        context: {
          username: normalized,
          sourceIp: req.socket.remoteAddress ?? null
        }
      });
      await this.audit({
        username: normalized || null,
        authMethod: 'local',
        sourceIp: req.socket.remoteAddress ?? null,
        action: 'auth.local.login',
        targetType: 'user',
        targetIdentifier: normalized,
        result: 'denied',
        correlationId
      });
      throw new AppError({
        errorKey: 'AUTH_LOGIN_INVALID',
        reason: 'Invalid username or password.',
        status: 401
      });
    }

    const id = createOpaqueToken();
    const csrfToken = createOpaqueToken();
    const expiresAtMs = Date.now() + (this.runtime.config.auth.local.sessionTtlMinutes * 60_000);
    await this.db.transaction({
      task: async (executor) => {
        await executor.run({
          sql: 'DELETE FROM sessions WHERE id = ?',
          parameters: [id]
        });
        await executor.run({
          sql: `
            INSERT INTO sessions(
              id, user_id, auth_method, csrf_token, session_version,
              created_at_ms, expires_at_ms, source_ip, user_agent
            ) VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?)
          `,
          parameters: [
            id,
            user.id,
            csrfToken,
            Number(user.session_version),
            Date.now(),
            expiresAtMs,
            req.socket.remoteAddress ?? null,
            req.headers['user-agent'] ?? null
          ]
        });
      }
    });
    res.cookie(this.sessionCookieName, id, this.cookieOptions());
    await this.audit({
      username: user.username,
      authMethod: 'local',
      sourceIp: req.socket.remoteAddress ?? null,
      action: 'auth.local.login',
      targetType: 'user',
      targetIdentifier: user.username,
      result: 'success',
      correlationId
    });
    return {
      username: user.username,
      csrfToken,
      expiresAt: new Date(expiresAtMs).toISOString()
    };
  }

  async logout({
    identity,
    res,
    req,
    correlationId
  }: {
    identity: AuthenticatedIdentity;
    res: Response;
    req: Request;
    correlationId: string;
  }) {
    if (identity.sessionId) {
      await this.db.run({
        sql: 'DELETE FROM sessions WHERE id = ?',
        parameters: [identity.sessionId]
      });
    }
    res.clearCookie(this.sessionCookieName, this.cookieOptions());
    await this.audit({
      username: identity.username,
      authMethod: identity.authMethod,
      sourceIp: req.socket.remoteAddress ?? null,
      action: 'auth.logout',
      targetType: 'session',
      targetIdentifier: identity.sessionId,
      result: 'success',
      correlationId
    });
  }

  private headerCsrfToken({
    username,
    expiresAtMs = Date.now() + (60 * 60_000)
  }: {
    username: string;
    expiresAtMs?: number;
  }) {
    const payload = Buffer.from(JSON.stringify({
      username,
      expiresAtMs
    })).toString('base64url');
    const signature = createHmac('sha256', this.runtime.secrets.sessionSecret!).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  private verifyHeaderCsrfToken({
    username,
    token
  }: {
    username: string;
    token: string;
  }) {
    const [payload, signature, ...extra] = token.split('.');
    if (!payload || !signature || extra.length > 0) return false;
    const expected = createHmac('sha256', this.runtime.secrets.sessionSecret!).update(payload).digest('base64url');
    if (!safeEqual({ left: signature, right: expected })) return false;
    try {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        username: string;
        expiresAtMs: number;
      };
      return parsed.username === username && parsed.expiresAtMs > Date.now();
    } catch {
      return false;
    }
  }

  private headerAllowed({
    username,
    groups
  }: {
    username: string;
    groups: string[];
  }) {
    return this.allowedUsers.has(username)
      || groups.some((group) => this.allowedGroups.has(group.toLowerCase()));
  }

  private directPeerTrusted({ req }: { req: Request }) {
    const address = normalizeIpAddress({ value: req.socket.remoteAddress ?? '' });
    return isIpInCidrs({
      address,
      cidrs: this.trustedCidrs
    });
  }

  private reservedHeadersPresent({ req }: { req: Request }) {
    const header = this.runtime.config.auth.header;
    return Boolean(
      req.get(header.usernameHeader)
      || req.get(header.groupsHeader)
      || req.get(header.signedIdentity.headerName)
    );
  }

  private async authenticateHeader({
    req,
    correlationId
  }: {
    req: Request;
    correlationId: string;
  }): Promise<AuthenticatedIdentity | null> {
    const config = this.runtime.config.auth.header;
    if (!config.enabled) return null;
    const trusted = this.directPeerTrusted({ req });
    if (!trusted) {
      if (this.reservedHeadersPresent({ req })) {
        await this.audit({
          username: null,
          authMethod: 'header',
          sourceIp: req.socket.remoteAddress ?? null,
          action: 'auth.header.spoof',
          targetType: 'identity',
          targetIdentifier: null,
          result: 'denied',
          correlationId
        });
        throw new AppError({
          errorKey: 'AUTH_HEADER_UNTRUSTED',
          reason: 'Reserved identity headers were sent by an untrusted direct peer.',
          status: 401
        });
      }
      return null;
    }

    let username = '';
    let groups: string[] = [];
    if (config.signedIdentity.enabled) {
      const token = req.get(config.signedIdentity.headerName);
      if (!token) return null;
      try {
        const result = await jwtVerify(
          token,
          new TextEncoder().encode(this.runtime.secrets.signedIdentitySecret!),
          {
            algorithms: ['HS256'],
            issuer: config.signedIdentity.issuer!,
            audience: config.signedIdentity.audience!,
            clockTolerance: config.signedIdentity.clockSkewSeconds
          }
        );
        username = normalizeUsername({
          username: String(result.payload.preferred_username ?? result.payload.sub ?? '')
        });
        groups = Array.isArray(result.payload.groups)
          ? result.payload.groups.map((group) => String(group).trim().toLowerCase()).filter(Boolean)
          : [];
      } catch (error) {
        throw new AppError({
          errorKey: 'AUTH_SIGNED_IDENTITY_INVALID',
          reason: 'Signed identity verification failed.',
          status: 401,
          cause: error
        });
      }
    } else {
      const usernameValue = req.get(config.usernameHeader);
      if (!usernameValue) return null;
      username = normalizeUsername({ username: usernameValue });
      groups = (req.get(config.groupsHeader) ?? '')
        .split(config.groupsSeparator)
        .map((group) => group.trim().toLowerCase())
        .filter(Boolean);
    }

    if (!username || !this.headerAllowed({ username, groups })) {
      await this.audit({
        username: username || null,
        authMethod: 'header',
        sourceIp: req.socket.remoteAddress ?? null,
        action: 'auth.header.identity',
        targetType: 'identity',
        targetIdentifier: username || null,
        result: 'denied',
        correlationId
      });
      throw new AppError({
        errorKey: 'AUTH_FORBIDDEN',
        reason: 'The authenticated header identity is not allowed.',
        status: 403
      });
    }

    await this.audit({
      username,
      authMethod: 'header',
      sourceIp: req.socket.remoteAddress ?? null,
      action: 'auth.header.identity',
      targetType: 'identity',
      targetIdentifier: username,
      result: 'accepted',
      correlationId
    });
    return {
      username,
      groups,
      authMethod: 'header',
      userId: null,
      sessionId: null,
      csrfToken: this.headerCsrfToken({ username }),
      role: 'readwrite'
    };
  }

  private async authenticateSession({ req }: { req: Request }): Promise<AuthenticatedIdentity | null> {
    const sessionId = req.cookies?.[this.sessionCookieName] as string | undefined;
    if (!sessionId) return null;
    const row = await this.db.one<SessionRow & UserRow>({
      sql: `
        SELECT sessions.*, app_user.username, app_user.password_hash, app_user.session_version AS user_session_version
        FROM sessions
        JOIN app_user ON app_user.id = sessions.user_id
        WHERE sessions.id = ?
      `,
      parameters: [sessionId]
    });
    if (
      !row
      || Number(row.expires_at_ms) <= Date.now()
      || Number(row.session_version) !== Number((row as unknown as { user_session_version: number | string }).user_session_version)
    ) {
      await this.db.run({
        sql: 'DELETE FROM sessions WHERE id = ?',
        parameters: [sessionId]
      });
      return null;
    }
    return {
      username: row.username,
      groups: [],
      authMethod: 'local',
      userId: row.user_id,
      sessionId: row.id,
      csrfToken: row.csrf_token,
      role: 'readwrite'
    };
  }

  private authenticateApiKey({ req }: { req: Request }): AuthenticatedIdentity | null {
    const config = this.runtime.config.auth.apiKey;
    if (!config.enabled) return null;
    const headerToken = req.get(config.headerName);
    const authorization = req.get('authorization');
    const bearerToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const supplied = headerToken ?? bearerToken ?? null;
    if (!supplied) return null;
    let match: (typeof this.runtime.secrets.apiKeys)[number] | null = null;
    for (const entry of this.runtime.secrets.apiKeys) {
      const matches = safeTokenEqual({
        supplied,
        expected: entry.key
      });
      if (matches && !match) match = entry;
    }
    if (!match) {
      throw new AppError({
        errorKey: 'AUTH_FORBIDDEN',
        reason: 'The supplied API key is invalid.',
        status: 403
      });
    }
    return {
      username: match.name,
      groups: [`api:${match.role}`],
      authMethod: 'apiKey',
      userId: null,
      sessionId: null,
      csrfToken: '',
      role: match.role
    };
  }

  async authenticate({
    req,
    correlationId
  }: {
    req: Request;
    correlationId: string;
  }) {
    const apiKey = this.authenticateApiKey({ req });
    if (apiKey) return apiKey;
    const header = await this.authenticateHeader({ req, correlationId });
    if (header) return header;
    return this.authenticateSession({ req });
  }

  assertCsrf({
    req,
    identity
  }: {
    req: Request;
    identity: AuthenticatedIdentity;
  }) {
    if (identity.authMethod === 'apiKey') {
      if (identity.role !== 'readwrite') {
        throw new AppError({
          errorKey: 'AUTH_FORBIDDEN',
          reason: 'This API key is read-only.',
          status: 403
        });
      }
      return;
    }
    const origin = req.get('origin');
    const expectedOrigin = new URL(this.runtime.config.publicBaseUrl).origin;
    if (!origin || origin !== expectedOrigin) {
      throw new AppError({
        errorKey: 'AUTH_ORIGIN_INVALID',
        reason: 'Mutation origin does not match the configured public origin.',
        status: 403
      });
    }
    const token = req.get('x-csrf-token') ?? '';
    const valid = identity.authMethod === 'header'
      ? this.verifyHeaderCsrfToken({ username: identity.username, token })
      : safeEqual({ left: token, right: identity.csrfToken });
    if (!valid) {
      throw new AppError({
        errorKey: 'AUTH_CSRF_INVALID',
        reason: 'CSRF token is missing or invalid.',
        status: 403
      });
    }
  }

  async purgeExpiredSessions() {
    await this.db.run({
      sql: 'DELETE FROM sessions WHERE expires_at_ms <= ?',
      parameters: [Date.now()]
    });
  }

  async audit({
    username,
    authMethod,
    sourceIp,
    action,
    targetType,
    targetIdentifier,
    result,
    correlationId,
    details = {}
  }: {
    username: string | null;
    authMethod: AuthMethod | null;
    sourceIp: string | null;
    action: string;
    targetType: string | null;
    targetIdentifier: string | null;
    result: string;
    correlationId: string;
    details?: unknown;
  }) {
    await this.db.run({
      sql: `
        INSERT INTO audit_log(
          id, occurred_at_ms, username, auth_method, source_ip, action,
          target_type, target_identifier, result, correlation_id, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      parameters: [
        createId({ prefix: 'aud' }),
        Date.now(),
        username,
        authMethod,
        sourceIp,
        action,
        targetType,
        targetIdentifier,
        result,
        correlationId,
        JSON.stringify(details)
      ]
    });
  }

  getMethods() {
    return {
      local: this.runtime.config.auth.local.enabled,
      header: this.runtime.config.auth.header.enabled,
      signedIdentity: this.runtime.config.auth.header.signedIdentity.enabled,
      apiKey: this.runtime.config.auth.apiKey.enabled
    };
  }
}

export const authInternals = {
  normalizeSet,
  normalizeUsername,
  safeEqual,
  safeTokenEqual
};
