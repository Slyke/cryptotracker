import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from './api-client.js';
import type { ClientIdentity, McpRuntimeConfig } from './config.js';
import type { HistoryStore } from './history.js';
import type { McpLogger } from './logger.js';
import type { McpRateLimiter } from './rate-limit.js';

export interface McpToolContext {
  config: McpRuntimeConfig;
  version: string;
  logger: McpLogger;
  api: ApiClient;
  history: HistoryStore;
}

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface ApiOperation {
  method: ApiMethod;
  path: string;
  toolName: string;
  pattern: RegExp;
  mutating: boolean;
  destructive?: boolean;
  sensitiveDownload?: boolean;
}

const toolNameForOperation = ({
  method,
  path
}: {
  method: ApiMethod;
  path: string;
}) => {
  const resource = path
    .replace(/^\/api\/?/, '')
    .replaceAll(/:([A-Za-z][A-Za-z0-9_]*)/g, 'by_$1')
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .toLowerCase();
  return `cryptotracker_${resource}_${method.toLowerCase()}`;
};

const operation = ({
  method,
  path,
  mutating = false,
  destructive = false,
  sensitiveDownload = false
}: {
  method: ApiMethod;
  path: string;
  mutating?: boolean;
  destructive?: boolean;
  sensitiveDownload?: boolean;
}): ApiOperation => ({
  method,
  path,
  toolName: toolNameForOperation({ method, path }),
  mutating,
  destructive,
  sensitiveDownload,
  pattern: new RegExp(`^${path
    .replaceAll('/', '\\/')
    .replaceAll(/:[A-Za-z][A-Za-z0-9_]*/g, '[^/]+')}$`)
});

const operations: ApiOperation[] = [
  operation({ method: 'GET', path: '/api/me' }),
  operation({ method: 'GET', path: '/api/settings' }),
  operation({ method: 'PATCH', path: '/api/settings', mutating: true }),
  operation({ method: 'GET', path: '/api/providers/status' }),
  operation({ method: 'GET', path: '/api/sync/progress' }),
  operation({ method: 'GET', path: '/api/diagnostics/storage' }),
  operation({ method: 'GET', path: '/api/jobs' }),
  operation({ method: 'GET', path: '/api/jobs/:id' }),
  operation({ method: 'GET', path: '/api/catalog/assets' }),
  operation({ method: 'POST', path: '/api/catalog/refresh', mutating: true }),
  operation({ method: 'GET', path: '/api/watchlist/assets' }),
  operation({ method: 'POST', path: '/api/watchlist/assets', mutating: true }),
  operation({ method: 'POST', path: '/api/watchlist/assets/bulk', mutating: true }),
  operation({ method: 'PATCH', path: '/api/watchlist/assets/:id', mutating: true }),
  operation({ method: 'DELETE', path: '/api/watchlist/assets/:id', mutating: true, destructive: true }),
  operation({ method: 'GET', path: '/api/watchlist/currencies' }),
  operation({ method: 'PUT', path: '/api/watchlist/currencies', mutating: true }),
  operation({ method: 'GET', path: '/api/market/series' }),
  operation({ method: 'GET', path: '/api/market/metrics' }),
  operation({ method: 'GET', path: '/api/portfolio/series' }),
  operation({ method: 'POST', path: '/api/market/backfill', mutating: true }),
  operation({ method: 'POST', path: '/api/market/repair', mutating: true }),
  operation({ method: 'GET', path: '/api/addresses' }),
  operation({ method: 'GET', path: '/api/addresses/networks' }),
  operation({ method: 'POST', path: '/api/addresses', mutating: true }),
  operation({ method: 'PATCH', path: '/api/addresses/:id', mutating: true }),
  operation({ method: 'DELETE', path: '/api/addresses/:id', mutating: true, destructive: true }),
  operation({ method: 'PUT', path: '/api/addresses/:id/assets', mutating: true }),
  operation({ method: 'POST', path: '/api/addresses/:id/refresh', mutating: true }),
  operation({ method: 'GET', path: '/api/addresses/holdings' }),
  operation({ method: 'GET', path: '/api/addresses/series' }),
  operation({ method: 'GET', path: '/api/kraken/status' }),
  operation({ method: 'POST', path: '/api/kraken/refresh', mutating: true }),
  operation({ method: 'GET', path: '/api/kraken/summary' }),
  operation({ method: 'GET', path: '/api/kraken/holdings' }),
  operation({ method: 'GET', path: '/api/kraken/earn' }),
  operation({ method: 'GET', path: '/api/kraken/earn/series' }),
  operation({ method: 'GET', path: '/api/kraken/activity' }),
  operation({ method: 'GET', path: '/api/kraken/pnl' }),
  operation({ method: 'GET', path: '/api/kraken/series' }),
  operation({ method: 'GET', path: '/api/exports/series.csv' }),
  operation({ method: 'GET', path: '/api/exports/series.json' }),
  operation({ method: 'POST', path: '/api/exports/application', mutating: true }),
  operation({ method: 'GET', path: '/api/exports/application/:id' }),
  operation({
    method: 'GET',
    path: '/api/exports/application/:id/download',
    sensitiveDownload: true
  })
];

const queryValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()]))
]);
type ApiQuery = Record<
  string,
  string | number | boolean | Array<string | number | boolean>
>;

const readSchema = z.object({
  path: z.string().startsWith('/api/'),
  query: z.record(z.string(), queryValueSchema).optional(),
  confirmSensitiveDownload: z.boolean().default(false)
}).strict();

const writeSchema = z.object({
  method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().startsWith('/api/'),
  query: z.record(z.string(), queryValueSchema).optional(),
  body: z.unknown().optional(),
  apply: z.boolean().default(false),
  confirm: z.boolean().default(false)
}).strict();

const redactedKeys = new Set([
  'authorization',
  'cookie',
  'key',
  'privatekey',
  'seed',
  'seedphrase',
  'mnemonic',
  'password',
  'secret',
  'token',
  'csrftoken',
  'apikey',
  'apisecret',
  'sessionsecret',
  'localpassword'
]);

const shouldRedactKey = (key: string) => {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
  return redactedKeys.has(normalized)
    || normalized.endsWith('apikey')
    || normalized.endsWith('apisecret')
    || normalized.endsWith('password')
    || normalized.endsWith('secret')
    || normalized.endsWith('apitoken')
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('refreshtoken')
    || normalized.endsWith('sessiontoken')
    || normalized.endsWith('bearertoken')
    || normalized.endsWith('csrftoken');
};

const redact = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    shouldRedactKey(key) ? '[REDACTED]' : redact(entry)
  ]));
};

const toMcpResult = (payload: Record<string, unknown>) => ({
  content: [{
    type: 'text' as const,
    text: JSON.stringify(payload, null, 2)
  }],
  structuredContent: payload,
  isError: payload.ok === false
});

const resolveOperation = ({
  method,
  path
}: {
  method: ApiMethod;
  path: string;
}) => operations.find((candidate) => (
  candidate.method === method
  && candidate.pattern.test(path)
)) ?? null;

const operationPathParameters = ({ path }: { path: string }) => (
  [...path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]!)
);

const focusedInputSchema = ({ selected }: { selected: ApiOperation }) => {
  const shape: Record<string, z.ZodType> = Object.fromEntries(
    operationPathParameters({ path: selected.path })
      .map((name) => [name, z.string().min(1).max(500)])
  );
  shape.query = z.record(z.string(), queryValueSchema).optional();
  if (selected.mutating) {
    shape.body = z.unknown().optional();
    shape.apply = z.boolean().default(false);
    if (selected.destructive) shape.confirm = z.boolean().default(false);
  } else if (selected.sensitiveDownload) {
    shape.confirmSensitiveDownload = z.boolean().default(false);
  }
  return z.object(shape).strict();
};

const resolveFocusedPath = ({
  selected,
  args
}: {
  selected: ApiOperation;
  args: Record<string, unknown>;
}) => {
  let path = selected.path;
  for (const name of operationPathParameters({ path: selected.path })) {
    path = path.replace(`:${name}`, encodeURIComponent(String(args[name])));
  }
  return path;
};

