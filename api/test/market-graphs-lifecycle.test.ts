import { describe, expect, it } from 'vitest';
import {
  combineCandles,
  combinePriceObservations,
  convertQuote,
  deriveCandle,
  hasMeaningfulVolume,
  median,
  providerSpread
} from '../src/domain/market.js';
import {
  aggregateLinePoints,
  canUseLogScale,
  filterEventMarkers,
  normalizeSeries,
  resolveAutoGranularity,
  resolveBounds
} from '../src/domain/graphs.js';
import {
  deriveLifecycleQuantity,
  resolveObservedValue,
  sameAssetIdentity
} from '../src/domain/lifecycle.js';

describe('market arithmetic', () => {
  it('uses exact decimal medians, native preference, fallback, and disputes', () => {
    expect(median({ values: ['0.1', '0.2'] })).toBe('0.15');
    const combined = combinePriceObservations({
      observations: [
        { provider: 'a', value: '100', dataKind: 'native' },
        { provider: 'b', value: '120', dataKind: 'native' },
        { provider: 'derived', value: '999', dataKind: 'derived' }
      ],
      disagreementThresholdPercent: 5
    });
    expect(combined.value).toBe('110');
    expect(combined.providers).toEqual(['a', 'b']);
    expect(combined.disputed).toBe(true);
    expect(combinePriceObservations({
      observations: [{ provider: 'a', value: '4.2', dataKind: 'native' }]
    }).status).toBe('fallback');
    expect(combinePriceObservations({ observations: [] }).status).toBe('missing');
    expect(providerSpread({ values: ['-1', '0', '1'] })).toEqual({
      spread: '2',
      kind: 'absolute'
    });
  });

  it('derives candles only from sufficient samples and never combines volume', () => {
    expect(deriveCandle({
      bucketStartMs: 0,
      samples: [{ timestampMs: 1, value: '1' }]
    })).toBeNull();
    expect(deriveCandle({
      bucketStartMs: 0,
      samples: [
        { timestampMs: 2, value: '2.5', volume: '1.1' },
        { timestampMs: 1, value: '1.5', volume: '2.2' }
      ]
    })).toMatchObject({
      open: '1.5',
      high: '2.5',
      low: '1.5',
      close: '2.5',
      volume: '3.3',
      dataKind: 'derived'
    });
    expect(combineCandles({
      candles: [
        { provider: 'a', open: '10', high: '11', low: '9', close: '10', volume: '3', dataKind: 'native' },
        { provider: 'b', open: '12', high: '13', low: '8', close: '12', volume: '4', dataKind: 'native' }
      ]
    }).volume).toBeNull();
    expect(hasMeaningfulVolume({ source: 'combined', volumes: ['1'] })).toBe(false);
    expect(hasMeaningfulVolume({ source: 'kraken', volumes: [null, '0'] })).toBe(true);
  });

  it('converts quotes without binary floating-point arithmetic', () => {
    expect(convertQuote({
      sourceValue: '123456789.123456789',
      conversionRatio: '1.25'
    })?.value).toBe('154320986.40432098625');
    expect(convertQuote({ sourceValue: null, conversionRatio: '1' })).toBeNull();
  });
});

describe('shared graph contract', () => {
  it('resolves and aggregates granularities deterministically', () => {
    expect(resolveAutoGranularity({ fromMs: 0, toMs: 24 * 60 * 60_000 })).toBe(300);
    expect(aggregateLinePoints({
      granularitySeconds: 60,
      points: [
        { timestampMs: 1_000, value: '1' },
        { timestampMs: 20_000, value: '2' },
        { timestampMs: 80_000, value: null }
      ]
    })).toEqual([
      { timestampMs: 0, value: '2', sampleCount: 2 },
      { timestampMs: 60_000, value: null, sampleCount: 0 }
    ]);
  });

  it('normalizes while retaining raw values and validates scale and bounds', () => {
    const normalized = normalizeSeries({
      points: [
        { timestampMs: 1, value: null },
        { timestampMs: 2, value: '10' },
        { timestampMs: 3, value: '12.5' }
      ]
    });
    expect(normalized.baseTimestampMs).toBe(2);
    expect(normalized.points[2]).toMatchObject({
      rawValue: '12.5',
      normalizedPercent: '25'
    });
    expect(canUseLogScale({ series: [[{ timestampMs: 1, value: '0' }]] })).toBe(false);
    expect(resolveBounds({
      values: ['10', '20'],
      minimum: { mode: 'relative', percent: '10' },
      maximum: { mode: 'relative', percent: '20' }
    })).toMatchObject({
      valid: true,
      minimum: '9',
      maximum: '22'
    });
    expect(resolveBounds({
      values: ['-1', '2'],
      minimum: { mode: 'auto' },
      maximum: { mode: 'auto' },
      logScale: true
    }).valid).toBe(false);
  });

  it('filters and orders accessible event markers', () => {
    expect(filterEventMarkers({
      events: [
        { id: 'b', category: 'trade', timestampMs: 2 },
        { id: 'a', category: 'reward', timestampMs: 1 }
      ],
      enabledCategories: ['reward']
    }).map((event) => event.id)).toEqual(['a']);
  });
});

describe('asset lifecycle', () => {
  it('keeps wrapped identities distinct and applies migrations and redenominations', () => {
    expect(sameAssetIdentity({
      left: { canonicalId: 'eth', symbol: 'ETH', network: 'ethereum', contractOrMint: null },
      right: { canonicalId: 'weth', symbol: 'WETH', network: 'ethereum', contractOrMint: '0x1', wrappedUnderlyingId: 'eth' }
    })).toBe(false);
    expect(deriveLifecycleQuantity({
      assetId: 'old',
      quantity: '1.25',
      timestampMs: 30,
      events: [
        { id: '1', eventType: 'migration', sourceAssetId: 'old', destinationAssetId: 'new', effectiveAtMs: 10, conversionRatio: '2' },
        { id: '2', eventType: 'redenomination', sourceAssetId: 'new', destinationAssetId: 'new2', effectiveAtMs: 20, conversionRatio: '1000' }
      ]
    })).toMatchObject({
      assetId: 'new2',
      quantity: '2500',
      derived: true
    });
  });

  it('never assumes a stablecoin peg', () => {
    expect(resolveObservedValue({
      asset: { canonicalId: 'usdc', symbol: 'USDC', network: 'ethereum', contractOrMint: '0x1', stablecoin: true },
      quantity: '10',
      observedPrice: null
    })).toMatchObject({
      value: null,
      priced: false
    });
  });
});
