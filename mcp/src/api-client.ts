import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { McpRuntimeConfig } from './config.js';
import type { McpLogger } from './logger.js';

type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type QueryValue = string | number | boolean | Array<string | number | boolean>;

export interface ApiClientResult {
  [key: string]: unknown;
  ok: boolean;
  status: number;
  response: unknown;
}

export class ApiClient {
  private readonly baseUrl: URL;
  private readonly ca: Buffer | undefined;

  constructor(
    private readonly config: McpRuntimeConfig['upstream'],
    private readonly apiKey: string,
    private readonly logger: McpLogger
  ) {
    this.baseUrl = new URL(config.baseUrl.endsWith('/') ? config.baseUrl : `${config.baseUrl}/`);
    this.ca = (
      this.baseUrl.protocol === 'https:'
      && config.caCertPath
    )
      ? readFileSync(config.caCertPath)
      : undefined;
  }

  async request({
    method,
    path,
    query,
    body,
    correlationId = null
  }: {
    method: ApiMethod;
    path: string;
    query?: Record<string, QueryValue>;
    body?: unknown;
    correlationId?: string | null;
  }): Promise<ApiClientResult> {
    const attempts = method === 'GET' ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.requestOnce({
          method,
          path,
          ...(query ? { query } : {}),
          ...(body !== undefined ? { body } : {}),
          correlationId
        });
      } catch (error) {
        lastError = error;
        if (attempt >= attempts) break;
        this.logger.warn({
          event: 'UPSTREAM_API_RETRY',
          message: 'Retrying a failed read-only CryptoTracker API request.',
          correlationId,
          context: { method, path, attempt },
          error
        });
      }
    }
    throw lastError;
  }

  private async requestOnce({
    method,
    path,
    query,
    body,
    correlationId
  }: {
    method: ApiMethod;
    path: string;
    query?: Record<string, QueryValue>;
    body?: unknown;
    correlationId: string | null;
  }): Promise<ApiClientResult> {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, String(item));
      }
    }
    const requestBody = body === undefined
      ? null
      : Buffer.from(JSON.stringify(body));
    const startedAt = Date.now();
    this.logger.debug({
      event: 'UPSTREAM_API_REQUEST',
      message: 'Calling the CryptoTracker API.',
      correlationId,
      context: {
        method,
        path: `${url.pathname}${url.search}`
      }
    });
    const response = await new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: Buffer;
    }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        rejectUnauthorized: this.config.verifyTls,
        ...(url.protocol === 'https:' && this.ca ? { ca: this.ca } : {}),
        headers: {
          accept: 'application/json, text/csv, application/gzip',
          [this.config.apiKeyHeaderName]: this.apiKey,
          ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
          ...(requestBody ? {
            'content-type': 'application/json',
            'content-length': requestBody.length
          } : {})
        },
        timeout: this.config.timeoutMs
      }, (incoming) => {
        const chunks: Buffer[] = [];
        let length = 0;
        incoming.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 20 * 1024 * 1024) {
            incoming.destroy(new Error('API response exceeds the 20 MiB MCP response limit.'));
            return;
          }
          chunks.push(chunk);
        });
        incoming.once('end', () => resolve({
          status: incoming.statusCode ?? 500,
          headers: incoming.headers,
          body: Buffer.concat(chunks)
        }));
      });
      request.once('timeout', () => request.destroy(new Error('CryptoTracker API request timed out.')));
      request.once('error', reject);
      if (requestBody) request.write(requestBody);
      request.end();
    });
    const contentType = String(response.headers['content-type'] ?? '');
    let responseBody: unknown;
    if (/json/i.test(contentType)) {
      try {
        responseBody = JSON.parse(response.body.toString('utf8')) as unknown;
      } catch {
        responseBody = null;
      }
    } else if (/text|csv/i.test(contentType)) {
      responseBody = response.body.toString('utf8');
    } else {
      responseBody = {
        encoding: 'base64',
        contentType,
        fileName: response.headers['content-disposition'] ?? null,
        checksumSha256: response.headers['x-checksum-sha256'] ?? null,
        data: response.body.toString('base64')
      };
    }
    this.logger.debug({
      event: 'UPSTREAM_API_RESPONSE',
      message: 'CryptoTracker API request completed.',
      correlationId,
      context: {
        method,
        path: `${url.pathname}${url.search}`,
        status: response.status,
        durationMs: Date.now() - startedAt
      }
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      response: responseBody
    };
  }
}
