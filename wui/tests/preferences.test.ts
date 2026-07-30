import { describe, expect, it } from 'vitest';
import {
  chartDisplayStateFromSetting,
  chartQueryStateFromSetting,
  defaultChartDisplayState,
  defaultChartQueryState,
  defaultPerformanceChartDisplayState,
  formatDateTime,
  formatDisplayNumber,
  formatPercent,
  historyDepthRetentionWarning,
  moveInOrder,
  normalizeOrder,
  performanceChartDisplayStateFromSetting,
  replaceSavedGraph,
  relativeRangeWindow,
  savedGraphNameExists,
  savedGraphWithName,
  toggleCollapsed
} from '../src/lib/preferences.js';

describe('database-backed UI preferences', () => {
  it('normalizes saved block order without duplicates or unknown blocks', () => {
    expect(normalizeOrder({
      saved: ['chart', 'unknown', 'chart', 'controls'],
      defaults: ['controls', 'chart', 'table']
    })).toEqual(['chart', 'controls', 'table']);
  });

  it('moves blocks one position and leaves boundary moves unchanged', () => {
    expect(moveInOrder({
      order: ['one', 'two', 'three'],
      id: 'two',
      direction: 'up'
    })).toEqual(['two', 'one', 'three']);
    expect(moveInOrder({
      order: ['one', 'two', 'three'],
      id: 'one',
      direction: 'up'
    })).toEqual(['one', 'two', 'three']);
  });

  it('toggles a block in the persisted collapsed list', () => {
    expect(toggleCollapsed({ collapsed: ['sync'], id: 'storage' })).toEqual(['sync', 'storage']);
    expect(toggleCollapsed({ collapsed: ['sync', 'storage'], id: 'sync' })).toEqual(['storage']);
  });

  it('restores persisted chart query and display controls with safe fallbacks', () => {
    expect(chartQueryStateFromSetting({
      value: {
        range: 'all',
        granularity: '300',
        customFromMs: 1,
        customToMs: 2,
        customRangeMode: 'ago',
        customAgoValue: 4,
        customAgoUnit: 'years'
      },
      fallback: defaultChartQueryState()
    })).toEqual({
      range: 'all',
      granularity: '300',
      customFromMs: 1,
      customToMs: 2,
      customRangeMode: 'ago',
      customAgoValue: 4,
      customAgoUnit: 'years'
    });
    expect(chartDisplayStateFromSetting({
      value: {
        scale: 'log',
        normalized: true,
        showEvents: false,
        showVolume: true,
        yAxisUnit: 'ethereum',
        rightYAxisUnit: 'bitcoin',
        leftYAxisSeriesIds: ['combined'],
        rightYAxisSeriesIds: ['bitcoin'],
        leftYAxisLineColor: '#123456',
        rightYAxisLineColor: '#abcdef',
        tooltipUnits: ['CAD', 'USD', 'bitcoin', 'ethereum', 'dogecoin', 'solana']
      },
      fallback: defaultChartDisplayState('CAD')
    })).toEqual({
      scale: 'log',
      normalized: true,
      showEvents: false,
      showVolume: true,
      yAxisUnit: 'ethereum',
      rightYAxisUnit: 'bitcoin',
      tooltipUnits: ['CAD', 'USD', 'bitcoin', 'ethereum', 'dogecoin'],
      visibleSeriesIds: ['combined', 'bitcoin'],
      leftYAxisSeriesIds: ['combined'],
      rightYAxisSeriesIds: ['bitcoin'],
      leftYAxisLineColor: '#123456',
      rightYAxisLineColor: '#abcdef'
    });
    expect(performanceChartDisplayStateFromSetting({
      value: {
        leftYAxisSeriesIds: ['portfolio'],
        rightYAxisSeriesIds: ['benchmark'],
        rightYAxisUnit: '%',
        leftYAxisLineColor: '#102030',
        rightYAxisLineColor: '#a0b0c0',
        tooltipUnits: [],
        minimumMode: 'relative',
        maximumMode: 'absolute',
        minimumValue: '5',
        maximumValue: '120'
      }
    })).toEqual({
      ...defaultPerformanceChartDisplayState(),
      visibleSeriesIds: null,
      leftYAxisSeriesIds: ['portfolio'],
      rightYAxisSeriesIds: ['benchmark'],
      rightYAxisUnit: '%',
      leftYAxisLineColor: '#102030',
      rightYAxisLineColor: '#a0b0c0',
      tooltipUnits: [],
      minimumMode: 'relative',
      maximumMode: 'absolute',
      minimumValue: '5',
      maximumValue: '120'
    });
    expect(chartQueryStateFromSetting({
      value: { customAgoValue: 0, customAgoUnit: 'centuries' },
      fallback: defaultChartQueryState()
    })).toMatchObject({
      customAgoValue: 1,
      customAgoUnit: 'days'
    });
  });

  it('warns when retention is shorter than automatic market-history synchronization', () => {
    expect(historyDepthRetentionWarning({
      retentionDays: 730,
      marketHistoryBackfillDays: 1_825
    })).toContain('Retention is set to 730 days');
    expect(historyDepthRetentionWarning({
      retentionDays: 730,
      marketHistoryBackfillDays: null
    })).toContain('maximum available history');
    expect(historyDepthRetentionWarning({
      retentionDays: null,
      marketHistoryBackfillDays: null
    })).toBeNull();
    expect(historyDepthRetentionWarning({
      retentionDays: 3_650,
      marketHistoryBackfillDays: 1_825
    })).toBeNull();
  });

  it('rounds displayed percentages to at most four decimals', () => {
    expect(formatPercent('7.1428571428571428571')).toBe('7.1429');
    expect(formatPercent('0.123456789')).toBe('0.1235');
    expect(formatPercent(100)).toBe('100');
  });

  it('rounds values at magnitude ten to two decimals while retaining small-value precision', () => {
    expect(formatDisplayNumber({
      value: '11103.908554971',
      locale: 'en-CA'
    })).toBe('11,103.91');
    expect(formatDisplayNumber({ value: '0.12345678', locale: 'en-CA' })).toBe('0.12345678');
    expect(formatDisplayNumber({
      value: '0.12345678901234567',
      locale: 'en-CA'
    })).toBe('0.12345678901234566');
    expect(formatDisplayNumber({ value: '-10.005', locale: 'en-CA' })).toBe('-10.01');
  });

  it('formats all displayed timestamps as YYYY-MM-DD and 24-hour time', () => {
    expect(formatDateTime({ value: '2026-07-28T19:45:00Z', timezone: 'UTC' }))
      .toBe('2026-07-28, 19:45');
  });

  it('detects duplicate dashboard item names without case or surrounding-space differences', () => {
    const savedGraphs = [{
      id: 'existing',
      name: 'Market History',
      type: 'market' as const,
      hidden: false,
      config: {}
    }];
    expect(savedGraphNameExists({ savedGraphs, name: ' market history ' })).toBe(true);
    expect(savedGraphNameExists({
      savedGraphs,
      name: 'Market History',
      excludingId: 'existing'
    })).toBe(false);
    expect(savedGraphNameExists({ savedGraphs, name: 'Kraken History' })).toBe(false);
    expect(savedGraphWithName({ savedGraphs, name: ' market HISTORY ' })?.id)
      .toBe('existing');
    expect(savedGraphWithName({ savedGraphs, name: 'Kraken History' })).toBeNull();
  });

  it('replaces a dashboard item in place so its row placement remains valid', () => {
    const savedGraphs = [{
      id: 'existing',
      name: 'Market History',
      type: 'market' as const,
      hidden: true,
      config: { range: '30d' }
    }];
    expect(replaceSavedGraph({
      savedGraphs,
      replacement: {
        id: 'temporary',
        name: 'Market History',
        type: 'market',
        hidden: false,
        config: { range: '1y' }
      },
      replacedId: 'existing'
    })).toEqual([{
      id: 'existing',
      name: 'Market History',
      type: 'market',
      hidden: false,
      config: { range: '1y' }
    }]);
  });

  it('resolves rolling custom ranges in hours, days, weeks, months, and years', () => {
    const toMs = Date.UTC(2026, 6, 28, 12);
    expect(relativeRangeWindow({ value: 6, unit: 'hours', toMs })?.from)
      .toBe(Date.UTC(2026, 6, 28, 6));
    expect(relativeRangeWindow({ value: 2, unit: 'weeks', toMs })?.from)
      .toBe(Date.UTC(2026, 6, 14, 12));
    expect(relativeRangeWindow({ value: 3, unit: 'months', toMs })?.from)
      .toBe(Date.UTC(2026, 3, 28, 12));
    expect(relativeRangeWindow({ value: 1, unit: 'years', toMs })?.from)
      .toBe(Date.UTC(2025, 6, 28, 12));
    expect(relativeRangeWindow({ value: 0, unit: 'days', toMs })).toBeNull();
  });
});
