import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createSecureServer, type Server as HttpsServer } from 'node:https';
import { pipeline } from 'node:stream/promises';
import cookieParser from 'cookie-parser';
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from 'express';
import httpProxy from 'http-proxy';
import { z } from 'zod';
import type { AuthService, AuthenticatedIdentity } from '../auth/service.js';
import type { BuildInfo } from '../build-info.js';
import type { LoadedRuntime } from '../config/load.js';
import type { AppDatabase } from '../db/index.js';
import { AppError, asAppError, errorResponse } from '../errors.js';
import type { JobQueue } from '../jobs/queue.js';
import type { Logger } from '../logging/logger.js';
import type { Scheduler } from '../scheduler.js';
import type { AddressService } from '../services/addresses.js';
import type { DiagnosticsService } from '../services/diagnostics.js';
import {
  serializeSeriesCsv,
  serializeSeriesJson,
  type ApplicationExportService,
  type ExportableSeries
} from '../services/exports.js';
import type { KrakenService } from '../services/kraken.js';
import type { MarketService } from '../services/market.js';
import type { PortfolioService } from '../services/portfolio.js';
import type { RetentionService } from '../services/retention.js';
import type { SettingsService, UserSettings } from '../services/settings.js';
import type { TransferService } from '../services/transfers.js';
import { loadHttpsCertificates } from './certificates.js';

export interface AppContext {
  runtime: LoadedRuntime;
  buildInfo: BuildInfo;
  db: AppDatabase;
  logger: Logger;
  auth: AuthService;
  settings: SettingsService;
  market: MarketService;
  portfolio: PortfolioService;
  addresses: AddressService;
  kraken: KrakenService;
  transfers: TransferService;
  diagnostics: DiagnosticsService;
  exports: ApplicationExportService;
  retention: RetentionService;
  jobs: JobQueue;
  scheduler: Scheduler;
}

const asyncRoute = (handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler => (
  (req, res, next) => void handler(req, res, next).catch(next)
);

const parse = <T>({
  schema,
  value
}: {
  schema: z.ZodType<T>;
  value: unknown;
}): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError({
      errorKey: 'INPUT_INVALID',
      reason: 'Request input failed validation.',
      status: 400,
      context: result.error.flatten()
    });
  }
  return result.data;
};

const validateSavedGraphNames = ({
  current,
  next
}: {
  current: UserSettings['savedGraphs'];
  next: UserSettings['savedGraphs'];
}) => {
  const normalize = (name: string) => name.trim().toLocaleLowerCase();
  const currentById = new Map(current.map((graph) => [graph.id, normalize(graph.name)]));
  const firstByName = new Map<string, { id: string; index: number }>();
  next.forEach((graph, index) => {
    const normalized = normalize(graph.name);
    const existing = firstByName.get(normalized);
    if (!existing) {
      firstByName.set(normalized, { id: graph.id, index });
      return;
    }
    const duplicateAlreadyExisted = currentById.get(existing.id) === normalized
      && currentById.get(graph.id) === normalized;
    if (duplicateAlreadyExisted) return;
    throw new AppError({
      errorKey: 'INPUT_INVALID',
      reason: 'Request input failed validation.',
      status: 400,
      context: {
        fieldErrors: {
          savedGraphs: [
            `Dashboard item ${index + 1} duplicates the name of item ${existing.index + 1}.`
          ]
        }
      }
    });
  });
};

const identity = ({ req }: { req: Request }) => {
  if (!req.identity) {
    throw new AppError({
      errorKey: 'AUTH_REQUIRED',
      reason: 'Authentication is required.',
      status: 401
    });
  }
  return req.identity;
};

const auditMutation = async ({
  context,
  req,
  action,
  targetType,
  targetIdentifier,
  details = {}
}: {
  context: AppContext;
  req: Request;
  action: string;
  targetType: string;
  targetIdentifier: string | null;
  details?: unknown;
}) => {
  const current = identity({ req });
  await context.auth.audit({
    username: current.username,
    authMethod: current.authMethod,
    sourceIp: req.socket.remoteAddress ?? null,
    action,
    targetType,
    targetIdentifier,
    result: 'success',
    correlationId: req.correlationId,
    details
  });
};

const authenticate: ({ context }: { context: AppContext }) => RequestHandler = ({ context }) => asyncRoute(async (req, _res, next) => {
  req.identity = await context.auth.authenticate({
    req,
    correlationId: req.correlationId
  });
  if (!req.identity) {
    throw new AppError({
      errorKey: 'AUTH_REQUIRED',
      reason: 'Authentication is required.',
      status: 401
    });
  }
  next();
});

const csrf: ({ context }: { context: AppContext }) => RequestHandler = ({ context }) => (
  (req, _res, next) => {
    try {
      context.auth.assertCsrf({
        req,
        identity: identity({ req })
      });
      next();
    } catch (error) {
      next(error);
    }
  }
);

