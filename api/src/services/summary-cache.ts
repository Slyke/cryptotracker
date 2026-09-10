import { createHash, randomUUID } from 'node:crypto';
import type { LoadedRuntime } from '../config/load.js';
import type { GraphDataChange } from '../jobs/queue.js';
import type { Logger } from '../logging/logger.js';
import { withSlowOperationWarning } from '../logging/slow-operation.js';
import type { GraphCacheService } from './graph-cache.js';

export type SummaryScope = 'portfolio' | 'kraken';
export interface SummaryRequest {
  scope: SummaryScope;
  quoteCurrencies?: string[];
}
type RedisClient = NonNullable<Awaited<ReturnType<GraphCacheService['readyClient']>>>;
interface CacheEntry {
  data: unknown;
  generation: string;
  calculatedAtMs: number;
}
interface RegisteredRequest {
  request: SummaryRequest;
  epoch: string;
  requestedAtMs: number;
}

// Retain successful values while refreshing; TTL is storage retention, not freshness.
const freshForMs = 60_000;
const activeForMs = 10 * 60_000;
const lockForMs = 120_000;

export class SummaryCacheService {
  private readonly baseKey: string;
  private readonly fills = new Map<string, Promise<unknown>>();

  constructor(
    private readonly runtime: LoadedRuntime,
    private readonly logger: Logger,
    private readonly redis: () => Promise<RedisClient | null>,
    private readonly load: (request: SummaryRequest) => Promise<unknown>
  ) {
    // Include valuation defaults so changing deployment configuration cannot reuse
    // totals calculated with different pricing rules.
    const defaults = createHash('sha256').update(JSON.stringify(runtime.config.ui)).digest('hex');
    this.baseKey = `${runtime.config.cache.redis.keyPrefix}:dashboard-summaries:v1:${defaults}`;
  }

