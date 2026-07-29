import { createServer as createNodeServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/service.js';
import { bootstrapApplicationData } from '../src/services/bootstrap.js';
import { SettingsService } from '../src/services/settings.js';
import { createHttpServer, type AppContext } from '../src/http/app.js';
import { createTestLogger, createTestRuntime, openMigratedTestDatabase } from './helpers.js';

const servers: Server[] = [];

const listen = async (server: Server, protocol = 'http') => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `${protocol}://127.0.0.1:${address.port}`;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

const requestFixture = ({
  remoteAddress,
  headers
}: {
  remoteAddress: string;
  headers: Record<string, string>;
}) => ({
  socket: { remoteAddress },
  cookies: {},
  get: (name: string) => headers[name.toLowerCase()]
}) as unknown as Request;

describe('authentication security', () => {
  it('authenticates named API keys with timing-safe roles and bypasses CSRF only for write keys', async () => {
    const runtime = await createTestRuntime({
      config: {
        auth: {
          apiKey: {
            enabled: true,
            headerName: 'X-API-Key'
          },
          local: { enabled: false }
        }
      },
      secrets: {
        localPassword: null,
        apiKeys: [
          {
            name: 'reader',
            key: 'reader-key-with-at-least-16-characters',
            role: 'read'
          },
          {
            name: 'writer',
            key: 'writer-key-with-at-least-16-characters',
            role: 'readwrite'
          }
        ]
      }
    });
    const { db } = await openMigratedTestDatabase({ runtime });
    const auth = new AuthService(runtime, db, createTestLogger({ runtime }));
    try {
      const readerRequest = requestFixture({
        remoteAddress: '127.0.0.1',
        headers: {
          'x-api-key': 'reader-key-with-at-least-16-characters'
        }
      });
      const reader = await auth.authenticate({
        req: readerRequest,
        correlationId: 'api-reader'
      });
      expect(reader).toMatchObject({
        username: 'reader',
        authMethod: 'apiKey',
        role: 'read'
      });
      expect(() => auth.assertCsrf({
        req: readerRequest,
        identity: reader!
      })).toThrow(/read-only/);

      const writerRequest = requestFixture({
        remoteAddress: '127.0.0.1',
        headers: {
          authorization: 'Bearer writer-key-with-at-least-16-characters'
        }
      });
      const writer = await auth.authenticate({
        req: writerRequest,
        correlationId: 'api-writer'
      });
      expect(() => auth.assertCsrf({
        req: writerRequest,
        identity: writer!
      })).not.toThrow();

      await expect(auth.authenticate({
        req: requestFixture({
          remoteAddress: '127.0.0.1',
          headers: { 'x-api-key': 'invalid-key-with-at-least-16-characters' }
        }),
        correlationId: 'api-invalid'
      })).rejects.toMatchObject({
        errorKey: 'AUTH_FORBIDDEN'
      });
    } finally {
      await db.close();
    }
  });

  it('uses allow-user OR allow-group semantics and rejects spoofed peers', async () => {
    const runtime = await createTestRuntime({
      config: {
        auth: {
          local: { enabled: false },
          header: {
            enabled: true,
            trustedCidrs: ['127.0.0.1/32'],
            allowedUsers: ['alice'],
            allowedGroups: ['operators']
          }
        }
      },
      secrets: {
        localPassword: null
      }
    });
    const { db } = await openMigratedTestDatabase({ runtime });
    const auth = new AuthService(runtime, db, createTestLogger({ runtime }));
    try {
      const byUser = await auth.authenticate({
        req: requestFixture({
          remoteAddress: '127.0.0.1',
          headers: { 'remote-user': 'alice' }
        }),
        correlationId: 'user'
      });
      expect(byUser?.username).toBe('alice');
      const byGroup = await auth.authenticate({
        req: requestFixture({
          remoteAddress: '127.0.0.1',
          headers: {
            'remote-user': 'bob',
            'remote-groups': 'readers, Operators'
          }
        }),
        correlationId: 'group'
      });
      expect(byGroup?.username).toBe('bob');
      await expect(auth.authenticate({
        req: requestFixture({
          remoteAddress: '192.0.2.1',
          headers: { 'remote-user': 'alice' }
        }),
        correlationId: 'spoof'
      })).rejects.toMatchObject({
        errorKey: 'AUTH_HEADER_UNTRUSTED'
      });
    } finally {
      await db.close();
    }
  });

  it('verifies signed identity issuer, audience, expiry, and allow rules', async () => {
    const secret = 'signed-identity-test-secret-with-32-characters';
    const runtime = await createTestRuntime({
      config: {
        auth: {
          local: { enabled: false },
          header: {
            enabled: true,
            trustedCidrs: ['127.0.0.1/32'],
            allowedUsers: [],
            allowedGroups: ['operators'],
            signedIdentity: {
              enabled: true,
              issuer: 'fixture-issuer',
              audience: 'fixture-audience',
              clockSkewSeconds: 0
            }
          }
        }
      },
      secrets: {
        localPassword: null,
        signedIdentitySecret: secret
      }
    });
    const { db } = await openMigratedTestDatabase({ runtime });
    const auth = new AuthService(runtime, db, createTestLogger({ runtime }));
    try {
      const token = await new SignJWT({
        preferred_username: 'signed-user',
        groups: ['operators']
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('fixture-issuer')
        .setAudience('fixture-audience')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(new TextEncoder().encode(secret));
      const identity = await auth.authenticate({
        req: requestFixture({
          remoteAddress: '127.0.0.1',
          headers: { 'x-oauth-identity': token }
        }),
        correlationId: 'signed'
      });
      expect(identity).toMatchObject({
        username: 'signed-user',
        groups: ['operators'],
        authMethod: 'header'
      });

      const expired = await new SignJWT({
        preferred_username: 'signed-user',
        groups: ['operators']
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('fixture-issuer')
        .setAudience('fixture-audience')
        .setIssuedAt(1)
        .setExpirationTime(2)
        .sign(new TextEncoder().encode(secret));
      await expect(auth.authenticate({
        req: requestFixture({
          remoteAddress: '127.0.0.1',
          headers: { 'x-oauth-identity': expired }
        }),
        correlationId: 'expired'
      })).rejects.toMatchObject({
        errorKey: 'AUTH_SIGNED_IDENTITY_INVALID'
      });
    } finally {
      await db.close();
    }
  });

  it('synchronizes the configured password and invalidates old sessions', async () => {
    const initialRuntime = await createTestRuntime();
    const { db } = await openMigratedTestDatabase({ runtime: initialRuntime });
    const initialAuth = new AuthService(initialRuntime, db, createTestLogger({ runtime: initialRuntime }));
    try {
      await initialAuth.synchronizeLocalUser();
      const user = await db.one<{ id: string; password_hash: string; session_version: number | string }>({
        sql: 'SELECT id, password_hash, session_version FROM app_user WHERE username = ?',
        parameters: ['admin']
      });
      await db.run({
        sql: `
          INSERT INTO sessions(
            id, user_id, auth_method, csrf_token, session_version,
            created_at_ms, expires_at_ms
          ) VALUES (?, ?, 'local', ?, ?, ?, ?)
        `,
        parameters: ['old-session', user!.id, 'csrf', Number(user!.session_version), Date.now(), Date.now() + 60_000]
      });
      const changedRuntime = {
        ...initialRuntime,
        secrets: {
          ...initialRuntime.secrets,
          localPassword: 'changed-password'
        }
      };
      await new AuthService(
        changedRuntime,
        db,
        createTestLogger({ runtime: changedRuntime })
      ).synchronizeLocalUser();
      expect(await db.one({ sql: 'SELECT id FROM sessions WHERE id = ?', parameters: ['old-session'] })).toBeNull();
      expect(Number((await db.one<{ session_version: number | string }>({
        sql: 'SELECT session_version FROM app_user WHERE id = ?',
        parameters: [user!.id]
      }))!.session_version)).toBe(Number(user!.session_version) + 1);
    } finally {
      await db.close();
    }
  });
});

describe('HTTP ingress', () => {
  it('enforces auth, origin and CSRF while proxying WUI traffic', async () => {
    const upstream = createNodeServer((_req, res) => {
      res.setHeader('content-type', 'text/plain');
      res.end('proxied-wui');
    });
    const upstreamUrl = await listen(upstream);
    const runtime = await createTestRuntime({
      config: {
        publicBaseUrl: 'http://localhost:8192',
        wui: {
          upstreamBaseUrl: upstreamUrl,
          healthPath: '/',
          timeoutMs: 2_000
        }
      }
    });
    const { db } = await openMigratedTestDatabase({ runtime });
    const logger = createTestLogger({ runtime });
    const auth = new AuthService(runtime, db, logger);
    await auth.synchronizeLocalUser();
    const { userId } = await bootstrapApplicationData({ db, runtime });
    const settings = new SettingsService(db, runtime, userId);
    const context = {
      runtime,
      buildInfo: { version: '1.0.0', buildHash: 'fixture' },
      db,
      logger,
      auth,
      settings
    } as unknown as AppContext;
    const { server } = createHttpServer({ context });
    const baseUrl = await listen(server);
    try {
      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(health.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await fetch(`${baseUrl}/mcp`, { method: 'POST' })).toMatchObject({ status: 404 });
      expect(await fetch(`${baseUrl}/api/settings`)).toMatchObject({ status: 401 });
      expect(await fetch(`${baseUrl}/auth/local/login`, {
        method: 'POST',
        headers: {
          origin: 'https://attacker.invalid',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ username: 'admin', password: 'test-password' })
      })).toMatchObject({ status: 403 });

      const login = await fetch(`${baseUrl}/auth/local/login`, {
        method: 'POST',
        headers: {
          origin: 'http://localhost:8192',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ username: 'admin', password: 'test-password' })
      });
      expect(login.status).toBe(200);
      const loginPayload = await login.json() as { csrfToken: string };
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
      expect(await fetch(`${baseUrl}/api/settings`, {
        headers: { cookie }
      })).toMatchObject({ status: 200 });
      expect(await fetch(`${baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: {
          cookie,
          origin: 'http://localhost:8192',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ theme: 'light' })
      })).toMatchObject({ status: 403 });
      const settingsPatch = await fetch(`${baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: {
          cookie,
          origin: 'http://localhost:8192',
          'x-csrf-token': loginPayload.csrfToken,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          theme: 'light',
          accordionStates: {
            'settings:market-coverage': false
          },
          dashboardRows: [{
            id: 'fixture-row',
            name: 'Fixture row',
            columns: 3,
            itemIds: ['fixture-chart', 'fixture-table']
          }]
        })
      });
      expect(settingsPatch.status).toBe(200);
      expect(await settingsPatch.json()).toMatchObject({
        settings: {
          theme: 'light',
          accordionStates: {
            'settings:market-coverage': false
          },
          dashboardRows: [{
            id: 'fixture-row',
            columns: 3,
            itemIds: ['fixture-chart', 'fixture-table']
          }]
        }
      });
      expect(await (await fetch(`${baseUrl}/api/settings`, {
        headers: { cookie }
      })).json()).toMatchObject({
        settings: {
          accordionStates: {
            'settings:market-coverage': false
          }
        }
      });
      const duplicateNames = await fetch(`${baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: {
          cookie,
          origin: 'http://localhost:8192',
          'x-csrf-token': loginPayload.csrfToken,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          savedGraphs: [
            {
              id: 'first',
              name: 'Market history',
              type: 'market',
              hidden: false,
              config: {}
            },
            {
              id: 'second',
              name: ' market HISTORY ',
              type: 'kraken',
              hidden: false,
              config: {}
            }
          ]
        })
      });
      expect(duplicateNames.status).toBe(400);
      const proxied = await fetch(`${baseUrl}/some-wui-route`);
      expect(await proxied.text()).toBe('proxied-wui');
    } finally {
      await db.close();
    }
  });
});
