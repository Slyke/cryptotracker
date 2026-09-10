// Provider responses can echo API keys, wallet addresses, and request payloads.
// Extract bounded, allowlisted hints rather than storing arbitrary upstream text.
const responseContexts = new WeakMap<Response, Record<string, unknown>>();
const bodyHintPatterns: Array<[string, RegExp]> = [
  ['access_denied', /access denied|forbidden|not allowed|permission denied/i],
  ['rate_limited', /rate.?limit|too many requests|quota exceeded/i],
  ['ip_restricted', /\bip\b.{0,60}(blocked|banned|denied|restricted)|(?:blocked|banned|denied).{0,60}\bip\b/i],
  ['region_restricted', /(?:country|region|geograph).{0,80}(blocked|restricted|not supported|unavailable)|(?:blocked|restricted|unavailable).{0,80}(country|region)/i],
  ['authentication_required', /invalid api.?key|expired.{0,20}(key|token)|unauthorized|authentication required/i],
  ['browser_challenge', /cf-chl-|challenge-platform|just a moment|enable javascript and cookies|captcha/i],
  ['method_unsupported', /method not (found|allowed|supported)|unsupported method/i],
  ['upstream_unavailable', /bad gateway|service unavailable|gateway time.?out/i]
];

export const providerBodyHints = (text: string) => bodyHintPatterns
  .filter(([, pattern]) => pattern.test(text.slice(0, 16_384)))
  .map(([hint]) => hint);

const responseHeaders = (response: Response): Record<string, unknown> => {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const rayId = response.headers.get('cf-ray');
  const retryAfter = response.headers.get('retry-after');
  return {
    ...(contentType && ['application/json', 'text/html', 'text/plain'].includes(contentType)
      ? { contentType } : {}),
    ...(/cloudflare/i.test(response.headers.get('server') ?? '') ? { edgeServer: 'cloudflare' } : {}),
    ...(rayId && /^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/i.test(rayId) ? { edgeRequestId: rayId } : {}),
    ...(retryAfter && /^\d{1,8}$/.test(retryAfter) ? { retryAfterSeconds: Number(retryAfter) } : {})
  };
};

export const bufferProviderResponse = async (fetched: Response): Promise<Response> => {
  const buffered = await fetched.arrayBuffer();
  const response = new Response([204, 205, 304].includes(fetched.status) ? null : buffered, {
    status: fetched.status,
    statusText: fetched.statusText,
    headers: fetched.headers
  });
  if (!response.ok) {
    const text = new TextDecoder().decode(buffered.slice(0, 16_384));
    const cloudflareError = /(?:error code|error)[\s:<>=\w"/-]{0,40}\b(1\d{3})\b/i.exec(text)?.[1];
    responseContexts.set(response, {
      ...responseHeaders(response),
      responseBytes: buffered.byteLength,
      responseHints: providerBodyHints(text),
      ...(/cloudflare/i.test(text) && cloudflareError
        ? { edgeErrorCode: Number(cloudflareError) } : {})
    });
  }
  return response;
};

export const providerResponseContext = (response: Response) => (
  responseContexts.get(response) ?? responseHeaders(response)
);

export interface ProviderRequestContext {
  host: string;
  httpMethod: 'GET' | 'POST';
  rpcMethod?: string;
  operation?: string;
}

export const providerRequestContext = ({ url, method, jsonBody }: {
  url: URL;
  method: 'GET' | 'POST';
  jsonBody?: unknown;
}): ProviderRequestContext => {
  const rpcMethod = jsonBody && typeof jsonBody === 'object' && 'method' in jsonBody
    ? jsonBody.method : undefined;
  const action = url.searchParams.get('action');
  return {
    // Do not log URL paths, query strings, request keys, headers, or RPC params.
    host: url.hostname,
    httpMethod: method,
    ...(typeof rpcMethod === 'string' && ['eth_blockNumber', 'eth_getBalance', 'eth_call'].includes(rpcMethod)
      ? { rpcMethod } : {}),
    ...(action && ['txlist', 'txlistinternal', 'tokentx'].includes(action) ? { operation: action } : {})
  };
};

const networkCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'
]);

export const providerNetworkContext = (error: unknown) => {
  const codes = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== 'object' || depth > 4) return;
    if ('code' in value && typeof value.code === 'string' && networkCodes.has(value.code)) codes.add(value.code);
    if ('cause' in value) visit(value.cause, depth + 1);
    if (value instanceof AggregateError) for (const child of value.errors.slice(0, 8)) visit(child, depth + 1);
  };
  visit(error, 0);
  return { networkErrorCodes: [...codes] };
};
