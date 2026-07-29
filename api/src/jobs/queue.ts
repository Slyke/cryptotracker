import type { AppDatabase, DatabaseExecutor } from '../db/index.js';
import { AppError } from '../errors.js';
import type { Logger } from '../logging/logger.js';
import { createId } from '../utils/ids.js';

export type JobStatus = 'queued' | 'running' | 'retry' | 'completed' | 'failed' | 'cancelled';

export interface JobRecord {
  id: string;
  job_type: string;
  resource_key: string;
  idempotency_key: string;
  priority: number;
  status: JobStatus;
  progress_current: number | string;
  progress_total: number | string | null;
  cursor_json: string;
  attempts: number | string;
  max_attempts: number | string;
  next_retry_at_ms: number | string | null;
  locked_at_ms: number | string | null;
  locked_by: string | null;
  last_error_json: string | null;
  payload_json: string;
  created_at_ms: number | string;
  updated_at_ms: number | string;
  completed_at_ms: number | string | null;
}

export interface JobContinuation {
  jobType: string;
  resourceKey: string;
  idempotencyKey: string;
  priority: number;
  payload?: unknown;
  maxAttempts?: number;
}

export type JobHandler = ({
  job,
  updateProgress
}: {
  job: JobRecord;
  updateProgress: ({
    current,
    total,
    cursor
  }: {
    current: number;
    total?: number | null;
    cursor?: unknown;
  }) => Promise<void>;
}) => Promise<JobContinuation | void>;

export class JobQueue {
  private readonly handlers = new Map<string, JobHandler>();
  private timer: NodeJS.Timeout | null = null;
  private tickPromise: Promise<void> | null = null;
  private active = 0;
  private stopped = true;
  private readonly workerId = createId({ prefix: 'worker' });

  constructor(
    private readonly db: AppDatabase,
    private readonly logger: Logger,
    private readonly concurrency: number
  ) {}

  register({ jobType, handler }: { jobType: string; handler: JobHandler }) {
    this.handlers.set(jobType, handler);
  }

  async enqueue({
    jobType,
    resourceKey,
    idempotencyKey,
    priority,
    payload = {},
    maxAttempts = 5
  }: {
    jobType: string;
    resourceKey: string;
    idempotencyKey: string;
    priority: number;
    payload?: unknown;
    maxAttempts?: number;
  }) {
    return this.db.transaction({
      task: async (executor) => {
        const active = await executor.one<JobRecord>({
          sql: `
            SELECT * FROM jobs
            WHERE job_type = ? AND resource_key = ? AND status IN ('queued', 'running', 'retry')
            ORDER BY created_at_ms ASC
            LIMIT 1
          `,
          parameters: [jobType, resourceKey]
        });
        if (active) return { job: active, coalesced: true };

        const existing = await executor.one<JobRecord>({
          sql: 'SELECT * FROM jobs WHERE idempotency_key = ?',
          parameters: [idempotencyKey]
        });
        if (existing) return { job: existing, coalesced: true };

        const now = Date.now();
        const id = createId({ prefix: 'job' });
        await executor.run({
          sql: `
            INSERT INTO jobs(
              id, job_type, resource_key, idempotency_key, priority, status,
              payload_json, max_attempts, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
          `,
          parameters: [id, jobType, resourceKey, idempotencyKey, priority, JSON.stringify(payload), maxAttempts, now, now]
        });
        const job = await executor.one<JobRecord>({
          sql: 'SELECT * FROM jobs WHERE id = ?',
          parameters: [id]
        });
        return { job: job!, coalesced: false };
      }
    });
  }

  private async claim() {
    return this.db.transaction({
      task: async (executor) => {
        const now = Date.now();
        const candidate = await executor.one<JobRecord>({
          sql: `
            SELECT * FROM jobs
            WHERE status IN ('queued', 'retry')
              AND (next_retry_at_ms IS NULL OR next_retry_at_ms <= ?)
              AND (locked_at_ms IS NULL OR locked_at_ms < ?)
            ORDER BY priority ASC, created_at_ms ASC
            LIMIT 1
          `,
          parameters: [now, now - (15 * 60_000)]
        });
        if (!candidate) return null;
        const claimed = await executor.run({
          sql: `
            UPDATE jobs
            SET status = 'running', locked_at_ms = ?, locked_by = ?, attempts = attempts + 1, updated_at_ms = ?
            WHERE id = ? AND status IN ('queued', 'retry')
          `,
          parameters: [now, this.workerId, now, candidate.id]
        });
        if (claimed.changes !== 1) return null;
        return executor.one<JobRecord>({
          sql: 'SELECT * FROM jobs WHERE id = ?',
          parameters: [candidate.id]
        });
      }
    });
  }

  private async execute({ job }: { job: JobRecord }) {
    const handler = this.handlers.get(job.job_type);
    if (!handler) {
      throw new AppError({
        errorKey: 'JOB_EXECUTION_FAILED',
        reason: `No handler is registered for ${job.job_type}.`
      });
    }
    const continuation = await handler({
      job,
      updateProgress: async ({ current, total = null, cursor = {} }) => {
        await this.db.run({
          sql: `
            UPDATE jobs
            SET progress_current = ?, progress_total = ?, cursor_json = ?, updated_at_ms = ?
            WHERE id = ?
          `,
          parameters: [current, total, JSON.stringify(cursor), Date.now(), job.id]
        });
      }
    });
    await this.db.run({
      sql: `
        UPDATE jobs
        SET status = 'completed', completed_at_ms = ?, updated_at_ms = ?, locked_at_ms = NULL, locked_by = NULL
        WHERE id = ? AND status = 'running'
      `,
      parameters: [Date.now(), Date.now(), job.id]
    });
    if (continuation) {
      await this.enqueue(continuation);
    }
  }

