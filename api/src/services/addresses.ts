import { Decimal } from 'decimal.js';
import type { LoadedRuntime } from '../config/load.js';
import type { AppDatabase } from '../db/index.js';
import { normalizeAddress, reconstructBalance, validateAddress, valueHoldings, type AddressNetwork } from '../domain/addresses.js';
import { combinePriceObservations } from '../domain/market.js';
import { AppError } from '../errors.js';
import type { JobQueue } from '../jobs/queue.js';
import type { ChainAdapter, SelectedChainAsset } from '../providers/chains.js';
import { createId } from '../utils/ids.js';
import { enabledChartDenominations, historicalPriceLookup } from './chart-values.js';
import { addressEvents } from './event-markers.js';

interface AddressRow {
  id: string;
  network: AddressNetwork;
  address: string;
  normalized_address: string;
  label: string;
  enabled: number | string;
  created_at_ms: number | string;
  updated_at_ms: number | string;
  status?: string | null;
  oldest_reconstructed_at_ms?: number | string | null;
  last_success_at_ms?: number | string | null;
  warnings_json?: string | null;
  work_active?: number | string;
}

interface SelectionRow {
  id: string;
  address_id: string;
  canonical_asset_id: string;
  contract_or_mint: string | null;
  enabled: number | string;
}

interface EventRow {
  id: string;
  address_id: string;
  canonical_asset_id: string;
  occurred_at_ms: number | string;
  ordering_key: string;
  quantity_delta: string;
}

interface AddressValuePoint {
  timestampMs: number;
  value: string | null;
  coveragePercent: string;
  unpricedAssets: string[];
  quantities: Record<string, string>;
  denominations: Record<string, string | null>;
  quotes: Record<string, string | null>;
}

interface AddressValueSeries {
  id: string;
  label: string;
  points: AddressValuePoint[];
}

const nativeAsset = ({ network }: { network: AddressNetwork }) => ({
  bitcoin: 'bitcoin',
  dogecoin: 'dogecoin',
  ethereum: 'ethereum',
  polkadot: 'polkadot',
  solana: 'solana'
})[network];

const mainnetRegistry = [
  {
    id: 'bitcoin',
    label: 'Bitcoin mainnet',
    nativeAssetId: 'bitcoin',
    memberAssetIds: ['bitcoin']
  },
  {
    id: 'dogecoin',
    label: 'Dogecoin mainnet',
    nativeAssetId: 'dogecoin',
    memberAssetIds: ['dogecoin']
  },
  {
    id: 'ethereum',
    label: 'Ethereum mainnet',
    nativeAssetId: 'ethereum',
    memberAssetIds: ['ethereum', 'shiba-inu']
  },
  {
    id: 'polkadot',
    label: 'Polkadot mainnet',
    nativeAssetId: 'polkadot',
    memberAssetIds: ['polkadot']
  },
  {
    id: 'solana',
    label: 'Solana mainnet-beta',
    nativeAssetId: 'solana',
    memberAssetIds: ['solana']
  }
] as const;

export class AddressService {
  constructor(
    private readonly db: AppDatabase,
    private readonly runtime: LoadedRuntime,
    private readonly adapters: Map<AddressNetwork, ChainAdapter>,
    private readonly jobs: JobQueue
  ) {}

  async networkOptions() {
    const enabledAssets = await this.db.query<{
      canonical_id: string;
      symbol: string;
      network: string | null;
      contract_or_mint: string | null;
    }>({
      sql: `
        SELECT watched_assets.canonical_id, watched_assets.symbol,
               COALESCE(watched_assets.network, asset_catalog.network) AS network,
               COALESCE(watched_assets.contract_or_mint, asset_catalog.contract_or_mint) AS contract_or_mint
        FROM watched_assets
        LEFT JOIN asset_catalog ON asset_catalog.canonical_id = watched_assets.canonical_id
        WHERE watched_assets.enabled = 1
        ORDER BY watched_assets.symbol, watched_assets.canonical_id
      `
    });
    const enabledById = new Map(enabledAssets.map((asset) => [asset.canonical_id, asset]));
    const options = mainnetRegistry.flatMap((mainnet) => {
      const members = enabledAssets.filter((asset) => (
        (mainnet.memberAssetIds as readonly string[]).includes(asset.canonical_id)
        || asset.network === mainnet.id
      ));
      if (members.length === 0) return [];
      const supported = this.adapters.has(mainnet.id as AddressNetwork);
      const missingProviderReason = mainnet.id === 'ethereum'
        ? 'ETH and ERC-20 assets such as SHIB share one Etherscan API key for public-address history.'
        : mainnet.id === 'solana'
          ? 'SOL and SPL assets share one Helius API key for public-address history.'
          : mainnet.id === 'polkadot'
            ? 'DOT public-address history requires a Subscan API key.'
            : null;
      return [{
        id: mainnet.id,
        label: mainnet.label,
        nativeAssetId: mainnet.nativeAssetId,
        enabledAssets: members.map((asset) => ({
          id: asset.canonical_id,
          symbol: asset.symbol,
          contractOrMint: asset.contract_or_mint
        })),
        supported,
        reason: supported
          ? null
          : missingProviderReason
            ?? `A reviewed read-only ${mainnet.label} history provider is not configured.`
      }];
    });
    const mapped = new Set(options.flatMap((option) => option.enabledAssets.map((asset) => asset.id)));
    return {
      mainnets: options,
      unmappedAssets: [...enabledById.values()]
        .filter((asset) => !mapped.has(asset.canonical_id))
        .map((asset) => ({
          id: asset.canonical_id,
          symbol: asset.symbol
        }))
    };
  }

