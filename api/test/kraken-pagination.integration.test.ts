import { describe, expect, it, vi } from 'vitest';
import type { JobQueue } from '../src/jobs/queue.js';
import { KrakenService, type KrakenClientContract } from '../src/services/kraken.js';
import { createTestRuntime, openMigratedTestDatabase } from './helpers.js';

describe('Kraken read-only import', () => {
  it('persists a page cursor, resumes after interruption, and completes every paginated endpoint', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    let registered: Parameters<JobQueue['register']>[0] | null = null;
    const jobs = {
      register: vi.fn((registration: Parameters<JobQueue['register']>[0]) => {
        registered = registration;
      }),
      enqueue: vi.fn(async () => ({ coalesced: false, job: { id: 'reconcile' } }))
    } as unknown as JobQueue;
    const requests: Array<{ path: string; parameters: Record<string, string | number> }> = [];
    let failTradeSecondPage = true;
    let openOrderPresent = true;
    const client: KrakenClientContract = {
      isConfigured: () => true,
      inspectPermissions: async () => ({
        available: true,
        permissions: ['Query Funds', 'Query Closed Trades'],
        required: ['query-funds', 'query-open-trades', 'query-closed-trades', 'query-ledger'],
        missing: [],
        safe: true,
        unsafe: []
      }),
      privateQuery: async <T>({ path, parameters = {} }: {
        path: string;
        parameters?: Record<string, string | number>;
      }) => {
        requests.push({ path, parameters });
        if (path === '/0/private/TradesHistory') {
          const offset = Number(parameters.ofs ?? 0);
          if (offset === 2 && failTradeSecondPage) {
            failTradeSecondPage = false;
            throw new Error('fixture interruption');
          }
          const result = offset === 0
            ? {
                count: 3,
                trades: {
                  trade1: { pair: 'XXBTZCAD', type: 'buy', time: '1', vol: '1', price: '10', cost: '10', fee: '0.1' },
                  trade2: { pair: 'XETHZCAD', type: 'buy', time: '2', vol: '2', price: '20', cost: '40', fee: '0.2' }
                }
              }
            : {
                count: 3,
                trades: {
                  trade3: { pair: 'SOLCAD', type: 'sell', time: '3', vol: '3', price: '30', cost: '90', fee: '0.3' }
                }
              };
          return result as T;
        }
        if (path === '/0/private/Ledgers') {
          const offset = Number(parameters.ofs ?? 0);
          return (offset === 0
            ? {
                count: 2,
                ledger: {
                  ledger1: { asset: 'XXBT', type: 'deposit', time: '1', amount: '1', fee: '0', refid: 'tx1' }
                }
              }
            : {
                count: 2,
                ledger: {
                  ledger2: { asset: 'XETH', type: 'staking', time: '2', amount: '0.1', fee: '0' }
                }
              }) as T;
        }
        if (path === '/0/private/Earn/Allocations') {
          return (parameters.cursor
            ? {
                items: [{
                  strategy_id: 'earn2',
                  native_asset: 'ETH',
                  amount_allocated: { total: { native: '2' } },
                  total_rewarded: { native: '0.25' },
                  status: 'active'
                }]
              }
            : {
                items: [{ id: 'earn1', asset: 'XXBT', amount: '1', status: 'active' }],
                next_cursor: 'page-2'
              }) as T;
        }
        if (path === '/0/private/Earn/Strategies') {
          return {
            items: [
              {
                id: 'earn1',
                asset: 'XXBT',
                lock_type: { type: 'instant', payout_frequency: 604800 },
                apr_estimate: { low: '3', high: '4' },
                auto_compound: { type: 'enabled' }
              },
              {
                id: 'earn2',
                asset: 'ETH',
                lock_type: { type: 'bonded', payout_frequency: 604800 },
                apr_estimate: { low: '5', high: '6' },
                auto_compound: { type: 'enabled' }
              }
            ]
          } as T;
        }
        if (path === '/0/private/BalanceEx') {
          return {
            'DOT28.S': { balance: '10', hold_trade: '0' },
            XXDG: { balance: '100', hold_trade: '25' },
            ZCAD: { balance: '0', hold_trade: '0' }
          } as T;
        }
        if (path === '/0/private/OpenPositions') return {} as T;
        if (path === '/0/private/OpenOrders') {
          return {
            open: openOrderPresent ? {
              order1: {
                status: 'open',
                opentm: 4,
                vol: '2',
                vol_exec: '1',
                cost: '10',
                fee: '0.1'
              }
            } : {}
          } as T;
        }
        if (path === '/0/private/ClosedOrders') {
          return {
            count: 1,
            closed: {
              order2: {
                status: 'canceled',
                opentm: 2,
                closetm: 3,
                vol: '1',
                vol_exec: '0'
              }
            }
          } as T;
        }
        if (path === '/0/private/TradeBalance') {
          return {
            eb: '100',
            tb: '90',
            m: '0',
            n: '0',
            e: '90',
            mf: '90',
            ml: null
          } as T;
        }
        if (path === '/0/private/DepositStatus') {
          return [{
            refid: 'deposit1',
            txid: 'tx-deposit',
            asset: 'XXBT',
            amount: '1',
            time: 5,
            status: 'Success'
          }] as T;
        }
        if (path === '/0/private/WithdrawStatus') {
          return [{
            refid: 'withdrawal1',
            txid: 'tx-withdrawal',
            asset: 'XETH',
            amount: '1',
            time: 6,
            status: 'Pending'
          }] as T;
        }
        if (path === '/0/private/TradeVolume') {
          return {
            currency: 'ZUSD',
            volume: '1000',
            fees: {
              XXBTZCAD: {
                fee: '0.25',
                nextfee: '0.24',
                nextvolume: '10000'
              }
            }
          } as T;
        }
        if (path === '/0/private/CreditLines') {
          return {
            asset_details: {},
            limits_monitor: {
              total_credit_usd: '0',
              total_credit_used_usd: '0'
            }
          } as T;
        }
        if (
          path === '/0/private/Earn/AllocateStatus'
          || path === '/0/private/Earn/DeallocateStatus'
        ) {
          return { pending: false } as T;
        }
        throw new Error(`Unexpected fixture path: ${path}`);
      },
      status: () => ({ status: 'healthy' })
    };
    const service = new KrakenService(db, runtime, client, jobs);
    service.registerJobs();
    const handler = () => registered!.handler({
      job: {
        id: 'job',
        job_type: 'kraken.sync',
        resource_key: 'kraken:account',
        idempotency_key: 'fixture',
        status: 'running',
        priority: 1,
        payload_json: '{}',
        progress_current: 0,
        progress_total: 1,
        progress_cursor_json: '{}',
        attempt_count: 0,
        max_attempts: 3,
        next_attempt_at_ms: 0,
        last_error_json: null,
        locked_at_ms: null,
        created_at_ms: 0,
        updated_at_ms: 0,
        completed_at_ms: null
      },
      updateProgress: vi.fn(async () => undefined)
    });
    try {
      await expect(handler()).rejects.toThrow('fixture interruption');
      expect(await db.one<{ completeness: string; cursor_json: string }>({
        sql: "SELECT completeness, cursor_json FROM kraken_sync_cursors WHERE endpoint = 'trades'"
      })).toMatchObject({
        completeness: 'syncing',
        cursor_json: expect.stringContaining('"offset":2')
      });

      await db.run({
        sql: `
          INSERT INTO kraken_earn_allocations(
            id, allocation_id, asset_raw, canonical_asset_id, product_id,
            quantity, reward_quantity, state, captured_at_ms, raw_json
          ) VALUES (?, ?, '', '', ?, '0', NULL, 'active', ?, '{}')
        `,
        parameters: ['stale-earn-row', 'earn2', 'earn2', Date.now()]
      });

      await handler();
      expect(requests.filter((request) => request.path === '/0/private/TradesHistory')
        .map((request) => request.parameters.ofs)).toEqual([0, 2, 2]);
      expect(requests.filter((request) => request.path === '/0/private/Ledgers')
        .map((request) => request.parameters.ofs)).toEqual([0, 1]);
      expect(requests.filter((request) => request.path === '/0/private/Earn/Allocations')
        .map((request) => request.parameters.cursor ?? null)).toEqual([null, 'page-2']);
      expect(requests.filter((request) => request.path === '/0/private/Earn/Strategies'))
        .toHaveLength(1);
      expect(await db.one<{ count: number | string }>({
        sql: 'SELECT COUNT(*) AS count FROM kraken_trades'
      })).toEqual({ count: 3 });
      expect(await db.one<{ count: number | string }>({
        sql: 'SELECT COUNT(*) AS count FROM kraken_ledgers'
      })).toEqual({ count: 2 });
      expect(await db.one<{ count: number | string }>({
        sql: 'SELECT COUNT(*) AS count FROM kraken_earn_allocations'
      })).toEqual({ count: 2 });
      expect(await db.query<{
        allocation_id: string;
        asset_raw: string;
        canonical_asset_id: string;
        quantity: string;
        reward_quantity: string | null;
      }>({
        sql: `
          SELECT allocation_id, asset_raw, canonical_asset_id, quantity, reward_quantity
          FROM kraken_earn_allocations
          ORDER BY allocation_id
        `
      })).toEqual([
        {
          allocation_id: 'earn1',
          asset_raw: 'XXBT',
          canonical_asset_id: 'bitcoin',
          quantity: '1',
          reward_quantity: null
        },
        {
          allocation_id: 'earn2',
          asset_raw: 'ETH',
          canonical_asset_id: 'ethereum',
          quantity: '2',
          reward_quantity: '0.25'
        }
      ]);
      expect(await db.query<{
        strategy_id: string;
        canonical_asset_id: string;
        apy_low_percent: string;
        apy_high_percent: string;
      }>({
        sql: `
          SELECT strategy_id, canonical_asset_id, apy_low_percent, apy_high_percent
          FROM kraken_earn_strategy_rates
          ORDER BY strategy_id
        `
      })).toEqual([
        expect.objectContaining({
          strategy_id: 'earn1',
          canonical_asset_id: 'bitcoin',
          apy_low_percent: expect.any(String),
          apy_high_percent: expect.any(String)
        }),
        expect.objectContaining({
          strategy_id: 'earn2',
          canonical_asset_id: 'ethereum',
          apy_low_percent: expect.any(String),
          apy_high_percent: expect.any(String)
        })
      ]);
      expect(await db.query<{
        asset_raw: string;
        canonical_asset_id: string;
        category: string;
      }>({
        sql: `
          SELECT asset_raw, canonical_asset_id, category
          FROM kraken_snapshot_balances
          ORDER BY asset_raw
        `
      })).toEqual([
        { asset_raw: 'DOT28.S', canonical_asset_id: 'polkadot', category: 'earn' },
        { asset_raw: 'XXDG', canonical_asset_id: 'dogecoin', category: 'spot' },
        { asset_raw: 'ZCAD', canonical_asset_id: 'cad', category: 'spot' }
      ]);
      expect((await service.summary()).sections.earn).toBe(true);
      await db.run({
        sql: "UPDATE kraken_snapshot_balances SET canonical_asset_id = 'xxdg' WHERE asset_raw = 'XXDG'"
      });
      const snapshot = await db.one<{ captured_at_ms: number | string }>({
        sql: 'SELECT captured_at_ms FROM kraken_snapshots ORDER BY captured_at_ms DESC LIMIT 1'
      });
      for (const [id, assetId, quoteCurrency, close] of [
        ['dot-cad', 'polkadot', 'CAD', '5'],
        ['doge-cad', 'dogecoin', 'CAD', '0.1'],
        ['dot-usd', 'polkadot', 'USD', '4'],
        ['doge-usd', 'dogecoin', 'USD', '0.08']
      ] as const) {
        await db.run({
          sql: `
            INSERT INTO market_points(
              id, provider, canonical_asset_id, quote_currency, bucket_start_ms,
              granularity_seconds, data_kind, close_value, retrieved_at_ms
            ) VALUES (?, 'fixture', ?, ?, ?, 300, 'native', ?, ?)
          `,
          parameters: [
            id,
            assetId,
            quoteCurrency,
            Number(snapshot!.captured_at_ms),
            close,
            Number(snapshot!.captured_at_ms)
          ]
        });
      }
      const krakenSeries = await service.series({
        fromMs: 0,
        toMs: Date.now(),
        quoteCurrencies: ['CAD', 'USD']
      });
      expect(krakenSeries.series.map((item) => item.id)).toEqual(expect.arrayContaining([
        'kraken-total',
        'kraken-asset:polkadot',
        'kraken-asset:dogecoin'
      ]));
      expect(krakenSeries.series.map((item) => item.id)).not.toContain('kraken-asset:xxdg');
      expect(krakenSeries.series.find((item) => item.id === 'kraken-total')?.points).toEqual([
        expect.objectContaining({
          value: expect.any(String),
          coveragePercent: expect.any(String),
          quantities: expect.objectContaining({
            dogecoin: '100',
            polkadot: '10'
          })
        })
      ]);
      expect(krakenSeries.series.find((item) => item.id === 'kraken-asset:dogecoin')?.points[0])
        .toEqual(expect.objectContaining({
          value: '10',
          quotes: {
            CAD: '10',
            USD: '8'
          },
          quantities: {
            dogecoin: '100'
          }
        }));
      expect(krakenSeries.series.find((item) => item.id === 'kraken-asset:polkadot')?.points[0])
        .toEqual(expect.objectContaining({
          value: '50',
          quotes: {
            CAD: '50',
            USD: '40'
          }
        }));
      expect(krakenSeries.series.find((item) => item.id === 'kraken-total')?.points[0])
        .toEqual(expect.objectContaining({
          value: '60',
          quotes: {
            CAD: '60',
            USD: '48'
          }
        }));
      expect(await service.summary({ quoteCurrencies: ['CAD', 'USD'] }))
        .toEqual(expect.objectContaining({
          values: {
            CAD: '60',
            USD: '48'
          }
        }));
      const earnOverview = await service.earnOverview({
        fromMs: 0,
        toMs: Date.now(),
        quoteCurrencies: ['CAD', 'USD']
      });
      expect(earnOverview.summary).toMatchObject({
        assetCount: 3,
        totalRewardValue: expect.any(String),
        pricedRewardAssetCount: expect.any(Number),
        allocationCount: 2,
        values: expect.objectContaining({
          CAD: expect.anything(),
          USD: expect.anything()
        }),
        rewardValues: expect.objectContaining({
          CAD: expect.anything(),
          USD: expect.anything()
        })
      });
      expect(earnOverview.apySeries.length).toBeGreaterThan(0);
      expect(earnOverview.assets.find((asset) => asset.assetId === 'ethereum'))
        .toEqual(expect.objectContaining({
          currentValues: expect.objectContaining({ CAD: null, USD: null }),
          apyLowPercent: expect.any(String),
          apyHighPercent: expect.any(String)
        }));
      expect(earnOverview.series.map((item) => item.id)).toEqual(expect.arrayContaining([
        'kraken-earn-total',
        'kraken-earn:ethereum',
        'kraken-earn:polkadot'
      ]));
      expect(earnOverview.series.find((item) => item.id === 'kraken-earn:ethereum')?.points)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            value: null,
            quantities: { ethereum: '2' }
          })
        ]));
      expect(earnOverview.assets.map((asset) => asset.assetId)).toEqual(expect.arrayContaining([
        'bitcoin',
        'ethereum',
        'polkadot'
      ]));
      expect(earnOverview.activity).toEqual(expect.arrayContaining([
        expect.objectContaining({
          category: 'reward',
          asset: 'ethereum'
        })
      ]));
      expect(earnOverview.payoutDistribution).toEqual(expect.arrayContaining([
        expect.objectContaining({
          assetId: 'ethereum',
          quantity: '0.1',
          payoutCount: 1
        })
      ]));
      expect(await db.query<{ endpoint: string; completeness: string }>({
        sql: 'SELECT endpoint, completeness FROM kraken_sync_cursors ORDER BY endpoint'
      })).toEqual([
        { endpoint: 'closed-orders', completeness: 'complete' },
        { endpoint: 'credit-lines', completeness: 'complete' },
        { endpoint: 'deposit-status', completeness: 'complete' },
        { endpoint: 'earn', completeness: 'complete' },
        { endpoint: 'earn-operation-status', completeness: 'complete' },
        { endpoint: 'earn-strategies', completeness: 'complete' },
        { endpoint: 'extended-balances', completeness: 'complete' },
        { endpoint: 'ledgers', completeness: 'complete' },
        { endpoint: 'margin', completeness: 'complete' },
        { endpoint: 'open-orders', completeness: 'complete' },
        { endpoint: 'trade-balance', completeness: 'complete' },
        { endpoint: 'trade-volume', completeness: 'complete' },
        { endpoint: 'trades', completeness: 'complete' },
        { endpoint: 'withdraw-status', completeness: 'complete' }
      ]);
      expect(await db.query<{
        endpoint: string;
        entity_id: string;
        present: number | string;
      }>({
        sql: `
          SELECT endpoint, entity_id, present
          FROM kraken_account_observations
          ORDER BY endpoint, entity_id
        `
      })).toEqual(expect.arrayContaining([
        { endpoint: 'credit-lines', entity_id: 'account', present: 1 },
        { endpoint: 'deposit-status', entity_id: 'deposit1', present: 1 },
        { endpoint: 'earn-allocations', entity_id: 'earn1', present: 1 },
        { endpoint: 'earn-allocations', entity_id: 'earn2', present: 1 },
        { endpoint: 'extended-balances', entity_id: 'XXDG', present: 1 },
        { endpoint: 'open-orders', entity_id: 'order1', present: 1 },
        { endpoint: 'closed-orders', entity_id: 'order2', present: 1 },
        { endpoint: 'trade-balance', entity_id: 'CAD', present: 1 },
        { endpoint: 'withdraw-status', entity_id: 'withdrawal1', present: 1 }
      ]));
      const observationCount = await db.one<{ count: number | string }>({
        sql: 'SELECT COUNT(*) AS count FROM kraken_account_observations'
      });
      await handler();
      expect(await db.one<{ count: number | string }>({
        sql: 'SELECT COUNT(*) AS count FROM kraken_account_observations'
      })).toEqual(observationCount);
      openOrderPresent = false;
      await handler();
      expect(await db.query<{ present: number | string }>({
        sql: `
          SELECT present
          FROM kraken_account_observations
          WHERE endpoint = 'open-orders' AND entity_id = 'order1'
          ORDER BY observed_at_ms
        `
      })).toEqual([{ present: 1 }, { present: 0 }]);
      expect(requests.map((request) => request.path).every((path) => path.startsWith('/0/private/'))).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('carries every staked asset through later Earn events when reconstructing the total', async () => {
    const { db, runtime } = await openMigratedTestDatabase();
    const client = {
      isConfigured: () => false,
      inspectPermissions: vi.fn(),
      privateQuery: vi.fn(),
      status: () => ({})
    } as unknown as KrakenClientContract;
    const jobs = {
      register: vi.fn(),
      enqueue: vi.fn()
    } as unknown as JobQueue;
    const service = new KrakenService(db, runtime, client, jobs);
    try {
      await db.run({
        sql: `
          INSERT INTO kraken_sync_cursors(
            endpoint, cursor_json, completeness, oldest_at_ms,
            newest_at_ms, last_success_at_ms, updated_at_ms
          ) VALUES ('ledgers', '{}', 'complete', 1000, 2000, 2000, 2000)
        `
      });
      for (const [id, raw, assetId, timestampMs, amount] of [
        ['ledger-dot', 'DOT28.S', 'polkadot', 1_000, '10'],
        ['ledger-eth', 'ETH2.S', 'ethereum', 2_000, '1']
      ] as const) {
        await db.run({
          sql: `
            INSERT INTO kraken_ledgers(
              id, kraken_id, asset_raw, canonical_asset_id, event_type,
              subtype, occurred_at_ms, amount, raw_json
            ) VALUES (?, ?, ?, ?, 'transfer', 'spottostaking', ?, ?, '{}')
          `,
          parameters: [id, id, raw, assetId, timestampMs, amount]
        });
      }
      for (const [id, assetId, timestampMs, close] of [
        ['dot-1', 'polkadot', 1_000, '5'],
        ['dot-2', 'polkadot', 2_000, '5'],
        ['eth-1', 'ethereum', 1_000, '20'],
        ['eth-2', 'ethereum', 2_000, '20']
      ] as const) {
        await db.run({
          sql: `
            INSERT INTO market_points(
              id, provider, canonical_asset_id, quote_currency, bucket_start_ms,
              granularity_seconds, data_kind, close_value, retrieved_at_ms
            ) VALUES (?, 'fixture', ?, 'CAD', ?, 60, 'native', ?, ?)
          `,
          parameters: [id, assetId, timestampMs, close, timestampMs]
        });
      }
      const overview = await service.earnOverview({
        fromMs: 1_000,
        toMs: 3_000,
        granularitySeconds: 60,
        quoteCurrencies: ['CAD']
      });
      expect(overview.series.find((item) => item.id === 'kraken-earn-total')?.points)
        .toEqual([
          expect.objectContaining({ timestampMs: 1_000 }),
          expect.objectContaining({
            timestampMs: 3_000,
            value: '70',
            quantities: {
              ethereum: '1',
              polkadot: '10'
            }
          })
        ]);
      expect(overview.series.find((item) => item.id === 'kraken-earn:polkadot')?.points)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            timestampMs: 3_000,
            quantities: { polkadot: '10' }
          })
        ]));
      expect(overview.events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          category: 'stake',
          timestampMs: 2_000,
          asset: 'ethereum'
        })
      ]));
      expect(overview.coverage.ledgerComplete).toBe(true);
      expect(overview.granularitySeconds).toBe(60);
    } finally {
      await db.close();
    }
  });

  it('calculates and stores estimates in the configured primary currency', async () => {
    const runtime = await createTestRuntime({
      config: {
        ui: {
          defaultPrimaryCurrency: 'AUD'
        }
      }
    });
    const { db } = await openMigratedTestDatabase({ runtime });
    const jobs = {
      register: vi.fn(),
      enqueue: vi.fn()
    } as unknown as JobQueue;
    const client = {
      isConfigured: () => false,
      inspectPermissions: async () => ({
        available: false,
        permissions: [],
        required: [],
        missing: [],
        safe: false,
        unsafe: []
      }),
      privateQuery: vi.fn(),
      status: () => ({ status: 'unconfigured' })
    } as unknown as KrakenClientContract;
    const service = new KrakenService(db, runtime, client, jobs);

    try {
      const result = await service.pnl({ method: 'acb' });
      expect(result).toMatchObject({
        currency: 'AUD',
        realisedPnl: '0'
      });
      expect(await db.one<{ currency: string }>({
        sql: 'SELECT currency FROM calculation_runs ORDER BY completed_at_ms DESC LIMIT 1'
      })).toEqual({ currency: 'AUD' });
    } finally {
      await db.close();
    }
  });
});
