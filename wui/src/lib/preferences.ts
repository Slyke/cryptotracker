import { apiRequest } from '$lib/api';
import {
  normalizeChartSeriesLineStyles,
  type ChartSeriesLineStyles
} from '$lib/chart-line-styles';
import { formatInTimezone } from '$lib/timezone';

export type SavedGraphType = 'market' | 'kraken' | 'addresses' | 'portfolio';

export interface SavedGraph {
  id: string;
  name: string;
  type: SavedGraphType;
  hidden: boolean;
  config: Record<string, unknown>;
}

export interface DashboardRow {
  id: string;
  name: string;
  columns: 1 | 2 | 3 | 4;
  itemIds: string[];
}

export interface PersonalizationSettings {
  graphDefaults: Record<string, unknown>;
  pageLayouts: Record<string, string[]>;
  collapsedBlocks: Record<string, string[]>;
  accordionStates: Record<string, boolean>;
  tableColumns: Record<string, string[]>;
  tableRows: Record<string, string[]>;
  savedGraphs: SavedGraph[];
  dashboardRows: DashboardRow[];
  dashboardGraphColumns: 1 | 2 | 3 | 4;
  dismissedNotices: string[];
  retentionDays: number | null;
  marketHistoryBackfillDays: number | null;
  failedJobRetentionHours: number | null;
}

export type RelativeRangeUnit = 'hours' | 'days' | 'weeks' | 'months' | 'years';

export interface ChartQueryState {
  range: string;
  granularity: string;
  customFromMs: number | null;
  customToMs: number | null;
  customRangeMode: 'dates' | 'ago';
  customAgoValue: number;
  customAgoUnit: RelativeRangeUnit;
}

export interface ChartDisplayState {
  scale: 'linear' | 'log';
  normalized: boolean;
  showEvents: boolean;
  showVolume: boolean;
  yAxisUnit: string;
  tooltipUnits: string[];
  visibleSeriesIds: string[] | null;
  leftYAxisSeriesIds: string[] | null;
  rightYAxisUnit: string;
  rightYAxisSeriesIds: string[];
  leftYAxisLineColor: string;
  rightYAxisLineColor: string;
  seriesLineStyles: ChartSeriesLineStyles;
}

export interface PerformanceChartDisplayState {
  visibleSeriesIds: string[] | null;
  leftYAxisSeriesIds: string[] | null;
  rightYAxisSeriesIds: string[];
  rightYAxisUnit: string;
  leftYAxisLineColor: string;
  rightYAxisLineColor: string;
  seriesLineStyles: ChartSeriesLineStyles;
  tooltipUnits: string[];
  minimumMode: 'auto' | 'absolute' | 'relative';
  maximumMode: 'auto' | 'absolute' | 'relative';
  minimumValue: string;
  maximumValue: string;
}

export const defaultChartQueryState = ({
  range = '30d',
  granularity = 'auto'
}: {
  range?: string;
  granularity?: string;
} = {}): ChartQueryState => ({
  range,
  granularity,
  customFromMs: null,
  customToMs: null,
  customRangeMode: 'dates',
  customAgoValue: 30,
  customAgoUnit: 'days'
});

export const normalizeTooltipUnits = ({
  value,
  fallback = []
}: {
  value: unknown;
  fallback?: string[];
}) => {
  const candidate = Array.isArray(value) ? value : fallback;
  return [...new Set(candidate
    .filter((unit): unit is string => typeof unit === 'string')
    .map((unit) => unit.trim())
    .filter(Boolean))]
    .slice(0, 5);
};

export const defaultChartDisplayState = (
  currency: string,
  tooltipUnits: string[] = [currency]
): ChartDisplayState => ({
  scale: 'linear',
  normalized: false,
  showEvents: true,
  showVolume: false,
  yAxisUnit: currency,
  tooltipUnits: normalizeTooltipUnits({ value: tooltipUnits, fallback: [currency] }),
  visibleSeriesIds: null,
  leftYAxisSeriesIds: null,
  rightYAxisUnit: '',
  rightYAxisSeriesIds: [],
  leftYAxisLineColor: '#364255',
  rightYAxisLineColor: '#ffbc3a',
  seriesLineStyles: {}
});

