import { describe, expect, it, vi } from 'vitest';
import type { JobQueue } from '../src/jobs/queue.js';
import { createChainAdapters } from '../src/providers/chains.js';
import { AddressService } from '../src/services/addresses.js';
import { openMigratedTestDatabase } from './helpers.js';

describe('enabled address mainnets', () => {
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
});
