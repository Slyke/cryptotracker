import type { AppDatabase } from '../db/index.js';
import { classifyOwnedTransfer, reconcileTransfer, type TransferCandidate } from '../domain/reconciliation.js';
import { createId } from '../utils/ids.js';

interface KrakenLedgerRow {
  id: string;
  kraken_id: string;
  canonical_asset_id: string;
  event_type: string;
  occurred_at_ms: number | string;
  amount: string;
  fee: string | null;
  transaction_id: string | null;
}

interface ChainEventRow {
  id: string;
  transaction_id: string | null;
  canonical_asset_id: string;
  occurred_at_ms: number | string;
  quantity_delta: string;
  fee_quantity: string | null;
  network: string;
}

export class TransferService {
  constructor(private readonly db: AppDatabase) {}

  registerJobs({ jobs }: { jobs: import('../jobs/queue.js').JobQueue }) {
    jobs.register({
      jobType: 'transfers.reconcile',
      handler: async () => {
        await this.reconcileAll();
      }
    });
  }

  async reconcileAll() {
    const ledgers = await this.db.query<KrakenLedgerRow>({
      sql: `
        SELECT * FROM kraken_ledgers
        WHERE event_type IN ('deposit', 'withdrawal')
        ORDER BY occurred_at_ms, kraken_id
      `
    });
    const chainEvents = await this.db.query<ChainEventRow>({
      sql: `
        SELECT address_balance_events.*, tracked_addresses.network
        FROM address_balance_events
        JOIN tracked_addresses ON tracked_addresses.id = address_balance_events.address_id
        WHERE address_balance_events.event_type IN (
          'receive', 'send', 'internal_receive', 'internal_send', 'token_receive', 'token_send'
        )
        ORDER BY address_balance_events.occurred_at_ms, address_balance_events.id
      `
    });
    const created: Array<{
      id: string;
      confidence: 'exact' | 'likely';
      classification: ReturnType<typeof classifyOwnedTransfer>;
    }> = [];
    const usedChainEventIds = new Set<string>();
    await this.db.transaction({
      task: async (executor) => {
        await executor.run({ sql: 'DELETE FROM internal_transfer_matches' });
        for (const ledger of ledgers) {
          const kraken: TransferCandidate = {
            id: ledger.id,
            source: 'kraken',
            assetId: ledger.canonical_asset_id,
            direction: ledger.event_type === 'deposit' ? 'in' : 'out',
            quantity: ledger.amount,
            occurredAtMs: Number(ledger.occurred_at_ms),
            transactionId: ledger.transaction_id,
            network: null,
            feeQuantity: ledger.fee
          };
          const candidates = chainEvents
            .filter((event) => (
              event.canonical_asset_id === ledger.canonical_asset_id
              && !usedChainEventIds.has(event.id)
            ))
            .map((event) => ({
              event,
              match: reconcileTransfer({
                kraken,
                chain: {
                  id: event.id,
                  source: 'chain',
                  assetId: event.canonical_asset_id,
                  direction: event.quantity_delta.startsWith('-') ? 'out' : 'in',
                  quantity: event.quantity_delta,
                  occurredAtMs: Number(event.occurred_at_ms),
                  transactionId: event.transaction_id,
                  network: event.network,
                  feeQuantity: event.fee_quantity
                }
              })
            }))
            .sort((left, right) => {
              const rank = { exact: 0, likely: 1, unmatched: 2 };
              const confidenceDifference = rank[left.match.confidence] - rank[right.match.confidence];
              if (confidenceDifference !== 0) return confidenceDifference;
              return Math.abs(Number(left.event.occurred_at_ms) - Number(ledger.occurred_at_ms))
                - Math.abs(Number(right.event.occurred_at_ms) - Number(ledger.occurred_at_ms));
            });
          const best = candidates[0];
          if (!best || best.match.confidence === 'unmatched') continue;
          usedChainEventIds.add(best.event.id);
          const classification = classifyOwnedTransfer({ match: best.match });
          const id = createId({ prefix: 'itm' });
          await executor.run({
            sql: `
              INSERT INTO internal_transfer_matches(
                id, kraken_ledger_id, chain_transaction_id, address_balance_event_id,
                canonical_asset_id, direction, confidence, quantity, fee_quantity,
                evidence_json, created_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            parameters: [
              id,
              ledger.id,
              best.event.transaction_id,
              best.event.id,
              ledger.canonical_asset_id,
              kraken.direction,
              best.match.confidence,
              ledger.amount,
              ledger.fee,
              JSON.stringify({
                ...best.match.evidence,
                classification
              }),
              Date.now()
            ]
          });
          created.push({
            id,
            confidence: best.match.confidence,
            classification
          });
        }
      }
    });
    return created;
  }
}
