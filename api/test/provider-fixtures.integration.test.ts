import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapApplicationData } from '../src/services/bootstrap.js';
import { createChainAdapters } from '../src/providers/chains.js';
import { createMarketProviders, marketProviderInternals } from '../src/providers/market.js';
import { MarketService } from '../src/services/market.js';
import type { MarketProviderAdapter } from '../src/providers/market.js';
import type { JobQueue } from '../src/jobs/queue.js';
import { createTestRuntime, openMigratedTestDatabase } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Coinbase historical backfill', () => {
  it('splits Coinbase backfills into persistent 300-candle windows', async () => {
    const runtime = await createTestRuntime();
    const { db } = await openMigratedTestDatabase({ runtime });
    await bootstrapApplicationData({ db, runtime });
    const requested: Array<{
      fromMs: number;
      toMs: number;
      pairId: string;
      quoteCurrency: string;
    }> = [];
    const adapter: MarketProviderAdapter = {
      provider: 'coinbase',
      fetchCandles: async ({ pair, fromMs, toMs }) => {
        requested.push({
          fromMs,
          toMs,
          pairId: pair.pairId,
          quoteCurrency: pair.quoteCurrency
        });
        return [{
          bucketStartMs: fromMs,
          granularitySeconds: 60,
          open: '100',
          high: '101',
          low: '99',
          close: '100',
          volume: '1',
          finalized: true,
          dataKind: 'native',
          provenance: {
            endpoint: 'fixture'
          }
        }];
      },
      status: () => ({
        status: 'healthy',
        consecutiveFailures: 0,
        cooldownUntilMs: 0,
        lastSuccessAtMs: null,
        lastFailureAtMs: null
      })
    };
    const enqueue = vi.fn();
    const jobs = {
      enqueue,
      register: vi.fn()
    } as unknown as JobQueue;
    const market = new MarketService(db, runtime, new Map([['coinbase', adapter]]), jobs);
    const minuteMs = 60_000;
    try {
      const result = await market.synchronizeRange({
        provider: 'coinbase',
        canonicalAssetId: 'bitcoin',
        quoteCurrency: 'CAD',
        fromMs: 0,
        toMs: 600 * minuteMs,
        granularitySeconds: 60
      });
      expect(requested).toEqual([
        {
          fromMs: 0,
          toMs: 299 * minuteMs,
          pairId: 'BTC-USD',
          quoteCurrency: 'USD'
        },
        {
          fromMs: 300 * minuteMs,
          toMs: 599 * minuteMs,
          pairId: 'BTC-USD',
          quoteCurrency: 'USD'
        },
        {
          fromMs: 600 * minuteMs,
          toMs: 600 * minuteMs,
          pairId: 'BTC-USD',
          quoteCurrency: 'USD'
        }
      ]);
      expect(result).toEqual({
        insertedOrUpdated: 3,
        windowsProcessed: 3
      });
      expect(await db.one<{ count: number | string; quote_currency: string }>({
        sql: "SELECT COUNT(*) AS count, MIN(quote_currency) AS quote_currency FROM market_points WHERE provider = 'coinbase'"
      })).toMatchObject({ count: 3, quote_currency: 'USD' });

      await market.queueBackfill({
        provider: 'coinbase',
        canonicalAssetId: 'bitcoin',
        quoteCurrency: 'CAD',
        fromMs: 0,
        toMs: minuteMs,
        granularitySeconds: 60
      });
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        resourceKey: 'coinbase:bitcoin:USD:60',
        payload: expect.objectContaining({
          quoteCurrency: 'USD'
        })
      }));

      const alreadyCovered = await market.queueBackfillIfNeeded({
        provider: 'coinbase',
        canonicalAssetId: 'bitcoin',
        quoteCurrency: 'CAD',
        fromMs: 0,
        toMs: minuteMs,
        granularitySeconds: 60
      });
      expect(alreadyCovered).toMatchObject({
        skipped: true,
        reason: 'Cached history already reaches the requested start.'
      });
      expect(enqueue).toHaveBeenCalledTimes(1);

      await market.queueBackfillIfNeeded({
        provider: 'coinbase',
        canonicalAssetId: 'bitcoin',
        quoteCurrency: 'CAD',
        fromMs: 0,
        toMs: 90 * 24 * 60 * minuteMs,
        granularitySeconds: 3_600
      });
      expect(enqueue).toHaveBeenCalledTimes(2);
      expect(enqueue).toHaveBeenLastCalledWith(expect.objectContaining({
        resourceKey: 'coinbase:bitcoin:USD:3600'
      }));
    } finally {
      await db.close();
    }
  });
});

