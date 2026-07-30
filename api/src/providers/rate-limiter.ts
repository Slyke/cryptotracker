import type { ProviderRateConfig } from '../config/schema.js';
import { AppError } from '../errors.js';

interface CircuitState {
  status: 'healthy' | 'degraded' | 'rate-limited' | 'unavailable';
  consecutiveFailures: number;
  cooldownUntilMs: number;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
}

const retryAfterMilliseconds = ({ response, nowMs = Date.now() }: { response: Response; nowMs?: number }) => {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : null;
};

const wait = async ({ milliseconds }: { milliseconds: number }) => {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), milliseconds);
    timeout.unref?.();
  });
};

export class ProviderRateLimiter {
  private tokens: number;
  private lastRefillMs = Date.now();
  private lastRequestAtMs = 0;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private circuit: CircuitState = {
    status: 'healthy',
    consecutiveFailures: 0,
    cooldownUntilMs: 0,
    lastSuccessAtMs: null,
    lastFailureAtMs: null
  };

  constructor(
    private readonly provider: string,
    private readonly config: ProviderRateConfig
  ) {
    this.tokens = config.burst;
  }

  private refill() {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillMs) / 1_000;
    this.tokens = Math.min(this.config.burst, this.tokens + (elapsedSeconds * this.config.refillPerSecond));
    this.lastRefillMs = now;
  }

  private async acquire() {
    if (this.active >= this.config.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    this.refill();
    if (this.tokens < 1) {
      const tokenWaitMs = Math.ceil(((1 - this.tokens) / this.config.refillPerSecond) * 1_000);
      await wait({ milliseconds: tokenWaitMs });
      this.refill();
    }
    const spacingWaitMs = Math.max(0, (this.lastRequestAtMs + this.config.minimumSpacingMs) - Date.now());
    await wait({ milliseconds: spacingWaitMs });
    this.tokens = Math.max(0, this.tokens - 1);
    this.lastRequestAtMs = Date.now();
  }

  private release() {
    this.active = Math.max(0, this.active - 1);
    this.waiting.shift()?.();
  }

  private recordSuccess() {
    this.circuit = {
      status: 'healthy',
      consecutiveFailures: 0,
      cooldownUntilMs: 0,
      lastSuccessAtMs: Date.now(),
      lastFailureAtMs: this.circuit.lastFailureAtMs
    };
  }

  private recordFailure({ rateLimited }: { rateLimited: boolean }) {
    const consecutiveFailures = this.circuit.consecutiveFailures + 1;
    const opens = consecutiveFailures >= this.config.cooldownThreshold;
    this.circuit = {
      ...this.circuit,
      status: rateLimited ? 'rate-limited' : opens ? 'unavailable' : 'degraded',
      consecutiveFailures,
      cooldownUntilMs: opens ? Date.now() + this.config.cooldownMs : this.circuit.cooldownUntilMs,
      lastFailureAtMs: Date.now()
    };
  }

  private assertCircuitAvailable() {
    if (this.circuit.cooldownUntilMs <= Date.now()) {
      if (this.circuit.status === 'unavailable') {
        this.circuit.status = 'degraded';
      }
      return;
    }

    throw new AppError({
      errorKey: 'PROVIDER_CIRCUIT_OPEN',
      reason: `${this.provider} is cooling down after repeated failures.`,
      status: 503,
      context: {
        provider: this.provider,
        cooldownUntilMs: this.circuit.cooldownUntilMs
      }
    });
  }

  private async executeAttempt<T>({
    task
  }: {
    task: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    const signal = AbortSignal.timeout(this.config.requestTimeoutMs);
    return new Promise<T>((resolve, reject) => {
      const timedOut = () => {
        reject(new AppError({
          errorKey: 'PROVIDER_REQUEST_FAILED',
          reason: `${this.provider} timed out after ${this.config.requestTimeoutMs}ms.`,
          status: 504,
          context: {
            provider: this.provider,
            failureKind: 'timeout',
            timeoutMs: this.config.requestTimeoutMs
          }
        }));
      };
      signal.addEventListener('abort', timedOut, { once: true });
      Promise.resolve()
        .then(() => task(signal))
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', timedOut));
    });
  }

  async execute<T>({
    requestKey,
    task
  }: {
    requestKey: string;
    task: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    const existing = this.inFlight.get(requestKey) as Promise<T> | undefined;
    if (existing) return existing;

    const execution = this.executeWithRetry({ task }).finally(() => {
      this.inFlight.delete(requestKey);
    });
    this.inFlight.set(requestKey, execution);
    return execution;
  }

  private async executeWithRetry<T>({
    task
  }: {
    task: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    this.assertCircuitAvailable();
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      await this.acquire();
      try {
        const result = await this.executeAttempt({ task });
        if (result instanceof Response && !result.ok) {
          const rateLimited = result.status === 429;
          const retryable = rateLimited || result.status >= 500;
          if (retryable) this.recordFailure({ rateLimited });
          const retryAfter = retryAfterMilliseconds({ response: result });
          const error = new AppError({
            errorKey: rateLimited ? 'PROVIDER_RATE_LIMITED' : 'PROVIDER_REQUEST_FAILED',
            reason: `${this.provider} returned HTTP ${result.status}.`,
            status: rateLimited ? 429 : 502,
            context: {
              provider: this.provider,
              status: result.status
            }
          });
          lastError = error;
          if (attempt === this.config.maxRetries || !retryable) throw error;
          const exponential = this.config.baseBackoffMs * (2 ** attempt);
          const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential / 4)));
          await wait({ milliseconds: retryAfter ?? (exponential + jitter) });
          continue;
        }

        this.recordSuccess();
        return result;
      } catch (error) {
        if (error === lastError) throw error;
        lastError = error;
        this.recordFailure({ rateLimited: error instanceof AppError && error.status === 429 });
        if (attempt === this.config.maxRetries) throw error;
        const exponential = this.config.baseBackoffMs * (2 ** attempt);
        const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(exponential / 4)));
        await wait({ milliseconds: exponential + jitter });
      } finally {
        this.release();
      }
    }

    throw lastError;
  }

  getStatus() {
    return { ...this.circuit };
  }
}

export const rateLimiterInternals = {
  retryAfterMilliseconds,
  wait
};
