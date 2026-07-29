import { AppError } from '../errors.js';
import { ProviderRateLimiter } from './rate-limiter.js';

interface ProviderRequest {
  path: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: URLSearchParams | null;
  jsonBody?: unknown;
  requestKey?: string;
}

export interface ProviderHttpClient {
  json<T>(request: ProviderRequest): Promise<T>;
  text(request: ProviderRequest): Promise<string>;
}

export const createProviderHttpClient = ({
  provider,
  baseUrl,
  limiter,
  allowedPaths
}: {
  provider: string;
  baseUrl: string;
  limiter: ProviderRateLimiter;
  allowedPaths: RegExp[];
}): ProviderHttpClient => {
  const request = async ({
    path,
    query = {},
    headers = {},
    method = 'GET',
    body = null,
    jsonBody,
    requestKey
  }: ProviderRequest) => {
    if (!path.startsWith('/') || !allowedPaths.some((pattern) => pattern.test(path))) {
      throw new AppError({
        errorKey: 'INPUT_INVALID',
        reason: `Provider path is not in the read-only ${provider} allowlist.`,
        status: 400,
        context: { provider, path }
      });
    }
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await limiter.execute<Response>({
      requestKey: requestKey ?? `${method}:${path}:${JSON.stringify(query)}:${JSON.stringify(jsonBody ?? body ?? null)}`,
      task: async () => fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...headers,
          ...(jsonBody !== undefined
            ? { 'content-type': 'application/json' }
            : body
              ? { 'content-type': 'application/x-www-form-urlencoded' }
              : {})
        },
        body: jsonBody === undefined ? body : JSON.stringify(jsonBody)
      })
    });
    const text = await response.text();
    if (!response.ok) {
      throw new AppError({
        errorKey: response.status === 429 ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_REQUEST_FAILED',
        reason: `${provider} request failed with HTTP ${response.status}.`,
        status: response.status === 429 ? 429 : 502,
        context: {
          provider,
          status: response.status,
          responsePreview: text.slice(0, 300)
        }
      });
    }
    return text;
  };

  return {
    text: request,
    json: async <T>(input: ProviderRequest) => {
      const text = await request(input);
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new AppError({
          errorKey: 'PROVIDER_RESPONSE_INVALID',
          reason: `${provider} returned invalid JSON.`,
          status: 502,
          context: {
            provider,
            responsePreview: text.slice(0, 300)
          },
          cause: error
        });
      }
    }
  };
};
