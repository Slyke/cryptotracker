import type { BuildInfo } from './build-info.js';
import type { LoadedRuntime } from './config/load.js';
import { AppError } from './errors.js';
import { redact } from './logging/logger.js';

const safeEndpoint = ({ value }: { value: string | null }) => {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const port = parsed.port ? `:${parsed.port}` : '';
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.protocol}//${parsed.hostname}${port}${path}`;
  } catch {
    return 'configured';
  }
};

const enabledNames = (entries: Record<string, { enabled: boolean }>) => (
  Object.entries(entries)
    .filter(([, value]) => value.enabled)
    .map(([name]) => name)
);

export const buildStartupDiagnostics = ({
  runtime,
  buildInfo
}: {
  runtime: LoadedRuntime;
  buildInfo: BuildInfo;
}) => {
  const { config, secrets } = runtime;
  const postgres = config.database.postgres;
  const database = runtime.databaseKind === 'postgres' && postgres
    ? {
        kind: 'postgres' as const,
        host: postgres.host,
        port: postgres.port,
        database: postgres.database,
        user: postgres.user,
        poolMax: postgres.poolMax,
        ssl: postgres.ssl,
        rejectUnauthorized: postgres.rejectUnauthorized,
        credentialConfigured: Boolean(secrets.postgresPassword)
      }
    : {
        kind: 'sqlite' as const,
        path: runtime.sqlitePath,
        busyTimeoutMs: config.database.sqlite.busyTimeoutMs,
        synchronous: config.database.sqlite.synchronous
      };
  const enabledMarketProviders = enabledNames(config.providers.market);
  const enabledChainProviders = enabledNames(config.providers.chains);

  return {
    build: {
      version: buildInfo.version,
      buildHash: buildInfo.buildHash
    },
    process: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid
    },
    configuration: {
      configPath: runtime.configPath,
      credentialsFileConfigured: Boolean(runtime.secretsPath)
    },
    ingress: {
      publicBaseUrl: safeEndpoint({ value: config.publicBaseUrl }),
      http: {
        host: config.api.host,
        port: config.api.port
      },
      https: {
        enabled: config.api.https.enabled,
        port: config.api.https.enabled ? config.api.https.port : null,
        generateSelfSigned: config.api.https.enabled
          ? config.api.https.generateSelfSigned
          : null
      },
      wuiUpstream: safeEndpoint({ value: config.wui.upstreamBaseUrl })
    },
    database,
    redis: {
      enabled: config.cache.redis.enabled,
      endpoint: config.cache.redis.enabled
        ? safeEndpoint({ value: config.cache.redis.url })
        : null,
      credentialConfigured: Boolean(secrets.redisPassword),
      keyPrefix: config.cache.redis.keyPrefix,
      resultTtlSeconds: config.cache.redis.resultTtlSeconds,
      connectTimeoutMs: config.cache.redis.connectTimeoutMs,
      fallback: runtime.databaseKind
    },
    authentication: {
      local: config.auth.local.enabled,
      trustedHeader: config.auth.header.enabled,
      signedIdentity: config.auth.header.signedIdentity.enabled,
      automationKeys: {
        enabled: config.auth.apiKey.enabled,
        identities: secrets.apiKeys.length
      }
    },
    providers: {
      enabledMarketProviders,
      enabledChainProviders,
      market: {
        coinGecko: {
          enabled: config.providers.market.coinGecko.enabled,
          endpoint: safeEndpoint({ value: config.providers.market.coinGecko.baseUrl }),
          credentialConfigured: Boolean(secrets.providers.coinGeckoApiKey)
        },
        coinbase: {
          enabled: config.providers.market.coinbase.enabled,
          endpoint: safeEndpoint({ value: config.providers.market.coinbase.baseUrl }),
          credentialRequired: false
        },
        kraken: {
          enabled: config.providers.market.kraken.enabled,
          endpoint: safeEndpoint({ value: config.providers.market.kraken.baseUrl }),
          privateApiConfigured: Boolean(secrets.kraken.apiKey && secrets.kraken.apiSecret)
        }
      },
      chains: {
        bitcoin: {
          enabled: config.providers.chains.bitcoin.enabled,
          provider: config.providers.chains.bitcoin.provider,
          endpoint: safeEndpoint({ value: config.providers.chains.bitcoin.baseUrl }),
          credentialRequired: false
        },
        dogecoin: {
          enabled: config.providers.chains.dogecoin.enabled,
          provider: config.providers.chains.dogecoin.provider,
          endpoint: safeEndpoint({ value: config.providers.chains.dogecoin.baseUrl }),
          credentialConfigured: Boolean(secrets.providers.blockCypherApiToken)
        },
        ethereum: {
          enabled: config.providers.chains.ethereum.enabled,
          provider: config.providers.chains.ethereum.provider,
          endpoint: safeEndpoint({ value: config.providers.chains.ethereum.baseUrl }),
          rpcEndpoint: safeEndpoint({ value: config.providers.chains.ethereum.rpcBaseUrl }),
          credentialConfigured: Boolean(secrets.providers.etherscanApiKey)
        },
        polkadot: {
          enabled: config.providers.chains.polkadot.enabled,
          provider: config.providers.chains.polkadot.provider,
          endpoint: safeEndpoint({ value: config.providers.chains.polkadot.baseUrl }),
          credentialConfigured: Boolean(secrets.providers.subscanApiKey)
        },
        solana: {
          enabled: config.providers.chains.solana.enabled,
          provider: config.providers.chains.solana.provider,
          endpoint: safeEndpoint({ value: config.providers.chains.solana.baseUrl }),
          credentialConfigured: Boolean(secrets.providers.heliusApiKey)
        }
      }
    },
    scheduling: {
      pollMinutes: config.sync.pollMinutes,
      staleAfterMinutes: config.sync.staleAfterMinutes,
      overlapBuckets: config.sync.overlapBuckets,
      maxConcurrentJobs: config.sync.maxConcurrentJobs
    },
    logging: {
      console: config.logging.sinks.console.enabled,
      file: config.logging.sinks.file.enabled,
      http: config.logging.sinks.http.enabled,
      syslog: config.logging.sinks.syslog.enabled,
      kubernetesMetadata: config.logging.kubernetes.enabled
    },
    kubernetes: {
      podName: process.env.K8S_POD_NAME ?? null,
      namespace: process.env.K8S_NAMESPACE ?? null,
      podIp: process.env.K8S_POD_IP ?? null,
      nodeName: process.env.K8S_NODE_NAME ?? null
    }
  };
};

