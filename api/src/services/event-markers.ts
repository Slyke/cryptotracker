import { Decimal } from 'decimal.js';
import type { AppDatabase } from '../db/index.js';
import { canonicalKrakenAsset } from '../domain/kraken-assets.js';

export interface SeriesEvent {
  id: string;
  category: string;
  timestampMs: number;
  asset?: string;
  quantity?: string;
  source?: string;
  reconciliationState?: string;
  details?: Record<string, unknown>;
}

const parseObject = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

const isKrakenEarnRawAsset = (assetRaw: string) => /\.(S|B|M|F)$/i.test(assetRaw);

const reconciliationByLedger = async ({
  db,
  fromMs,
  toMs
}: {
  db: AppDatabase;
  fromMs: number;
  toMs: number;
}) => {
  const rows = await db.query<{
    id: string;
    kraken_ledger_id: string;
    confidence: string;
    evidence_json: string;
  }>({
    sql: `
      SELECT internal_transfer_matches.id, internal_transfer_matches.kraken_ledger_id,
        internal_transfer_matches.confidence, internal_transfer_matches.evidence_json
      FROM internal_transfer_matches
      JOIN kraken_ledgers ON kraken_ledgers.id = internal_transfer_matches.kraken_ledger_id
      WHERE kraken_ledgers.occurred_at_ms >= ? AND kraken_ledgers.occurred_at_ms <= ?
      ORDER BY internal_transfer_matches.created_at_ms DESC
    `,
    parameters: [fromMs, toMs]
  });
  return new Map(rows.map((row) => [row.kraken_ledger_id, row]));
};

export const lifecycleAndDisputeEvents = async ({
  db,
  assetIds,
  fromMs,
  toMs
}: {
  db: AppDatabase;
  assetIds: string[];
  fromMs: number;
  toMs: number;
}): Promise<SeriesEvent[]> => {
  if (assetIds.length === 0) return [];
  const placeholders = assetIds.map(() => '?').join(', ');
  const lifecycle = await db.query<{
    id: string;
    source_asset_id: string;
    destination_asset_id: string | null;
    event_type: string;
    effective_at_ms: number | string;
    conversion_ratio: string | null;
    provenance_json: string;
  }>({
    sql: `
      SELECT * FROM asset_lifecycle_events
      WHERE effective_at_ms >= ? AND effective_at_ms <= ?
        AND (
          source_asset_id IN (${placeholders})
          OR destination_asset_id IN (${placeholders})
        )
      ORDER BY effective_at_ms, id
    `,
    parameters: [fromMs, toMs, ...assetIds, ...assetIds]
  });
  const disputes = await db.query<{
    id: string;
    provider: string;
    canonical_asset_id: string;
    bucket_start_ms: number | string;
    granularity_seconds: number | string;
    spread_value: string | null;
    contributing_values_json: string;
  }>({
    sql: `
      SELECT id, provider, canonical_asset_id, bucket_start_ms, granularity_seconds,
        spread_value, contributing_values_json
      FROM market_points
      WHERE canonical_asset_id IN (${placeholders})
        AND bucket_start_ms >= ? AND bucket_start_ms <= ?
        AND disputed = 1
      ORDER BY bucket_start_ms, canonical_asset_id, provider
      LIMIT 5000
    `,
    parameters: [...assetIds, fromMs, toMs]
  });
  return [
    ...lifecycle.map((event): SeriesEvent => ({
      id: event.id,
      category: 'lifecycle',
      timestampMs: Number(event.effective_at_ms),
      asset: event.source_asset_id,
      source: 'application lifecycle mapping',
      details: {
        eventType: event.event_type,
        sourceAssetId: event.source_asset_id,
        destinationAssetId: event.destination_asset_id,
        conversionRatio: event.conversion_ratio,
        provenance: parseObject(event.provenance_json)
      }
    })),
    ...disputes.map((event): SeriesEvent => ({
      id: event.id,
      category: 'disputed',
      timestampMs: Number(event.bucket_start_ms),
      asset: event.canonical_asset_id,
      source: event.provider,
      details: {
        spread: event.spread_value,
        granularitySeconds: Number(event.granularity_seconds),
        contributingValues: parseObject(event.contributing_values_json)
      }
    }))
  ].sort((left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id));
};

