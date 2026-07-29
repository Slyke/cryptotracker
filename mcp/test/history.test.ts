import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HistoryStore } from '../src/history.js';
import { McpLogger } from '../src/logger.js';

describe('MCP mutation history', () => {
  it('retains only the configured newest entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cryptotracker-mcp-history-'));
    const history = new HistoryStore({
      enabled: true,
      path: join(directory, 'history.json'),
      maxEntries: 3
    }, new McpLogger('test'));
    for (let index = 0; index < 5; index += 1) {
      await history.append({
        timestamp: new Date(index).toISOString(),
        requestId: `request-${index}`,
        identityName: 'automation',
        role: 'readwrite',
        toolName: 'cryptotracker_settings_patch',
        action: 'PATCH /api/settings',
        applied: false,
        result: 'planned',
        sourceIp: '127.0.0.1',
        arguments: { index }
      });
    }
    const entries = await history.search({ limit: 10 });
    expect(entries.map((entry) => entry.requestId)).toEqual([
      'request-4',
      'request-3',
      'request-2'
    ]);
  });
});
