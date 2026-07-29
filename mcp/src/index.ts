import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Server } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ApiClient } from './api-client.js';
import { authenticateBearer, toMcpAuthInfo } from './auth.js';
import { getBuildInfo } from './build-info.js';
import { loadHttpsCertificates } from './certificates.js';
import { loadMcpRuntime } from './config.js';
import { HistoryStore } from './history.js';
import { McpLogger } from './logger.js';
import { McpRateLimiter } from './rate-limit.js';
import { createMcpServer, type McpToolContext } from './tools.js';

const sendJson = ({
  res,
  status = 200,
  body
}: {
  res: ServerResponse;
  status?: number;
  body: unknown;
}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
};

const sendMcpError = ({
  res,
  status,
  code,
  message
}: {
  res: ServerResponse;
  status: number;
  code: string;
  message: string;
}) => sendJson({
  res,
  status,
  body: {
    jsonrpc: '2.0',
    error: {
      code: -32_000,
      message,
      data: { code }
    },
    id: null
  }
});

const readJsonBody = async ({
  req,
  maxBytes = 16 * 1024 * 1024
}: {
  req: IncomingMessage;
  maxBytes?: number;
}) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw Object.assign(
      new Error('MCP request body exceeds the 16 MiB limit.'),
      { status: 413 }
    );
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};

const listen = async ({
  server,
  host,
  port
}: {
  server: Server;
  host: string;
  port: number;
}) => new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => {
    server.off('error', reject);
    resolve();
  });
});

const close = async (server: Server) => new Promise<void>((resolve) => {
  server.close(() => resolve());
});

const waitWhileDisabled = async () => new Promise<void>((resolve) => {
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});