const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
};

const healthPayload = ({ context, ok = true }: { context: AppContext; ok?: boolean }) => ({
  ok,
  version: context.buildInfo.version,
  buildHash: context.buildInfo.buildHash
});

const checkWui = async ({ context }: { context: AppContext }) => {
  try {
    const url = new URL(context.runtime.config.wui.healthPath, context.runtime.config.wui.upstreamBaseUrl);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(context.runtime.config.wui.timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
};

const makeSeriesRequest = ({
  req
}: {
  req: Request;
}) => {
  const query = parse({
    schema: z.object({
      assetIds: z.string().min(1),
      quoteCurrency: z.string().length(3).default('CAD'),
      source: z.enum(['combined', 'coingecko', 'coinbase', 'kraken']).default('combined'),
      from: z.coerce.number().int().nonnegative(),
      to: z.coerce.number().int().positive(),
      granularity: z.union([z.literal('auto'), z.coerce.number().int().positive()]).default('auto'),
      chartMode: z.enum(['line', 'candlestick']).default('line')
    }),
    value: req.query
  });
  if (query.from >= query.to) {
    throw new AppError({
      errorKey: 'INPUT_INVALID',
      reason: 'Range start must be earlier than range end.',
      status: 400
    });
  }
  return {
    assetIds: query.assetIds.split(',').map((asset) => asset.trim()).filter(Boolean),
    quoteCurrency: query.quoteCurrency.toUpperCase(),
    source: query.source,
    fromMs: query.from,
    toMs: query.to,
    granularity: query.granularity,
    chartMode: query.chartMode
  };
};

const registerRoutes = ({
  app,
  context
}: {
  app: express.Express;
  context: AppContext;
}) => {
  app.get(['/health', '/healthz'], (_req, res) => res.json(healthPayload({ context })));
  app.get('/readyz', asyncRoute(async (_req, res) => {
    const [database, wui] = await Promise.all([
      context.db.ping(),
      checkWui({ context })
    ]);
    const ok = database && wui;
    res.status(ok ? 200 : 503).json({
      ...healthPayload({ context, ok }),
      checks: {
        database,
        migrations: database,
        configuration: true,
        wui
      }
    });
  }));
  app.get('/auth/methods', (_req, res) => res.json({
    ok: true,
    methods: context.auth.getMethods()
  }));
  app.post('/auth/local/login', asyncRoute(async (req, res) => {
    const origin = req.get('origin');
    if (!origin || origin !== new URL(context.runtime.config.publicBaseUrl).origin) {
      throw new AppError({
        errorKey: 'AUTH_ORIGIN_INVALID',
        reason: 'Login origin does not match the configured public origin.',
        status: 403
      });
    }
    const input = parse({
      schema: z.object({
        username: z.string().min(1).max(200),
        password: z.string().min(1).max(1_024)
      }),
      value: req.body
    });
    const result = await context.auth.login({
      ...input,
      req,
      res,
      correlationId: req.correlationId
    });
    res.json({ ok: true, ...result });
  }));

  const requireAuth = authenticate({ context });
  const requireCsrf = csrf({ context });
  app.post('/auth/logout', requireAuth, requireCsrf, asyncRoute(async (req, res) => {
    await context.auth.logout({
      identity: identity({ req }),
      req,
      res,
      correlationId: req.correlationId
    });
    res.json({ ok: true });
  }));
  app.all('/mcp', (_req, res) => {
    res.status(404).json({
      ok: false,
      error: {
        code: 'MCP_SIDECAR_REQUIRED',
        message: 'MCP is served by the separately configured cryptotracker-mcp sidecar.',
        details: {
          documentation: 'See mcp/README.md.'
        }
      }
    });
  });

  app.use('/api', requireAuth);
  app.get('/api/me', (req, res) => {
    const current = identity({ req });
    res.json({
      ok: true,
      user: {
        username: current.username,
        groups: current.groups,
        authMethod: current.authMethod
      },
      csrfToken: current.csrfToken,
      build: context.buildInfo,
      runtime: context.settings.getPublicRuntime()
    });
  });
  app.get('/api/settings', asyncRoute(async (_req, res) => {
    res.json({ ok: true, settings: await context.settings.get() });
  }));
  app.patch('/api/settings', requireCsrf, asyncRoute(async (req, res) => {
    const changes = parse({
      schema: z.object({
        locale: z.string().min(2).optional(),
        timezone: z.string().min(1).optional(),
        theme: z.enum(['dark', 'light']).optional(),
        font: z.string().min(1).optional(),
        contentWidth: z.enum(['min', '1080', 'standard', '1440', '1920', 'full']).optional(),
        primaryCurrency: z.string().length(3).transform((value) => value.toUpperCase()).optional(),
        tooltipCurrencies: z.array(z.string().length(3).transform((value) => value.toUpperCase())).min(1).max(5).optional(),
        marketSource: z.enum(['combined', 'coingecko', 'coinbase', 'kraken']).optional(),
        providerDisagreementThresholdPercent: z.number().min(0).max(1_000).optional(),
        costBasisMethod: z.enum(['acb', 'fifo', 'lifo']).optional(),
        graphDefaults: z.record(z.string(), z.unknown()).optional(),
        pageLayouts: z.record(z.string(), z.array(z.string().min(1)).max(50)).optional(),
        collapsedBlocks: z.record(z.string(), z.array(z.string().min(1)).max(50)).optional(),
        accordionStates: z.record(z.string(), z.boolean()).optional(),
        tableColumns: z.record(z.string(), z.array(z.string().min(1)).max(100)).optional(),
        tableRows: z.record(z.string(), z.array(z.string().min(1)).max(500)).optional(),
        savedGraphs: z.array(z.object({
          id: z.string().min(1).max(200),
          name: z.string().trim().min(1).max(120),
          type: z.enum(['market', 'kraken', 'addresses', 'portfolio']),
          hidden: z.boolean(),
          config: z.record(z.string(), z.unknown())
        })).max(200).optional(),
        savedCalculations: z.array(z.object({
          id: z.string().min(1).max(200),
          name: z.string().trim().min(1).max(120),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          currency: z.string().length(3).transform((value) => value.toUpperCase()),
          principal: z.number().finite().min(0).max(1e15),
          ratePercent: z.number().finite().min(-99.99).max(10_000),
          rateKind: z.enum(['apy', 'apr']),
          periodsPerYear: z.union([
            z.literal(1),
            z.literal(12),
            z.literal(52),
            z.literal(365)
          ]),
          durationValue: z.number().finite().positive().max(200),
          durationUnit: z.enum(['days', 'months', 'years']),
          contributionPerPeriod: z.number().finite().min(0).max(1e15),
          targetAmount: z.number().finite().positive().max(1e18).nullable()
        }).strict()).max(100).superRefine((calculations, refinement) => {
          const names = new Set<string>();
          calculations.forEach((calculation, index) => {
            const normalized = calculation.name.toLocaleLowerCase();
            if (names.has(normalized)) {
              refinement.addIssue({
                code: 'custom',
                path: [index, 'name'],
                message: 'Saved calculation names must be unique.'
              });
            }
            names.add(normalized);
          });
        }).optional(),
        dashboardRows: z.array(z.object({
          id: z.string().min(1).max(200),
          name: z.string().min(1).max(120),
          columns: z.number().int().min(1).max(4).transform((value) => value as 1 | 2 | 3 | 4),
          itemIds: z.array(z.string().min(1).max(200)).max(200)
        })).max(100).optional(),
        dashboardGraphColumns: z.number().int().min(1).max(4)
          .transform((value) => value as 1 | 2 | 3 | 4)
          .optional(),
        dismissedNotices: z.array(z.string().min(1).max(200)).max(200).optional(),
        retentionDays: z.number().int().min(1).max(36_500).nullable().optional(),
        marketHistoryBackfillDays: z.number().int().min(1).max(36_500).nullable().optional(),
        failedJobRetentionHours: z.number().int().min(1).max(87_600).nullable().optional(),
        pollingIntervalsMinutes: z.object({
          marketCoinGecko: z.number().int().min(5).max(10_080),
          marketCoinbase: z.number().int().min(5).max(10_080),
          marketKraken: z.number().int().min(5).max(10_080),
          assetCatalog: z.number().int().min(5).max(10_080),
          addresses: z.number().int().min(5).max(10_080),
          krakenAccount: z.number().int().min(5).max(10_080)
        }).strict().optional()
      }).strict(),
      value: req.body
    }) as Partial<UserSettings>;
    if (changes.savedGraphs) {
      validateSavedGraphNames({
        current: (await context.settings.get()).savedGraphs,
        next: changes.savedGraphs
      });
    }
    const settings = await context.settings.patch({ changes });
    const retention = Object.hasOwn(changes, 'retentionDays')
      ? await context.retention.apply({ retentionDays: settings.retentionDays })
      : null;
    const failedJobRetention = Object.hasOwn(changes, 'failedJobRetentionHours')
      ? await context.retention.applyFailedJobs({
          retentionHours: settings.failedJobRetentionHours
        })
      : null;
    await auditMutation({
      context,
      req,
      action: 'settings.update',
      targetType: 'settings',
      targetIdentifier: null,
      details: { fields: Object.keys(changes), retention, failedJobRetention }
    });
    res.json({ ok: true, settings, retention, failedJobRetention });
  }));
  app.get('/api/providers/status', asyncRoute(async (_req, res) => {
    res.json({ ok: true, providers: await context.diagnostics.providers() });
  }));
  app.get('/api/sync/progress', asyncRoute(async (req, res) => {
    const query = parse({
      schema: z.object({
        failedQuery: z.string().max(200).default(''),
        failedType: z.string().max(100).default(''),
        failedPage: z.coerce.number().int().positive().default(1),
        failedPageSize: z.coerce.number().int().refine(
          (value) => [10, 20, 50, 100].includes(value),
          'Page size must be 10, 20, 50, or 100.'
        ).default(10)
      }),
      value: req.query
    });
    res.json({
      ok: true,
      progress: await context.diagnostics.syncProgress(query)
    });
  }));
  app.get('/api/diagnostics/storage', asyncRoute(async (_req, res) => {
    res.json({ ok: true, storage: await context.diagnostics.storage() });
  }));
  app.get('/api/jobs', asyncRoute(async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).catch(100).parse(req.query.limit);
    res.json({ ok: true, jobs: await context.jobs.list({ limit }) });
  }));
  app.get('/api/jobs/:id', asyncRoute(async (req, res) => {
    const job = await context.jobs.getJob({ id: String(req.params.id) });
    if (!job) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: 'Job was not found.',
        status: 404
      });
    }
    res.json({ ok: true, job });
  }));

  app.get('/api/catalog/assets', asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      assets: await context.market.listCatalog({
        query: typeof req.query.q === 'string' ? req.query.q : '',
        limit: z.coerce.number().int().min(1).max(500).catch(100).parse(req.query.limit)
      })
    });
  }));
  app.post('/api/catalog/refresh', requireCsrf, asyncRoute(async (req, res) => {
    const result = await context.market.queueCatalogRefresh();
    await auditMutation({
      context,
      req,
      action: 'catalog.refresh',
      targetType: 'catalog',
      targetIdentifier: 'coingecko:top100'
    });
    res.status(202).json({ ok: true, ...result });
  }));
  app.get('/api/watchlist/assets', asyncRoute(async (_req, res) => {
    res.json({ ok: true, assets: await context.market.listWatchlist() });
  }));
  app.post('/api/watchlist/assets', requireCsrf, asyncRoute(async (req, res) => {
    const input = parse({
      schema: z.object({ canonicalId: z.string().min(1) }),
      value: req.body
    });
    const asset = await context.market.addAsset(input);
    await auditMutation({
      context,
      req,
      action: 'watchlist.asset.add',
      targetType: 'asset',
      targetIdentifier: asset.canonicalId
    });
    res.status(201).json({ ok: true, asset });
  }));
  app.post('/api/watchlist/assets/bulk', requireCsrf, asyncRoute(async (req, res) => {
    const input = parse({
      schema: z.object({
        limit: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100)])
      }),
      value: req.body
    });
    const result = await context.market.addTopAssets(input);
    await auditMutation({
      context,
      req,
      action: 'watchlist.asset.bulk_add',
      targetType: 'asset-catalog',
      targetIdentifier: `top-${input.limit}`,
      details: {
        requested: input.limit,
        addedOrEnabled: result.addedOrEnabled
      }
    });
    res.status(201).json({ ok: true, ...result });
  }));
  app.patch('/api/watchlist/assets/:id', requireCsrf, asyncRoute(async (req, res) => {
    const input = parse({
      schema: z.object({ enabled: z.boolean() }),
      value: req.body
    });
    const asset = await context.market.patchAsset({
      id: String(req.params.id),
      enabled: input.enabled
    });
    await auditMutation({
      context,
      req,
      action: 'watchlist.asset.update',
      targetType: 'asset',
      targetIdentifier: asset.canonicalId,
      details: input
    });
    res.json({ ok: true, asset });
  }));
  app.delete('/api/watchlist/assets/:id', requireCsrf, asyncRoute(async (req, res) => {
    await context.market.removeAsset({ id: String(req.params.id) });
    await auditMutation({
      context,
      req,
      action: 'watchlist.asset.remove',
      targetType: 'asset',
      targetIdentifier: String(req.params.id)
    });
    res.status(204).end();
  }));
  app.get('/api/watchlist/currencies', asyncRoute(async (_req, res) => {
    const settings = await context.settings.get();
    res.json({
      ok: true,
      primaryCurrency: settings.primaryCurrency,
      tooltipCurrencies: settings.tooltipCurrencies
    });
  }));
  app.put('/api/watchlist/currencies', requireCsrf, asyncRoute(async (req, res) => {
    const input = parse({
      schema: z.object({
        primaryCurrency: z.string().length(3).transform((value) => value.toUpperCase()),
        tooltipCurrencies: z.array(z.string().length(3).transform((value) => value.toUpperCase())).min(1).max(5)
      }),
      value: req.body
    });
    const settings = await context.settings.patch({ changes: input });
    res.json({ ok: true, settings });
  }));
  app.get('/api/market/series', asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      data: await context.market.getSeries(makeSeriesRequest({ req }))
    });
  }));
  app.get('/api/market/metrics', asyncRoute(async (req, res) => {
    const query = parse({
      schema: z.object({
        assetIds: z.string(),
        quoteCurrencies: z.string().default('CAD')
      }),
      value: req.query
    });
    const assetIds = [...new Set(query.assetIds.split(',').map((value) => value.trim()).filter(Boolean))].slice(0, 100);
    const quoteCurrencies = [...new Set(
      query.quoteCurrencies.split(',').map((value) => value.trim().toUpperCase()).filter((value) => value.length === 3)
    )].slice(0, 6);
    res.json({
      ok: true,
      metrics: await context.market.assetMetrics({
        assetIds,
        quoteCurrencies: quoteCurrencies.length > 0 ? quoteCurrencies : ['CAD']
      })
    });
  }));
  app.get('/api/portfolio/series', asyncRoute(async (req, res) => {
    const query = parse({
      schema: z.object({
        from: z.coerce.number().int().nonnegative(),
        to: z.coerce.number().int().positive(),
        quoteCurrencies: z.string().optional(),
        granularitySeconds: z.union([
          z.literal('auto'),
          z.coerce.number().int().positive()
        ]).default('auto')
      }),
      value: req.query
    });
    if (query.from >= query.to && query.from !== 0) {
      throw new AppError({
        errorKey: 'INPUT_INVALID',
        reason: 'Range start must be earlier than range end.',
        status: 400
      });
    }
    res.json({
      ok: true,
      data: await context.portfolio.series({
        fromMs: query.from,
        toMs: query.to,
        granularitySeconds: query.granularitySeconds,
        ...(query.quoteCurrencies ? {
          quoteCurrencies: query.quoteCurrencies.split(',')
            .map((currency) => currency.trim().toUpperCase())
            .filter((currency) => /^[A-Z]{3}$/.test(currency))
            .slice(0, 6)
        } : {})
      })
    });
  }));
  const marketJob = async (req: Request, res: Response, repair: boolean) => {
    const input = parse({
      schema: z.object({
        provider: z.enum(['coingecko', 'coinbase', 'kraken']),
        canonicalAssetId: z.string().min(1),
        quoteCurrency: z.string().length(3),
        fromMs: z.number().int().nonnegative(),
        toMs: z.number().int().positive(),
        granularitySeconds: z.number().int().positive()
      }),
      value: req.body
    });
    const result = await context.market.queueBackfill({ ...input, repair });
    await auditMutation({
      context,
      req,
      action: repair ? 'market.repair' : 'market.backfill',
      targetType: 'asset',
      targetIdentifier: input.canonicalAssetId,
      details: {
        provider: input.provider,
        fromMs: input.fromMs,
        toMs: input.toMs
      }
    });
    res.status(202).json({ ok: true, ...result });
  };
  app.post('/api/market/backfill', requireCsrf, asyncRoute(async (req, res) => marketJob(req, res, false)));
  app.post('/api/market/repair', requireCsrf, asyncRoute(async (req, res) => marketJob(req, res, true)));

  app.get('/api/addresses', asyncRoute(async (_req, res) => {
    res.json({ ok: true, addresses: await context.addresses.list() });
  }));
  app.get('/api/addresses/networks', asyncRoute(async (_req, res) => {
    res.json({ ok: true, ...(await context.addresses.networkOptions()) });
  }));
  app.post('/api/addresses', requireCsrf, asyncRoute(async (req, res) => {
    const input = parse({
      schema: z.object({
        network: z.enum(['bitcoin', 'dogecoin', 'ethereum', 'polkadot', 'solana']),
        address: z.string().min(1).max(200),
        label: z.string().min(1).max(200),
        enabled: z.boolean().default(true),
        assets: z.array(z.object({
          canonicalAssetId: z.string().min(1),
          contractOrMint: z.string().nullable()
        })).default([])
      }),
      value: req.body
    });
    const address = await context.addresses.add(input);
    await auditMutation({
      context,
      req,
      action: 'address.add',
      targetType: 'address',
      targetIdentifier: address.id,
      details: {
        network: input.network,
        label: input.label
      }
    });
    res.status(201).json({ ok: true, address });
  }));
  app.patch('/api/addresses/:id', requireCsrf, asyncRoute(async (req, res) => {
    const input = parse({
      schema: z.object({
        label: z.string().min(1).max(200).optional(),
        enabled: z.boolean().optional()
      }).refine((value) => Object.keys(value).length > 0),
      value: req.body
    });
    const address = await context.addresses.patch({
      id: String(req.params.id),
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled })
    });
    await auditMutation({
      context,
      req,
      action: 'address.update',
      targetType: 'address',
      targetIdentifier: address.id,
      details: input
    });
    res.json({ ok: true, address });
  }));
  app.delete('/api/addresses/:id', requireCsrf, asyncRoute(async (req, res) => {
    await context.addresses.delete({ id: String(req.params.id) });
    await auditMutation({
      context,
      req,
      action: 'address.delete',
      targetType: 'address',
      targetIdentifier: String(req.params.id)
    });
    res.status(204).end();
  }));
  app.put('/api/addresses/:id/assets', requireCsrf, asyncRoute(async (req, res) => {
    const input = parse({
      schema: z.object({
        assets: z.array(z.object({
          canonicalAssetId: z.string().min(1),
          contractOrMint: z.string().nullable()
        }))
      }),
      value: req.body
    });
    const result = await context.addresses.replaceAssets({
      id: String(req.params.id),
      assets: input.assets
    });
    await auditMutation({
      context,
      req,
      action: 'address.assets.update',
      targetType: 'address',
      targetIdentifier: String(req.params.id),
      details: {
        assetCount: result.assets.length
      }
    });
    res.json({ ok: true, ...result });
  }));
  app.post('/api/addresses/:id/refresh', requireCsrf, asyncRoute(async (req, res) => {
    const result = await context.addresses.queueRefresh({
      id: String(req.params.id),
      priority: 10,
      reason: 'manual'
    });
    await auditMutation({
      context,
      req,
      action: 'address.refresh',
      targetType: 'address',
      targetIdentifier: String(req.params.id)
    });
    res.status(202).json({ ok: true, ...result });
  }));
  app.get('/api/addresses/holdings', asyncRoute(async (req, res) => {
    const query = parse({
      schema: z.object({
        quoteCurrency: z.string().length(3).default('CAD'),
        quoteCurrencies: z.string().optional()
      }),
      value: req.query
    });
    res.json({
      ok: true,
      holdings: await context.addresses.holdings({
        quoteCurrency: query.quoteCurrency.toUpperCase(),
        ...(query.quoteCurrencies === undefined
          ? {}
          : {
              quoteCurrencies: query.quoteCurrencies
                .split(',')
                .map((currency) => currency.trim().toUpperCase())
                .filter((currency) => /^[A-Z]{3}$/.test(currency))
                .slice(0, 6)
            })
      })
    });
  }));
  app.get('/api/addresses/series', asyncRoute(async (req, res) => {
    const query = parse({
      schema: z.object({
        quoteCurrency: z.string().length(3).default('CAD'),
        quoteCurrencies: z.string().optional(),
        from: z.coerce.number().int().nonnegative(),
        to: z.coerce.number().int().positive(),
        granularitySeconds: z.union([
          z.literal('auto'),
          z.coerce.number().int().positive()
        ]).default('auto')
      }),
      value: req.query
    });
    res.json({
      ok: true,
      data: await context.addresses.series({
        quoteCurrency: query.quoteCurrency.toUpperCase(),
        ...(query.quoteCurrencies === undefined
          ? {}
          : {
              quoteCurrencies: query.quoteCurrencies
                .split(',')
                .map((currency) => currency.trim().toUpperCase())
                .filter((currency) => /^[A-Z]{3}$/.test(currency))
                .slice(0, 6)
            }),
        fromMs: query.from,
        toMs: query.to,
        granularitySeconds: query.granularitySeconds
      })
    });
  }));

  app.get('/api/kraken/status', asyncRoute(async (_req, res) => {
    res.json({ ok: true, status: await context.kraken.status() });
  }));
  app.post('/api/kraken/refresh', requireCsrf, asyncRoute(async (req, res) => {
    const result = await context.kraken.queueRefresh();
    await auditMutation({
      context,
      req,
      action: 'kraken.refresh',
      targetType: 'kraken',
      targetIdentifier: 'account'
    });
    res.status(202).json({ ok: true, ...result });
  }));
  app.get('/api/kraken/summary', asyncRoute(async (req, res) => {
    const quoteCurrencies = z.string().optional().parse(req.query.quoteCurrencies);
    res.json({
      ok: true,
      summary: await context.kraken.summary({
        ...(quoteCurrencies ? {
          quoteCurrencies: quoteCurrencies.split(',')
            .map((currency) => currency.trim().toUpperCase())
            .filter((currency) => /^[A-Z]{3}$/.test(currency))
            .slice(0, 6)
        } : {})
      })
    });
  }));
  app.get('/api/kraken/holdings', asyncRoute(async (_req, res) => {
    res.json({ ok: true, holdings: await context.kraken.holdings() });
  }));
  app.get('/api/kraken/earn', asyncRoute(async (_req, res) => {
    res.json({ ok: true, allocations: await context.kraken.earnAllocations() });
  }));
  app.get('/api/kraken/earn/series', asyncRoute(async (req, res) => {
    const query = parse({
      schema: z.object({
        from: z.coerce.number().int().nonnegative(),
        to: z.coerce.number().int().positive(),
        granularitySeconds: z.coerce.number().int().min(60).default(86_400),
        quoteCurrencies: z.string().optional()
      }),
      value: req.query
    });
    res.json({
      ok: true,
      data: await context.kraken.earnOverview({
        fromMs: query.from,
        toMs: query.to,
        granularitySeconds: query.granularitySeconds,
        ...(query.quoteCurrencies ? {
          quoteCurrencies: query.quoteCurrencies.split(',')
            .map((currency) => currency.trim().toUpperCase())
            .filter((currency) => /^[A-Z]{3}$/.test(currency))
            .slice(0, 6)
        } : {})
      })
    });
  }));
  app.get('/api/kraken/activity', asyncRoute(async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).catch(200).parse(req.query.limit);
    res.json({ ok: true, activity: await context.kraken.activity({ limit }) });
  }));
  app.get('/api/kraken/pnl', asyncRoute(async (req, res) => {
    const method = z.enum(['acb', 'fifo', 'lifo']).catch('acb').parse(req.query.method);
    res.json({ ok: true, pnl: await context.kraken.pnl({ method }) });
  }));
  app.get('/api/kraken/series', asyncRoute(async (req, res) => {
    const query = parse({
      schema: z.object({
        from: z.coerce.number().int().nonnegative(),
        to: z.coerce.number().int().positive(),
        quoteCurrencies: z.string().optional(),
        granularitySeconds: z.union([
          z.literal('auto'),
          z.coerce.number().int().positive()
        ]).default('auto')
      }),
      value: req.query
    });
    res.json({
      ok: true,
      data: await context.kraken.series({
        fromMs: query.from,
        toMs: query.to,
        granularitySeconds: query.granularitySeconds,
        ...(query.quoteCurrencies ? {
          quoteCurrencies: query.quoteCurrencies.split(',')
            .map((currency) => currency.trim().toUpperCase())
            .filter((currency) => /^[A-Z]{3}$/.test(currency))
            .slice(0, 6)
        } : {})
      })
    });
  }));

  const getExportSeries = async (req: Request): Promise<ExportableSeries> => context.market.getSeries(makeSeriesRequest({ req })) as Promise<ExportableSeries>;
  app.get('/api/exports/series.csv', asyncRoute(async (req, res) => {
    const data = await getExportSeries(req);
    const settings = await context.settings.get();
    const csv = serializeSeriesCsv({
      data,
      timezone: settings.timezone
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="cryptotracker-series.csv"');
    res.send(csv);
  }));
  app.get('/api/exports/series.json', asyncRoute(async (req, res) => {
    const data = await getExportSeries(req);
    const settings = await context.settings.get();
    res.setHeader('Content-Disposition', 'attachment; filename="cryptotracker-series.json"');
    res.json(serializeSeriesJson({
      data,
      buildInfo: context.buildInfo,
      locale: settings.locale,
      timezone: settings.timezone,
      graphType: data.chartMode ?? 'line',
      filters: {
        assetIds: req.query.assetIds,
        tooltipCurrencies: settings.tooltipCurrencies
      }
    }));
  }));
  app.post('/api/exports/application', requireCsrf, asyncRoute(async (req, res) => {
    const result = await context.exports.create();
    await auditMutation({
      context,
      req,
      action: 'application.export.start',
      targetType: 'application_export',
      targetIdentifier: result.id
    });
    res.status(202).json({ ok: true, export: result });
  }));
  app.get('/api/exports/application/:id', asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      export: await context.exports.get({ id: String(req.params.id) })
    });
  }));
  app.get('/api/exports/application/:id/download', asyncRoute(async (req, res) => {
    const download = await context.exports.download({ id: String(req.params.id) });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${download.fileName}"`);
    res.setHeader('Content-Length', download.size);
    res.setHeader('X-Checksum-Sha256', download.checksumSha256 ?? '');
    await auditMutation({
      context,
      req,
      action: 'application.export.download',
      targetType: 'application_export',
      targetIdentifier: String(req.params.id)
    });
    await pipeline(download.stream, res);
  }));
  const receiveBackup = express.raw({
    type: ['application/zip', 'application/octet-stream'],
    limit: context.runtime.config.exports.restoreBodyLimit
  });
  const backupBytes = (req: Request) => {
    if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
      throw new AppError({
        errorKey: 'BACKUP_INVALID',
        reason: 'A non-empty ZIP backup must be uploaded.',
        status: 400
      });
    }
    return new Uint8Array(req.body);
  };
  app.post('/api/backups/inspect', requireCsrf, receiveBackup, asyncRoute(async (req, res) => {
    res.json({
      ok: true,
      backup: context.exports.inspect({
        archiveBytes: backupBytes(req)
      })
    });
  }));
  app.post('/api/backups/restore', requireCsrf, receiveBackup, asyncRoute(async (req, res) => {
    const query = parse({
      schema: z.object({
        domains: z.string().min(1),
        confirmation: z.literal('replace-selected-data')
      }),
      value: req.query
    });
    const domains = z.array(z.enum([
      'preferences',
      'markets',
      'addresses',
      'kraken',
      'portfolio',
      'calculations'
    ])).min(1).parse(query.domains.split(','));
    const result = await context.exports.restore({
      archiveBytes: backupBytes(req),
      domains
    });
    await auditMutation({
      context,
      req,
      action: 'application.backup.restore',
      targetType: 'backup',
      targetIdentifier: null,
      details: {
        domains: result.restoredDomains.map((domain) => domain.id),
        rowCount: result.restoredDomains.reduce((sum, domain) => sum + domain.rowCount, 0)
      }
    });
    res.json({ ok: true, restore: result });
  }));
};

