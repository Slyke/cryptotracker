import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import JSON5 from 'json5';
import { configSchema, secretsSchema, type RuntimeConfig, type RuntimeSecrets } from './schema.js';
import { AppError } from '../errors.js';

export type DatabaseKind = 'sqlite' | 'postgres';

export interface LoadedRuntime {
  config: RuntimeConfig;
  secrets: RuntimeSecrets;
  databaseKind: DatabaseKind;
  sqlitePath: string;
  configPath: string | null;
  secretsPath: string | null;
}

type Environment = NodeJS.ProcessEnv;

const environmentReferencePattern = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

const resolveEnvironmentReferences = ({
  value,
  env
}: {
  value: unknown;
  env: Environment;
}): unknown => {
  if (typeof value === 'string') {
    const match = environmentReferencePattern.exec(value);
    if (!match) return value;

    const environmentValue = env[match[1]!];
    return environmentValue === undefined ? null : environmentValue;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveEnvironmentReferences({ value: entry, env }));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        resolveEnvironmentReferences({ value: entry, env })
      ])
    );
  }

  return value;
};

const parseBoolean = ({ key, value }: { key: string; value: string }) => {
  const normalized = value.trim().toLowerCase();
  if (['true', '1'].includes(normalized)) return true;
  if (['false', '0'].includes(normalized)) return false;
  throw new AppError({
    errorKey: 'CONFIG_ENV_INVALID',
    reason: `${key} must be true, false, 1, or 0.`,
    status: 500,
    context: { key }
  });
};

const parseNumber = ({ key, value }: { key: string; value: string }) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError({
      errorKey: 'CONFIG_ENV_INVALID',
      reason: `${key} must be a finite number.`,
      status: 500,
      context: { key }
    });
  }
  return parsed;
};

const parseCsv = ({ value }: { value: string }) => (
  value.split(',').map((entry) => entry.trim()).filter(Boolean)
);

const readOptionalJson5 = async ({
  filePath,
  kind,
  env
}: {
  filePath: string | null;
  kind: 'config' | 'secrets';
  env: Environment;
}) => {
  if (!filePath) return {};

  try {
    const text = await readFile(filePath, 'utf8');
    return resolveEnvironmentReferences({
      value: JSON5.parse(text) as unknown,
      env
    });
  } catch (error) {
    throw new AppError({
      errorKey: kind === 'config' ? 'CONFIG_FILE_LOAD_FAILED' : 'SECRETS_FILE_LOAD_FAILED',
      reason: `Unable to read or parse the ${kind} JSON5 file.`,
      status: 500,
      context: { filePath },
      cause: error
    });
  }
};

const resolveApiKeyFiles = async ({
  rawSecrets,
  secretsPath
}: {
  rawSecrets: Record<string, unknown>;
  secretsPath: string | null;
}) => {
  if (!Array.isArray(rawSecrets.apiKeys)) return;
  const baseDirectory = secretsPath ? dirname(resolve(secretsPath)) : process.cwd();
  for (const [index, value] of rawSecrets.apiKeys.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const key = typeof entry.key === 'string' ? entry.key : '';
    const keyFile = typeof entry.keyFile === 'string' ? entry.keyFile.trim() : '';
    if (key && keyFile) {
      throw new AppError({
        errorKey: 'SECRETS_VALIDATION_FAILED',
        reason: `apiKeys[${index}] must use either key or keyFile, not both.`,
        status: 500
      });
    }
    if (!keyFile) continue;
    const resolvedPath = resolve(baseDirectory, keyFile);
    try {
      entry.key = (await readFile(resolvedPath, 'utf8')).trim();
      delete entry.keyFile;
    } catch (error) {
      throw new AppError({
        errorKey: 'SECRETS_FILE_LOAD_FAILED',
        reason: `Unable to read apiKeys[${index}] from its configured keyFile.`,
        status: 500,
        context: {
          keyFile: resolvedPath
        },
        cause: error
      });
    }
  }
};

