import { describe, expect, it } from 'vitest';
import { mcpServerInternals } from '../src/tools.js';
import { McpRateLimiter } from '../src/rate-limit.js';

describe('MCP API safety', () => {
  it('covers every REST API route family and classifies writes explicitly', () => {
    const operations = mcpServerInternals.operations;
    expect(operations.some((entry) => (
      entry.method === 'GET' && entry.path === '/api/portfolio/series'
    ))).toBe(true);
    expect(operations.some((entry) => (
      entry.method === 'POST'
      && entry.path === '/api/kraken/refresh'
      && entry.mutating
    ))).toBe(true);
    expect(operations.some((entry) => (
      entry.method === 'DELETE'
      && entry.path === '/api/addresses/:id'
      && entry.destructive
    ))).toBe(true);
    expect(operations.every((entry) => entry.path.startsWith('/api/'))).toBe(true);
    expect(operations.every((entry) => entry.toolName.startsWith('cryptotracker_'))).toBe(true);
    expect(new Set(operations.map((entry) => entry.toolName)).size).toBe(operations.length);
  });

  it('redacts credentials recursively without hiding ordinary identifiers', () => {
    expect(mcpServerInternals.redact({
      canonicalAssetId: 'bitcoin',
      nested: {
        apiKey: 'secret',
        coinGeckoApiKey: 'secret',
        private_key: 'secret',
        csrfToken: 'secret',
        errorKey: 'INPUT_INVALID'
      }
    })).toEqual({
      canonicalAssetId: 'bitcoin',
      nested: {
        apiKey: '[REDACTED]',
        coinGeckoApiKey: '[REDACTED]',
        private_key: '[REDACTED]',
        csrfToken: '[REDACTED]',
        errorKey: 'INPUT_INVALID'
      }
    });
  });

  it('isolates fixed-window limits by named key and safety category', () => {
    let nowMs = 1_000;
    const limiter = new McpRateLimiter({
      windowSeconds: 60,
      read: 2,
      write: 1,
      destructive: 1
    }, () => nowMs);
    expect(limiter.check({ identityName: 'agent-a', category: 'read' }).allowed).toBe(true);
    expect(limiter.check({ identityName: 'agent-a', category: 'read' }).allowed).toBe(true);
    expect(limiter.check({ identityName: 'agent-a', category: 'read' }).allowed).toBe(false);
    expect(limiter.check({ identityName: 'agent-b', category: 'read' }).allowed).toBe(true);
    expect(limiter.check({ identityName: 'agent-a', category: 'write' }).allowed).toBe(true);
    nowMs += 60_000;
    expect(limiter.check({ identityName: 'agent-a', category: 'read' }).allowed).toBe(true);
  });
});
