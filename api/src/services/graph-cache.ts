import { randomUUID, createHash } from 'node:crypto';
import { createClient } from 'redis';
import type { LoadedRuntime } from '../config/load.js';
import type { GraphDataChange } from '../jobs/queue.js';
import type { Logger } from '../logging/logger.js';

export type GraphCacheScope = 'market' | 'portfolio' | 'addresses' | 'kraken' | 'kraken-earn';

export interface GraphCachePlan {
  id: string;
  revision: string;
  scope: GraphCacheScope;
  input: Record<string, unknown>;
  sliding: boolean;
}

type RedisClient = ReturnType<typeof createClient>;

const pause = (milliseconds: number) => new Promise<void>((resolve) => {
  const timeout = setTimeout(resolve, milliseconds);
  timeout.unref();
});

export class GraphCacheService {
  private client: RedisClient | null = null;
  private nextConnectionAttemptAt = 0;
  private readonly redisConfig;
  private readonly baseKey: string;

  constructor(
    private readonly runtime: LoadedRuntime,
    private readonly logger: Logger,
    private readonly loadPlan: (plan: GraphCachePlan) => Promise<unknown>
  ) {
    this.redisConfig = runtime.config.cache.redis;
    this.baseKey = `${this.redisConfig.keyPrefix}:dashboard-graphs:v1`;
  }

  get enabled() {
    return this.redisConfig.enabled;
  }

  private key(suffix: string) {
    return `${this.baseKey}:${suffix}`;
  }

  private resultKey(plan: Pick<GraphCachePlan, 'id' | 'revision'>) {
    const digest = createHash('sha256')
      .update(`${plan.id}\0${plan.revision}`)
      .digest('hex');
    return this.key(`result:${digest}`);
  }

  private lockKey(plan: Pick<GraphCachePlan, 'id' | 'revision'>) {
    const digest = createHash('sha256')
      .update(`${plan.id}\0${plan.revision}`)
      .digest('hex');
    return this.key(`lock:${digest}`);
  }

  async initialize() {
    if (!this.enabled || this.client?.isReady) return;
    if (Date.now() < this.nextConnectionAttemptAt) return;
    this.nextConnectionAttemptAt = Date.now() + 5_000;
    const client = createClient({
      url: this.redisConfig.url,
      ...(this.runtime.secrets.redisPassword
        ? { password: this.runtime.secrets.redisPassword }
        : {}),
      socket: {
        connectTimeout: this.redisConfig.connectTimeoutMs,
        reconnectStrategy: false
      }
    });
    client.on('error', (error) => {
      this.logger.error({
        caller: 'graphCache::redis',
        message: 'Optional Redis graph cache connection failed; PostgreSQL fallback remains active.',
        error
      });
    });
    try {
      await client.connect();
      this.client = client;
      this.logger.info({
        caller: 'graphCache::initialize',
        message: 'Optional Redis dashboard graph cache is ready.'
      });
    } catch (error) {
      await client.close().catch(() => undefined);
      this.logger.error({
        caller: 'graphCache::initialize',
        message: 'Optional Redis graph cache is unavailable; PostgreSQL fallback remains active.',
        error
      });
    }
  }

  private async readyClient() {
    if (!this.enabled) return null;
    if (!this.client?.isReady) await this.initialize();
    return this.client?.isReady ? this.client : null;
  }

  async close() {
    const client = this.client;
    this.client = null;
    if (client?.isOpen) await client.close().catch(() => undefined);
  }

  private normalizePlan(plan: GraphCachePlan): GraphCachePlan {
    if (!plan.sliding) return plan;
    const fromMs = Number(plan.input.fromMs);
    const toMs = Number(plan.input.toMs);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return plan;
    const now = Date.now();
    return {
      ...plan,
      input: {
        ...plan.input,
        fromMs: fromMs === 0 ? 0 : Math.max(0, now - (toMs - fromMs)),
        toMs: now
      }
    };
  }

