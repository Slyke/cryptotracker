import type { AppDatabase } from '../db/index.js';

export interface RetentionResult {
  retentionDays: number | null;
  cutoff: string | null;
  deleted: {
    marketPoints: number;
    addressBalancePoints: number;
    krakenSnapshots: number;
  };
}

export interface FailedJobRetentionResult {
  retentionHours: number | null;
  cutoff: string | null;
  deleted: number;
}

export class RetentionService {
  private lastScheduledDay: string | null = null;

  constructor(private readonly db: AppDatabase) {}

  async apply({ retentionDays }: { retentionDays: number | null }): Promise<RetentionResult> {
    if (retentionDays === null) {
      return {
        retentionDays,
        cutoff: null,
        deleted: {
          marketPoints: 0,
          addressBalancePoints: 0,
          krakenSnapshots: 0
        }
      };
    }
    const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60_000;
    return this.db.transaction({
      task: async (executor) => {
        const marketPoints = await executor.run({
          sql: 'DELETE FROM market_points WHERE bucket_start_ms < ?',
          parameters: [cutoffMs]
        });
        const addressBalancePoints = await executor.run({
          sql: 'DELETE FROM address_balance_points WHERE bucket_start_ms < ?',
          parameters: [cutoffMs]
        });
        const krakenSnapshots = await executor.run({
          sql: 'DELETE FROM kraken_snapshots WHERE captured_at_ms < ?',
          parameters: [cutoffMs]
        });
        return {
          retentionDays,
          cutoff: new Date(cutoffMs).toISOString(),
          deleted: {
            marketPoints: marketPoints.changes,
            addressBalancePoints: addressBalancePoints.changes,
            krakenSnapshots: krakenSnapshots.changes
          }
        };
      }
    });
  }

  async applyScheduled({ retentionDays }: { retentionDays: number | null }) {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastScheduledDay === today) return null;
    this.lastScheduledDay = today;
    return this.apply({ retentionDays });
  }

  async applyFailedJobs({
    retentionHours
  }: {
    retentionHours: number | null;
  }): Promise<FailedJobRetentionResult> {
    if (retentionHours === null) {
      return {
        retentionHours,
        cutoff: null,
        deleted: 0
      };
    }
    const cutoffMs = Date.now() - retentionHours * 60 * 60_000;
    const deleted = await this.db.run({
      sql: `
        DELETE FROM jobs
        WHERE status = 'failed'
          AND COALESCE(completed_at_ms, updated_at_ms) < ?
      `,
      parameters: [cutoffMs]
    });
    return {
      retentionHours,
      cutoff: new Date(cutoffMs).toISOString(),
      deleted: deleted.changes
    };
  }

  async applyAllScheduled({
    retentionDays,
    failedJobRetentionHours
  }: {
    retentionDays: number | null;
    failedJobRetentionHours: number | null;
  }) {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastScheduledDay === today) return null;
    this.lastScheduledDay = today;
    const [historical, failedJobs] = await Promise.all([
      this.apply({ retentionDays }),
      this.applyFailedJobs({ retentionHours: failedJobRetentionHours })
    ]);
    return { historical, failedJobs };
  }
}