describe('recorded provider fixtures', () => {
  it('chunks CoinGecko intraday history and records the cadence it actually returned', () => {
    const dayMs = 24 * 60 * 60_000;
    expect(marketProviderInternals.coingeckoRequestWindows({
      fromMs: 0,
      toMs: 90 * dayMs,
      granularitySeconds: 3_600
    })).toEqual([
      { fromMs: 0, toMs: 30 * dayMs },
      { fromMs: 30 * dayMs, toMs: 60 * dayMs },
      { fromMs: 60 * dayMs, toMs: 90 * dayMs }
    ]);
    expect(marketProviderInternals.coingeckoObservedGranularity({
      timestamps: [0, dayMs, 2 * dayMs, 3 * dayMs],
      requested: 3_600
    })).toBe(86_400);
    expect(marketProviderInternals.coingeckoObservedGranularity({
      timestamps: [0, 3_600_000, 7_200_000],
      requested: 3_600
    })).toBe(3_600);
    expect(marketProviderInternals.coingeckoObservedGranularity({
      timestamps: [0, 3_600_000, 7_200_000],
      requested: 86_400
    })).toBe(3_600);
  });

  it('preserves configured API path prefixes and derives CoinGecko OHLC honestly', async () => {
    const runtime = await createTestRuntime();
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      requested.push(String(input));
      return new Response(JSON.stringify({
        prices: [
          [1_000, 10.125],
          [2_000, 11.375],
          [60_000, 12.5]
        ],
        total_volumes: [
          [1_000, 100]
        ]
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }));
    const provider = createMarketProviders({
      config: runtime.config,
      secrets: runtime.secrets
    }).get('coingecko')!;
    const candles = await provider.fetchCandles({
      pair: {
        canonicalAssetId: 'bitcoin',
        quoteCurrency: 'CAD',
        providerAssetId: 'bitcoin',
        providerSymbol: 'btc',
        pairId: 'bitcoin'
      },
      fromMs: 0,
      toMs: 60_000,
      granularitySeconds: 60
    });
    expect(requested[0]).toContain('api.coingecko.com/api/v3/coins/bitcoin/market_chart/range');
    expect(candles[0]).toMatchObject({
      open: '10.125',
      high: '11.375',
      close: '11.375',
      dataKind: 'derived'
    });
    expect(candles[1]).toMatchObject({
      open: '12.5',
      high: '12.5',
      low: '12.5',
      close: '12.5',
      dataKind: 'derived'
    });
  });


  it('uses the keyless Coinbase candle endpoint and normalizes native candles', async () => {
    const runtime = await createTestRuntime();
    const requested: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      requested.push(new URL(String(input)));
      return new Response(JSON.stringify([
        [120, 100, 105, 101, 104, 8],
        [60, 98, 103, 99, 102, 7],
        [0, 97, 101, 98, 100, 6]
      ]), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }));
    const provider = createMarketProviders({
      config: runtime.config,
      secrets: runtime.secrets
    }).get('coinbase')!;
    const candles = await provider.fetchCandles({
      pair: {
        canonicalAssetId: 'bitcoin',
        quoteCurrency: 'USD',
        providerAssetId: 'BTC',
        providerSymbol: 'BTC',
        pairId: 'BTC-USD'
      },
      fromMs: 0,
      toMs: 60_000,
      granularitySeconds: 60
    });

    expect(requested[0]?.pathname).toBe('/products/BTC-USD/candles');
    expect(requested[0]?.searchParams.get('granularity')).toBe('60');
    expect(requested[0]?.searchParams.get('start')).toBe('1970-01-01T00:00:00.000Z');
    expect(requested[0]?.searchParams.get('end')).toBe('1970-01-01T00:02:00.000Z');
    expect(candles.map((candle) => candle.bucketStartMs)).toEqual([0, 60_000]);
    expect(candles[1]).toMatchObject({
      open: '99',
      high: '103',
      low: '98',
      close: '102',
      volume: '7',
      dataKind: 'native'
    });
  });

  it('uses the Esplora tip fixture for finality and returns a resumable cursor', async () => {
    const runtime = await createTestRuntime();
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/api/blocks/tip/height')) {
        return new Response('110', { status: 200 });
      }
      return new Response(JSON.stringify([{
        txid: 'tx-1',
        status: {
          confirmed: true,
          block_height: 105,
          block_time: 1
        },
        vin: [],
        vout: [{
          scriptpubkey_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
          value: 20_000_000
        }],
        fee: 1_000
      }]), {
        status: 200,
        headers: {
          'content-type': 'application/json'
        }
      });
    }));
    const adapter = createChainAdapters({
      config: runtime.config,
      secrets: runtime.secrets
    }).get('bitcoin')!;
    const result = await adapter.fetchHistory({
      address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
      selectedAssets: [{
        canonicalAssetId: 'bitcoin',
        contractOrMint: null
      }],
      cursor: {}
    });
    expect(requested).toEqual(expect.arrayContaining([
      expect.stringContaining('/api/address/1BoatSLRHtKNngkdXEeobR76b53LETtpyT/txs'),
      expect.stringContaining('/api/blocks/tip/height')
    ]));
    expect(result.transactions[0]?.confirmationState).toBe('finalized');
    expect(result.events[0]?.quantityDelta).toBe('0.2');
    expect(result.cursor).toMatchObject({
      lastSeenTxid: 'tx-1',
      backfillComplete: true
    });
  });

  it('imports Dogecoin history through the read-only BlockCypher address endpoint', async () => {
    const runtime = await createTestRuntime();
    const address = 'DFixtureAddress';
    const requested: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      requested.push(new URL(String(input)));
      return new Response(JSON.stringify({
        hasMore: false,
        txs: [{
          hash: 'doge-tx-1',
          block_height: 100,
          block_index: 2,
          confirmed: '2026-01-01T00:00:00.000Z',
          confirmations: 10,
          fees: 100_000,
          inputs: [],
          outputs: [{
            value: 200_000_000,
            addresses: [address]
          }]
        }]
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }));
    const adapter = createChainAdapters({
      config: runtime.config,
      secrets: runtime.secrets
    }).get('dogecoin')!;
    const result = await adapter.fetchHistory({
      address,
      selectedAssets: [{ canonicalAssetId: 'dogecoin', contractOrMint: null }],
      cursor: {}
    });
    expect(requested[0]?.pathname).toBe(`/v1/doge/main/addrs/${address}/full`);
    expect(result.transactions[0]?.confirmationState).toBe('finalized');
    expect(result.events[0]).toMatchObject({
      canonicalAssetId: 'dogecoin',
      quantityDelta: '2',
      eventType: 'receive',
      finalized: true
    });
    expect(result.completeness).toBe('complete');
  });

  it('imports explicitly selected ERC-20 history through Etherscan v2', async () => {
    const runtime = await createTestRuntime({
      secrets: {
        providers: {
          etherscanApiKey: 'etherscan-fixture-key'
        }
      }
    });
    const address = '0x0000000000000000000000000000000000000001';
    const contract = '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE';
    const requested: URL[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requested.push(url);
      const result = url.searchParams.get('action') === 'tokentx'
        ? [{
            hash: 'erc20-tx-1',
            blockNumber: '123',
            transactionIndex: '2',
            logIndex: '3',
            timeStamp: '1700000000',
            from: '0x0000000000000000000000000000000000000002',
            to: address,
            contractAddress: contract,
            tokenDecimal: '18',
            tokenSymbol: 'SHIB',
            confirmations: '1',
            value: '1000000000000000000'
          }]
        : [];
      return new Response(JSON.stringify({
        status: '1',
        message: 'OK',
        result
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }));
    const adapter = createChainAdapters({
      config: runtime.config,
      secrets: runtime.secrets
    }).get('ethereum')!;
    const result = await adapter.fetchHistory({
      address,
      selectedAssets: [
        { canonicalAssetId: 'ethereum', contractOrMint: null },
        { canonicalAssetId: 'shiba-inu', contractOrMint: contract }
      ],
      cursor: {}
    });
    expect(requested).toHaveLength(3);
    expect(requested.every((url) => url.pathname === '/v2/api')).toBe(true);
    expect(requested.every((url) => (
      url.searchParams.get('apikey') === 'etherscan-fixture-key'
      && url.searchParams.get('chainid') === '1'
    ))).toBe(true);
    expect(result.events).toContainEqual(expect.objectContaining({
      canonicalAssetId: 'shiba-inu',
      quantityDelta: '1',
      eventType: 'token_receive',
      finalized: false
    }));
  });

  it('reads an exact SHIB balance and token decimals through keyless read-only Ethereum JSON-RPC', async () => {
    const runtime = await createTestRuntime();
    const address = '0x0000000000000000000000000000000000000001';
    const contract = '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE';
    const methods: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      methods.push(request.method);
      const result = request.method === 'eth_blockNumber'
        ? '0x123'
        : request.method === 'eth_getBalance'
          ? '0x0'
          : methods.filter((method) => method === 'eth_call').length === 1
            ? '0x12'
            : '0x1c935c7ed74892c53a40000';
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }));
    const adapter = createChainAdapters({
      config: runtime.config,
      secrets: runtime.secrets
    }).get('ethereum')!;
    const result = await adapter.fetchCurrentBalances!({
      address,
      selectedAssets: [
        { canonicalAssetId: 'ethereum', contractOrMint: null },
        { canonicalAssetId: 'shiba-inu', contractOrMint: contract }
      ]
    });
    expect(methods).toEqual([
      'eth_blockNumber',
      'eth_getBalance',
      'eth_call',
      'eth_call'
    ]);
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        canonicalAssetId: 'shiba-inu',
        quantity: '552733073',
        blockReference: '0x123'
      })
    ]));
    expect(result.warnings).toEqual([]);
  });

  it('does not treat an Etherscan authentication failure as empty complete history', async () => {
    const runtime = await createTestRuntime({
      secrets: {
        providers: {
          etherscanApiKey: 'invalid-fixture-key'
        }
      }
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: '0',
      message: 'NOTOK',
      result: 'Missing/Invalid API Key'
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })));
    const adapter = createChainAdapters({
      config: runtime.config,
      secrets: runtime.secrets
    }).get('ethereum')!;
    await expect(adapter.fetchHistory({
      address: '0x0000000000000000000000000000000000000001',
      selectedAssets: [{ canonicalAssetId: 'ethereum', contractOrMint: null }],
      cursor: {}
    })).rejects.toMatchObject({
      errorKey: 'PROVIDER_RESPONSE_INVALID'
    });
  });

  it('imports Polkadot transfers through an authenticated read-only Subscan POST', async () => {
    const runtime = await createTestRuntime({
      secrets: {
        providers: {
          subscanApiKey: 'subscan-fixture-key'
        }
      }
    });
    const address = '1FixturePolkadotAddress';
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      requests.push({ url: new URL(String(input)), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({
        code: 0,
        data: {
          count: 1,
          list: [{
            hash: 'dot-tx-1',
            block_num: 123,
            block_timestamp: 1_700_000_000,
            from: '1Sender',
            to: address,
            amount: '1.25',
            asset_symbol: 'DOT',
            finalized: true
          }]
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }));
    const adapter = createChainAdapters({
      config: runtime.config,
      secrets: runtime.secrets
    }).get('polkadot')!;
    const result = await adapter.fetchHistory({
      address,
      selectedAssets: [{ canonicalAssetId: 'polkadot', contractOrMint: null }],
      cursor: {}
    });
    expect(requests[0]?.url.pathname).toBe('/api/v2/scan/transfers');
    expect(requests[0]?.init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'X-API-Key': 'subscan-fixture-key',
        'content-type': 'application/json'
      })
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      address,
      asset_symbol: 'DOT',
      direction: 'all'
    });
    expect(result.events[0]).toMatchObject({
      canonicalAssetId: 'polkadot',
      quantityDelta: '1.25',
      eventType: 'receive',
      finalized: true
    });
  });
});