const apiRequest = async ({
  context,
  method,
  path,
  query,
  body
}: {
  context: McpToolContext;
  method: ApiMethod;
  path: string;
  query?: ApiQuery;
  body?: unknown;
}) => context.api.request({
  method,
  path,
  ...(query ? { query } : {}),
  ...(body !== undefined ? { body } : {})
}).then((result) => redact(result) as Awaited<ReturnType<ApiClient['request']>>);

const safeApiRequest = async (
  args: Parameters<typeof apiRequest>[0]
) => {
  try {
    return await apiRequest(args);
  } catch (error) {
    args.context.logger.error({
      event: 'MCP_UPSTREAM_API_FAILED',
      message: 'CryptoTracker MCP could not complete an upstream API request.',
      correlationId: null,
      context: {
        method: args.method,
        path: args.path
      },
      error
    });
    return {
      ok: false,
      error: {
        code: 'api_request_failed',
        message: 'The CryptoTracker API request failed.',
        details: {}
      }
    };
  }
};

const logToolCall = ({
  context,
  identity,
  toolName
}: {
  context: McpToolContext;
  identity: ClientIdentity;
  toolName: string;
}) => {
  context.logger.info({
    event: 'MCP_TOOL_CALL',
    message: 'CryptoTracker MCP tool called.',
    correlationId: null,
    context: {
      toolName,
      identityName: identity.name,
      role: identity.role
    }
  });
};