const setPath = ({
  target,
  path,
  value
}: {
  target: Record<string, unknown>;
  path: string[];
  value: unknown;
}) => {
  let cursor = target;
  for (const part of path.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  const finalPart = path.at(-1);
  if (finalPart) cursor[finalPart] = value;
};

const applyConfigOverrides = ({
  rawConfig,
  env
}: {
  rawConfig: Record<string, unknown>;
  env: Environment;
}) => {
  const stringOverrides: Array<[string, string[]]> = [
    ['CRYPTOTRACKER_PUBLIC_BASE_URL', ['publicBaseUrl']],
    ['CRYPTOTRACKER_API_HOST', ['api', 'host']],
    ['CRYPTOTRACKER_WUI_UPSTREAM_BASE_URL', ['wui', 'upstreamBaseUrl']],
    ['CRYPTOTRACKER_AUTH_LOCAL_USERNAME', ['auth', 'local', 'username']],
    ['CRYPTOTRACKER_API_KEY_HEADER', ['auth', 'apiKey', 'headerName']],
    ['CRYPTOTRACKER_HTTPS_CERT_PATH', ['api', 'https', 'certPath']],
    ['CRYPTOTRACKER_HTTPS_KEY_PATH', ['api', 'https', 'keyPath']],
    ['CRYPTOTRACKER_AUTH_HEADER_USERNAME_HEADER', ['auth', 'header', 'usernameHeader']],
    ['CRYPTOTRACKER_AUTH_HEADER_GROUPS_HEADER', ['auth', 'header', 'groupsHeader']],
    ['CRYPTOTRACKER_AUTH_HEADER_GROUPS_SEPARATOR', ['auth', 'header', 'groupsSeparator']],
    ['CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_HEADER', ['auth', 'header', 'signedIdentity', 'headerName']],
    ['CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_ISSUER', ['auth', 'header', 'signedIdentity', 'issuer']],
    ['CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_AUDIENCE', ['auth', 'header', 'signedIdentity', 'audience']],
    ['CRYPTOTRACKER_DEFAULT_LOCALE', ['ui', 'locale']],
    ['CRYPTOTRACKER_DEFAULT_TIMEZONE', ['ui', 'timezone']],
    ['CRYPTOTRACKER_DEFAULT_PRIMARY_CURRENCY', ['ui', 'defaultPrimaryCurrency']],
    ['CRYPTOTRACKER_DEFAULT_MARKET_SOURCE', ['ui', 'defaultMarketSource']]
  ];
  const booleanOverrides: Array<[string, string[]]> = [
    ['CRYPTOTRACKER_AUTH_LOCAL_ENABLED', ['auth', 'local', 'enabled']],
    ['CRYPTOTRACKER_API_KEY_ENABLED', ['auth', 'apiKey', 'enabled']],
    ['CRYPTOTRACKER_HTTPS_ENABLED', ['api', 'https', 'enabled']],
    ['CRYPTOTRACKER_HTTPS_GENERATE_SELF_SIGNED', ['api', 'https', 'generateSelfSigned']],
    ['CRYPTOTRACKER_AUTH_HEADER_ENABLED', ['auth', 'header', 'enabled']],
    ['CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_ENABLED', ['auth', 'header', 'signedIdentity', 'enabled']],
    ['LOG_K8S_METADATA_ENABLED', ['logging', 'kubernetes', 'enabled']]
  ];
  const csvOverrides: Array<[string, string[]]> = [
    ['CRYPTOTRACKER_AUTH_HEADER_TRUSTED_CIDRS', ['auth', 'header', 'trustedCidrs']],
    ['CRYPTOTRACKER_AUTH_HEADER_ALLOWED_USERS', ['auth', 'header', 'allowedUsers']],
    ['CRYPTOTRACKER_AUTH_HEADER_ALLOWED_GROUPS', ['auth', 'header', 'allowedGroups']]
  ];

  for (const [key, path] of stringOverrides) {
    if (env[key] !== undefined && env[key] !== '') {
      setPath({ target: rawConfig, path, value: env[key]!.trim() });
    }
  }

  if (env.CRYPTOTRACKER_API_PORT !== undefined && env.CRYPTOTRACKER_API_PORT !== '') {
    setPath({
      target: rawConfig,
      path: ['api', 'port'],
      value: parseNumber({
        key: 'CRYPTOTRACKER_API_PORT',
        value: env.CRYPTOTRACKER_API_PORT
      })
    });
  }
  if (env.CRYPTOTRACKER_HTTPS_PORT !== undefined && env.CRYPTOTRACKER_HTTPS_PORT !== '') {
    setPath({
      target: rawConfig,
      path: ['api', 'https', 'port'],
      value: parseNumber({
        key: 'CRYPTOTRACKER_HTTPS_PORT',
        value: env.CRYPTOTRACKER_HTTPS_PORT
      })
    });
  }
  if (
    env.CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_MAX_TTL_SECONDS !== undefined
    && env.CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_MAX_TTL_SECONDS !== ''
  ) {
    setPath({
      target: rawConfig,
      path: ['auth', 'header', 'signedIdentity', 'maxTokenTtlSeconds'],
      value: parseNumber({
        key: 'CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_MAX_TTL_SECONDS',
        value: env.CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_MAX_TTL_SECONDS
      })
    });
  }
  for (const [key, path] of booleanOverrides) {
    if (env[key] !== undefined && env[key] !== '') {
      setPath({
        target: rawConfig,
        path,
        value: parseBoolean({ key, value: env[key]! })
      });
    }
  }

  for (const [key, path] of csvOverrides) {
    if (env[key] !== undefined) {
      setPath({
        target: rawConfig,
        path,
        value: parseCsv({ value: env[key]! })
      });
    }
  }
};

const applySecretOverrides = ({
  rawSecrets,
  env
}: {
  rawSecrets: Record<string, unknown>;
  env: Environment;
}) => {
  const overrides: Array<[string, string[]]> = [
    ['CRYPTOTRACKER_SESSION_SECRET', ['sessionSecret']],
    ['CRYPTOTRACKER_AUTH_LOCAL_PASSWORD', ['localPassword']],
    ['CRYPTOTRACKER_AUTH_SIGNED_IDENTITY_SECRET', ['signedIdentitySecret']],
    ['CRYPTOTRACKER_COINGECKO_API_KEY', ['providers', 'coinGeckoApiKey']],
    ['CRYPTOTRACKER_ETHERSCAN_API_KEY', ['providers', 'etherscanApiKey']],
    ['CRYPTOTRACKER_HELIUS_API_KEY', ['providers', 'heliusApiKey']],
    ['CRYPTOTRACKER_KRAKEN_API_KEY', ['kraken', 'apiKey']],
    ['CRYPTOTRACKER_KRAKEN_API_SECRET', ['kraken', 'apiSecret']],
    ['CRYPTOTRACKER_POSTGRES_PASSWORD', ['postgresPassword']]
  ];

  for (const [key, path] of overrides) {
    if (env[key] !== undefined && env[key] !== '') {
      setPath({ target: rawSecrets, path, value: env[key]!.trim() });
    }
  }
  const directApiKey = env.CRYPTOTRACKER_API_KEY?.trim() ?? '';
  const directApiKeyFile = env.CRYPTOTRACKER_API_KEY_FILE?.trim() ?? '';
  if (directApiKey && directApiKeyFile) {
    throw new AppError({
      errorKey: 'SECRETS_VALIDATION_FAILED',
      reason: 'Use either CRYPTOTRACKER_API_KEY or CRYPTOTRACKER_API_KEY_FILE, not both.',
      status: 500
    });
  }
  if (directApiKey || directApiKeyFile) {
    const name = env.CRYPTOTRACKER_API_KEY_NAME?.trim() || 'environment';
    const existing = Array.isArray(rawSecrets.apiKeys)
      ? rawSecrets.apiKeys.filter((entry) => (
        !entry
        || typeof entry !== 'object'
        || Array.isArray(entry)
        || String((entry as Record<string, unknown>).name ?? '').toLowerCase() !== name.toLowerCase()
      ))
      : [];
    setPath({
      target: rawSecrets,
      path: ['apiKeys'],
      value: [...existing, {
        name,
        ...(directApiKey
          ? { key: directApiKey }
          : { keyFile: directApiKeyFile }),
        role: env.CRYPTOTRACKER_API_KEY_ROLE?.trim().toLowerCase() === 'readwrite'
          ? 'readwrite'
          : 'read'
      }]
    });
  }
};

const validateIntegrationRequirements = ({
  config,
  secrets,
  databaseKind
}: {
  config: RuntimeConfig;
  secrets: RuntimeSecrets;
  databaseKind: DatabaseKind;
}) => {
  if (config.auth.local.enabled && !secrets.localPassword) {
    throw new AppError({
      errorKey: 'CONFIG_LOCAL_PASSWORD_REQUIRED',
      reason: 'Local authentication is enabled but no local password is configured.',
      status: 500
    });
  }

  if ((config.auth.local.enabled || config.auth.header.enabled) && !secrets.sessionSecret) {
    throw new AppError({
      errorKey: 'CONFIG_SESSION_SECRET_REQUIRED',
      reason: 'An enabled authentication mode requires a session secret.',
      status: 500
    });
  }

  if (
    config.auth.header.signedIdentity.enabled
    && !secrets.signedIdentitySecret
  ) {
    throw new AppError({
      errorKey: 'CONFIG_SIGNED_IDENTITY_SECRET_REQUIRED',
      reason: 'Signed identity verification is enabled but its secret is not configured.',
      status: 500
    });
  }

  if (
    databaseKind === 'postgres'
    && (!config.database.postgres || !secrets.postgresPassword)
  ) {
    throw new AppError({
      errorKey: 'CONFIG_POSTGRES_REQUIRED',
      reason: 'Postgres mode requires complete Postgres config and a password.',
      status: 500
    });
  }

  const krakenConfigured = Boolean(secrets.kraken.apiKey || secrets.kraken.apiSecret);
  if (krakenConfigured && (!secrets.kraken.apiKey || !secrets.kraken.apiSecret)) {
    throw new AppError({
      errorKey: 'CONFIG_KRAKEN_CREDENTIALS_INCOMPLETE',
      reason: 'Kraken requires both an API key and API secret.',
      status: 500
    });
  }
};

export const loadRuntime = async ({
  env = process.env
}: {
  env?: Environment;
} = {}): Promise<LoadedRuntime> => {
  const configPath = env.CRYPTOTRACKER_CONFIG_PATH?.trim() || null;
  const secretsPath = env.CRYPTOTRACKER_SECRETS_PATH?.trim() || null;
  const databaseKindValue = env.CRYPTOTRACKER_DB_KIND?.trim().toLowerCase() || 'sqlite';

  if (!['sqlite', 'postgres'].includes(databaseKindValue)) {
    throw new AppError({
      errorKey: 'CONFIG_DB_KIND_INVALID',
      reason: 'CRYPTOTRACKER_DB_KIND must be sqlite or postgres.',
      status: 500
    });
  }

  const [fileConfig, fileSecrets] = await Promise.all([
    readOptionalJson5({ filePath: configPath, kind: 'config', env }),
    readOptionalJson5({ filePath: secretsPath, kind: 'secrets', env })
  ]);
  const rawConfig = structuredClone(fileConfig) as Record<string, unknown>;
  const rawSecrets = structuredClone(fileSecrets) as Record<string, unknown>;
  applyConfigOverrides({ rawConfig, env });
  applySecretOverrides({ rawSecrets, env });
  await resolveApiKeyFiles({ rawSecrets, secretsPath });

  const configResult = configSchema.safeParse(rawConfig);
  if (!configResult.success) {
    throw new AppError({
      errorKey: 'CONFIG_VALIDATION_FAILED',
      reason: 'Configuration failed schema validation.',
      status: 500,
      context: configResult.error.flatten()
    });
  }

  const secretsResult = secretsSchema.safeParse(rawSecrets);
  if (!secretsResult.success) {
    throw new AppError({
      errorKey: 'SECRETS_VALIDATION_FAILED',
      reason: 'Secrets failed schema validation.',
      status: 500,
      context: secretsResult.error.flatten()
    });
  }

  const databaseKind = databaseKindValue as DatabaseKind;
  validateIntegrationRequirements({
    config: configResult.data,
    secrets: secretsResult.data,
    databaseKind
  });

  return {
    config: configResult.data,
    secrets: secretsResult.data,
    databaseKind,
    sqlitePath: env.CRYPTOTRACKER_SQLITE_PATH?.trim() || './data/cryptotracker.sqlite',
    configPath,
    secretsPath
  };
};

export const configurationHelpers = {
  applyConfigOverrides,
  applySecretOverrides,
  parseBoolean,
  parseCsv,
  parseNumber,
  resolveApiKeyFiles,
  resolveEnvironmentReferences
};
