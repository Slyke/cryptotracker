import { createChainAdapters } from './providers/chains.js';
import { createMarketProviders } from './providers/market.js';
import { KrakenReadOnlyClient } from './providers/kraken.js';
import { AuthService } from './auth/service.js';
import { getBuildInfo } from './build-info.js';
import { loadRuntime } from './config/load.js';
import { openDatabase } from './db/index.js';
import { createHttpServer, type AppContext } from './http/app.js';
import { JobQueue } from './jobs/queue.js';
import { Logger } from './logging/logger.js';
import { Scheduler } from './scheduler.js';
import { AddressService } from './services/addresses.js';
import { bootstrapApplicationData } from './services/bootstrap.js';
import { DiagnosticsService } from './services/diagnostics.js';
import { ApplicationExportService } from './services/exports.js';
import { GraphCacheService } from './services/graph-cache.js';
import { KrakenService } from './services/kraken.js';
import { MarketService } from './services/market.js';
import { PortfolioService } from './services/portfolio.js';
import { RetentionService } from './services/retention.js';
import { SettingsService } from './services/settings.js';
import { TransferService } from './services/transfers.js';
import {
  buildStartupDiagnostics,
  startupFailureEntry,
  startupSummary
} from './startup-diagnostics.js';

let startupPhase = 'loading configuration and build metadata';

