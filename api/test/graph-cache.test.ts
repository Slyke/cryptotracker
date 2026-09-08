import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/logging/logger.js';
import { GraphCacheService, type GraphCachePlan } from '../src/services/graph-cache.js';
import { createTestRuntime } from './helpers.js';

const plan: GraphCachePlan = {
  id: 'market:test',
  revision: 'revision-1',
  scope: 'market',
  input: {
    assetIds: ['bitcoin'],
    quoteCurrency: 'USD',
    fromMs: 1,
    toMs: 2
  },
  sliding: false
};

const createLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}) as unknown as Logger;

const setClient = ({
  service,
  client
}: {
  service: GraphCacheService;
  client: Record<string, unknown>;
}) => {
  (service as unknown as { client: Record<string, unknown> }).client = client;
};

const createService = async () => {
  const runtime = await createTestRuntime({
    config: {
      cache: {
        redis: {
          enabled: true
        }
      }
    }
  });
  const logger = createLogger();
  const service = new GraphCacheService(runtime, logger, vi.fn());
  return { logger, service };
};

describe('dashboard graph cache request logging', () => {
  it('does not log a miss when Redis returns a cached result', async () => {
    const { logger, service } = await createService();
    const body = JSON.stringify({ ok: true, data: [{ time: 1, value: 2 }] });
    const client = {
      isReady: true,
      hGet: vi.fn().mockResolvedValue(JSON.stringify(plan)),
      get: vi.fn().mockResolvedValue(body),
      hSet: vi.fn().mockResolvedValue(1)
    };
    setClient({ service, client });
    const load = vi.fn();

    expect(await service.getOrLoad({ plan, load })).toBe(body);
    expect(load).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('logs one structured miss when the plan is not registered', async () => {
    const { logger, service } = await createService();
    const client = {
      isReady: true,
      hGet: vi.fn().mockResolvedValue(null)
    };
    setClient({ service, client });
    const load = vi.fn().mockResolvedValue([{ time: 1, value: 2 }]);

    await service.getOrLoad({ plan, load });

    expect(load).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith({
      caller: 'graphCache::getOrLoad',
      loggerKey: 'GRAPH_CACHE_MISS',
      message: 'Redis dashboard graph cache miss: plan_not_registered.',
      context: {
        cacheOutcome: 'miss',
        reason: 'plan_not_registered',
        resolution: 'postgresql_fallback',
        planId: plan.id,
        scope: plan.scope
      }
    });
  });

  it('logs one miss when the request materializes an absent result', async () => {
    const { logger, service } = await createService();
    const client = {
      isReady: true,
      hGet: vi.fn().mockResolvedValue(JSON.stringify(plan)),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      setEx: vi.fn().mockResolvedValue('OK'),
      hSet: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(true),
      eval: vi.fn().mockResolvedValue(1)
    };
    setClient({ service, client });
    const load = vi.fn().mockResolvedValue([{ time: 1, value: 2 }]);

    await service.getOrLoad({ plan, load });

    expect(load).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      loggerKey: 'GRAPH_CACHE_MISS',
      message: 'Redis dashboard graph cache miss: result_not_found.',
      context: expect.objectContaining({
        reason: 'result_not_found',
        resolution: 'materialize_or_await'
      })
    }));
  });

  it('logs a Redis error as one miss before using PostgreSQL', async () => {
    const { logger, service } = await createService();
    const client = {
      isReady: true,
      hGet: vi.fn().mockRejectedValue(new Error('lookup failed'))
    };
    setClient({ service, client });
    const load = vi.fn().mockResolvedValue([{ time: 1, value: 2 }]);

    await service.getOrLoad({ plan, load });

    expect(load).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      loggerKey: 'GRAPH_CACHE_MISS',
      message: 'Redis dashboard graph cache miss: redis_error.',
      context: expect.objectContaining({
        reason: 'redis_error',
        resolution: 'postgresql_fallback'
      })
    }));
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