  private async configuredTooltipCurrencies() {
    const row = await this.db.one<{ setting_value_json: string }>({
      sql: `
        SELECT setting_value_json
        FROM user_settings
        WHERE setting_key = 'tooltipCurrencies'
        ORDER BY updated_at_ms DESC
        LIMIT 1
      `
    });
    try {
      const value = JSON.parse(row?.setting_value_json ?? 'null') as unknown;
      return Array.isArray(value)
        ? value.map(String)
        : this.runtime.config.ui.defaultTooltipCurrencies;
    } catch {
      return this.runtime.config.ui.defaultTooltipCurrencies;
    }
  }

  private async selections({ addressId }: { addressId: string }) {
    const rows = await this.db.query<SelectionRow>({
      sql: `
        SELECT * FROM address_asset_selections
        WHERE address_id = ?
        ORDER BY enabled DESC, canonical_asset_id, contract_or_mint
      `,
      parameters: [addressId]
    });
    return rows.map((row) => ({
      id: row.id,
      canonicalAssetId: row.canonical_asset_id,
      contractOrMint: row.contract_or_mint,
      enabled: Boolean(Number(row.enabled))
    }));
  }

  async list() {
    const rows = await this.db.query<AddressRow>({
      sql: `
        SELECT tracked_addresses.*, address_sync_state.status,
          address_sync_state.oldest_reconstructed_at_ms,
          address_sync_state.last_success_at_ms,
          address_sync_state.warnings_json,
          EXISTS (
            SELECT 1
            FROM jobs
            WHERE jobs.job_type = 'address.sync'
              AND jobs.resource_key = 'address:' || tracked_addresses.id
              AND jobs.status IN ('queued', 'running', 'retry')
          ) AS work_active
        FROM tracked_addresses
        LEFT JOIN address_sync_state ON address_sync_state.address_id = tracked_addresses.id
        WHERE tracked_addresses.deleted_at_ms IS NULL
        ORDER BY tracked_addresses.enabled DESC, tracked_addresses.created_at_ms, tracked_addresses.id
      `
    });
    const staleBoundaryMs = Date.now() - this.runtime.config.sync.staleAfterMinutes * 60_000;
    return Promise.all(rows.map(async (row) => {
      const providerAvailable = this.adapters.has(row.network);
      const warnings = JSON.parse(row.warnings_json ?? '[]') as unknown[];
      return {
        id: row.id,
        network: row.network,
        address: row.address,
        label: row.label,
        enabled: Boolean(Number(row.enabled)),
        privacyNotice: 'The configured external chain provider receives this public address.',
        history: {
          status: !providerAvailable
            ? 'unavailable'
            : row.last_success_at_ms !== null
              && row.last_success_at_ms !== undefined
              && Number(row.last_success_at_ms) < staleBoundaryMs
              ? 'stale'
              : row.status ?? 'syncing',
          oldestReconstructedAt: row.oldest_reconstructed_at_ms
            ? new Date(Number(row.oldest_reconstructed_at_ms)).toISOString()
            : null,
          lastSuccessfulSync: row.last_success_at_ms
            ? new Date(Number(row.last_success_at_ms)).toISOString()
            : null,
          warnings: providerAvailable
            ? warnings
            : [
                ...warnings,
                {
                  code: 'ADDRESS_PROVIDER_UNAVAILABLE',
                  network: row.network
                }
              ],
          workActive: Boolean(Number(row.work_active ?? 0)),
          providerHistoryAvailable: !warnings.some((warning) => (
            warning
            && typeof warning === 'object'
            && 'code' in warning
            && (warning as { code?: unknown }).code === 'ETHEREUM_HISTORY_PROVIDER_UNAVAILABLE'
          ))
        },
        assets: await this.selections({ addressId: row.id })
      };
    }));
  }

  private validateSelectedAssets({
    network,
    assets
  }: {
    network: AddressNetwork;
    assets: SelectedChainAsset[];
  }) {
    const native = nativeAsset({ network });
    for (const asset of assets) {
      if (asset.canonicalAssetId === native && !asset.contractOrMint) continue;
      if (network === 'bitcoin' || network === 'dogecoin' || network === 'polkadot') {
        throw new AppError({
          errorKey: 'INPUT_INVALID',
          reason: `${network} addresses support their native asset only.`,
          status: 400
        });
      }
      if (network === 'ethereum' && !/^0x[0-9a-fA-F]{40}$/.test(asset.contractOrMint ?? '')) {
        throw new AppError({
          errorKey: 'INPUT_INVALID',
          reason: 'ERC-20 selections require a contract address.',
          status: 400
        });
      }
      if (network === 'solana' && !(asset.contractOrMint && asset.contractOrMint.length >= 32 && asset.contractOrMint.length <= 44)) {
        throw new AppError({
          errorKey: 'INPUT_INVALID',
          reason: 'SPL selections require a mint address.',
          status: 400
        });
      }
    }
  }

