import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderHttpClient } from '../src/providers/http.js';
import { KrakenReadOnlyClient } from '../src/providers/kraken.js';
import { ProviderRateLimiter } from '../src/providers/rate-limiter.js';
import { bufferProviderResponse, providerBodyHints } from '../src/providers/diagnostics.js';
import { createTestRuntime } from './helpers.js';

const rate = {
  minimumSpacingMs: 0, concurrency: 2, burst: 100, refillPerSecond: 100,
  requestTimeoutMs: 1_000, maxRetries: 0, baseBackoffMs: 0,
  cooldownThreshold: 3, cooldownMs: 10
};
const makeClient = (overrides = {}) => createProviderHttpClient({
  provider: 'ethereum-json-rpc', baseUrl: 'https://rpc.example.test',
  limiter: new ProviderRateLimiter('ethereum-json-rpc', { ...rate, ...overrides }),
  allowedPaths: [/^\/$/]
});
const rpcRequest = {
  path: '/', method: 'POST' as const,
  jsonBody: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('shared provider responses', () => {
  it('gives all concurrent callers readable bodies while fetching once', async () => {
    const fetchMock = vi.fn(async () => new Response('{"result":"0x123"}'));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    const results = await Promise.all([
      client.json<{ result: string }>(rpcRequest),
      client.json<{ result: string }>(rpcRequest),
      client.text(rpcRequest)
    ]);
    expect(results).toEqual([{ result: '0x123' }, { result: '0x123' }, '{"result":"0x123"}']);
    expect(results[0]).not.toBe(results[1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(client.json(rpcRequest)).resolves.toEqual({ result: '0x123' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the shared original unread even when one consumer finishes first', async () => {
    const limiter = new ProviderRateLimiter('fixture', rate);
    const original = new Response('independent streams');
    const task = vi.fn(async () => original);
    const left = limiter.execute({ requestKey: 'same', task });
    const right = limiter.execute({ requestKey: 'same', task });
    const first = await left;
    expect(await first.text()).toBe('independent streams');
    const second = await right;
    expect(await second.text()).toBe('independent streams');
    expect(original.bodyUsed).toBe(false);
    expect(first).not.toBe(second);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('also coalesces Kraken private queries without consuming each other\'s bodies', async () => {
    const runtime = await createTestRuntime({ secrets: {
      kraken: { apiKey: 'test-key', apiSecret: Buffer.from('test-secret').toString('base64') }
    } });
    const fetchMock = vi.fn(async () => new Response('{"error":[],"result":{"ZCAD":"10"}}'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new KrakenReadOnlyClient({ ...runtime.config.providers.market.kraken, rate }, runtime.secrets.kraken);
    expect(await Promise.all([
      client.privateQuery({ path: '/0/private/Balance' }),
      client.privateQuery({ path: '/0/private/Balance' })
    ])).toEqual([{ ZCAD: '10' }, { ZCAD: '10' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows empty successful responses without constructing an invalid Response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await expect(makeClient().text({ path: '/' })).resolves.toBe('');
  });
});

describe('safe failure diagnostics', () => {
  it('preserves 403 evidence for all callers without retrying or leaking echoed request data', async () => {
    const echoedSecret = 'unique-secret-do-not-log';
    const wallet = '0x0123456789012345678901234567890123456789';
    const body = `<html>Cloudflare Error code: 1020 Access denied. IP blocked.
      Authorization: Bearer ${echoedSecret}; wallet: ${wallet}</html>`;
    const fetchMock = vi.fn(async () => new Response(body, { status: 403, headers: {
      server: 'cloudflare', 'content-type': 'text/html; charset=utf-8',
      'cf-ray': 'abcdef0123456789-YVR', 'set-cookie': echoedSecret, 'x-request-secret': echoedSecret
    } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = createProviderHttpClient({
      provider: 'ethereum-json-rpc', baseUrl: `https://user:${echoedSecret}@rpc.example.test/${echoedSecret}`,
      limiter: new ProviderRateLimiter('ethereum-json-rpc', { ...rate, maxRetries: 2 }),
      allowedPaths: [/^\/$/]
    });
    const request = { ...rpcRequest, query: { apikey: echoedSecret },
      headers: { authorization: `Bearer ${echoedSecret}` },
      jsonBody: { ...rpcRequest.jsonBody, method: 'eth_getBalance', params: [wallet, 'latest'] } };
    const results = await Promise.allSettled([client.json(request), client.json(request)]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status !== 'rejected') throw new Error('Expected failure');
      expect(result.reason).toMatchObject({
        errorKey: 'PROVIDER_REQUEST_FAILED', status: 502,
        context: { provider: 'ethereum-json-rpc', host: 'rpc.example.test', httpMethod: 'POST',
          rpcMethod: 'eth_getBalance', status: 403, contentType: 'text/html', edgeServer: 'cloudflare',
          edgeRequestId: 'abcdef0123456789-YVR', edgeErrorCode: 1020,
          responseHints: ['access_denied', 'ip_restricted'], responseBytes: Buffer.byteLength(body) }
      });
      const persisted = JSON.stringify(result.reason.context);
      expect(persisted).not.toContain(echoedSecret);
      expect(persisted).not.toContain(wallet);
      expect(persisted).not.toContain('Authorization');
      expect(persisted).not.toContain('<html>');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])('still retries HTTP %i and returns a readable successful result', async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('temporarily unavailable', { status, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('{"result":"ok"}'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(makeClient({ maxRetries: 1 }).json(rpcRequest)).resolves.toEqual({ result: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retains retry information and body hints on a terminal 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Too many requests', {
      status: 429, headers: { 'retry-after': '2' }
    })));
    await expect(makeClient().json(rpcRequest)).rejects.toMatchObject({
      errorKey: 'PROVIDER_RATE_LIMITED', status: 429,
      context: { status: 429, retryAfterSeconds: 2, responseHints: ['rate_limited'] }
    });
  });

  it('cleans up a failed in-flight entry so the next request can recover', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('{"result":"ok"}'));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient();
    await expect(client.json(rpcRequest)).rejects.toMatchObject({ context: { status: 403 } });
    await expect(client.json(rpcRequest)).resolves.toEqual({ result: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps network cause codes but excludes messages, addresses, and unknown codes', async () => {
    const cause = new AggregateError([
      Object.assign(new Error('connect 10.2.3.4 with secret'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('secret'), { code: 'secret-custom-code' }),
      Object.assign(new Error('secret'), { code: 'ENETUNREACH' })
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause }); }));
    await expect(makeClient().json(rpcRequest)).rejects.toMatchObject({
      errorKey: 'PROVIDER_REQUEST_FAILED', message: 'ethereum-json-rpc request failed.',
      context: { provider: 'ethereum-json-rpc', host: 'rpc.example.test', httpMethod: 'POST',
        rpcMethod: 'eth_blockNumber', failureKind: 'network', networkErrorCodes: ['ECONNREFUSED', 'ENETUNREACH'] }
    });
  });

  it('adds request context to timeouts and cooldown failures without changing their keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Promise<Response>(() => undefined)));
    const client = makeClient({ requestTimeoutMs: 20, cooldownThreshold: 1, cooldownMs: 1_000 });
    await expect(client.json(rpcRequest)).rejects.toMatchObject({
      errorKey: 'PROVIDER_REQUEST_FAILED', status: 504,
      context: { failureKind: 'timeout', timeoutMs: 20, host: 'rpc.example.test', rpcMethod: 'eth_blockNumber' }
    });
    await expect(client.json(rpcRequest)).rejects.toMatchObject({
      errorKey: 'PROVIDER_CIRCUIT_OPEN', status: 503,
      context: { host: 'rpc.example.test', rpcMethod: 'eth_blockNumber' }
    });
  });

  it('omits raw invalid JSON and identifies browser challenge pages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Just a moment secret-api-key wallet-address</html>')));
    await expect(makeClient().json(rpcRequest)).rejects.toMatchObject({
      errorKey: 'PROVIDER_RESPONSE_INVALID',
      context: { host: 'rpc.example.test', rpcMethod: 'eth_blockNumber', responseHints: ['browser_challenge'] }
    });
  });

  it('bounds body inspection and classifies region/authentication errors without storing text', async () => {
    expect(providerBodyHints('This service is unavailable in your country. Invalid API key.'))
      .toEqual(['region_restricted', 'authentication_required']);
    expect(providerBodyHints(`${'x'.repeat(16_384)}Access denied`)).toEqual([]);
    const response = await bufferProviderResponse(new Response('Forbidden', { status: 403 }));
    const limiter = new ProviderRateLimiter('fixture', rate);
    await expect(limiter.execute({ requestKey: 'buffered', task: async () => response }))
      .rejects.toMatchObject({ context: { status: 403, responseHints: ['access_denied'] } });
  });
});