export const addressEvents = async ({
  db,
  addressIds,
  fromMs,
  toMs
}: {
  db: AppDatabase;
  addressIds: string[];
  fromMs: number;
  toMs: number;
}): Promise<SeriesEvent[]> => {
  if (addressIds.length === 0) return [];
  const placeholders = addressIds.map(() => '?').join(', ');
  const rows = await db.query<{
    id: string;
    address_id: string;
    transaction_id: string | null;
    canonical_asset_id: string;
    occurred_at_ms: number | string;
    quantity_delta: string;
    fee_quantity: string | null;
    event_type: string;
    finalized: number | string;
    provenance_json: string;
    address_label: string;
    transfer_confidence: string | null;
    transfer_evidence: string | null;
  }>({
    sql: `
      SELECT address_balance_events.*, tracked_addresses.label AS address_label,
        internal_transfer_matches.confidence AS transfer_confidence,
        internal_transfer_matches.evidence_json AS transfer_evidence
      FROM address_balance_events
      JOIN tracked_addresses ON tracked_addresses.id = address_balance_events.address_id
      LEFT JOIN internal_transfer_matches
        ON internal_transfer_matches.address_balance_event_id = address_balance_events.id
      WHERE address_balance_events.address_id IN (${placeholders})
        AND address_balance_events.occurred_at_ms >= ?
        AND address_balance_events.occurred_at_ms <= ?
      ORDER BY address_balance_events.occurred_at_ms, address_balance_events.ordering_key,
        address_balance_events.id
      LIMIT 5000
    `,
    parameters: [...addressIds, fromMs, toMs]
  });
  return rows.map((event) => ({
    id: event.id,
    category: event.transfer_confidence ? 'transfer' : 'address',
    timestampMs: Number(event.occurred_at_ms),
    asset: event.canonical_asset_id,
    quantity: event.quantity_delta,
    source: event.address_label,
    ...(event.transfer_confidence ? { reconciliationState: event.transfer_confidence } : {}),
    details: {
      eventType: event.event_type,
      transactionId: event.transaction_id,
      feeQuantity: event.fee_quantity,
      finalized: Boolean(Number(event.finalized)),
      provenance: parseObject(event.provenance_json),
      ...(event.transfer_evidence ? { reconciliationEvidence: parseObject(event.transfer_evidence) } : {})
    }
  }));
};

export const krakenEvents = async ({
  db,
  fromMs,
  toMs
}: {
  db: AppDatabase;
  fromMs: number;
  toMs: number;
}): Promise<SeriesEvent[]> => {
  const [trades, ledgers, matches] = await Promise.all([
    db.query<{
      id: string;
      kraken_id: string;
      pair_raw: string;
      side: string;
      occurred_at_ms: number | string;
      quantity: string;
      price: string;
      cost: string | null;
      fee: string | null;
      asset_in_id: string | null;
      asset_out_id: string | null;
    }>({
      sql: `
        SELECT id, kraken_id, pair_raw, side, occurred_at_ms, quantity, price,
          cost, fee, asset_in_id, asset_out_id
        FROM kraken_trades
        WHERE occurred_at_ms >= ? AND occurred_at_ms <= ?
        ORDER BY occurred_at_ms, kraken_id
        LIMIT 5000
      `,
      parameters: [fromMs, toMs]
    }),
    db.query<{
      id: string;
      kraken_id: string;
      asset_raw: string;
      canonical_asset_id: string | null;
      event_type: string;
      subtype: string | null;
      occurred_at_ms: number | string;
      amount: string;
      fee: string | null;
      transaction_id: string | null;
    }>({
      sql: `
        SELECT id, kraken_id, asset_raw, canonical_asset_id, event_type, subtype, occurred_at_ms,
          amount, fee, transaction_id
        FROM kraken_ledgers
        WHERE occurred_at_ms >= ? AND occurred_at_ms <= ?
        ORDER BY occurred_at_ms, kraken_id
        LIMIT 5000
      `,
      parameters: [fromMs, toMs]
    }),
    reconciliationByLedger({ db, fromMs, toMs })
  ]);
  const tradeEvents = trades.map((event): SeriesEvent => ({
    id: event.id,
    category: 'trade',
    timestampMs: Number(event.occurred_at_ms),
    ...(event.side === 'buy'
      ? event.asset_in_id ? { asset: canonicalKrakenAsset({ raw: event.asset_in_id }) } : {}
      : event.asset_out_id ? { asset: canonicalKrakenAsset({ raw: event.asset_out_id }) } : {}),
    quantity: event.quantity,
    source: 'Kraken',
    details: {
      krakenId: event.kraken_id,
      pair: event.pair_raw,
      side: event.side,
      price: event.price,
      cost: event.cost,
      fee: event.fee
    }
  }));
  const ledgerEvents = ledgers.map((event): SeriesEvent => {
    const match = matches.get(event.id);
    const reward = ['staking', 'earn', 'reward'].includes(event.event_type);
    const subtype = event.subtype?.toLowerCase() ?? '';
    const earnTransfer = isKrakenEarnRawAsset(event.asset_raw)
      && ['spottostaking', 'stakingtospot', 'autoallocation'].includes(subtype);
    const earnTransferCategory = earnTransfer
      ? new Decimal(event.amount).isNegative() ? 'unstake' : 'stake'
      : null;
    const category = match
      ? 'transfer'
      : reward
        ? 'reward'
        : earnTransferCategory
          ? earnTransferCategory
          : ['deposit', 'withdrawal'].includes(event.event_type)
            ? event.event_type
            : event.event_type === 'receive'
              ? 'purchase'
              : event.event_type === 'spend'
                ? 'sale'
                : 'kraken';
    return {
      id: event.id,
      category,
      timestampMs: Number(event.occurred_at_ms),
      asset: canonicalKrakenAsset({ raw: event.asset_raw }),
      quantity: event.amount,
      source: 'Kraken',
      ...(match ? { reconciliationState: match.confidence } : {}),
      details: {
        krakenId: event.kraken_id,
        eventType: event.event_type,
        subtype: event.subtype,
        assetRaw: event.asset_raw,
        fee: event.fee,
        transactionId: event.transaction_id,
        ...(match ? {
          reconciliationMatchId: match.id,
          reconciliationEvidence: parseObject(match.evidence_json)
        } : {})
      }
    };
  });
  return [...tradeEvents, ...ledgerEvents]
    .sort((left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id));
};