  private async fail({ job, error }: { job: JobRecord; error: unknown }) {
    const attempts = Number(job.attempts);
    const maxAttempts = Number(job.max_attempts);
    const circuitOpen = error instanceof AppError && error.errorKey === 'PROVIDER_CIRCUIT_OPEN';
    const upstreamStatus = error instanceof AppError
      && error.context
      && typeof error.context === 'object'
      && 'status' in error.context
      ? Number((error.context as { status: unknown }).status)
      : Number.NaN;
    const nonRetryableProviderResponse = error instanceof AppError
      && error.errorKey === 'PROVIDER_REQUEST_FAILED'
      && upstreamStatus >= 400 && upstreamStatus < 500;
    const terminal = nonRetryableProviderResponse || (!circuitOpen && attempts >= maxAttempts);
    const retryDelay = Math.min(60 * 60_000, 1_000 * (2 ** Math.max(0, attempts - 1)));
    const cooldownUntilMs = circuitOpen
      && error.context
      && typeof error.context === 'object'
      && 'cooldownUntilMs' in error.context
      ? Number((error.context as { cooldownUntilMs: unknown }).cooldownUntilMs)
      : Number.NaN;
    const nextRetryAtMs = terminal
      ? null
      : circuitOpen && Number.isFinite(cooldownUntilMs)
        ? Math.max(Date.now() + 1_000, cooldownUntilMs)
        : Date.now() + retryDelay;
    await this.db.run({
      sql: `
        UPDATE jobs
        SET status = ?, next_retry_at_ms = ?, last_error_json = ?, updated_at_ms = ?,
            locked_at_ms = NULL, locked_by = NULL, completed_at_ms = ?,
            attempts = CASE WHEN ? = 1 AND attempts > 0 THEN attempts - 1 ELSE attempts END
        WHERE id = ?
      `,
      parameters: [
        terminal ? 'failed' : 'retry',
        nextRetryAtMs,
        JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          errorKey: error instanceof AppError ? error.errorKey : 'JOB_EXECUTION_FAILED',
          ...(circuitOpen ? { retryAtMs: nextRetryAtMs } : {})
        }),
        Date.now(),
        terminal ? Date.now() : null,
        circuitOpen ? 1 : 0,
        job.id
      ]
    });
    this.logger.error({
      caller: 'jobs::execute',
      message: `Job ${job.id} failed.`,
      error,
      context: {
        jobId: job.id,
        jobType: job.job_type,
        attempts,
        terminal
      }
    });
  }

  private async tick() {
    while (!this.stopped && this.active < this.concurrency) {
      const job = await this.claim();
      if (!job) break;
      this.active += 1;
      void this.execute({ job })
        .catch((error) => this.fail({ job, error }))
        .finally(() => {
          this.active -= 1;
          this.scheduleTick();
        });
    }
  }

  private runTick() {
    if (this.tickPromise) return this.tickPromise;
    const tickPromise = this.tick();
    this.tickPromise = tickPromise;
    void tickPromise.then(
      () => {
        if (this.tickPromise === tickPromise) this.tickPromise = null;
      },
      () => {
        if (this.tickPromise === tickPromise) this.tickPromise = null;
      }
    );
    return tickPromise;
  }

  private scheduleTick() {
    if (this.stopped) return;
    void this.runTick().catch((error) => {
      this.logger.error({
        caller: 'jobs::tick',
        message: 'Job queue polling failed.',
        error
      });
    });
  }

  async recoverInterrupted() {
    await this.db.run({
      sql: `
        UPDATE jobs
        SET status = 'retry', locked_at_ms = NULL, locked_by = NULL, next_retry_at_ms = ?, updated_at_ms = ?
        WHERE status = 'running'
      `,
      parameters: [Date.now(), Date.now()]
    });
  }

  async start() {
    if (!this.stopped) return;
    this.stopped = false;
    await this.recoverInterrupted();
    this.timer = setInterval(() => this.scheduleTick(), 1_000);
    this.timer.unref();
    await this.runTick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.tickPromise?.catch(() => undefined);
    while (this.active > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  async getJob({ id }: { id: string }) {
    return this.db.one<JobRecord>({
      sql: 'SELECT * FROM jobs WHERE id = ?',
      parameters: [id]
    });
  }

  async list({ limit = 100 }: { limit?: number } = {}) {
    return this.db.query<JobRecord>({
      sql: 'SELECT * FROM jobs ORDER BY created_at_ms DESC LIMIT ?',
      parameters: [Math.min(500, Math.max(1, limit))]
    });
  }
}

export const resetJobForRetry = async ({
  executor,
  id
}: {
  executor: DatabaseExecutor;
  id: string;
}) => executor.run({
  sql: `UPDATE jobs SET status = 'retry', locked_at_ms = NULL, locked_by = NULL, next_retry_at_ms = ? WHERE id = ?`,
  parameters: [Date.now(), id]
});