export const defaultPerformanceChartDisplayState = (): PerformanceChartDisplayState => ({
  visibleSeriesIds: null,
  leftYAxisSeriesIds: null,
  rightYAxisSeriesIds: [],
  rightYAxisUnit: '',
  leftYAxisLineColor: '#364255',
  rightYAxisLineColor: '#ffbc3a',
  seriesLineStyles: {},
  tooltipUnits: ['%'],
  minimumMode: 'auto',
  maximumMode: 'auto',
  minimumValue: '',
  maximumValue: ''
});

export const chartQueryStateFromSetting = ({
  value,
  fallback
}: {
  value: unknown;
  fallback: ChartQueryState;
}): ChartQueryState => {
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as Record<string, unknown>;
  const agoUnit = String(candidate.customAgoUnit ?? fallback.customAgoUnit);
  return {
    range: typeof candidate.range === 'string' ? candidate.range : fallback.range,
    granularity: typeof candidate.granularity === 'string'
      ? candidate.granularity
      : fallback.granularity,
    customFromMs: typeof candidate.customFromMs === 'number'
      ? candidate.customFromMs
      : fallback.customFromMs,
    customToMs: typeof candidate.customToMs === 'number'
      ? candidate.customToMs
      : fallback.customToMs,
    customRangeMode: candidate.customRangeMode === 'ago' ? 'ago' : 'dates',
    customAgoValue: Number.isFinite(Number(candidate.customAgoValue))
      ? Math.max(1, Math.floor(Number(candidate.customAgoValue)))
      : fallback.customAgoValue,
    customAgoUnit: ['hours', 'days', 'weeks', 'months', 'years'].includes(agoUnit)
      ? agoUnit as RelativeRangeUnit
      : fallback.customAgoUnit
  };
};

export const chartDisplayStateFromSetting = ({
  value,
  fallback
}: {
  value: unknown;
  fallback: ChartDisplayState;
}): ChartDisplayState => {
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as Record<string, unknown>;
  const seriesIds = (input: unknown) => Array.isArray(input)
    ? [...new Set(input
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean))]
    : null;
  const leftYAxisSeriesIds = seriesIds(candidate.leftYAxisSeriesIds)
    ?? seriesIds(candidate.visibleSeriesIds)
    ?? fallback.leftYAxisSeriesIds;
  const rightYAxisSeriesIds = seriesIds(candidate.rightYAxisSeriesIds)
    ?? fallback.rightYAxisSeriesIds;
  const axisLineColor = (input: unknown, fallbackColor: string) => (
    typeof input === 'string' && /^#[0-9a-f]{6}$/i.test(input)
      ? input.toLowerCase()
      : fallbackColor
  );
  return {
    scale: candidate.scale === 'log' ? 'log' : 'linear',
    normalized: candidate.normalized === true,
    showEvents: candidate.showEvents !== false,
    showVolume: candidate.showVolume === true,
    yAxisUnit: typeof candidate.yAxisUnit === 'string'
      ? candidate.yAxisUnit
      : fallback.yAxisUnit,
    tooltipUnits: normalizeTooltipUnits({
      value: candidate.tooltipUnits,
      fallback: fallback.tooltipUnits
    }),
    visibleSeriesIds: seriesIds(candidate.visibleSeriesIds)
      ?? (
        leftYAxisSeriesIds === null
          ? fallback.visibleSeriesIds
          : [...new Set([...leftYAxisSeriesIds, ...rightYAxisSeriesIds])]
      ),
    leftYAxisSeriesIds,
    rightYAxisUnit: typeof candidate.rightYAxisUnit === 'string'
      ? candidate.rightYAxisUnit
      : fallback.rightYAxisUnit,
    rightYAxisSeriesIds,
    leftYAxisLineColor: axisLineColor(
      candidate.leftYAxisLineColor,
      fallback.leftYAxisLineColor
    ),
    rightYAxisLineColor: axisLineColor(
      candidate.rightYAxisLineColor,
      fallback.rightYAxisLineColor
    ),
    seriesLineStyles: normalizeChartSeriesLineStyles(
      candidate.seriesLineStyles,
      fallback.seriesLineStyles
    )
  };
};

