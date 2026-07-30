import { describe, expect, it } from 'vitest';
import { transformPerformanceSeries } from '../src/lib/performance.js';

describe('performance series', () => {
  it('calculates each asset return independently', () => {
    const transformed = transformPerformanceSeries({
      mode: 'return',
      series: [
        {
          id: 'ethereum',
          label: 'ETH · Ethereum',
          points: [
            { timestampMs: 1, value: '2000' },
            { timestampMs: 2, value: '2400' }
          ]
        },
        {
          id: 'token',
          label: 'TOKEN · Token',
          points: [
            { timestampMs: 1, value: '10' },
            { timestampMs: 2, value: '5' }
          ]
        }
      ]
    });

    expect(Number(transformed[0]?.points.at(-1)?.value)).toBeCloseTo(20);
    expect(transformed[1]?.points.at(-1)?.value).toBe('-50');
    expect(transformed[0]?.points.at(-1)?.provenance).toMatchObject({
      sourceSeriesId: 'ethereum'
    });
  });

  it('calculates drawdown from each series own preceding peak', () => {
    const [transformed] = transformPerformanceSeries({
      mode: 'drawdown',
      series: [{
        id: 'bitcoin',
        label: 'BTC · Bitcoin',
        points: [
          { timestampMs: 1, value: '100' },
          { timestampMs: 2, value: '120' },
          { timestampMs: 3, value: '90' }
        ]
      }]
    });

    expect(transformed?.points.map((point) => point.value)).toEqual(['0', '0', '-25']);
  });
});
