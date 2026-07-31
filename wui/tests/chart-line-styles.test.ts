import { describe, expect, it } from 'vitest';
import {
  defaultChartSeriesLineStyle,
  normalizeChartSeriesLineStyles,
  resolvedChartSeriesLineStyles
} from '../src/lib/chart-line-styles.js';

describe('chart series line styles', () => {
  it('keeps the existing automatic palette, pattern, and thickness sequence', () => {
    expect(defaultChartSeriesLineStyle(0)).toEqual({
      type: 'solid',
      color: '#5070dd',
      width: 2.5
    });
    expect(defaultChartSeriesLineStyle(1)).toEqual({
      type: 'dashed',
      color: '#b6d634',
      width: 1.8
    });
    expect(defaultChartSeriesLineStyle(2)).toEqual({
      type: 'dotted',
      color: '#505372',
      width: 1.8
    });
  });

  it('validates persisted overrides and clamps line thickness', () => {
    expect(normalizeChartSeriesLineStyles({
      bitcoin: { type: 'dashed', color: '#AABBCC', width: 0.2 },
      ethereum: { type: 'dotted', color: '#123456', width: 12 },
      invalid: { type: 'wavy', color: '#123456', width: 2 }
    })).toEqual({
      bitcoin: { type: 'dashed', color: '#aabbcc', width: 1 },
      ethereum: { type: 'dotted', color: '#123456', width: 8 }
    });
  });

  it('materializes automatic styles for unset series while retaining saved overrides', () => {
    expect(resolvedChartSeriesLineStyles({
      styles: {
        ethereum: { type: 'solid', color: '#abcdef', width: 4 }
      },
      series: [{ id: 'bitcoin' }, { id: 'ethereum' }, { id: 'solana' }]
    })).toEqual({
      bitcoin: defaultChartSeriesLineStyle(0),
      ethereum: { type: 'solid', color: '#abcdef', width: 4 },
      solana: defaultChartSeriesLineStyle(2)
    });
  });
});