export const startupSummary = ({
  diagnostics
}: {
  diagnostics: ReturnType<typeof buildStartupDiagnostics>;
}) => {
  const database = diagnostics.database.kind === 'postgres'
    ? `postgres:${diagnostics.database.host}:${diagnostics.database.port}/${diagnostics.database.database}`
    : `sqlite:${diagnostics.database.path}`;
  const redis = diagnostics.redis.enabled ? 'enabled' : 'disabled';
  const market = diagnostics.providers.enabledMarketProviders.join(',') || 'none';
  const chains = diagnostics.providers.enabledChainProviders.join(',') || 'none';
  const auth = Object.entries({
    local: diagnostics.authentication.local,
    header: diagnostics.authentication.trustedHeader,
    automation: diagnostics.authentication.automationKeys.enabled
  })
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(',') || 'none';
  const credentials = [
    `postgres:${diagnostics.database.kind === 'postgres' && diagnostics.database.credentialConfigured ? 'set' : 'n/a'}`,
    `redis:${diagnostics.redis.enabled ? diagnostics.redis.credentialConfigured ? 'set' : 'unset' : 'n/a'}`,
    `coingecko:${diagnostics.providers.market.coinGecko.credentialConfigured ? 'set' : 'unset'}`,
    `blockcypher:${diagnostics.providers.chains.dogecoin.credentialConfigured ? 'set' : 'unset'}`,
    `etherscan:${diagnostics.providers.chains.ethereum.credentialConfigured ? 'set' : 'unset'}`,
    `subscan:${diagnostics.providers.chains.polkadot.credentialConfigured ? 'set' : 'unset'}`,
    `helius:${diagnostics.providers.chains.solana.credentialConfigured ? 'set' : 'unset'}`,
    `kraken-private:${diagnostics.providers.market.kraken.privateApiConfigured ? 'set' : 'unset'}`
  ].join(',');
  return `CryptoTracker v${diagnostics.build.version} (${diagnostics.build.buildHash}) starting. db=${database} redis=${redis} auth=${auth} market=${market} chains=${chains} credentials=${credentials}`;
};

export const startupFailureEntry = ({
  error,
  phase
}: {
  error: unknown;
  phase: string;
}) => {
  const appError = error instanceof AppError ? error : null;
  return {
    timestamp: new Date().toISOString(),
    level: 'error',
    caller: 'index::main',
    errorKey: appError?.errorKey ?? 'STARTUP_FAILED',
    ...(appError ? { errorCode: appError.errorCode } : {}),
    message: error instanceof Error ? error.message : 'CryptoTracker startup failed.',
    context: redact({
      value: {
        startupPhase: phase,
        ...(appError?.context !== null && appError?.context !== undefined
          ? { failure: appError.context }
          : {})
      }
    }),
    rootCause: redact({ value: error })
  };
};

export const startupDiagnosticsInternals = {
  safeEndpoint
};
