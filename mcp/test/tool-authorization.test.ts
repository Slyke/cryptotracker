import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../src/api-client.js';
import { configInternals, type ClientIdentity } from '../src/config.js';
import type { HistoryStore } from '../src/history.js';
import { McpLogger } from '../src/logger.js';
import { McpRateLimiter } from '../src/rate-limit.js';
import { createMcpServer, type McpToolContext } from '../src/tools.js';

const listTools = async (identity: ClientIdentity) => {
  const historyEntries: unknown[] = [];
  const context: McpToolContext = {
    config: configInternals.defaults,
    version: '1.0.0',
    logger: new McpLogger('test'),
    api: {
      request: async () => ({ ok: true, status: 200, response: {} })
    } as unknown as ApiClient,
    history: {
      append: async (entry: unknown) => {
        historyEntries.push(entry);
      },
      search: async () => historyEntries
    } as unknown as HistoryStore
  };
  const server = createMcpServer({
    context,
    identity,
    rateLimiter: new McpRateLimiter(context.config.rateLimits),
    correlationId: 'tool-test',
    sourceIp: '127.0.0.1'
  });
  const client = new Client({
    name: 'test-client',
    version: '1.0.0'
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    historyEntries,
    tools: (await client.listTools()).tools.map((tool) => tool.name)
  };
};

describe('MCP tool authorization', () => {
  it('omits write and sensitive-download tools from read identities', async () => {
    const fixture = await listTools({ name: 'reader', role: 'read' });
    try {
      expect(fixture.tools).toContain('api_read');
      expect(fixture.tools).toContain('mcp_history_search');
      expect(fixture.tools).toContain('cryptotracker_settings_get');
      expect(fixture.tools).not.toContain('api_write');
      expect(fixture.tools).not.toContain('cryptotracker_settings_patch');
      expect(fixture.tools).not.toContain('cryptotracker_exports_application_by_id_download_get');
    } finally {
      await fixture.client.close();
      await fixture.server.close();
    }
  });

  it('registers write tools for readwrite identities and records dry-runs', async () => {
    const fixture = await listTools({ name: 'automation', role: 'readwrite' });
    try {
      expect(fixture.tools).toContain('api_write');
      expect(fixture.tools).toContain('cryptotracker_settings_patch');
      const result = await fixture.client.callTool({
        name: 'cryptotracker_settings_patch',
        arguments: {
          body: {
            theme: 'light',
            apiKey: 'must-be-redacted'
          }
        }
      });
      expect(result.isError).toBe(false);
      expect(JSON.stringify(result)).toContain('"applied":false');
      expect(fixture.historyEntries).toHaveLength(1);
      expect(JSON.stringify(fixture.historyEntries[0])).toContain('[REDACTED]');
      expect(JSON.stringify(fixture.historyEntries[0])).not.toContain('must-be-redacted');
    } finally {
      await fixture.client.close();
      await fixture.server.close();
    }
  });
});
