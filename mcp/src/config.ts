import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import JSON5 from 'json5';
import { z } from 'zod';

const transportSchema = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65_535)
}).strict();

const httpsTransportSchema = transportSchema.extend({
  certPath: z.string().trim().min(1),
  keyPath: z.string().trim().min(1),
  generateSelfSigned: z.boolean()
}).strict();

const rateLimitSchema = z.object({
  windowSeconds: z.number().int().min(1).max(3_600),
  read: z.number().int().min(1).max(100_000),
  write: z.number().int().min(1).max(100_000),
  destructive: z.number().int().min(1).max(100_000)
}).strict();

const runtimeConfigSchema = z.object({
  enabled: z.boolean(),
  readOnly: z.boolean(),
  http: transportSchema,
  https: httpsTransportSchema,
  upstream: z.object({
    baseUrl: z.string().url(),
    apiKeyHeaderName: z.string().regex(/^[A-Za-z0-9-]+$/),
    timeoutMs: z.number().int().min(1_000).max(120_000),
    verifyTls: z.boolean(),
    caCertPath: z.string().trim().min(1).nullable(),
    readyCheck: z.boolean()
  }).strict(),
  rateLimits: rateLimitSchema,
  history: z.object({
    enabled: z.boolean(),
    path: z.string().trim().min(1),
    maxEntries: z.number().int().min(100).max(100_000)
  }).strict()
}).strict().superRefine((value, context) => {
  if (!value.enabled) return;
  if (!value.http.enabled && !value.https.enabled) {
    context.addIssue({
      code: 'custom',
      path: ['http', 'enabled'],
      message: 'At least one MCP HTTP or HTTPS listener must be enabled.'
    });
  }
  if (
    value.http.enabled
    && value.https.enabled
    && value.http.host === value.https.host
    && value.http.port === value.https.port
  ) {
    context.addIssue({
      code: 'custom',
      path: ['https', 'port'],
      message: 'MCP HTTP and HTTPS listeners cannot use the same host and port.'
    });
  }
});

const clientApiKeySchema = z.object({
  name: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  key: z.string().min(16),
  role: z.enum(['read', 'readwrite'])
}).strict();

const runtimeSecretsSchema = z.object({
  upstreamApiKey: z.string().min(16).nullable(),
  clientApiKeys: z.array(clientApiKeySchema).max(100)
}).strict().superRefine((value, context) => {
  const names = value.clientApiKeys.map((entry) => entry.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    context.addIssue({
      code: 'custom',
      path: ['clientApiKeys'],
      message: 'MCP client API key names must be unique.'
    });
  }
  if (
    value.upstreamApiKey
    && value.clientApiKeys.some((entry) => entry.key === value.upstreamApiKey)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['upstreamApiKey'],
      message: 'The upstream API key must differ from every MCP client API key.'
    });
  }
});

export type McpRuntimeConfig = z.infer<typeof runtimeConfigSchema>;
export type McpRuntimeSecrets = z.infer<typeof runtimeSecretsSchema>;
export type RateLimitConfig = McpRuntimeConfig['rateLimits'];
export type ClientIdentity = Pick<McpRuntimeSecrets['clientApiKeys'][number], 'name' | 'role'>;

export interface LoadedMcpRuntime {
  config: McpRuntimeConfig;
  secrets: McpRuntimeSecrets;
  configPath: string | null;
  secretsPath: string | null;
}

type Environment = NodeJS.ProcessEnv;
type UnknownRecord = Record<string, unknown>;

const defaults: McpRuntimeConfig = {
  enabled: true,
  readOnly: false,
  http: {
    enabled: false,
    host: '0.0.0.0',
    port: 8_195
  },
  https: {
    enabled: true,
    host: '0.0.0.0',
    port: 8_193,
    certPath: './data/certs/server.crt',
    keyPath: './data/certs/server.key',
    generateSelfSigned: true
  },
  upstream: {
    baseUrl: 'http://127.0.0.1:8192',
    apiKeyHeaderName: 'X-API-Key',
    timeoutMs: 30_000,
    verifyTls: true,
    caCertPath: null,
    readyCheck: true
  },
  rateLimits: {
    windowSeconds: 60,
    read: 300,
    write: 120,
    destructive: 30
  },
  history: {
    enabled: true,
    path: './data/mcp-history.json',
    maxEntries: 5_000
  }
};