const createWuiProxy = ({
  context
}: {
  context: AppContext;
}) => {
  const proxy = httpProxy.createProxyServer({
    target: context.runtime.config.wui.upstreamBaseUrl,
    ws: true,
    changeOrigin: false,
    xfwd: true,
    timeout: context.runtime.config.wui.timeoutMs,
    proxyTimeout: context.runtime.config.wui.timeoutMs
  });
  const hopByHop = [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
  ];
  proxy.on('proxyReq', (proxyReq, req) => {
    for (const header of hopByHop) proxyReq.removeHeader(header);
    const correlationId = (req as Request).correlationId;
    if (correlationId) proxyReq.setHeader('x-correlation-id', correlationId);
  });
  proxy.on('proxyRes', (proxyRes) => {
    for (const header of hopByHop) delete proxyRes.headers[header];
  });
  return proxy;
};

export const createHttpServer = ({
  context
}: {
  context: AppContext;
}): {
  app: express.Express;
  server: HttpServer;
  secureServer: HttpsServer | null;
} => {
  const app = express();
  if (context.runtime.config.api.trustProxy) app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use((req, res, next) => {
    const incoming = req.get('x-correlation-id');
    req.correlationId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)
      ? incoming
      : crypto.randomUUID();
    req.identity = null;
    res.setHeader('X-Correlation-Id', req.correlationId);
    next();
  });
  app.use(cookieParser());
  app.use(express.json({
    limit: context.runtime.config.api.bodyLimit,
    type: ['application/json', 'application/*+json']
  }));
  registerRoutes({ app, context });
  const proxy = createWuiProxy({ context });
  app.use((req, res) => {
    proxy.web(req, res, {}, (error) => {
      context.logger.error({
        caller: 'http::wuiProxy',
        message: 'WUI proxy request failed.',
        error,
        correlationId: req.correlationId
      });
      if (!res.headersSent) {
        const appError = new AppError({
          errorKey: 'WUI_UNAVAILABLE',
          reason: 'The internal WUI process is unavailable.',
          status: 502
        });
        res.status(502).json(errorResponse({
          error: appError,
          correlationId: req.correlationId
        }));
      } else {
        res.destroy();
      }
    });
  });
  const errorHandler: ErrorRequestHandler = (caught, req, res, _next) => {
    const error = asAppError({
      error: caught,
      errorKey: 'ERR_UNKNOWN',
      reason: 'Unexpected application error.'
    });
    context.logger.error({
      caller: 'http::errorHandler',
      message: error.message,
      error,
      correlationId: req.correlationId,
      username: req.identity?.username ?? null,
      context: error.context
    });
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(error.status).json(errorResponse({
      error,
      correlationId: req.correlationId
    }));
  };
  app.use(errorHandler);
  const httpsConfig = context.runtime.config.api.https;
  const server = createServer(app);
  const secureServer = httpsConfig.enabled
    ? createSecureServer(loadHttpsCertificates({
        certPath: httpsConfig.certPath,
        keyPath: httpsConfig.keyPath,
        generateSelfSigned: httpsConfig.generateSelfSigned
      }), (req, res) => {
        const pathname = new URL(req.url ?? '/', 'https://localhost').pathname;
        if (
          pathname.startsWith('/api/')
          || ['/health', '/healthz', '/readyz'].includes(pathname)
        ) {
          app(req, res);
          return;
        }
        const payload = JSON.stringify({
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: 'The API HTTPS listener exposes only API and health endpoints.',
            details: {}
          }
        });
        res.writeHead(404, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload)
        });
        res.end(payload);
      })
    : null;
  server.on('upgrade', (req, socket, head) => {
    const correlationId = String(req.headers['x-correlation-id'] ?? crypto.randomUUID());
    req.headers['x-correlation-id'] = correlationId;
    proxy.ws(req, socket, head);
  });
  return { app, server, secureServer };
};

export const httpInternals = {
  checkWui,
  makeSeriesRequest,
  parse
};