  private async releaseLock(client: RedisClient, key: string, owner: string) {
    await client.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      { keys: [key], arguments: [owner] }
    ).catch(() => undefined);
  }

  private async materialize({
    client,
    plan,
    load
  }: {
    client: RedisClient;
    plan: GraphCachePlan;
    load?: () => Promise<unknown>;
  }) {
    const normalized = this.normalizePlan(plan);
    const resultKey = this.resultKey(normalized);
    const lockKey = this.lockKey(normalized);
    const owner = randomUUID();
    const acquired = await client.set(lockKey, owner, { NX: true, PX: 120_000 });
    if (!acquired) return null;
    try {
      const data = await (load ? load() : this.loadPlan(normalized));
      const body = JSON.stringify({ ok: true, data });
      await Promise.all([
        client.setEx(resultKey, this.redisConfig.resultTtlSeconds, body),
        client.hSet(this.key('plans'), normalized.id, JSON.stringify(normalized)),
        client.expire(this.key('plans'), this.redisConfig.resultTtlSeconds)
      ]);
      return body;
    } finally {
      await this.releaseLock(client, lockKey, owner);
    }
  }

  async getOrLoad({
    plan,
    load
  }: {
    plan: GraphCachePlan;
    load: () => Promise<unknown>;
  }) {
    const client = await this.readyClient();
    if (!client) return JSON.stringify({ ok: true, data: await load() });
    try {
      const registeredRaw = await client.hGet(this.key('plans'), plan.id);
      if (!registeredRaw) return JSON.stringify({ ok: true, data: await load() });
      const registered = JSON.parse(registeredRaw) as GraphCachePlan;
      if (registered.revision !== plan.revision || registered.scope !== plan.scope) {
        return JSON.stringify({ ok: true, data: await load() });
      }
      const cached = await client.get(this.resultKey(plan));
      if (cached !== null) {
        await client.hSet(this.key('plans'), plan.id, JSON.stringify(this.normalizePlan(plan)));
        return cached;
      }
      const materialized = await this.materialize({ client, plan, load });
      if (materialized !== null) return materialized;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await pause(200);
        const shared = await client.get(this.resultKey(plan));
        if (shared !== null) return shared;
      }
    } catch (error) {
      this.logger.error({
        caller: 'graphCache::getOrLoad',
        message: 'Redis graph lookup failed; loading the graph from PostgreSQL.',
        error,
        context: { planId: plan.id, scope: plan.scope }
      });
    }
    return JSON.stringify({ ok: true, data: await load() });
  }

  async activate({
    plans,
    inactivityMinutes,
    registeredPlanIds = plans.map((plan) => plan.id),
    replacePlans = true
  }: {
    plans: GraphCachePlan[];
    inactivityMinutes: number;
    registeredPlanIds?: string[];
    replacePlans?: boolean;
  }) {
    const client = await this.readyClient();
    if (!client) return;
    const plansKey = this.key('plans');
    const activityKey = this.key('activity');
    const [current, previousActivityRaw] = await Promise.all([
      client.hGetAll(plansKey),
      client.get(activityKey)
    ]);
    let reactivating = true;
    if (previousActivityRaw) {
      try {
        const previousActivity = JSON.parse(previousActivityRaw) as {
          atMs?: number;
          inactivityMs?: number;
        };
        reactivating = !Number.isFinite(previousActivity.atMs)
          || !Number.isFinite(previousActivity.inactivityMs)
          || Date.now() - Number(previousActivity.atMs) > Number(previousActivity.inactivityMs);
      } catch {
        reactivating = true;
      }
    }
    const nextIds = new Set(registeredPlanIds);
    const removedIds = replacePlans
      ? Object.keys(current).filter((id) => !nextIds.has(id))
      : [];
    const transaction = client.multi();
    transaction.setEx(activityKey, this.redisConfig.resultTtlSeconds, JSON.stringify({
      atMs: Date.now(),
      inactivityMs: inactivityMinutes * 60_000
    }));
    for (const plan of plans) {
      transaction.hSet(plansKey, plan.id, JSON.stringify(this.normalizePlan(plan)));
      if (reactivating) transaction.del(this.resultKey(plan));
    }
    if (reactivating) {
      const invalidateIds = replacePlans ? nextIds : new Set(plans.map((plan) => plan.id));
      for (const id of invalidateIds) {
        const previous = current[id];
        if (!previous) continue;
        try {
          transaction.del(this.resultKey(JSON.parse(previous) as GraphCachePlan));
        } catch {
          continue;
        }
      }
    }
    if (removedIds.length > 0) transaction.hDel(plansKey, removedIds);
    transaction.expire(plansKey, this.redisConfig.resultTtlSeconds);
    await transaction.exec();
    for (const id of removedIds) {
      try {
        const previous = JSON.parse(current[id]!) as GraphCachePlan;
        await client.del(this.resultKey(previous));
      } catch {
        continue;
      }
    }
    void this.warmPlans(plans).catch((error) => {
      this.logger.error({
        caller: 'graphCache::activate',
        message: 'Dashboard graph cache warm-up failed; requests will continue through PostgreSQL.',
        error
      });
    });
  }

  private planCurrencies(plan: GraphCachePlan) {
    const listed = Array.isArray(plan.input.quoteCurrencies)
      ? plan.input.quoteCurrencies.map(String)
      : [];
    const single = typeof plan.input.quoteCurrency === 'string'
      ? [plan.input.quoteCurrency]
      : [];
    return new Set([...listed, ...single].map((currency) => currency.toUpperCase()));
  }

  private affected(plan: GraphCachePlan, changes: GraphDataChange[]) {
    return changes.some((change) => {
      if (change.domain === 'portfolio') return plan.scope === 'portfolio';
      if (change.domain === 'addresses') {
        return plan.scope === 'addresses' || plan.scope === 'portfolio';
      }
      if (change.domain === 'kraken') {
        return ['kraken', 'kraken-earn', 'portfolio'].includes(plan.scope);
      }
      if (plan.scope === 'market') {
        const planAssets = Array.isArray(plan.input.assetIds)
          ? plan.input.assetIds.map(String)
          : [];
        const assetMatches = planAssets.some((assetId) => change.assetIds.includes(assetId));
        const quoteCurrency = String(plan.input.quoteCurrency ?? '').toUpperCase();
        const currencyMatches = change.quoteCurrencies.includes(quoteCurrency)
          || change.quoteCurrencies.includes('USD');
        return assetMatches && currencyMatches;
      }
      const currencies = this.planCurrencies(plan);
      return change.quoteCurrencies.some((currency) => currencies.has(currency))
        || change.quoteCurrencies.includes('USD');
    });
  }

  private async warmPlans(plans: GraphCachePlan[]) {
    const client = await this.readyClient();
    if (!client) return;
    const pending = [...plans];
    const worker = async () => {
      for (;;) {
        const plan = pending.shift();
        if (!plan) return;
        const existing = await client.get(this.resultKey(plan));
        if (existing === null) await this.materialize({ client, plan });
      }
    };
    await Promise.all([worker(), worker()]);
  }

  async isActive() {
    const client = await this.readyClient();
    if (!client) return false;
    const activityRaw = await client.get(this.key('activity'));
    if (!activityRaw) return false;
    try {
      const activity = JSON.parse(activityRaw) as { atMs?: number; inactivityMs?: number };
      return Number.isFinite(activity.atMs)
        && Number.isFinite(activity.inactivityMs)
        && Date.now() - Number(activity.atMs) <= Number(activity.inactivityMs);
    } catch {
      return false;
    }
  }

  async refreshAffected(changes: GraphDataChange[]) {
    const client = await this.readyClient();
    if (!client || changes.length === 0) return;
    if (!await this.isActive()) return;
    const serialized = await client.hGetAll(this.key('plans'));
    const plans = Object.values(serialized).flatMap((value) => {
      try {
        return [JSON.parse(value) as GraphCachePlan];
      } catch {
        return [];
      }
    }).filter((plan) => this.affected(plan, changes));
    const pending = [...plans];
    const worker = async () => {
      for (;;) {
        const plan = pending.shift();
        if (!plan) return;
        await client.del(this.resultKey(plan));
        for (let attempt = 0; attempt < 60; attempt += 1) {
          if (await this.materialize({ client, plan }) !== null) break;
          await pause(500);
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }
}
