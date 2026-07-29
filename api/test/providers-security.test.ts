import { describe, expect, it, vi } from 'vitest';
import { isIpInCidrs, normalizeIpAddress, parseCidr } from '../src/auth/cidr.js';
import { redact } from '../src/logging/logger.js';
import { createProviderHttpClient } from '../src/providers/http.js';
import {
  findUnsafeKrakenPermissions,
  krakenReadOnlyPaths,
  KrakenReadOnlyClient,
  MonotonicNonce
} from '../src/providers/kraken.js';
import { ProviderRateLimiter, rateLimiterInternals } from '../src/providers/rate-limiter.js';
import { createTestRuntime } from './helpers.js';

const rateConfig = {
  minimumSpacingMs: 0,
  concurrency: 2,
  burst: 10,
  refillPerSecond: 10,
  maxRetries: 1,
  baseBackoffMs: 1,
  cooldownThreshold: 3,
  cooldownMs: 10
};

describe('network trust and redaction', () => {
  it('normalizes mapped addresses and checks IPv4 and IPv6 CIDRs', () => {
    expect(normalizeIpAddress({ value: '::ffff:127.0.0.1' })).toBe('127.0.0.1');
    expect(isIpInCidrs({
      address: '10.2.3.4',
      cidrs: [parseCidr({ value: '10.0.0.0/8' })]
    })).toBe(true);
    expect(isIpInCidrs({
      address: '2001:db8::1',
      cidrs: [parseCidr({ value: '2001:db8::/32' })]
    })).toBe(true);
    expect(isIpInCidrs({
      address: '192.168.1.1',
      cidrs: [parseCidr({ value: '10.0.0.0/8' })]
    })).toBe(false);
  });

  it('redacts nested secrets and sensitive query parameters', () => {
    expect(redact({
      value: {
        apiKey: 'secret',
        nested: {
          url: 'https://example.test/?token=hello&safe=yes'
        }
      }
    })).toEqual({
      apiKey: '[REDACTED]',
      nested: {
        url: 'https://example.test/?token=[REDACTED]&safe=yes'
      }
    });
  });
});

