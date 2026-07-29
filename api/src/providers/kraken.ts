import { createHash, createHmac } from 'node:crypto';
import type { RuntimeConfig, RuntimeSecrets } from '../config/schema.js';
import { AppError } from '../errors.js';
import { ProviderRateLimiter } from './rate-limiter.js';

const readOnlyPrivatePaths = new Set([
  '/0/private/Balance',
  '/0/private/BalanceEx',
  '/0/private/CreditLines',
  '/0/private/TradeBalance',
  '/0/private/TradeVolume',
  '/0/private/OpenOrders',
  '/0/private/TradesHistory',
  '/0/private/Ledgers',
  '/0/private/OpenPositions',
  '/0/private/ClosedOrders',
  '/0/private/DepositStatus',
  '/0/private/WithdrawStatus',
  '/0/private/Earn/Allocations',
  '/0/private/Earn/Strategies',
  '/0/private/Earn/AllocateStatus',
  '/0/private/Earn/DeallocateStatus',
  '/0/private/GetApiKeyInfo'
]);

export const krakenRequiredPermissions = [
  'query-funds',
  'query-open-trades',
  'query-closed-trades',
  'query-ledger'
] as const;

const readOnlyPermissionAliases = new Set([
  ...krakenRequiredPermissions,
  'query funds',
  'query open trades',
  'query open orders & trades',
  'query closed trades',
  'query closed orders & trades',
  'query ledger',
  'query ledger entries'
]);

const normalizePermission = ({ permission }: { permission: string }) =>
  permission.trim().toLowerCase();

export class MonotonicNonce {
  private last = 0n;

  next() {
    const candidate = BigInt(Date.now()) * 1_000n;
    this.last = candidate > this.last ? candidate : this.last + 1n;
    return this.last.toString();
  }
}

export const findUnsafeKrakenPermissions = ({
  permissions
}: {
  permissions: string[];
}) => permissions.filter((permission) => !readOnlyPermissionAliases.has(
  normalizePermission({ permission })
));

export class KrakenReadOnlyClient {
  private readonly nonce = new MonotonicNonce();
  private readonly limiter: ProviderRateLimiter;

  constructor(
    private readonly config: RuntimeConfig['providers']['market']['kraken'],
    private readonly credentials: RuntimeSecrets['kraken']
  ) {
    this.limiter = new ProviderRateLimiter('kraken-private', {
      ...config.rate,
      concurrency: 1
    });
  }

  isConfigured() {
    return Boolean(this.credentials.apiKey && this.credentials.apiSecret);
  }

  async privateQuery<T>({
    path,
    parameters = {}
  }: {
    path: string;
    parameters?: Record<string, string | number>;
  }): Promise<T> {
    if (!readOnlyPrivatePaths.has(path)) {
      throw new AppError({
        errorKey: 'INPUT_INVALID',
        reason: 'Kraken endpoint is outside the immutable read-only allowlist.',
        status: 400,
        context: { path }
      });
    }
    if (!this.credentials.apiKey || !this.credentials.apiSecret) {
      throw new AppError({
        errorKey: 'PROVIDER_REQUEST_FAILED',
        reason: 'Kraken credentials are not configured.',
        status: 503
      });
    }
    let secret: Buffer;
    try {
      secret = Buffer.from(this.credentials.apiSecret, 'base64');
    } catch (error) {
      throw new AppError({
        errorKey: 'CONFIG_KRAKEN_CREDENTIALS_INCOMPLETE',
        reason: 'Kraken API secret is not valid base64.',
        cause: error
      });
    }
    for (let attempt = 0; attempt <= this.config.rate.maxRetries; attempt += 1) {
      const nonce = this.nonce.next();
      const body = new URLSearchParams({
        nonce,
        ...Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, String(value)]))
      });
      const encoded = body.toString();
      const message = Buffer.concat([
        Buffer.from(path),
        createHash('sha256').update(`${nonce}${encoded}`).digest()
      ]);
      const signature = createHmac('sha512', secret).update(message).digest('base64');
      const response = await this.limiter.execute<Response>({
        requestKey: `${path}:${JSON.stringify(parameters)}`,
        task: async () => fetch(new URL(path, this.config.baseUrl), {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
            'api-key': this.credentials.apiKey!,
            'api-sign': signature
          },
          body: encoded
        })
      });
      const payload = await response.json() as { error?: string[]; result?: T };
      const errors = payload.error ?? [];
      if (errors.length === 0) return payload.result as T;
      const rateLimited = errors.some((error) =>
        error.toLowerCase().includes('rate limit')
      );
      if (rateLimited && attempt < this.config.rate.maxRetries) {
        const delayMs = this.config.rate.baseBackoffMs * (2 ** attempt);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw new AppError({
        errorKey: rateLimited ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_REQUEST_FAILED',
        reason: `Kraken rejected a read-only query: ${errors.join(', ')}`,
        status: rateLimited ? 429 : 502,
        context: {
          path,
          errors
        }
      });
    }
    throw new AppError({
      errorKey: 'PROVIDER_REQUEST_FAILED',
      reason: 'Kraken read-only query exhausted its retry boundary.',
      status: 502,
      context: { path }
    });
  }

  async inspectPermissions() {
    try {
      const result = await this.privateQuery<Record<string, unknown>>({
        path: '/0/private/GetApiKeyInfo'
      });
      const permissions = Array.isArray(result.permissions)
        ? result.permissions.map((permission) => String(permission))
        : [];
      const normalizedPermissions = new Set(permissions.map((permission) =>
        normalizePermission({ permission })
      ));
      const unsafe = findUnsafeKrakenPermissions({ permissions });
      const missing = krakenRequiredPermissions.filter((permission) =>
        !normalizedPermissions.has(permission)
      );
      return {
        available: true,
        permissions,
        required: [...krakenRequiredPermissions],
        missing,
        safe: unsafe.length === 0,
        unsafe
      };
    } catch (error) {
      return {
        available: false,
        permissions: [] as string[],
        required: [...krakenRequiredPermissions],
        missing: [...krakenRequiredPermissions],
        safe: null,
        unsafe: [] as string[],
        reason: error instanceof Error ? error.message : 'Permission inspection unavailable.'
      };
    }
  }

  status() {
    return this.limiter.getStatus();
  }
}

export const krakenReadOnlyPaths = [...readOnlyPrivatePaths].sort();