describe('market persistence', () => {
  it('upserts initial and incremental fixture candles and returns partial-aware series', async () => {
    const runtime = await createTestRuntime();
    const { db } = await openMigratedTestDatabase({ runtime });
    await bootstrapApplicationData({ db, runtime });
    let close = '100.00000001';
    const adapter: MarketProviderAdapter = {
      provider: 'coinbase',
      fetchCandles: async () => [{
        bucketStartMs: 0,
        granularitySeconds: 60,
        open: '99',
        high: '101',
        low: '98',
        close,
        volume: '5',
        finalized: true,
        dataKind: 'native',
        provenance: {
          endpoint: 'fixture',
          tradeCount: 2
        }
      }],
      status: () => ({
        status: 'healthy',
        consecutiveFailures: 0,
        cooldownUntilMs: 0,
        lastSuccessAtMs: null,
        lastFailureAtMs: null
      })
    };
    const jobs = {
      enqueue: vi.fn(),
      register: vi.fn()
    } as unknown as JobQueue;
    const market = new MarketService(db, runtime, new Map([['coinbase', adapter]]), jobs);
    try {
      await market.synchronizeRange({
        provider: 'coinbase',
        canonicalAssetId: 'bitcoin',
        quoteCurrency: 'USD',
        fromMs: 0,
        toMs: 60_000,
        granularitySeconds: 60
      });
      close = '102.00000002';
      await market.synchronizeRange({
        provider: 'coinbase',
        canonicalAssetId: 'bitcoin',
        quoteCurrency: 'USD',
        fromMs: 0,
        toMs: 60_000,
        granularitySeconds: 60
      });
      expect(await db.one<{ count: number | string; close_value: string }>({
        sql: 'SELECT COUNT(*) AS count, MAX(close_value) AS close_value FROM market_points'
      })).toMatchObject({
        count: 1,
        close_value: '102.00000002'
      });
      const series = await market.getSeries({
        assetIds: ['bitcoin'],
        quoteCurrency: 'USD',
        source: 'coinbase',
        fromMs: 0,
        toMs: 120_000,
        granularity: 60,
        chartMode: 'line'
      });
      expect(series.series[0]?.points[0]).toMatchObject({
        timestampMs: 0,
        value: '102.00000002',
        providers: ['coinbase']
      });
      expect(series.partial).toBe(true);
    } finally {
      await db.close();
    }
  });
});
