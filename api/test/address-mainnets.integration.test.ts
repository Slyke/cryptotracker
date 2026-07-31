import { describe, expect, it, vi } from 'vitest';
import type { JobHandler, JobQueue, JobRecord } from '../src/jobs/queue.js';
import { createChainAdapters, type ChainAdapter } from '../src/providers/chains.js';
import { AddressService } from '../src/services/addresses.js';
import { openMigratedTestDatabase } from './helpers.js';

describe('enabled address mainnets', () => {
  it('tracks ETH and an ERC-20 separately for the same address without double-counting native ETH', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    const jobs = {
      register: vi.fn(),
      enqueue: vi.fn()
    } as unknown as JobQueue;
    const service = new AddressService(db, runtime, new Map(), jobs);
    const address = '0x0000000000000000000000000000000000000001';
    try {
      const shib = await service.add({
        network: 'ethereum' as const,
        address,
        label: 'SHIB wallet',
        includeNative: false,
        assets: [{
          canonicalAssetId: 'shiba-inu',
          contractOrMint: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE'
        }]
      });
      const now = Date.now();
      await db.run({
        sql: `
          INSERT INTO address_asset_selections(
            id, address_id, canonical_asset_id, contract_or_mint,
            enabled, created_at_ms, updated_at_ms
          ) VALUES (?, ?, 'ethereum', NULL, 1, ?, ?)
        `,
        parameters: ['legacy-native-selection', shib.id, now, now]
      });

      await service.add({
        network: 'ethereum',
        address,
        label: 'ETH wallet',
        assets: []
      });

      expect(await db.query<{
        label: string;
        canonical_asset_id: string;
        contract_or_mint: string | null;
        selection_enabled: number;
      }>({
        sql: `
          SELECT tracked_addresses.label,
                 address_asset_selections.canonical_asset_id,
                 address_asset_selections.contract_or_mint,
                 address_asset_selections.enabled AS selection_enabled
          FROM tracked_addresses
          JOIN address_asset_selections
            ON address_asset_selections.address_id = tracked_addresses.id
          ORDER BY tracked_addresses.label, address_asset_selections.canonical_asset_id
        `
      })).toEqual([
        {
          label: 'ETH wallet',
          canonical_asset_id: 'ethereum',
          contract_or_mint: null,
          selection_enabled: 1
        },
        {
          label: 'SHIB wallet',
          canonical_asset_id: 'ethereum',
          contract_or_mint: null,
          selection_enabled: 0
        },
        {
          label: 'SHIB wallet',
          canonical_asset_id: 'shiba-inu',
          contract_or_mint: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
          selection_enabled: 1
        }
      ]);
      await expect(service.add({
        network: 'ethereum',
        address,
        label: 'Duplicate ETH wallet',
        assets: []
      })).rejects.toMatchObject({
        errorKey: 'RESOURCE_CONFLICT',
        status: 409,
        message: 'ethereum is already tracked for that ethereum address.'
      });
    } finally {
      await db.close();
    }
  });

  it('shows only networks represented by enabled assets and reports provider availability', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    const now = Date.now();
    const assets = [
      ['bitcoin', 'BTC', 'Bitcoin', 'bitcoin', 0],
      ['dogecoin', 'DOGE', 'Dogecoin', 'dogecoin', 1],
      ['polkadot', 'DOT', 'Polkadot', 'polkadot', 1],
      ['shiba-inu', 'SHIB', 'Shiba Inu', null, 1],
      ['solana', 'SOL', 'Solana', 'solana', 0]
    ] as const;
    try {
      for (const [canonicalId, symbol, name, network, enabled] of assets) {
        await db.run({
          sql: `
            INSERT INTO watched_assets(
              id, canonical_id, symbol, name, network, contract_or_mint,
              enabled, created_at_ms, updated_at_ms
            ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
          `,
          parameters: [
            `asset-${canonicalId}`,
            canonicalId,
            symbol,
            name,
            network,
            enabled,
            now,
            now
          ]
        });
      }
      const jobs = {
        register: vi.fn(),
        enqueue: vi.fn()
      } as unknown as JobQueue;
      const service = new AddressService(
        db,
        runtime,
        createChainAdapters({
          config: runtime.config,
          secrets: runtime.secrets
        }),
        jobs
      );
      const result = await service.networkOptions();
      expect(result.mainnets.map((mainnet) => mainnet.id)).toEqual([
        'dogecoin',
        'ethereum',
        'polkadot'
      ]);
      expect(result.mainnets.find((mainnet) => mainnet.id === 'dogecoin')).toMatchObject({
        supported: true,
        enabledAssets: [{ id: 'dogecoin', symbol: 'DOGE' }]
      });
      expect(result.mainnets.find((mainnet) => mainnet.id === 'ethereum')).toMatchObject({
        supported: true,
        reason: null,
        enabledAssets: [{ id: 'shiba-inu', symbol: 'SHIB' }]
      });
      expect(result.mainnets.find((mainnet) => mainnet.id === 'polkadot')).toMatchObject({
        supported: false,
        enabledAssets: [{ id: 'polkadot', symbol: 'DOT' }]
      });
      expect(result.unmappedAssets).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('queues a current-balance refresh and does not invent zero before it succeeds', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    const now = Date.now();
    const jobs = {
      register: vi.fn(),
      enqueue: vi.fn(async () => ({ coalesced: false, job: { id: 'address-refresh' } }))
    } as unknown as JobQueue;
    const service = new AddressService(
      db,
      runtime,
      createChainAdapters({
        config: runtime.config,
        secrets: runtime.secrets
      }),
      jobs
    );
    try {
      await db.run({
        sql: `
          INSERT INTO tracked_addresses(
            id, network, address, normalized_address, label, enabled, created_at_ms, updated_at_ms
          ) VALUES (?, 'ethereum', ?, ?, 'Ethereum wallet', 1, ?, ?)
        `,
        parameters: [
          'address-ethereum',
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000001',
          now,
          now
        ]
      });
      await db.run({
        sql: `
          INSERT INTO address_sync_state(
            address_id, status, cursor_json, oldest_reconstructed_at_ms,
            provider_boundary_json, warnings_json, last_success_at_ms, updated_at_ms
          ) VALUES (?, 'complete', '{"newestBlock":123}', ?, '{}', '[]', ?, ?)
        `,
        parameters: ['address-ethereum', now - 1_000, now, now]
      });

      const result = await service.replaceAssets({
        id: 'address-ethereum',
        assets: [{
          canonicalAssetId: 'shiba-inu',
          contractOrMint: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE'
        }]
      });
      await service.replaceAssets({
        id: 'address-ethereum',
        assets: [{
          canonicalAssetId: 'shiba-inu',
          contractOrMint: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE'
        }]
      });

      expect(result.refresh).toMatchObject({
        coalesced: false,
        job: { id: 'address-refresh' }
      });
      expect(jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        jobType: 'address.sync',
        resourceKey: 'address:address-ethereum'
      }));
      expect(await db.one<{
        status: string;
        cursor_json: string;
        oldest_reconstructed_at_ms: number | null;
      }>({
        sql: `
          SELECT status, cursor_json, oldest_reconstructed_at_ms
          FROM address_sync_state
          WHERE address_id = ?
        `,
        parameters: ['address-ethereum']
      })).toEqual({
        status: 'syncing',
        cursor_json: '{}',
        oldest_reconstructed_at_ms: null
      });
      expect(await db.one<{ selection_count: number }>({
        sql: `
          SELECT COUNT(*) AS selection_count
          FROM address_asset_selections
          WHERE address_id = ? AND canonical_asset_id = 'ethereum'
        `,
        parameters: ['address-ethereum']
      })).toEqual({ selection_count: 1 });
      expect((await service.holdings({ quoteCurrency: 'CAD' })).map((holding) => ({
        assetId: holding.assetId,
        quantity: holding.quantity,
        currentValue: holding.currentValue,
        balanceObserved: holding.balanceObserved,
        completeness: holding.completeness
      }))).toEqual([
        {
          assetId: 'ethereum',
          quantity: null,
          currentValue: null,
          balanceObserved: false,
          completeness: 'syncing'
        },
        {
          assetId: 'shiba-inu',
          quantity: null,
          currentValue: null,
          balanceObserved: false,
          completeness: 'syncing'
        }
      ]);
      await db.run({
        sql: `
          INSERT INTO asset_catalog(
            canonical_id, symbol, name, network, contract_or_mint,
            source, updated_at_ms
          ) VALUES (
            'shiba-inu', 'SHIB', 'Shiba Inu', 'ethereum',
            '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE',
            'fixture', ?
          )
        `,
        parameters: [now]
      });
      await db.run({
        sql: `
          INSERT INTO address_balance_points(
            id, address_id, canonical_asset_id, bucket_start_ms,
            granularity_seconds, quantity, price_coverage
          ) VALUES (
            'shib-observation', 'address-ethereum', 'shiba-inu', ?,
            0, '552733073', 'balance_observed'
          )
        `,
        parameters: [now]
      });
      for (const [id, currency, close] of [
        ['shib-cad', 'CAD', '0.0000046'],
        ['shib-usd', 'USD', '0.0000034']
      ] as const) {
        await db.run({
          sql: `
            INSERT INTO market_points(
              id, provider, canonical_asset_id, quote_currency,
              bucket_start_ms, granularity_seconds, data_kind,
              close_value, retrieved_at_ms
            ) VALUES (?, 'fixture', 'shiba-inu', ?, ?, 300, 'native', ?, ?)
          `,
          parameters: [id, currency, now, close, now]
        });
      }
      const shib = (await service.holdings({
        quoteCurrency: 'CAD',
        quoteCurrencies: ['CAD', 'USD']
      })).find((holding) => holding.assetId === 'shiba-inu');
      expect(shib).toMatchObject({
        assetSymbol: 'SHIB',
        assetName: 'Shiba Inu',
        quantity: '552733073',
        currentValue: '2542.5721358',
        currentValues: {
          CAD: '2542.5721358',
          USD: '1879.2924482'
        },
        balanceObserved: true
      });
    } finally {
      await db.close();
    }
  });

  it('updates a UTXO event in place when it confirms and excludes it while pending', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    const now = Date.now();
    let finalized = false;
    let syncHandler: JobHandler | null = null;
    const jobs = {
      register: vi.fn(({ jobType, handler }: { jobType: string; handler: JobHandler }) => {
        if (jobType === 'address.sync') syncHandler = handler;
      }),
      enqueue: vi.fn(async () => ({ coalesced: false, job: { id: 'queued' } }))
    } as unknown as JobQueue;
    const adapter: ChainAdapter = {
      network: 'bitcoin',
      fetchHistory: async () => ({
        transactions: [{
          transactionId: 'tx-1',
          blockReference: finalized ? '100' : null,
          transactionPosition: null,
          occurredAtMs: now,
          confirmationState: finalized ? 'finalized' : 'unconfirmed',
          rawSummary: {},
          warning: null
        }],
        events: [{
          transactionId: 'tx-1',
          canonicalAssetId: 'bitcoin',
          occurredAtMs: now,
          orderingKey: finalized ? '100:tx-1' : 'unconfirmed:tx-1',
          quantityDelta: '1',
          feeQuantity: null,
          eventType: 'receive',
          finalized,
          provenance: { provider: 'fixture' }
        }],
        cursor: {},
        completeness: 'complete',
        providerBoundary: {},
        warnings: []
      }),
      status: () => ({
        status: 'healthy',
        consecutiveFailures: 0,
        cooldownUntilMs: 0,
        lastSuccessAtMs: null,
        lastFailureAtMs: null
      })
    };
    const service = new AddressService(
      db,
      runtime,
      new Map([['bitcoin', adapter]]),
      jobs
    );
    try {
      await db.run({
        sql: `
          INSERT INTO tracked_addresses(
            id, network, address, normalized_address, label, enabled, created_at_ms, updated_at_ms
          ) VALUES ('address-bitcoin', 'bitcoin', 'fixture', 'fixture', 'Bitcoin wallet', 1, ?, ?)
        `,
        parameters: [now, now]
      });
      await db.run({
        sql: `
          INSERT INTO address_asset_selections(
            id, address_id, canonical_asset_id, contract_or_mint, enabled, created_at_ms, updated_at_ms
          ) VALUES ('selection-bitcoin', 'address-bitcoin', 'bitcoin', NULL, 1, ?, ?)
        `,
        parameters: [now, now]
      });
      await db.run({
        sql: `
          INSERT INTO address_sync_state(
            address_id, status, cursor_json, provider_boundary_json, warnings_json, updated_at_ms
          ) VALUES ('address-bitcoin', 'syncing', '{}', '{}', '[]', ?)
        `,
        parameters: [now]
      });
      service.registerJobs();
      expect(syncHandler).not.toBeNull();
      const runSync = async () => syncHandler!({
        job: {
          payload_json: JSON.stringify({ addressId: 'address-bitcoin' })
        } as JobRecord,
        updateProgress: async () => undefined
      });

      await runSync();
      expect(await db.one<{ count: number; finalized: number }>({
        sql: 'SELECT COUNT(*) AS count, MAX(finalized) AS finalized FROM address_balance_events'
      })).toEqual({ count: 1, finalized: 0 });
      expect((await service.holdings({ quoteCurrency: 'CAD' }))[0]?.quantity).toBe('0');

      finalized = true;
      await runSync();
      expect(await db.one<{ count: number; finalized: number }>({
        sql: 'SELECT COUNT(*) AS count, MAX(finalized) AS finalized FROM address_balance_events'
      })).toEqual({ count: 1, finalized: 1 });
      expect((await service.holdings({ quoteCurrency: 'CAD' }))[0]?.quantity).toBe('1');
    } finally {
      await db.close();
    }
  });
});