  private get ttl() { return this.runtime.config.cache.redis.resultTtlSeconds; }
  private key(suffix: string) { return `${this.baseKey}:${suffix}`; }
  private resultKey(request: SummaryRequest, epoch: string) {
    return this.key(`result:${createHash('sha256').update(JSON.stringify([request, epoch])).digest('hex')}`);
  }
  private async version(client: RedisClient, kind: string, scope: SummaryScope) {
    return await client.get(this.key(`${kind}:${scope}`)) ?? '';
  }
  private parse(raw: string | null): CacheEntry | null {
    if (raw === null) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry || !Object.hasOwn(entry, 'data') || typeof entry.generation !== 'string'
      || !Number.isFinite(entry.calculatedAtMs)) throw new Error('Invalid summary cache entry.');
    return entry;
  }
  private fresh(entry: CacheEntry, generation: string) {
    const age = Date.now() - entry.calculatedAtMs;
    return entry.generation === generation && age >= 0 && age < freshForMs;
  }
  private logMiss(request: SummaryRequest, reason: string) {
    if (!this.runtime.config.cache.redis.enabled) return;
    this.logger.info({
      caller: 'summaryCache::getOrLoad', loggerKey: 'SUMMARY_CACHE_MISS',
      message: `Redis dashboard summary cache miss: ${reason}.`,
      context: { scope: request.scope, quoteCurrencies: request.quoteCurrencies ?? null, reason }
    });
  }
  private logError(error: unknown, scope?: SummaryScope) {
    this.logger.error({
      caller: 'summaryCache::refresh', loggerKey: 'SUMMARY_CACHE_FAILED',
      message: 'Summary cache operation failed; existing results are retained and uncached reads remain available.',
      error, context: { scope }
    });
  }
  private async timed<T>(request: SummaryRequest, phase: 'request' | 'calculation', task: () => Promise<T>) {
    return withSlowOperationWarning({
      logger: this.logger,
      thresholdMs: this.runtime.config.logging.slowOperationThresholdMs,
      caller: 'summaryCache::getOrLoad',
      loggerKey: 'SUMMARY_CACHE_SLOW',
      label: `Dashboard summary ${phase}`,
      context: { scope: request.scope, quoteCurrencies: request.quoteCurrencies ?? null, phase },
      task
    });
  }

  async getOrLoad(input: SummaryRequest): Promise<unknown> {
    const request: SummaryRequest = {
      scope: input.scope,
      ...(input.quoteCurrencies === undefined ? {} : {
        quoteCurrencies: [...new Set(input.quoteCurrencies.map((currency) => currency.trim().toUpperCase()))].sort()
      })
    };
    return this.timed(request, 'request', async () => {
      let client: RedisClient | null;
      let key = this.resultKey(request, 'fallback');
      let entry: CacheEntry | null;
      let generation: string;
      try {
        client = await this.redis();
        if (!client) {
          this.logMiss(request, 'redis_unavailable');
          return this.fill(null, key, request);
        }
        const epoch = await this.version(client, 'epoch', request.scope);
        key = this.resultKey(request, epoch);
        const [raw, currentGeneration] = await Promise.all([
          client.get(key), this.version(client, 'generation', request.scope),
          client.hSet(this.key('requests'), key, JSON.stringify({ request, epoch, requestedAtMs: Date.now() })),
          client.expire(this.key('requests'), this.ttl),
          client.setEx(this.key('activity'), activeForMs / 1_000, '1')
        ]);
        try { entry = this.parse(raw); }
        catch {
          this.logMiss(request, 'invalid_result');
          return this.fill(client, key, request);
        }
        generation = currentGeneration;
      } catch (error) {
        this.logMiss(request, 'redis_error');
        this.logError(error, request.scope);
        return this.fill(null, key, request);
      }
      if (entry) {
        if (!this.fresh(entry, generation)) {
          void this.fill(client, key, request, true).catch((error) => this.logError(error, request.scope));
        }
        return entry.data;
      }
      this.logMiss(request, 'result_not_found');
      return this.fill(client, key, request);
    }).then((data) => {
      // Staleness is clock-dependent even when the calculated amounts are cached.
      if (request.scope !== 'kraken' || !data || typeof data !== 'object') return data;
      const snapshot = data as { latestSuccessfulSync?: string | null };
      return { ...data, stale: snapshot.latestSuccessfulSync
        ? Date.parse(snapshot.latestSuccessfulSync) < Date.now() - this.runtime.config.sync.staleAfterMinutes * 60_000
        : false };
    });
  }

  private fill(client: RedisClient | null, key: string, request: SummaryRequest, background = false): Promise<unknown> {
    const existing = this.fills.get(key);
    if (existing) return existing;
    const pending = this.runFill(client, key, request, background).finally(() => { this.fills.delete(key); });
    this.fills.set(key, pending);
    return pending;
  }

  private async runFill(client: RedisClient | null, key: string, request: SummaryRequest, background: boolean) {
    const lockKey = `${key}:lock`;
    const owner = randomUUID();
    let locked = false;
    let generation = '';
    try {
      if (client) {
        try {
          // Share fills across API replicas too. Warm requests never enter this wait.
          const deadline = Date.now() + lockForMs;
          while (!(locked = Boolean(await client.set(lockKey, owner, { NX: true, PX: lockForMs })))) {
            const shared = this.parse(await client.get(key));
            if (shared) return shared.data;
            if (Date.now() >= deadline) throw new Error('Summary cache fill lock wait exceeded 120 seconds.');
            await new Promise<void>((resolve) => { setTimeout(resolve, 200).unref(); });
          }
          generation = await this.version(client, 'generation', request.scope);
          const current = this.parse(await client.get(key));
          if (current && this.fresh(current, generation)) return current.data;
        } catch (error) {
          this.logError(error, request.scope);
          // Redis errors must not prevent the underlying summary calculation.
        }
      }
      const data = await (background
        ? this.timed(request, 'calculation', () => this.load(request))
        : this.load(request));
      if (client && locked) {
        try {
          // A fill which outlived its lock cannot overwrite a newer replica's result.
          await client.eval(
            'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("setex", KEYS[2], ARGV[2], ARGV[3]) else return 0 end',
            { keys: [lockKey, key], arguments: [owner, String(this.ttl), JSON.stringify({ data, generation, calculatedAtMs: Date.now() })] }
          );
        } catch (error) {
          // Do not repeat an expensive successful query merely because storage failed.
          this.logError(error, request.scope);
        }
      }
      return data;
    } finally {
      if (client && locked) {
        await client.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          { keys: [lockKey], arguments: [owner] }
        ).catch((error) => this.logError(error, request.scope));
      }
    }
  }

  async isActive() {
    const client = await this.redis();
    return client ? await client.get(this.key('activity')) !== null : false;
  }

  async refreshAffected(changes: GraphDataChange[]) {
    if (changes.length === 0) return;
    const scopes = new Set<SummaryScope>();
    for (const change of changes) {
      scopes.add('portfolio');
      if (change.domain === 'market' || change.domain === 'kraken') scopes.add('kraken');
    }
    const client = await this.redis();
    if (!client) return;
    await Promise.all([...scopes].map((scope) => (
      client.setEx(this.key(`generation:${scope}`), this.ttl, randomUUID())
    )));
    const registered = await client.hGetAll(this.key('requests'));
    for (const [key, raw] of Object.entries(registered)) {
      try {
        const saved = JSON.parse(raw) as RegisteredRequest;
        if (Date.now() - saved.requestedAtMs > activeForMs
          || saved.epoch !== await this.version(client, 'epoch', saved.request.scope)) {
          await client.hDel(this.key('requests'), key);
          continue;
        }
        if (!scopes.has(saved.request.scope)) continue;
        // A change during a fill stays marked dirty and gets a follow-up calculation.
        await this.fills.get(key)?.catch(() => undefined);
        await this.fill(client, key, saved.request, true);
      } catch (error) { this.logError(error); }
    }
  }

  // Configuration/address selection changes must not serve a total from the old
  // selection. Rotate keys, so even an older in-flight fill cannot resurrect it.
  async invalidate(scopes: SummaryScope[]) {
    try {
      const client = await this.redis();
      if (!client) return;
      await Promise.all(scopes.map((scope) => (
        client.setEx(this.key(`epoch:${scope}`), this.ttl, randomUUID())
      )));
    } catch (error) { this.logError(error); }
  }

  async close() { await Promise.allSettled(this.fills.values()); }
}
