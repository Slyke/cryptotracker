import { apiRequest } from '$lib/api';
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
  failedJobRetentionHours: number | null;
}

export type RelativeRangeUnit = 'hours' | 'days' | 'weeks' | 'months' | 'years';

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