export const main = async () => {
  const [runtime, buildInfo] = await Promise.all([
    loadMcpRuntime(),
    getBuildInfo()
  ]);
  const logger = new McpLogger();
  if (!runtime.config.enabled) {
    logger.info({
      event: 'SERVICE_DISABLED',
      message: 'CryptoTracker MCP is disabled by configuration; no listeners were opened.',
      correlationId: null,
      context: {
        version: buildInfo.version,
        buildHash: buildInfo.buildHash,
        configPath: runtime.configPath
      }
    });
    await waitWhileDisabled();
    return;
  }

  const api = new ApiClient(
    runtime.config.upstream,
    runtime.secrets.upstreamApiKey!,
    logger
  );
  const history = new HistoryStore(runtime.config.history, logger);
  const rateLimiter = new McpRateLimiter(runtime.config.rateLimits);
  const toolContext: McpToolContext = {
    config: runtime.config,
    version: buildInfo.version,
    logger,
    api,
    history
  };
  const servers: Server[] = [];
  let shuttingDown = false;

  const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const incomingCorrelationId = req.headers['x-correlation-id'];
    const correlationId = (
      typeof incomingCorrelationId === 'string'
      && /^[A-Za-z0-9._:-]{1,128}$/.test(incomingCorrelationId)
    )
      ? incomingCorrelationId
      : randomUUID();
    res.setHeader('x-correlation-id', correlationId);
    try {
      if (url.pathname === '/healthz') {
        if (req.method !== 'GET') {
          sendJson({ res, status: 405, body: { ok: false } });
          return;
        }
        sendJson({
          res,
          body: {
            ok: true,
            version: buildInfo.version,
            buildHash: buildInfo.buildHash,
            enabled: true,
            readOnly: runtime.config.readOnly
          }
        });
        return;
      }
      if (url.pathname === '/readyz') {
        if (req.method !== 'GET') {
          sendJson({ res, status: 405, body: { ok: false } });
          return;
        }
        const ready = !runtime.config.upstream.readyCheck
          || (await api.request({
            method: 'GET',
            path: '/api/me',
            correlationId
          })).ok;
        sendJson({
          res,
          status: ready ? 200 : 503,
          body: {
            ok: ready,
            version: buildInfo.version,
            buildHash: buildInfo.buildHash,
            upstream: ready
          }
        });
        return;
      }
      if (url.pathname !== '/mcp') {
        sendJson({
          res,
          status: 404,
          body: {
            ok: false,
            error: {
              code: 'not_found',
              message: 'Not found.',
              details: {}
            }
          }
        });
        return;
      }
      if (req.method !== 'POST') {
        sendMcpError({
          res,
          status: 405,
          code: 'method_not_allowed',
          message: 'The stateless MCP endpoint accepts POST requests only.'
        });
        return;
      }
      const identity = authenticateBearer({
        authorization: req.headers.authorization,
        secrets: runtime.secrets
      });
      if (!identity) {
        sendMcpError({
          res,
          status: 401,
          code: 'authentication_required',
          message: 'Missing or invalid MCP client bearer API key.'
        });
        return;
      }
      const body = await readJsonBody({ req });
      Object.assign(req, {
        auth: toMcpAuthInfo({ identity })
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
      const mcp = createMcpServer({
        context: toolContext,
        identity,
        rateLimiter,
        correlationId,
        sourceIp: req.socket.remoteAddress ?? null
      });
      res.once('close', () => {
        void transport.close().catch(() => undefined);
        void mcp.close().catch(() => undefined);
      });
      await mcp.connect(transport as Parameters<typeof mcp.connect>[0]);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      logger.error({
        event: 'MCP_HTTP_REQUEST_FAILED',
        message: 'MCP request handling failed.',
        correlationId,
        context: {
          method: req.method,
          path: url.pathname
        },
        error
      });
      if (!res.headersSent) {
        const status = (
          error
          && typeof error === 'object'
          && 'status' in error
          && typeof error.status === 'number'
        )
          ? error.status
          : 500;
        sendMcpError({
          res,
          status,
          code: status === 413 ? 'request_too_large' : 'internal_error',
          message: status === 413 ? 'MCP request is too large.' : 'Internal server error.'
        });
      } else {
        res.destroy();
      }
    }
  };

  if (runtime.config.http.enabled) {
    const server = createHttpServer((req, res) => void requestHandler(req, res));
    await listen({
      server,
      host: runtime.config.http.host,
      port: runtime.config.http.port
    });
    servers.push(server);
  }
  if (runtime.config.https.enabled) {
    const server = createHttpsServer(loadHttpsCertificates(runtime.config.https), (req, res) => {
      void requestHandler(req, res);
    });
    await listen({
      server,
      host: runtime.config.https.host,
      port: runtime.config.https.port
    });
    servers.push(server);
  }

  logger.info({
    event: 'SERVICE_BOOT_DIAGNOSTICS',
    message: 'CryptoTracker MCP sidecar started.',
    correlationId: null,
    context: {
      version: buildInfo.version,
      buildHash: buildInfo.buildHash,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      configPath: runtime.configPath,
      secretsPathConfigured: Boolean(runtime.secretsPath),
      http: runtime.config.http,
      https: {
        ...runtime.config.https,
        certPath: runtime.config.https.certPath,
        keyPath: runtime.config.https.keyPath
      },
      upstreamBaseUrl: runtime.config.upstream.baseUrl,
      upstreamTlsVerification: runtime.config.upstream.verifyTls,
      clientIdentityCount: runtime.secrets.clientApiKeys.length,
      readOnly: runtime.config.readOnly,
      rateLimits: runtime.config.rateLimits
    }
  });

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({
      event: 'SERVICE_SHUTDOWN_STARTED',
      message: `CryptoTracker MCP shutdown started after ${signal}.`,
      correlationId: null
    });
    await Promise.all(servers.map(close));
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void shutdown(signal)
        .then(() => process.exit(0))
        .catch((error) => {
          logger.error({
            event: 'SERVICE_SHUTDOWN_FAILED',
            message: 'CryptoTracker MCP graceful shutdown failed.',
            correlationId: null,
            error
          });
          process.exit(1);
        });
    });
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: 'cryptotracker-mcp',
      event: 'SERVICE_START_FAILED',
      message: error instanceof Error ? error.message : 'CryptoTracker MCP startup failed.'
    }));
    process.exit(1);
  });
}
