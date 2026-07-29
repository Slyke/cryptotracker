import { Decimal } from 'decimal.js';

export type Granularity = 300 | 900 | 1_800 | 3_600 | 14_400 | 86_400 | 604_800;

export interface SeriesPoint {
  timestampMs: number;
  value: string | null;
  [key: string]: unknown;
}

export interface NormalizedPoint extends SeriesPoint {
  rawValue: string | null;
  normalizedPercent: string | null;
}

export const resolveAutoGranularity = ({
  fromMs,
  toMs,
  available = [300, 900, 1_800, 3_600, 14_400, 86_400, 604_800]
}: {
  fromMs: number;
  toMs: number;
  available?: number[];
}): Granularity => {
  const duration = Math.max(0, toMs - fromMs);
  const hour = 3_600_000;
  const day = 24 * hour;
  const preferred = duration <= (48 * hour)
    ? 300
    : duration <= (14 * day)
      ? 1_800
      : duration <= (90 * day)
        ? 3_600
        : duration <= (2 * 365 * day)
          ? 86_400
          : 604_800;
  const sorted = available.slice().sort((left, right) => left - right);
  return (sorted.find((granularity) => granularity >= preferred) ?? sorted.at(-1) ?? 86_400) as Granularity;
};

export const aggregateLinePoints = ({
  points,
  granularitySeconds
}: {
  points: SeriesPoint[];
  granularitySeconds: number;
}) => {
  const bucketMs = granularitySeconds * 1_000;
  const buckets = new Map<number, SeriesPoint[]>();
  for (const point of points) {
    const bucket = Math.floor(point.timestampMs / bucketMs) * bucketMs;
    const existing = buckets.get(bucket) ?? [];
    existing.push(point);
    buckets.set(bucket, existing);
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timestampMs, samples]) => {
      const valid = samples.filter((sample) => sample.value !== null).sort((left, right) => left.timestampMs - right.timestampMs);
      return {
        timestampMs,
        value: valid.at(-1)?.value ?? null,
        sampleCount: valid.length
      };
    });
};

export const normalizeSeries = ({
  points
}: {
  points: SeriesPoint[];
}): {
  baseTimestampMs: number | null;
  baseValue: string | null;
  points: NormalizedPoint[];
} => {
  const base = points.find((point) => point.value !== null && !new Decimal(point.value).isZero());
  if (!base || base.value === null) {
    return {
      baseTimestampMs: null,
      baseValue: null,
      points: points.map((point) => ({
        ...point,
        rawValue: point.value,
        normalizedPercent: null
      }))
    };
  }

  const baseValue = new Decimal(base.value);
  return {
    baseTimestampMs: base.timestampMs,
    baseValue: base.value,
    points: points.map((point) => ({
      ...point,
      rawValue: point.value,
      normalizedPercent: point.value === null
        ? null
        : new Decimal(point.value).minus(baseValue).dividedBy(baseValue).times(100).toString()
    }))
  };
};

export const canUseLogScale = ({
  series
}: {
  series: SeriesPoint[][];
}) => {
  const values = series.flat().filter((point) => point.value !== null).map((point) => new Decimal(point.value!));
  return values.length > 0 && values.every((value) => value.greaterThan(0));
};

export type BoundSetting =
  | { mode: 'auto' }
  | { mode: 'absolute'; value: string }
  | { mode: 'relative'; percent: string };

export const resolveBounds = ({
  values,
  minimum,
  maximum,
  logScale = false
}: {
  values: string[];
  minimum: BoundSetting;
  maximum: BoundSetting;
  logScale?: boolean;
}) => {
  if (values.length === 0) {
    return { valid: true, minimum: null, maximum: null, reason: null };
  }
  const decimals = values.map((value) => new Decimal(value));
  const dataMinimum = Decimal.min(...decimals);
  const dataMaximum = Decimal.max(...decimals);
  const range = dataMaximum.minus(dataMinimum);
  const safeRange = range.isZero()
    ? Decimal.max(dataMaximum.abs(), 1)
    : range;
  const resolve = ({ setting, direction }: { setting: BoundSetting; direction: 'minimum' | 'maximum' }) => {
    if (setting.mode === 'auto') return direction === 'minimum' ? dataMinimum : dataMaximum;
    if (setting.mode === 'absolute') return new Decimal(setting.value);
    const padding = safeRange.times(new Decimal(setting.percent).dividedBy(100));
    return direction === 'minimum' ? dataMinimum.minus(padding) : dataMaximum.plus(padding);
  };

  try {
    const resolvedMinimum = resolve({ setting: minimum, direction: 'minimum' });
    const resolvedMaximum = resolve({ setting: maximum, direction: 'maximum' });
    if (resolvedMinimum.greaterThanOrEqualTo(resolvedMaximum)) {
      return { valid: false, minimum: null, maximum: null, reason: 'Minimum must be less than maximum.' };
    }
    if (logScale && (!resolvedMinimum.greaterThan(0) || !resolvedMaximum.greaterThan(0))) {
      return { valid: false, minimum: null, maximum: null, reason: 'Logarithmic bounds must be positive.' };
    }
    return {
      valid: true,
      minimum: resolvedMinimum.toString(),
      maximum: resolvedMaximum.toString(),
      reason: null
    };
  } catch {
    return { valid: false, minimum: null, maximum: null, reason: 'Bound input is not a valid decimal.' };
  }
};

export interface EventMarker {
  id: string;
  category: string;
  timestampMs: number;
  [key: string]: unknown;
}

export const filterEventMarkers = ({
  events,
  enabledCategories
}: {
  events: EventMarker[];
  enabledCategories: string[];
}) => {
  const enabled = new Set(enabledCategories);
  return events
    .filter((event) => enabled.has(event.category))
    .sort((left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id));
};
