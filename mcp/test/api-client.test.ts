import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/api-client.js';
import { McpLogger } from '../src/logger.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe('CryptoTracker API client', () => {
  it('applies the dedicated upstream API key, query, and request body', async () => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          header: req.headers['x-api-key'],
          url: req.url,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const client = new ApiClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKeyHeaderName: 'X-API-Key',
      timeoutMs: 5_000,
      verifyTls: true,
      caCertPath: null,
      readyCheck: true
    }, 'upstream-api-key-with-at-least-16-characters', new McpLogger('test'));
    const result = await client.request({
      method: 'PATCH',
      path: '/api/settings',
      query: { source: 'mcp' },
      body: { theme: 'light' },
      correlationId: 'request-1'
    });
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      response: {
        header: 'upstream-api-key-with-at-least-16-characters',
        url: '/api/settings?source=mcp',
        body: { theme: 'light' }
      }
    });
  });
});