const readOptionalJson5 = async (filePath: string | null): Promise<UnknownRecord> => {
  if (!filePath) return {};
  try {
    return JSON5.parse(await readFile(filePath, 'utf8')) as UnknownRecord;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read or parse ${filePath}: ${message}`);
  }
};

const conventionalFilePath = async ({
  envPath,
  fileName
}: {
  envPath: string | undefined;
  fileName: string;
}) => {
  const explicit = envPath?.trim();
  if (explicit) return explicit;
  const conventional = resolve(process.cwd(), fileName);
  try {
    await access(conventional);
    return conventional;
  } catch {
    return null;
  }
};

const merge = (base: UnknownRecord, override: UnknownRecord): UnknownRecord => {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = (
      current
      && value
      && typeof current === 'object'
      && typeof value === 'object'
      && !Array.isArray(current)
      && !Array.isArray(value)
    )
      ? merge(current as UnknownRecord, value as UnknownRecord)
      : value;
  }
  return result;
};

const setPath = (target: UnknownRecord, path: string[], value: unknown) => {
  let cursor = target;
  for (const segment of path.slice(0, -1)) {
    if (!cursor[segment] || typeof cursor[segment] !== 'object' || Array.isArray(cursor[segment])) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as UnknownRecord;
  }
  cursor[path.at(-1)!] = value;
};

const parseBoolean = (key: string, value: string) => {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${key} must be true, false, 1, 0, yes, no, on, or off.`);
};

const parseInteger = (key: string, value: string) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${key} must be an integer.`);
  return parsed;
};

const applyConfigEnvironment = (config: UnknownRecord, env: Environment) => {
  const strings: Array<[string, string[]]> = [
    ['CRYPTOTRACKER_MCP_HTTP_HOST', ['http', 'host']],
    ['CRYPTOTRACKER_MCP_HTTPS_HOST', ['https', 'host']],
    ['CRYPTOTRACKER_MCP_HTTPS_CERT_PATH', ['https', 'certPath']],
    ['CRYPTOTRACKER_MCP_HTTPS_KEY_PATH', ['https', 'keyPath']],
    ['CRYPTOTRACKER_MCP_UPSTREAM_BASE_URL', ['upstream', 'baseUrl']],
    ['CRYPTOTRACKER_MCP_UPSTREAM_API_KEY_HEADER', ['upstream', 'apiKeyHeaderName']],
    ['CRYPTOTRACKER_MCP_UPSTREAM_CA_CERT_PATH', ['upstream', 'caCertPath']],
    ['CRYPTOTRACKER_MCP_HISTORY_PATH', ['history', 'path']]
  ];
  const booleans: Array<[string, string[]]> = [
    ['CRYPTOTRACKER_MCP_ENABLED', ['enabled']],
    ['CRYPTOTRACKER_MCP_READ_ONLY', ['readOnly']],
    ['CRYPTOTRACKER_MCP_HTTP_ENABLED', ['http', 'enabled']],
    ['CRYPTOTRACKER_MCP_HTTPS_ENABLED', ['https', 'enabled']],
    ['CRYPTOTRACKER_MCP_HTTPS_GENERATE_SELF_SIGNED', ['https', 'generateSelfSigned']],
    ['CRYPTOTRACKER_MCP_UPSTREAM_VERIFY_TLS', ['upstream', 'verifyTls']],
    ['CRYPTOTRACKER_MCP_UPSTREAM_READY_CHECK', ['upstream', 'readyCheck']],
    ['CRYPTOTRACKER_MCP_HISTORY_ENABLED', ['history', 'enabled']]
  ];
  const integers: Array<[string, string[]]> = [
    ['CRYPTOTRACKER_MCP_HTTP_PORT', ['http', 'port']],
    ['CRYPTOTRACKER_MCP_HTTPS_PORT', ['https', 'port']],
    ['CRYPTOTRACKER_MCP_UPSTREAM_TIMEOUT_MS', ['upstream', 'timeoutMs']],
    ['CRYPTOTRACKER_MCP_RATE_LIMIT_WINDOW_SECONDS', ['rateLimits', 'windowSeconds']],
    ['CRYPTOTRACKER_MCP_RATE_LIMIT_READ', ['rateLimits', 'read']],
    ['CRYPTOTRACKER_MCP_RATE_LIMIT_WRITE', ['rateLimits', 'write']],
    ['CRYPTOTRACKER_MCP_RATE_LIMIT_DESTRUCTIVE', ['rateLimits', 'destructive']],
    ['CRYPTOTRACKER_MCP_HISTORY_MAX_ENTRIES', ['history', 'maxEntries']]
  ];
  for (const [key, path] of strings) {
    if (env[key]?.trim()) setPath(config, path, env[key]!.trim());
  }
  for (const [key, path] of booleans) {
    if (env[key]?.trim()) setPath(config, path, parseBoolean(key, env[key]!));
  }
  for (const [key, path] of integers) {
    if (env[key]?.trim()) setPath(config, path, parseInteger(key, env[key]!));
  }
};

const loadKeyFile = async ({
  key,
  keyFile,
  baseDirectory,
  label
}: {
  key: unknown;
  keyFile: unknown;
  baseDirectory: string;
  label: string;
}) => {
  const inline = typeof key === 'string' ? key.trim() : '';
  const file = typeof keyFile === 'string' ? keyFile.trim() : '';
  if (inline && file) throw new Error(`${label} must use either key or keyFile, not both.`);
  if (inline) return inline;
  if (!file) return null;
  try {
    return (await readFile(resolve(baseDirectory, file), 'utf8')).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load ${label} keyFile: ${message}`);
  }
};