const main = async () => {
  const [runtime, buildInfo] = await Promise.all([
    loadRuntime(),
    getBuildInfo()
  ]);
  const logger = new Logger(runtime.config.logging);
  const startupDiagnostics = buildStartupDiagnostics({ runtime, buildInfo });
  logger.info({
    caller: 'index::startup',
    loggerKey: 'SERVICE_BOOT_DIAGNOSTICS',
    message: startupSummary({ diagnostics: startupDiagnostics }),
    context: startupDiagnostics
  });

  startupPhase = `opening ${runtime.databaseKind} database`;
  const db = await openDatabase({ runtime });
  logger.info({
    caller: 'index::startup',
    loggerKey: 'SERVICE_BOOT_DIAGNOSTICS',
    message: `${runtime.databaseKind} database connection opened.`
  });

  startupPhase = `applying ${runtime.databaseKind} database migrations`;
  await db.migrate();
  logger.info({
    caller: 'index::startup',
    loggerKey: 'SERVICE_BOOT_DIAGNOSTICS',
    message: `${runtime.databaseKind} database migrations completed.`
  });

  startupPhase = 'synchronizing authentication and application data';
  const auth = new AuthService(runtime, db, logger);
  await auth.synchronizeLocalUser();
  const { userId } = await bootstrapApplicationData({ db, runtime });
  const jobs = new JobQueue(db, logger, runtime.config.sync.maxConcurrentJobs);
  const market = new MarketService(
    db,
    runtime,
    createMarketProviders({
      config: runtime.config,
      secrets: runtime.secrets
    }),
    jobs
  );
  const addresses = new AddressService(
    db,
    runtime,
    createChainAdapters({
      config: runtime.config,
      secrets: runtime.secrets
    }),
    jobs
  );
  const krakenClient = new KrakenReadOnlyClient(
    runtime.config.providers.market.kraken,
    runtime.secrets.kraken
  );
  const kraken = new KrakenService(db, runtime, krakenClient, jobs);
  const settings = new SettingsService(db, runtime, userId);
  const portfolio = new PortfolioService(db, runtime);
  const transfers = new TransferService(db);
  const exports = new ApplicationExportService(db, runtime, jobs, buildInfo, userId);
  const retention = new RetentionService(db);
  const diagnostics = new DiagnosticsService(db, runtime, market, addresses, kraken);
  const graphCache = new GraphCacheService(runtime, logger, async (plan) => {
    switch (plan.scope) {
      case 'market':
        return market.getSeries(plan.input as unknown as Parameters<typeof market.getSeries>[0]);
      case 'portfolio':
        return portfolio.series(plan.input as unknown as Parameters<typeof portfolio.series>[0]);
      case 'addresses':
        return addresses.series(plan.input as unknown as Parameters<typeof addresses.series>[0]);
      case 'kraken':
        return kraken.series(plan.input as unknown as Parameters<typeof kraken.series>[0]);
      case 'kraken-earn':
        return kraken.earnOverview(plan.input as unknown as Parameters<typeof kraken.earnOverview>[0]);
    }
  });
  const refreshGraphCache = (changes: Parameters<typeof graphCache.refreshAffected>[0]) => (
    graphCache.refreshAffected(changes)
  );
  const scheduler = new Scheduler(
    db,
    runtime,
    market,
    addresses,
    kraken,
    portfolio,
    settings,
    retention,
    logger,
    graphCache.enabled ? refreshGraphCache : null,
    graphCache.enabled ? () => graphCache.isActive() : null
  );
  market.registerJobs();
  addresses.registerJobs();
  kraken.registerJobs();
  transfers.registerJobs({ jobs });
  exports.registerJobs();
  if (graphCache.enabled) {
    jobs.onGraphDataChange(refreshGraphCache, () => graphCache.isActive());
  }
  const context: AppContext = {
    runtime,
    buildInfo,
    db,
    logger,
    auth,
    settings,
    market,
    portfolio,
    addresses,
    kraken,
    transfers,
    diagnostics,
    exports,
    retention,
    jobs,
    scheduler,
    graphCache
  };
  startupPhase = 'initializing optional Redis graph cache';
  await graphCache.initialize();
  startupPhase = 'starting HTTP ingress';
  const { server, secureServer } = createHttpServer({ context });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(runtime.config.api.port, runtime.config.api.host, () => resolve());
  });
  if (secureServer) {
    await new Promise<void>((resolve, reject) => {
      secureServer.once('error', reject);
      secureServer.listen(
        runtime.config.api.https.port,
        runtime.config.api.host,
        () => resolve()
      );
    });
  }
  logger.info({
    caller: 'index::startup',
    loggerKey: 'SERVICE_BOOT_DIAGNOSTICS',
    message: `CryptoTracker HTTP ingress is listening on ${runtime.config.api.host}:${runtime.config.api.port}.`,
    context: {
      http: {
        host: runtime.config.api.host,
        port: runtime.config.api.port
      },
      https: {
        enabled: runtime.config.api.https.enabled,
        port: runtime.config.api.https.enabled ? runtime.config.api.https.port : null
      }
    }
  });
  startupPhase = 'initializing Kraken integration';
  await kraken.initialize().catch((error) => {
    logger.error({
      caller: 'index::krakenInitialize',
      message: 'Kraken integration started in degraded mode.',
      error
    });
  });
  startupPhase = 'starting persistent jobs and scheduler';
  await jobs.start();
  scheduler.start();
  logger.info({
    caller: 'index::startup',
    loggerKey: 'SERVICE_BOOT_DIAGNOSTICS',
    message: 'CryptoTracker startup completed; jobs and scheduler are active.',
    context: {
      version: buildInfo.version,
      buildHash: buildInfo.buildHash,
      databaseKind: runtime.databaseKind,
      redisEnabled: graphCache.enabled,
      krakenPrivateApiConfigured: krakenClient.isConfigured(),
      pollMinutes: runtime.config.sync.pollMinutes,
      maxConcurrentJobs: runtime.config.sync.maxConcurrentJobs
    }
  });
  const maintenance = setInterval(() => void auth.purgeExpiredSessions(), 15 * 60_000);
  maintenance.unref();

  let shuttingDown = false;
  const shutdown = async ({ signal }: { signal: NodeJS.Signals }) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({
      caller: 'index::shutdown',
      loggerKey: 'SERVICE_SHUTDOWN_STARTED',
      message: `Graceful shutdown started after ${signal}.`
    });
    scheduler.stop();
    await jobs.stop();
    clearInterval(maintenance);
    await Promise.all([
      new Promise<void>((resolve) => server.close(() => resolve())),
      ...(secureServer ? [
        new Promise<void>((resolve) => secureServer.close(() => resolve()))
      ] : [])
    ]);
    await graphCache.close();
    await db.close();
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdown({ signal })
        .then(() => process.exit(0))
        .catch((error) => {
          logger.error({
            caller: 'index::shutdown',
            message: 'Graceful shutdown failed.',
            error
          });
          process.exit(1);
        });
    });
  }
};

void main().catch((error) => {
  console.error(JSON.stringify(startupFailureEntry({ error, phase: startupPhase })));
  process.exit(1);
});