  async add({
    network,
    address,
    label,
    enabled = true,
    assets = []
  }: {
    network: AddressNetwork;
    address: string;
    label: string;
    enabled?: boolean;
    assets?: SelectedChainAsset[];
  }) {
    if (!await validateAddress({ network, address })) {
      throw new AppError({
        errorKey: 'INPUT_INVALID',
        reason: `Address is not valid for ${network}.`,
        status: 400
      });
    }
    const normalized = normalizeAddress({ network, address });
    const selectedAssets = [
      { canonicalAssetId: nativeAsset({ network }), contractOrMint: null },
      ...assets.filter((asset) => asset.canonicalAssetId !== nativeAsset({ network }) || asset.contractOrMint !== null)
    ];
    this.validateSelectedAssets({ network, assets: selectedAssets });
    const now = Date.now();
    const id = createId({ prefix: 'addr' });
    try {
      await this.db.transaction({
        task: async (executor) => {
          await executor.run({
            sql: `
              INSERT INTO tracked_addresses(
                id, network, address, normalized_address, label, enabled, created_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            parameters: [id, network, address.trim(), normalized, label.trim(), enabled ? 1 : 0, now, now]
          });
          for (const asset of selectedAssets) {
            await executor.run({
              sql: `
                INSERT INTO address_asset_selections(
                  id, address_id, canonical_asset_id, contract_or_mint, enabled, created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, 1, ?, ?)
              `,
              parameters: [
                createId({ prefix: 'aas' }),
                id,
                asset.canonicalAssetId,
                asset.contractOrMint,
                now,
                now
              ]
            });
          }
          await executor.run({
            sql: `
              INSERT INTO address_sync_state(
                address_id, status, cursor_json, provider_boundary_json, warnings_json, updated_at_ms
              ) VALUES (?, 'syncing', '{}', '{}', '[]', ?)
            `,
            parameters: [id, now]
          });
        }
      });
    } catch (error) {
      if (error instanceof Error && /unique/i.test(error.message)) {
        throw new AppError({
          errorKey: 'RESOURCE_CONFLICT',
          reason: 'That network address is already tracked.',
          status: 409,
          cause: error
        });
      }
      throw error;
    }
    await this.queueRefresh({ id, priority: 40, reason: 'initial' });
    return (await this.list()).find((entry) => entry.id === id)!;
  }

  async patch({
    id,
    label,
    enabled
  }: {
    id: string;
    label?: string;
    enabled?: boolean;
  }) {
    const existing = await this.db.one<AddressRow>({
      sql: 'SELECT * FROM tracked_addresses WHERE id = ? AND deleted_at_ms IS NULL',
      parameters: [id]
    });
    if (!existing) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: 'Tracked address was not found.',
        status: 404
      });
    }
    await this.db.run({
      sql: 'UPDATE tracked_addresses SET label = ?, enabled = ?, updated_at_ms = ? WHERE id = ?',
      parameters: [
        label?.trim() ?? existing.label,
        enabled === undefined ? Number(existing.enabled) : enabled ? 1 : 0,
        Date.now(),
        id
      ]
    });
    return (await this.list()).find((entry) => entry.id === id)!;
  }

  async replaceAssets({
    id,
    assets
  }: {
    id: string;
    assets: SelectedChainAsset[];
  }) {
    const address = await this.db.one<AddressRow>({
      sql: 'SELECT * FROM tracked_addresses WHERE id = ? AND deleted_at_ms IS NULL',
      parameters: [id]
    });
    if (!address) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: 'Tracked address was not found.',
        status: 404
      });
    }
    const selectedAssets = [
      { canonicalAssetId: nativeAsset({ network: address.network }), contractOrMint: null },
      ...assets.filter((asset) => asset.canonicalAssetId !== nativeAsset({ network: address.network }) || asset.contractOrMint !== null)
    ];
    this.validateSelectedAssets({ network: address.network, assets: selectedAssets });
    const now = Date.now();
    await this.db.transaction({
      task: async (executor) => {
        await executor.run({
          sql: 'UPDATE address_asset_selections SET enabled = 0, updated_at_ms = ? WHERE address_id = ?',
          parameters: [now, id]
        });
        for (const asset of selectedAssets) {
          await executor.run({
            sql: `
              INSERT INTO address_asset_selections(
                id, address_id, canonical_asset_id, contract_or_mint, enabled, created_at_ms, updated_at_ms
              ) VALUES (?, ?, ?, ?, 1, ?, ?)
              ON CONFLICT(address_id, canonical_asset_id, contract_or_mint)
              DO UPDATE SET enabled = 1, updated_at_ms = excluded.updated_at_ms
            `,
            parameters: [
              createId({ prefix: 'aas' }),
              id,
              asset.canonicalAssetId,
              asset.contractOrMint,
              now,
              now
            ]
          });
        }
        await executor.run({
          sql: `
            UPDATE address_sync_state
            SET status = 'syncing', cursor_json = '{}',
                oldest_reconstructed_at_ms = NULL,
                provider_boundary_json = '{}', warnings_json = '[]',
                updated_at_ms = ?
            WHERE address_id = ?
          `,
          parameters: [now, id]
        });
      }
    });
    const refresh = await this.queueRefresh({ id, priority: 40, reason: 'asset-selection' });
    return {
      assets: await this.selections({ addressId: id }),
      refresh
    };
  }

  async delete({ id }: { id: string }) {
    const result = await this.db.transaction({
      task: async (executor) => {
        await executor.run({
          sql: `
            UPDATE jobs SET status = 'cancelled', completed_at_ms = ?, updated_at_ms = ?
            WHERE resource_key = ? AND status IN ('queued', 'retry')
          `,
          parameters: [Date.now(), Date.now(), `address:${id}`]
        });
        return executor.run({
          sql: 'DELETE FROM tracked_addresses WHERE id = ?',
          parameters: [id]
        });
      }
    });
    if (result.changes === 0) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: 'Tracked address was not found.',
        status: 404
      });
    }
  }

  async queueRefresh({
    id,
    priority = 10,
    reason = 'manual'
  }: {
    id: string;
    priority?: number;
    reason?: string;
  }) {
    const address = await this.db.one<Pick<AddressRow, 'id' | 'network'>>({
      sql: 'SELECT id, network FROM tracked_addresses WHERE id = ? AND deleted_at_ms IS NULL',
      parameters: [id]
    });
    if (!address) {
      throw new AppError({
        errorKey: 'RESOURCE_NOT_FOUND',
        reason: 'Tracked address was not found.',
        status: 404
      });
    }
    if (!this.adapters.has(address.network)) {
      const now = Date.now();
      const warnings = JSON.stringify([{
        code: 'ADDRESS_PROVIDER_UNAVAILABLE',
        network: address.network
      }]);
      await this.db.run({
        sql: `
          INSERT INTO address_sync_state(
            address_id, status, cursor_json, provider_boundary_json,
            warnings_json, updated_at_ms
          ) VALUES (?, 'unavailable', '{}', '{}', ?, ?)
          ON CONFLICT(address_id)
          DO UPDATE SET
            status = 'unavailable',
            warnings_json = excluded.warnings_json,
            updated_at_ms = excluded.updated_at_ms
        `,
        parameters: [id, warnings, now]
      });
      return {
        skipped: true,
        reason: 'provider_unavailable',
        network: address.network
      };
    }
    return this.jobs.enqueue({
      jobType: 'address.sync',
      resourceKey: `address:${id}`,
      idempotencyKey: `address:${id}:${reason}:${Math.floor(Date.now() / 60_000)}`,
      priority,
      payload: { addressId: id }
    });
  }

  registerJobs() {
    this.jobs.register({
      jobType: 'address.sync',
      handler: async ({ job, updateProgress }) => {
        const { addressId } = JSON.parse(job.payload_json) as { addressId: string };
        const address = await this.db.one<AddressRow & { cursor_json: string | null }>({
          sql: `
            SELECT tracked_addresses.*, address_sync_state.cursor_json
            FROM tracked_addresses
            LEFT JOIN address_sync_state ON address_sync_state.address_id = tracked_addresses.id
            WHERE tracked_addresses.id = ?
          `,
          parameters: [addressId]
        });
        if (!address) return;
        const adapter = this.adapters.get(address.network);
        if (!adapter) {
          throw new AppError({
            errorKey: 'ADDRESS_SYNC_FAILED',
            reason: `${address.network} adapter is disabled.`
          });
        }
        const selections = (await this.selections({ addressId }))
          .filter((selection) => selection.enabled)
          .map((selection) => ({
            canonicalAssetId: selection.canonicalAssetId,
            contractOrMint: selection.contractOrMint
          }));
        await updateProgress({ current: 0, total: 1 });
        const [result, currentBalances] = await Promise.all([
          adapter.fetchHistory({
            address: address.normalized_address,
            selectedAssets: selections,
            cursor: JSON.parse(address.cursor_json ?? '{}') as Record<string, unknown>
          }),
          adapter.fetchCurrentBalances
            ? adapter.fetchCurrentBalances({
                address: address.normalized_address,
                selectedAssets: selections
              })
            : Promise.resolve({
                observations: [],
                providerBoundary: {},
                warnings: []
              })
        ]);
        const now = Date.now();
        await this.db.transaction({
          task: async (executor) => {
            const utxoNetwork = address.network === 'bitcoin' || address.network === 'dogecoin';
            if (utxoNetwork) {
              const seenTransactionIds = new Set(result.transactions.map((transaction) => transaction.transactionId));
              const pendingTransactions = await executor.query<{
                transaction_id: string;
              }>({
                sql: `
                  SELECT transaction_id
                  FROM chain_transactions
                  WHERE address_id = ? AND network = ? AND confirmation_state <> 'finalized'
                `,
                parameters: [addressId, address.network]
              });
              for (const pending of pendingTransactions) {
                if (seenTransactionIds.has(pending.transaction_id)) continue;
                const staleEvents = await executor.query<{ id: string }>({
                  sql: `
                    SELECT id FROM address_balance_events
                    WHERE address_id = ? AND transaction_id = ?
                  `,
                  parameters: [addressId, pending.transaction_id]
                });
                for (const staleEvent of staleEvents) {
                  await executor.run({
                    sql: 'DELETE FROM internal_transfer_matches WHERE address_balance_event_id = ?',
                    parameters: [staleEvent.id]
                  });
                }
                await executor.run({
                  sql: 'DELETE FROM address_balance_events WHERE address_id = ? AND transaction_id = ?',
                  parameters: [addressId, pending.transaction_id]
                });
                await executor.run({
                  sql: 'DELETE FROM chain_transactions WHERE address_id = ? AND network = ? AND transaction_id = ?',
                  parameters: [addressId, address.network, pending.transaction_id]
                });
              }
            }
            for (const transaction of result.transactions) {
              await executor.run({
                sql: `
                  INSERT INTO chain_transactions(
                    id, address_id, network, transaction_id, block_reference,
                    transaction_position, occurred_at_ms, confirmation_state,
                    raw_summary_json, warning_json
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(address_id, network, transaction_id)
                  DO UPDATE SET
                    block_reference = excluded.block_reference,
                    transaction_position = excluded.transaction_position,
                    occurred_at_ms = excluded.occurred_at_ms,
                    confirmation_state = excluded.confirmation_state,
                    raw_summary_json = excluded.raw_summary_json,
                    warning_json = excluded.warning_json
                `,
                parameters: [
                  createId({ prefix: 'ctx' }),
                  addressId,
                  address.network,
                  transaction.transactionId,
                  transaction.blockReference,
                  transaction.transactionPosition,
                  transaction.occurredAtMs,
                  transaction.confirmationState,
                  JSON.stringify(transaction.rawSummary),
                  transaction.warning ? JSON.stringify(transaction.warning) : null
                ]
              });
            }
            for (const event of result.events) {
              if (utxoNetwork && event.transactionId) {
                const existingEvents = await executor.query<{ id: string }>({
                  sql: `
                    SELECT id
                    FROM address_balance_events
                    WHERE address_id = ? AND transaction_id = ? AND canonical_asset_id = ?
                    ORDER BY finalized DESC, occurred_at_ms DESC, id
                  `,
                  parameters: [addressId, event.transactionId, event.canonicalAssetId]
                });
                const retained = existingEvents[0];
                for (const duplicate of existingEvents.slice(1)) {
                  await executor.run({
                    sql: 'DELETE FROM internal_transfer_matches WHERE address_balance_event_id = ?',
                    parameters: [duplicate.id]
                  });
                  await executor.run({
                    sql: 'DELETE FROM address_balance_events WHERE id = ?',
                    parameters: [duplicate.id]
                  });
                }
                if (retained) {
                  await executor.run({
                    sql: `
                      UPDATE address_balance_events
                      SET occurred_at_ms = ?, ordering_key = ?, quantity_delta = ?,
                          fee_quantity = ?, event_type = ?, finalized = ?, provenance_json = ?
                      WHERE id = ?
                    `,
                    parameters: [
                      event.occurredAtMs,
                      event.orderingKey,
                      event.quantityDelta,
                      event.feeQuantity,
                      event.eventType,
                      event.finalized ? 1 : 0,
                      JSON.stringify(event.provenance),
                      retained.id
                    ]
                  });
                  continue;
                }
              }
              await executor.run({
                sql: `
                  INSERT INTO address_balance_events(
                    id, address_id, transaction_id, canonical_asset_id, occurred_at_ms,
                    ordering_key, quantity_delta, fee_quantity, event_type, finalized, provenance_json
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(address_id, canonical_asset_id, ordering_key, event_type)
                  DO UPDATE SET
                    transaction_id = excluded.transaction_id,
                    occurred_at_ms = excluded.occurred_at_ms,
                    quantity_delta = excluded.quantity_delta,
                    fee_quantity = excluded.fee_quantity,
                    finalized = excluded.finalized,
                    provenance_json = excluded.provenance_json
                `,
                parameters: [
                  createId({ prefix: 'abe' }),
                  addressId,
                  event.transactionId,
                  event.canonicalAssetId,
                  event.occurredAtMs,
                  event.orderingKey,
                  event.quantityDelta,
                  event.feeQuantity,
                  event.eventType,
                  event.finalized ? 1 : 0,
                  JSON.stringify(event.provenance)
                ]
              });
            }
            for (const observation of currentBalances.observations) {
              const bucketStartMs = Math.floor(observation.observedAtMs / (30 * 60_000)) * (30 * 60_000);
              await executor.run({
                sql: `
                  INSERT INTO address_balance_points(
                    id, address_id, canonical_asset_id, bucket_start_ms,
                    granularity_seconds, quantity, value_currency, value_amount,
                    price_coverage, source_event_id
                  ) VALUES (?, ?, ?, ?, 0, ?, NULL, NULL, 'balance_observed', NULL)
                  ON CONFLICT(address_id, canonical_asset_id, bucket_start_ms, granularity_seconds)
                  DO UPDATE SET
                    quantity = excluded.quantity,
                    price_coverage = excluded.price_coverage
                `,
                parameters: [
                  createId({ prefix: 'abp' }),
                  addressId,
                  observation.canonicalAssetId,
                  bucketStartMs,
                  observation.quantity
                ]
              });
            }
            const oldest = result.transactions.length > 0
              ? Math.min(...result.transactions.map((transaction) => transaction.occurredAtMs))
              : null;
            await executor.run({
              sql: `
                INSERT INTO address_sync_state(
                  address_id, status, cursor_json, oldest_reconstructed_at_ms,
                  provider_boundary_json, warnings_json, last_success_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(address_id)
                DO UPDATE SET
                  status = excluded.status,
                  cursor_json = excluded.cursor_json,
                  oldest_reconstructed_at_ms = CASE
                    WHEN address_sync_state.oldest_reconstructed_at_ms IS NULL
                      OR excluded.oldest_reconstructed_at_ms < address_sync_state.oldest_reconstructed_at_ms
                    THEN excluded.oldest_reconstructed_at_ms
                    ELSE address_sync_state.oldest_reconstructed_at_ms END,
                  provider_boundary_json = excluded.provider_boundary_json,
                  warnings_json = excluded.warnings_json,
                  last_success_at_ms = excluded.last_success_at_ms,
                  updated_at_ms = excluded.updated_at_ms
              `,
              parameters: [
                addressId,
                result.completeness,
                JSON.stringify(result.cursor),
                oldest,
                JSON.stringify({
                  history: result.providerBoundary,
                  currentBalances: currentBalances.providerBoundary
                }),
                JSON.stringify([
                  ...result.warnings,
                  ...currentBalances.warnings
                ]),
                now,
                now
              ]
            });
          }
        });
        await updateProgress({ current: 1, total: 1, cursor: result.cursor });
        await this.jobs.enqueue({
          jobType: 'transfers.reconcile',
          resourceKey: 'owned-transfers',
          idempotencyKey: `transfers:address:${Math.floor(Date.now() / 60_000)}`,
          priority: 30,
          payload: { reason: 'address-sync' }
        });
        const historyUnavailable = result.warnings.some((warning) => (
          warning.code === 'ETHEREUM_HISTORY_PROVIDER_UNAVAILABLE'
        ));
        const cursorAdvanced = JSON.stringify(result.cursor) !== JSON.stringify(
          JSON.parse(address.cursor_json ?? '{}') as Record<string, unknown>
        );
        if (
          result.completeness === 'partial'
          && !historyUnavailable
          && cursorAdvanced
        ) {
          return {
            jobType: 'address.sync',
            resourceKey: `address:${addressId}`,
            idempotencyKey: `address:${addressId}:continuation:${job.id}`,
            priority: 20,
            payload: { addressId }
          };
        }
      }
    });
  }

  private async latestPrices({
    assetIds,
    quoteCurrency
  }: {
    assetIds: string[];
    quoteCurrency: string;
  }) {
    const prices: Record<string, string | null> = {};
    for (const assetId of assetIds) {
      const rows = await this.db.query<{ provider: string; close_value: string; data_kind: 'native' | 'derived' }>({
        sql: `
          SELECT provider, close_value, data_kind
          FROM market_points
          WHERE canonical_asset_id = ? AND quote_currency = ?
            AND bucket_start_ms = (
              SELECT MAX(bucket_start_ms) FROM market_points
              WHERE canonical_asset_id = ? AND quote_currency = ?
            )
          ORDER BY provider
        `,
        parameters: [assetId, quoteCurrency, assetId, quoteCurrency]
      });
      prices[assetId] = combinePriceObservations({
        observations: rows.map((row) => ({
          provider: row.provider,
          value: row.close_value,
          dataKind: row.data_kind
        })),
        disagreementThresholdPercent: this.runtime.config.ui.defaultProviderDisagreementThresholdPercent
      }).value;
    }
    return prices;
  }

  async holdings({
    quoteCurrency,
    quoteCurrencies
  }: {
    quoteCurrency: string;
    quoteCurrencies?: string[];
  }) {
    const addresses = await this.list();
    const [eventRows, observationRows, configuredCurrencies] = await Promise.all([
      this.db.query<{
        address_id: string;
        canonical_asset_id: string;
        quantity_delta: string;
      }>({
        sql: `
          SELECT address_balance_events.address_id,
                 address_balance_events.canonical_asset_id,
                 address_balance_events.quantity_delta
          FROM address_balance_events
          JOIN address_asset_selections
            ON address_asset_selections.address_id = address_balance_events.address_id
           AND address_asset_selections.canonical_asset_id = address_balance_events.canonical_asset_id
           AND address_asset_selections.enabled = 1
          WHERE address_balance_events.finalized = 1
          ORDER BY address_balance_events.address_id,
                   address_balance_events.canonical_asset_id,
                   address_balance_events.occurred_at_ms,
                   address_balance_events.ordering_key,
                   address_balance_events.id
        `
      }),
      this.db.query<{
        address_id: string;
        canonical_asset_id: string;
        quantity: string;
        bucket_start_ms: number | string;
      }>({
        sql: `
          SELECT point.address_id, point.canonical_asset_id,
                 point.quantity, point.bucket_start_ms
          FROM address_balance_points AS point
          JOIN (
            SELECT address_id, canonical_asset_id, MAX(bucket_start_ms) AS newest
            FROM address_balance_points
            WHERE granularity_seconds = 0
            GROUP BY address_id, canonical_asset_id
          ) AS latest
            ON latest.address_id = point.address_id
           AND latest.canonical_asset_id = point.canonical_asset_id
           AND latest.newest = point.bucket_start_ms
          JOIN address_asset_selections AS selection
            ON selection.address_id = point.address_id
           AND selection.canonical_asset_id = point.canonical_asset_id
           AND selection.enabled = 1
          WHERE point.granularity_seconds = 0
          ORDER BY point.address_id, point.canonical_asset_id
        `
      }),
      quoteCurrencies ?? this.configuredTooltipCurrencies()
    ]);
    const quantitiesByAddressAsset = new Map<string, {
      address_id: string;
      canonical_asset_id: string;
      quantity: Decimal;
      balanceObserved: boolean;
    }>();
    for (const event of eventRows) {
      const key = `${event.address_id}:${event.canonical_asset_id}`;
      const existing = quantitiesByAddressAsset.get(key);
      quantitiesByAddressAsset.set(key, {
        address_id: event.address_id,
        canonical_asset_id: event.canonical_asset_id,
        quantity: (existing?.quantity ?? new Decimal(0)).plus(event.quantity_delta),
        balanceObserved: true
      });
    }
    for (const observation of observationRows) {
      quantitiesByAddressAsset.set(
        `${observation.address_id}:${observation.canonical_asset_id}`,
        {
          address_id: observation.address_id,
          canonical_asset_id: observation.canonical_asset_id,
          quantity: new Decimal(observation.quantity),
          balanceObserved: true
        }
      );
    }
    for (const address of addresses) {
      for (const asset of address.assets.filter((selection) => selection.enabled)) {
        const key = `${address.id}:${asset.canonicalAssetId}`;
        if (quantitiesByAddressAsset.has(key)) continue;
        quantitiesByAddressAsset.set(key, {
          address_id: address.id,
          canonical_asset_id: asset.canonicalAssetId,
          quantity: new Decimal(0),
          balanceObserved: address.history.status === 'complete'
        });
      }
    }
    const rows = [...quantitiesByAddressAsset.values()].map((row) => ({
      address_id: row.address_id,
      canonical_asset_id: row.canonical_asset_id,
      quantity: row.quantity.toString(),
      balanceObserved: row.balanceObserved
    }));
    const assetIds = [...new Set(rows.map((row) => row.canonical_asset_id))];
    const resolvedQuoteCurrencies = [...new Set([
      quoteCurrency.toUpperCase(),
      ...configuredCurrencies.map((currency) => currency.toUpperCase())
        .filter((currency) => /^[A-Z]{3}$/.test(currency))
    ])];
    const [priceEntries, catalogRows] = await Promise.all([
      Promise.all(resolvedQuoteCurrencies.map(async (currency) => [
        currency,
        await this.latestPrices({ assetIds, quoteCurrency: currency })
      ] as const)),
      assetIds.length === 0
        ? Promise.resolve([])
        : this.db.query<{
            canonical_id: string;
            symbol: string;
            name: string;
          }>({
            sql: `
              SELECT canonical_id, symbol, name
              FROM asset_catalog
              WHERE canonical_id IN (${assetIds.map(() => '?').join(', ')})
            `,
            parameters: assetIds
          })
    ]);
    const pricesByCurrency = new Map(priceEntries);
    const assetLabels = new Map(catalogRows.map((asset) => [
      asset.canonical_id,
      {
        symbol: asset.symbol,
        name: asset.name
      }
    ]));
    return addresses.flatMap((address) => {
      const addressRows = rows.filter((row) => row.address_id === address.id);
      const quantities = Object.fromEntries(addressRows
        .filter((row) => row.balanceObserved)
        .map((row) => [row.canonical_asset_id, row.quantity]));
      const valuations = new Map(resolvedQuoteCurrencies.map((currency) => [
        currency,
        valueHoldings({
          quantities,
          prices: pricesByCurrency.get(currency) ?? {}
        })
      ]));
      const valuation = valuations.get(quoteCurrency.toUpperCase())!;
      return addressRows.map((row) => ({
        addressId: address.id,
        address: address.address,
        label: address.label,
        network: address.network,
        assetId: row.canonical_asset_id,
        assetSymbol: assetLabels.get(row.canonical_asset_id)?.symbol ?? row.canonical_asset_id.toUpperCase(),
        assetName: assetLabels.get(row.canonical_asset_id)?.name ?? row.canonical_asset_id,
        quantity: row.balanceObserved ? row.quantity : null,
        currentValue: row.balanceObserved ? valuation.values[row.canonical_asset_id] : null,
        currentValues: Object.fromEntries(resolvedQuoteCurrencies.map((currency) => [
          currency,
          row.balanceObserved
            ? valuations.get(currency)!.values[row.canonical_asset_id]
            : null
        ])),
        valueCurrency: quoteCurrency.toUpperCase(),
        completeness: address.history.status,
        oldestReconstructedAt: address.history.oldestReconstructedAt,
        lastSuccessfulSync: address.history.lastSuccessfulSync,
        pricedCoveragePercent: row.balanceObserved ? valuation.coveragePercent : '0',
        balanceObserved: row.balanceObserved,
        balanceReason: row.balanceObserved
          ? null
          : 'No successful chain-history import or current-balance observation confirms this asset balance.'
      }));
    });
  }

  async series({
    quoteCurrency,
    quoteCurrencies,
    fromMs,
    toMs,
    granularitySeconds
  }: {
    quoteCurrency: string;
    quoteCurrencies?: string[];
    fromMs: number;
    toMs: number;
    granularitySeconds: number;
  }) {
    const addresses = (await this.list()).filter((address) => address.enabled);
    const oldest = fromMs === 0
      ? await this.db.one<{ oldest: number | string | null }>({
          sql: `
            SELECT MIN(coverage.oldest) AS oldest
            FROM (
              SELECT MIN(address_balance_events.occurred_at_ms) AS oldest
              FROM address_balance_events
              JOIN tracked_addresses ON tracked_addresses.id = address_balance_events.address_id
              WHERE tracked_addresses.enabled = 1
                AND address_balance_events.finalized = 1
              UNION ALL
              SELECT MIN(address_balance_points.bucket_start_ms) AS oldest
              FROM address_balance_points
              JOIN tracked_addresses ON tracked_addresses.id = address_balance_points.address_id
              WHERE tracked_addresses.enabled = 1
                AND address_balance_points.granularity_seconds = 0
            ) AS coverage
          `
        })
      : null;
    const effectiveFromMs = fromMs === 0
      ? oldest?.oldest === null || oldest?.oldest === undefined
        ? toMs
        : Number(oldest.oldest)
      : fromMs;
    const bucketMs = granularitySeconds * 1_000;
    const buckets: number[] = [];
    for (let bucket = Math.floor(effectiveFromMs / bucketMs) * bucketMs; bucket <= toMs; bucket += bucketMs) {
      buckets.push(bucket);
    }
    if (buckets.at(-1) !== toMs) buckets.push(toMs);
    const denominationOptions = await enabledChartDenominations({ db: this.db });
    const configuredCurrencies = quoteCurrencies ?? await this.configuredTooltipCurrencies();
    const resolvedQuoteCurrencies = [...new Set([
      quoteCurrency.toUpperCase(),
      ...configuredCurrencies.map((currency) => currency.toUpperCase())
        .filter((currency) => /^[A-Z]{3}$/.test(currency))
    ])];
    const selectedAssetIds = [...new Set(addresses.flatMap((address) => (
      address.assets
        .filter((asset) => asset.enabled)
        .map((asset) => asset.canonicalAssetId)
    )))];
    const priceAssetIds = [
      ...selectedAssetIds,
      ...denominationOptions.map((option) => option.id)
    ];
    const quoteLookups = new Map(await Promise.all(resolvedQuoteCurrencies.map(async (currency) => [
      currency,
      await historicalPriceLookup({
        db: this.db,
        assetIds: priceAssetIds,
        quoteCurrency: currency,
        fromMs: effectiveFromMs,
        toMs,
        disagreementThresholdPercent: this.runtime.config.ui.defaultProviderDisagreementThresholdPercent
      })
    ] as const)));
    const priceAt = quoteLookups.get(quoteCurrency.toUpperCase())!;
    const denominationsAt = ({
      value,
      timestampMs
    }: {
      value: string | null;
      timestampMs: number;
    }) => Object.fromEntries(denominationOptions.map((option) => {
      const unitPrice = priceAt({ assetId: option.id, timestampMs });
      return [
        option.id,
        value === null || unitPrice === null || new Decimal(unitPrice).isZero()
          ? null
          : new Decimal(value).dividedBy(unitPrice).toString()
      ];
    }));
    const output: AddressValueSeries[] = [];
    for (const address of addresses) {
      const [rows, observations] = await Promise.all([
        this.db.query<EventRow>({
          sql: `
            SELECT id, address_id, canonical_asset_id, occurred_at_ms, ordering_key, quantity_delta
            FROM address_balance_events
            WHERE address_id = ? AND occurred_at_ms <= ? AND finalized = 1
              AND canonical_asset_id IN (
                SELECT canonical_asset_id
                FROM address_asset_selections
                WHERE address_id = ? AND enabled = 1
              )
            ORDER BY occurred_at_ms, ordering_key, id
          `,
          parameters: [address.id, toMs, address.id]
        }),
        this.db.query<{
          canonical_asset_id: string;
          bucket_start_ms: number | string;
          quantity: string;
        }>({
          sql: `
            SELECT canonical_asset_id, bucket_start_ms, quantity
            FROM address_balance_points
            WHERE address_id = ?
              AND granularity_seconds = 0
              AND bucket_start_ms <= ?
              AND canonical_asset_id IN (
                SELECT canonical_asset_id
                FROM address_asset_selections
                WHERE address_id = ? AND enabled = 1
              )
            ORDER BY canonical_asset_id, bucket_start_ms
          `,
          parameters: [address.id, toMs, address.id]
        })
      ]);
      const addressAssetIds = address.assets
        .filter((asset) => asset.enabled)
        .map((asset) => asset.canonicalAssetId);
      const balancePoints = reconstructBalance({
        events: rows.map((row) => ({
          id: row.id,
          assetId: row.canonical_asset_id,
          occurredAtMs: Number(row.occurred_at_ms),
          orderingKey: row.ordering_key,
          quantityDelta: row.quantity_delta
        })),
        buckets
      });
      const balanceByTimestampAsset = new Map(balancePoints.map((point) => [
        `${point.timestampMs}:${point.assetId}`,
        point.quantity
      ]));
      const observationsByAsset = Map.groupBy(
        observations,
        (observation) => observation.canonical_asset_id
      );
      const points: AddressValuePoint[] = [];
      for (const timestampMs of buckets) {
        const quantities: Record<string, string> = {};
        for (const assetId of addressAssetIds) {
          if (address.history.status === 'complete') {
            quantities[assetId] = balanceByTimestampAsset.get(`${timestampMs}:${assetId}`) ?? '0';
          }
          const observation = (observationsByAsset.get(assetId) ?? [])
            .findLast((candidate) => Number(candidate.bucket_start_ms) <= timestampMs);
          if (observation) quantities[assetId] = observation.quantity;
        }
        const balanceKnown = Object.keys(quantities).length > 0;
        const prices: Record<string, string | null> = {};
        for (const assetId of Object.keys(quantities)) {
          prices[assetId] = priceAt({ assetId, timestampMs });
        }
        const valuation = valueHoldings({ quantities, prices });
        const coveragePercent = addressAssetIds.length === 0
          ? '100'
          : new Decimal(valuation.pricedAssets)
            .dividedBy(addressAssetIds.length)
            .times(100)
            .toString();
        const quotes = Object.fromEntries(resolvedQuoteCurrencies.map((currency) => {
          if (!balanceKnown) return [currency, null];
          const lookup = quoteLookups.get(currency)!;
          const currencyPrices = Object.fromEntries(Object.keys(quantities).map((assetId) => [
            assetId,
            lookup({ assetId, timestampMs })
          ]));
          const quoted = valueHoldings({ quantities, prices: currencyPrices });
          return [
            currency,
            quoted.pricedAssets > 0 ? quoted.total : null
          ];
        }));
        points.push({
          timestampMs,
          value: balanceKnown ? valuation.total : null,
          coveragePercent,
          unpricedAssets: addressAssetIds.filter((assetId) => (
            quantities[assetId] === undefined || prices[assetId] === null
          )),
          quantities,
          quotes,
          denominations: denominationsAt({
            value: balanceKnown ? valuation.total : null,
            timestampMs
          })
        });
      }
      output.push({
        id: address.id,
        label: address.label,
        points
      });
    }
    const combinedPoints = buckets.map((timestampMs) => {
      const addressPoints = output
        .map((series) => series.points.find((point) => point.timestampMs === timestampMs))
        .filter((point): point is AddressValuePoint => point !== undefined);
      const quantityAssetIds = [...new Set(addressPoints.flatMap((point) => Object.keys(point.quantities)))];
      const knownValues = addressPoints
        .map((point) => point.value)
        .filter((pointValue): pointValue is string => pointValue !== null);
      const value = knownValues.length > 0
        ? Decimal.sum(0, ...knownValues).toString()
        : null;
      return {
        timestampMs,
        value,
        quantities: Object.fromEntries(quantityAssetIds.map((assetId) => [
          assetId,
          Decimal.sum(
            0,
            ...addressPoints.map((point) => point.quantities[assetId] ?? '0')
          ).toString()
        ])),
        quotes: Object.fromEntries(resolvedQuoteCurrencies.map((currency) => {
          const values = addressPoints
            .map((point) => point.quotes[currency])
            .filter((quote): quote is string => quote !== null);
          return [
            currency,
            values.length > 0 ? Decimal.sum(0, ...values).toString() : null
          ];
        })),
        denominations: denominationsAt({ value, timestampMs })
      };
    });
    const events = await addressEvents({
      db: this.db,
      addressIds: addresses.map((address) => address.id),
      fromMs: effectiveFromMs,
      toMs
    });
    return {
      quoteCurrency,
      range: {
        from: new Date(effectiveFromMs).toISOString(),
        to: new Date(toMs).toISOString()
      },
      granularitySeconds,
      stale: addresses.some((address) => address.history.status === 'stale'),
      partial: addresses.some((address) => ['partial', 'syncing', 'error', 'unavailable'].includes(address.history.status)),
      events,
      denominationOptions,
      series: [
        ...output,
        {
          id: 'combined',
          label: 'Combined addresses',
          points: combinedPoints
        }
      ]
    };
  }

  providerStatus() {
    return Object.fromEntries(
      [...this.adapters.entries()].map(([network, adapter]) => [
        network,
        {
          enabled: true,
          ...adapter.status()
        }
      ])
    );
  }
}