export const performanceChartDisplayStateFromSetting = ({
  value,
  legacyVisibleSeriesIds = null
}: {
  value: unknown;
  legacyVisibleSeriesIds?: string[] | null;
}): PerformanceChartDisplayState => {
  const fallback = defaultPerformanceChartDisplayState();
  const candidate = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  const seriesIds = (input: unknown) => Array.isArray(input)
    ? [...new Set(input
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean))]
    : null;
  const visibleSeriesIds = seriesIds(candidate.visibleSeriesIds)
    ?? legacyVisibleSeriesIds;
  const leftYAxisSeriesIds = seriesIds(candidate.leftYAxisSeriesIds)
    ?? visibleSeriesIds;
  const rightYAxisSeriesIds = seriesIds(candidate.rightYAxisSeriesIds) ?? [];
  const boundMode = (
    input: unknown,
    defaultValue: 'auto' | 'absolute' | 'relative'
  ) => ['auto', 'absolute', 'relative'].includes(String(input))
    ? String(input) as 'auto' | 'absolute' | 'relative'
    : defaultValue;
  const color = (input: unknown, defaultValue: string) => (
    typeof input === 'string' && /^#[0-9a-f]{6}$/i.test(input)
      ? input.toLowerCase()
      : defaultValue
  );
  return {
    visibleSeriesIds,
    leftYAxisSeriesIds,
    rightYAxisSeriesIds,
    rightYAxisUnit: candidate.rightYAxisUnit === '%' ? '%' : '',
    leftYAxisLineColor: color(candidate.leftYAxisLineColor, fallback.leftYAxisLineColor),
    rightYAxisLineColor: color(candidate.rightYAxisLineColor, fallback.rightYAxisLineColor),
    seriesLineStyles: normalizeChartSeriesLineStyles(
      candidate.seriesLineStyles,
      fallback.seriesLineStyles
    ),
    tooltipUnits: normalizeTooltipUnits({
      value: candidate.tooltipUnits,
      fallback: ['%']
    }).filter((unit) => unit === '%'),
    minimumMode: boundMode(candidate.minimumMode, fallback.minimumMode),
    maximumMode: boundMode(candidate.maximumMode, fallback.maximumMode),
    minimumValue: typeof candidate.minimumValue === 'string' ? candidate.minimumValue : '',
    maximumValue: typeof candidate.maximumValue === 'string' ? candidate.maximumValue : ''
  };
};

export const normalizeOrder = ({
  saved,
  defaults
}: {
  saved: string[] | undefined;
  defaults: string[];
}) => {
  const known = new Set(defaults);
  return [
    ...(saved ?? []).filter((id, index, values) => known.has(id) && values.indexOf(id) === index),
    ...defaults.filter((id) => !(saved ?? []).includes(id))
  ];
};

export const moveInOrder = ({
  order,
  id,
  direction
}: {
  order: string[];
  id: string;
  direction: 'up' | 'down';
}) => {
  const index = order.indexOf(id);
  const destination = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || destination < 0 || destination >= order.length) return order;
  const next = [...order];
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
};

export const toggleCollapsed = ({
  collapsed,
  id
}: {
  collapsed: string[];
  id: string;
}) => (
  collapsed.includes(id)
    ? collapsed.filter((blockId) => blockId !== id)
    : [...collapsed, id]
);