describe('provider controls', () => {
  it('coalesces identical in-flight requests and retries failures', async () => {
    const limiter = new ProviderRateLimiter('fixture', rateConfig);
    let calls = 0;
    const task = async () => {
      calls += 1;
      await Promise.resolve();
      return 'ok';
    };
    const [left, right] = await Promise.all([
      limiter.execute({ requestKey: 'same', task }),
      limiter.execute({ requestKey: 'same', task })
    ]);
    expect([left, right]).toEqual(['ok', 'ok']);
    expect(calls).toBe(1);

    let attempts = 0;
    await expect(limiter.execute({
      requestKey: 'retry',
      task: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary');
        return 'recovered';
      }
    })).resolves.toBe('recovered');
    expect(attempts).toBe(2);
  });

  it('records a terminal HTTP failure once instead of opening the circuit twice', async () => {
    const limiter = new ProviderRateLimiter('fixture', {
      ...rateConfig,
      maxRetries: 0,
      cooldownThreshold: 2
    });
    await expect(limiter.execute({
      requestKey: 'rate-limited',
      task: async () => new Response('', { status: 429 })
    })).rejects.toMatchObject({
      errorKey: 'PROVIDER_RATE_LIMITED'
    });
    expect(limiter.getStatus().consecutiveFailures).toBe(1);
    await expect(limiter.execute({
      requestKey: 'recovered',
      task: async () => new Response('', { status: 200 })
    })).resolves.toMatchObject({ status: 200 });
  });

  it('does not open the provider circuit for a non-retryable client response', async () => {
    const limiter = new ProviderRateLimiter('fixture', {
      ...rateConfig,
      maxRetries: 0,
      cooldownThreshold: 1
    });
    await expect(limiter.execute({
      requestKey: 'unsupported',
      task: async () => new Response('', { status: 401 })
    })).rejects.toMatchObject({
      errorKey: 'PROVIDER_REQUEST_FAILED'
    });
    expect(limiter.getStatus().consecutiveFailures).toBe(0);
    await expect(limiter.execute({
      requestKey: 'still-available',
      task: async () => new Response('', { status: 200 })
    })).resolves.toMatchObject({ status: 200 });
  });

  it('parses Retry-After and blocks provider path injection', async () => {
    expect(rateLimiterInternals.retryAfterMilliseconds({
      response: new Response('', { headers: { 'retry-after': '2' } }),
      nowMs: 0
    })).toBe(2_000);
    const client = createProviderHttpClient({
      provider: 'fixture',
      baseUrl: 'https://example.test/api',
      limiter: new ProviderRateLimiter('fixture', { ...rateConfig, maxRetries: 0 }),
      allowedPaths: [/^\/safe$/]
    });
    await expect(client.json({ path: '/unsafe/../write' })).rejects.toMatchObject({
      errorKey: 'INPUT_INVALID'
    });
  });

  it('keeps Kraken private operations on an immutable query-only allowlist', async () => {
    const mutatingPaths = [
      '/0/private/AddOrder',
      '/0/private/AddOrderBatch',
      '/0/private/CancelOrder',
      '/0/private/Withdraw',
      '/0/private/WalletTransfer',
      '/0/private/Earn/Allocate',
      '/0/private/Earn/Deallocate'
    ];
    expect(krakenReadOnlyPaths).not.toEqual(expect.arrayContaining(mutatingPaths));
    expect(findUnsafeKrakenPermissions({
      permissions: [
        'query-funds',
        'query-open-trades',
        'query-closed-trades',
        'query-ledger'
      ]
    })).toEqual([]);
    expect(findUnsafeKrakenPermissions({
      permissions: [
        'query-funds',
        'modify-trades',
        'withdraw-funds',
        'create-ws-token'
      ]
    })).toEqual(['modify-trades', 'withdraw-funds', 'create-ws-token']);
    const runtime = await createTestRuntime({
      secrets: {
        kraken: {
          apiKey: 'key',
          apiSecret: Buffer.from('secret').toString('base64')
        }
      }
    });
    const client = new KrakenReadOnlyClient(
      runtime.config.providers.market.kraken,
      runtime.secrets.kraken
    );
    for (const path of mutatingPaths) {
      await expect(client.privateQuery({ path })).rejects.toMatchObject({
        errorKey: 'INPUT_INVALID'
      });
    }
  });

  it('coordinates a strictly increasing nonce even when time does not move', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const nonce = new MonotonicNonce();
    const values = [nonce.next(), nonce.next(), nonce.next()].map(BigInt);
    expect(values[1]! > values[0]!).toBe(true);
    expect(values[2]! > values[1]!).toBe(true);
    vi.restoreAllMocks();
  });

  it('retries Kraken API-level rate-limit responses with a fresh nonce', async () => {
    const runtime = await createTestRuntime({
      config: {
        providers: {
          market: {
            kraken: {
              enabled: true,
              baseUrl: 'https://api.kraken.test',
              rate: {
                ...rateConfig,
                concurrency: 1
              }
            }
          }
        }
      },
      secrets: {
        kraken: {
          apiKey: 'key',
          apiSecret: Buffer.from('secret').toString('base64')
        }
      }
    });
    const nonces: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      nonces.push(body.get('nonce') ?? '');
      return new Response(JSON.stringify(nonces.length === 1
        ? { error: ['EAPI:Rate limit exceeded'] }
        : { error: [], result: { ZCAD: '1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }));
    try {
      const client = new KrakenReadOnlyClient(
        runtime.config.providers.market.kraken,
        runtime.secrets.kraken
      );
      await expect(client.privateQuery({
        path: '/0/private/Balance'
      })).resolves.toEqual({ ZCAD: '1' });
      expect(nonces).toHaveLength(2);
      expect(BigInt(nonces[1]!) > BigInt(nonces[0]!)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