export const createMcpServer = ({
  context,
  identity,
  rateLimiter,
  correlationId,
  sourceIp
}: {
  context: McpToolContext;
  identity: ClientIdentity;
  rateLimiter: McpRateLimiter;
  correlationId: string;
  sourceIp: string | null;
}) => {
  const server = new McpServer({
    name: 'cryptotracker',
    version: context.version
  });
  const applyRateLimit = ({
    toolName,
    category
  }: {
    toolName: string;
    category: 'read' | 'write' | 'destructive';
  }) => {
    const rate = rateLimiter.check({
      identityName: identity.name,
      category
    });
    if (rate.allowed) return null;
    context.logger.warn({
      event: 'MCP_RATE_LIMIT_BLOCKED',
      message: 'MCP tool call exceeded its named-key rate limit.',
      correlationId,
      context: {
        toolName,
        identityName: identity.name,
        category,
        limit: rate.limit,
        retryAfterSeconds: rate.retryAfterSeconds
      }
    });
    return toMcpResult({
      ok: false,
      error: {
        code: 'rate_limited',
        message: 'MCP tool rate limit exceeded.',
        details: {
          limit: rate.limit,
          retryAfterSeconds: rate.retryAfterSeconds
        }
      }
    });
  };
  const auditWrite = async ({
    result,
    method,
    path,
    applied,
    query,
    body,
    toolName = 'api_write'
  }: {
    result: string;
    method: ApiMethod;
    path: string;
    applied: boolean;
    query?: unknown;
    body?: unknown;
    toolName?: string;
  }) => {
    await context.history.append({
      timestamp: new Date().toISOString(),
      requestId: correlationId,
      identityName: identity.name,
      role: identity.role,
      toolName,
      action: `${method} ${path}`,
      applied,
      result,
      sourceIp,
      arguments: redact({
        query: redact(query),
        body: redact(body)
      })
    });
  };

  server.registerTool(
    'mcp_history_search',
    {
      description: 'Search the bounded, redacted MCP mutation history.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50),
        identityName: z.string().min(1).max(128).optional(),
        toolName: z.string().min(1).max(200).optional(),
        result: z.string().min(1).max(100).optional()
      }).strict(),
      annotations: {
        readOnlyHint: true
      }
    },
    async (args) => {
      logToolCall({ context, identity, toolName: 'mcp_history_search' });
      const limited = applyRateLimit({
        toolName: 'mcp_history_search',
        category: 'read'
      });
      if (limited) return limited;
      return toMcpResult({
        ok: true,
        entries: await context.history.search(args)
      });
    }
  );

  server.registerTool(
    'api_catalog',
    {
      description: 'List every CryptoTracker REST API operation exposed through MCP and its safety classification.',
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true
      }
    },
    async () => {
      logToolCall({ context, identity, toolName: 'api_catalog' });
      const limited = applyRateLimit({
        toolName: 'api_catalog',
        category: 'read'
      });
      if (limited) return limited;
      return toMcpResult({
        ok: true,
        readOnlyUpstream: true,
        operations: operations.map(({ method, path, toolName, mutating, destructive, sensitiveDownload }) => ({
          method,
          path,
          toolName,
          mutating,
          destructive: Boolean(destructive),
          sensitiveDownload: Boolean(sensitiveDownload)
        })),
        safety: {
          exchangeMutations: 'not implemented or exposed',
          krakenRefresh: 'queues read-only Kraken synchronization only'
        }
      });
    }
  );

  server.registerTool(
    'api_read',
    {
      description: 'Call any allowlisted read-only CryptoTracker /api endpoint. Secrets and authentication material are redacted.',
      inputSchema: readSchema,
      annotations: {
        readOnlyHint: true
      }
    },
    async (args) => {
      logToolCall({ context, identity, toolName: 'api_read' });
      const limited = applyRateLimit({
        toolName: 'api_read',
        category: 'read'
      });
      if (limited) return limited;
      const selected = resolveOperation({ method: 'GET', path: args.path });
      if (!selected || selected.mutating) {
        return toMcpResult({
          ok: false,
          error: {
            code: 'validation_error',
            message: 'That GET path is not in the MCP API allowlist.',
            details: { path: args.path }
          }
        });
      }
      if (
        selected.sensitiveDownload
        && (identity.role !== 'readwrite' || !args.confirmSensitiveDownload)
      ) {
        return toMcpResult({
          ok: false,
          error: {
            code: 'auth_error',
            message: 'Application-export downloads require a readwrite key and confirmSensitiveDownload: true.',
            details: {}
          }
        });
      }
      return toMcpResult(await safeApiRequest({
        context,
        method: 'GET',
        path: args.path,
        ...(args.query ? { query: args.query } : {})
      }));
    }
  );

  if (!context.config.readOnly && identity.role === 'readwrite') server.registerTool(
    'api_write',
    {
      description: 'Plan or apply an allowlisted local CryptoTracker API mutation. apply defaults to false; exchange-side mutations are never available.',
      inputSchema: writeSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true
      }
    },
    async (args) => {
      logToolCall({ context, identity, toolName: 'api_write' });
      const selected = resolveOperation({
        method: args.method,
        path: args.path
      });
      if (!selected?.mutating) {
        await auditWrite({
          result: 'rejected',
          method: args.method,
          path: args.path,
          applied: false,
          query: args.query,
          body: args.body
        });
        return toMcpResult({
          ok: false,
          error: {
            code: 'validation_error',
            message: 'That mutation is not in the MCP API allowlist.',
            details: {
              method: args.method,
              path: args.path
            }
          }
        });
      }
      const limited = applyRateLimit({
        toolName: 'api_write',
        category: selected.destructive ? 'destructive' : 'write'
      });
      if (limited) {
        await auditWrite({
          result: 'rate_limited',
          method: args.method,
          path: args.path,
          applied: false,
          query: args.query,
          body: args.body
        });
        return limited;
      }
      if (selected.destructive && !args.confirm) {
        await auditWrite({
          result: 'confirmation_required',
          method: args.method,
          path: args.path,
          applied: false,
          query: args.query,
          body: args.body
        });
        return toMcpResult({
          ok: false,
          error: {
            code: 'confirmation_required',
            message: 'This destructive operation requires confirm: true.',
            details: {
              method: args.method,
              path: args.path
            }
          }
        });
      }
      if (!args.apply) {
        await auditWrite({
          result: 'planned',
          method: args.method,
          path: args.path,
          applied: false,
          query: args.query,
          body: args.body
        });
        return toMcpResult({
          ok: true,
          applied: false,
          plan: {
            method: args.method,
            path: args.path,
            query: redact(args.query ?? {}),
            body: redact(args.body)
          },
          safety: {
            upstreamExchangeMutation: false
          }
        });
      }
      const result = await safeApiRequest({
        context,
        method: args.method,
        path: args.path,
        ...(args.query ? { query: args.query } : {}),
        ...(args.body !== undefined ? { body: args.body } : {})
      });
      await auditWrite({
        result: result.ok ? 'succeeded' : 'failed',
        method: args.method,
        path: args.path,
        applied: result.ok,
        query: args.query,
        body: args.body
      });
      return toMcpResult({
        ...result,
        applied: result.ok
      });
    }
  );

  for (const selected of operations) {
    if (
      selected.mutating
      && (context.config.readOnly || identity.role !== 'readwrite')
    ) continue;
    if (selected.sensitiveDownload && identity.role !== 'readwrite') continue;
    server.registerTool(
      selected.toolName,
      {
        description: selected.mutating
          ? `Plan or apply ${selected.method} ${selected.path}. apply defaults to false.`
          : `Call read-only endpoint ${selected.method} ${selected.path}.`,
        inputSchema: focusedInputSchema({ selected }),
        annotations: {
          readOnlyHint: !selected.mutating,
          destructiveHint: Boolean(selected.destructive)
        }
      },
      async (input) => {
        const args = input as Record<string, unknown>;
        const path = resolveFocusedPath({ selected, args });
        const query = args.query as ApiQuery | undefined;
        logToolCall({
          context,
          identity,
          toolName: selected.toolName
        });
        const category = selected.destructive
          ? 'destructive'
          : selected.mutating
            ? 'write'
            : 'read';
        const limited = applyRateLimit({
          toolName: selected.toolName,
          category
        });
        if (limited) {
          if (selected.mutating) {
            await auditWrite({
              result: 'rate_limited',
              method: selected.method,
              path,
              applied: false,
              query,
              body: args.body,
              toolName: selected.toolName
            });
          }
          return limited;
        }
        if (!selected.mutating) {
          if (
            selected.sensitiveDownload
            && (
              identity.role !== 'readwrite'
              || args.confirmSensitiveDownload !== true
            )
          ) {
            return toMcpResult({
              ok: false,
              error: {
                code: 'auth_error',
                message: 'Application-export downloads require a readwrite key and confirmSensitiveDownload: true.',
                details: {}
              }
            });
          }
          return toMcpResult(await safeApiRequest({
            context,
            method: 'GET',
            path,
            ...(query ? { query } : {})
          }));
        }
        if (selected.destructive && args.confirm !== true) {
          await auditWrite({
            result: 'confirmation_required',
            method: selected.method,
            path,
            applied: false,
            query,
            body: args.body,
            toolName: selected.toolName
          });
          return toMcpResult({
            ok: false,
            error: {
              code: 'confirmation_required',
              message: `${selected.toolName} requires confirm: true.`,
              details: {}
            }
          });
        }
        if (args.apply !== true) {
          await auditWrite({
            result: 'planned',
            method: selected.method,
            path,
            applied: false,
            query,
            body: args.body,
            toolName: selected.toolName
          });
          return toMcpResult({
            ok: true,
            applied: false,
            plan: {
              method: selected.method,
              path,
              query: redact(query ?? {}),
              body: redact(args.body)
            },
            safety: {
              upstreamExchangeMutation: false
            }
          });
        }
        const result = await safeApiRequest({
          context,
          method: selected.method,
          path,
          ...(query ? { query } : {}),
          ...(args.body !== undefined ? { body: args.body } : {})
        });
        await auditWrite({
          result: result.ok ? 'succeeded' : 'failed',
          method: selected.method,
          path,
          applied: result.ok,
          query,
          body: args.body,
          toolName: selected.toolName
        });
        return toMcpResult({
          ...result,
          applied: result.ok
        });
      }
    );
  }

  return server;
};

export const mcpServerInternals = {
  operations,
  redact,
  resolveOperation,
  toolNameForOperation
};