export const historyDepthRetentionWarning = ({
  retentionDays,
  marketHistoryBackfillDays
}: {
  retentionDays: number | null;
  marketHistoryBackfillDays: number | null;
}) => {
  if (
    retentionDays === null
    || (marketHistoryBackfillDays !== null && marketHistoryBackfillDays <= retentionDays)
  ) {
    return null;
  }
  const requestedDepth = marketHistoryBackfillDays === null
    ? 'maximum available history'
    : `${marketHistoryBackfillDays.toLocaleString()} days of history`;
  return `Retention is set to ${retentionDays.toLocaleString()} days, but automatic synchronization requests ${requestedDepth}. Scheduled backfill will stop at the retention limit so older points are not downloaded and immediately deleted.`;
};

export const savePreferences = async (changes: Record<string, unknown>) => (
  apiRequest({
    url: '/api/settings',
    method: 'PATCH',
    body: changes
  })
);

export const formatPercent = (value: unknown, digits = 4) => {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric.toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: digits
      })
    : String(value ?? '0');
};

export const formatDisplayNumber = ({
  value,
  locale,
  currency
}: {
  value: unknown;
  locale?: string;
  currency?: string;
}) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? 'unavailable');
  const rounded = Math.abs(numeric) >= 10;
  return numeric.toLocaleString(locale, {
    ...(currency ? { style: 'currency' as const, currency } : {}),
    minimumFractionDigits: rounded || currency ? 2 : 0,
    maximumFractionDigits: rounded ? 2 : 20
  });
};

export const formatDateTime = ({
  value,
  timezone
}: {
  value: string | number | Date | null;
  timezone: string;
}) => value === null
  ? null
  : formatInTimezone({ timestampMs: new Date(value).getTime(), timezone });

export const createSavedGraph = ({
  name,
  type,
  config
}: {
  name: string;
  type: SavedGraphType;
  config: Record<string, unknown>;
}): SavedGraph => ({
  id: crypto.randomUUID(),
  name,
  type,
  hidden: false,
  config
});

export const savedGraphNameExists = ({
  savedGraphs,
  name,
  excludingId = null
}: {
  savedGraphs: SavedGraph[];
  name: string;
  excludingId?: string | null;
}) => {
  const normalized = name.trim().toLocaleLowerCase();
  return normalized.length > 0 && savedGraphs.some((graph) => (
    graph.id !== excludingId
    && graph.name.trim().toLocaleLowerCase() === normalized
  ));
};

export const savedGraphWithName = ({
  savedGraphs,
  name
}: {
  savedGraphs: SavedGraph[];
  name: string;
}) => {
  const normalized = name.trim().toLocaleLowerCase();
  return normalized.length === 0
    ? null
    : savedGraphs.find((graph) => (
        graph.name.trim().toLocaleLowerCase() === normalized
      )) ?? null;
};

export const replaceSavedGraph = ({
  savedGraphs,
  replacement,
  replacedId
}: {
  savedGraphs: SavedGraph[];
  replacement: SavedGraph;
  replacedId: string;
}) => savedGraphs.map((graph) => (
  graph.id === replacedId
    ? {
        ...replacement,
        id: graph.id,
        hidden: false
      }
    : graph
));

export const relativeRangeWindow = ({
  value,
  unit,
  toMs = Date.now()
}: {
  value: number;
  unit: RelativeRangeUnit;
  toMs?: number;
}) => {
  const amount = Math.floor(Number(value));
  if (!Number.isFinite(amount) || amount < 1) return null;
  const from = new Date(toMs);
  if (unit === 'hours') from.setUTCHours(from.getUTCHours() - amount);
  else if (unit === 'days') from.setUTCDate(from.getUTCDate() - amount);
  else if (unit === 'weeks') from.setUTCDate(from.getUTCDate() - (amount * 7));
  else if (unit === 'months') from.setUTCMonth(from.getUTCMonth() - amount);
  else from.setUTCFullYear(from.getUTCFullYear() - amount);
  return { from: from.getTime(), to: toMs };
};
