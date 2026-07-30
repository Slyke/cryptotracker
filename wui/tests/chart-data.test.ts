import { describe, expect, it } from 'vitest';
import {
  bucketChartSeries,
  closestCandidateWithinRadius,
  hasMinimumValuedObservations
} from '../src/lib/chart-data.js';

describe('chart valued observations', () => {
  it('recognizes populated analytics data after it arrives', () => {
    expect(hasMinimumValuedObservations({
      series: [{
        id: 'btc:return',
        label: 'BTC · return',
        points: [
          { timestampMs: 1, value: '0' },
          { timestampMs: 2, value: '0.81930143' }
        ]
      }],
      minimum: 2
    })).toBe(true);
  });

  it('does not count missing or non-numeric values as observations', () => {
    expect(hasMinimumValuedObservations({
      series: [{
        id: 'btc:return',
        label: 'BTC · return',
        points: [
          { timestampMs: 1, value: null },
          { timestampMs: 2, value: 'not-a-number' },
          { timestampMs: 3, close: '1.25' }
        ]
      }],
      minimum: 2
    })).toBe(false);
  });

  it('selects only the closest series inside the tooltip proximity radius', () => {
    const candidates = [
      { id: 'btc', distance: 28 },
      { id: 'eth', distance: 11 },
      { id: 'sol', distance: null }
    ];
    expect(closestCandidateWithinRadius({
      candidates,
      radius: 36
    })?.id).toBe('eth');
    expect(closestCandidateWithinRadius({
      candidates,
      radius: 10
    })).toBeNull();
  });

  it('buckets local snapshot series at every requested coarse granularity', () => {
    expect(bucketChartSeries({
      granularitySeconds: 900,
      series: [{
        id: 'portfolio',
        label: 'Portfolio',
        points: [
          { timestampMs: 1_000, value: '10' },
          { timestampMs: 899_000, value: '11' },
          { timestampMs: 901_000, value: '12' }
        ]
      }]
    })[0]?.points).toEqual([
      { timestampMs: 0, value: '11' },
      { timestampMs: 900_000, value: '12' }
    ]);
  });
});