const normalizeSecrets = async ({
  raw,
  secretsPath,
  env
}: {
  raw: UnknownRecord;
  secretsPath: string | null;
  env: Environment;
}): Promise<UnknownRecord> => {
  const baseDirectory = secretsPath ? dirname(resolve(secretsPath)) : process.cwd();
  const directKey = env.CRYPTOTRACKER_MCP_UPSTREAM_API_KEY?.trim() ?? '';
  const directKeyFile = env.CRYPTOTRACKER_MCP_UPSTREAM_API_KEY_FILE?.trim() ?? '';
  const upstreamApiKey = await loadKeyFile({
    key: directKey || raw.upstreamApiKey,
    keyFile: directKeyFile || raw.upstreamApiKeyFile,
    baseDirectory,
    label: 'upstreamApiKey'
  });

  let entries = Array.isArray(raw.clientApiKeys)
    ? raw.clientApiKeys
    : [];
  const readEnvironment = env.CRYPTOTRACKER_MCP_READ_CLIENT_API_KEYS?.trim() || undefined;
  const writeEnvironment = env.CRYPTOTRACKER_MCP_READWRITE_CLIENT_API_KEYS?.trim() || undefined;
  if (readEnvironment !== undefined || writeEnvironment !== undefined) {
    const parseEntries = (value: string | undefined, role: 'read' | 'readwrite') => {
      if (!value) return [];
      const parsed = JSON5.parse(value) as unknown;
      if (!Array.isArray(parsed)) throw new Error(`MCP ${role} client API keys must be an array.`);
      return parsed.map((entry) => ({
        ...(entry as UnknownRecord),
        role
      }));
    };
    entries = [
      ...parseEntries(readEnvironment, 'read'),
      ...parseEntries(writeEnvironment, 'readwrite')
    ];
  }

  const clientApiKeys = await Promise.all(entries.map(async (entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`clientApiKeys[${index}] must be an object.`);
    }
    const record = entry as UnknownRecord;
    return {
      name: record.name,
      role: record.role ?? 'read',
      key: await loadKeyFile({
        key: record.key,
        keyFile: record.keyFile,
        baseDirectory,
        label: `clientApiKeys[${index}]`
      })
    };
  }));
  return {
    upstreamApiKey,
    clientApiKeys
  };
};

export const loadMcpRuntime = async ({
  env = process.env
}: {
  env?: Environment;
} = {}): Promise<LoadedMcpRuntime> => {
  const [configPath, secretsPath] = await Promise.all([
    conventionalFilePath({
      envPath: env.CRYPTOTRACKER_MCP_CONFIG_PATH,
      fileName: 'config.json5'
    }),
    conventionalFilePath({
      envPath: env.CRYPTOTRACKER_MCP_SECRETS_PATH,
      fileName: 'secrets.json5'
    })
  ]);
  const [fileConfig, fileSecrets] = await Promise.all([
    readOptionalJson5(configPath),
    readOptionalJson5(secretsPath)
  ]);
  const rawConfig = merge(defaults as unknown as UnknownRecord, fileConfig);
  applyConfigEnvironment(rawConfig, env);
  const config = runtimeConfigSchema.parse(rawConfig);
  const secrets = runtimeSecretsSchema.parse(await normalizeSecrets({
    raw: fileSecrets,
    secretsPath,
    env
  }));
  if (config.enabled) {
    if (!secrets.upstreamApiKey) {
      throw new Error('MCP is enabled but no upstream CryptoTracker API key is configured.');
    }
    if (secrets.clientApiKeys.length === 0) {
      throw new Error('MCP is enabled but no named MCP client API keys are configured.');
    }
  }
  return {
    config,
    secrets,
    configPath,
    secretsPath
  };
};

export const configInternals = {
  defaults,
  parseBoolean,
  parseInteger
};
