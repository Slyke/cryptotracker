import { Decimal } from 'decimal.js';

export type PriceStatus = 'native' | 'derived' | 'fallback' | 'converted' | 'disputed';
export type MarketDataKind = 'native' | 'derived';

export interface PriceObservation {
  provider: string;
  value: string;
  dataKind: MarketDataKind;
  provenance?: Record<string, unknown>;
}

export interface CombinedValue {
  value: string | null;
  providers: string[];
  dataKind: MarketDataKind | null;
  status: PriceStatus | 'missing';
  disputed: boolean;
  spread: string | null;
  spreadKind: 'relative' | 'absolute' | null;
  contributingValues: Record<string, string>;
}

export interface CandleObservation {
  provider: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string | null;
  dataKind: MarketDataKind;
  sampleCount?: number;
}

export interface CombinedCandle {
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume: null;
  disputed: boolean;
  components: Record<'open' | 'high' | 'low' | 'close', CombinedValue>;
  providers: string[];
  dataKind: MarketDataKind | null;
}

const toDecimal = ({ value }: { value: string }) => {
  const decimal = new Decimal(value);
  if (!decimal.isFinite()) throw new Error(`Non-finite decimal: ${value}`);
  return decimal;
};

export const median = ({ values }: { values: string[] }) => {
  if (values.length === 0) return null;
  const sorted = values.map((value) => toDecimal({ value })).sort((left, right) => left.comparedTo(right));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!.toString();
  return sorted[middle - 1]!.plus(sorted[middle]!).dividedBy(2).toString();
};

const preferredObservations = ({ observations }: { observations: PriceObservation[] }) => {
  const native = observations.filter((observation) => observation.dataKind === 'native');
  return native.length > 0 ? native : observations;
};

export const providerSpread = ({
  values
}: {
  values: string[];
}): {
  spread: string | null;
  kind: 'relative' | 'absolute' | null;
} => {
  if (values.length < 2) return { spread: null, kind: null };
  const decimals = values.map((value) => toDecimal({ value }));
  const minimum = Decimal.min(...decimals);
  const maximum = Decimal.max(...decimals);
  const medianValue = toDecimal({ value: median({ values })! });
  const absolute = maximum.minus(minimum);

  if (medianValue.isZero()) {
    return { spread: absolute.toString(), kind: 'absolute' };
  }

  return {
    spread: absolute.dividedBy(medianValue.abs()).toString(),
    kind: 'relative'
  };
};

export const combinePriceObservations = ({
  observations,
  disagreementThresholdPercent = 5
}: {
  observations: PriceObservation[];
  disagreementThresholdPercent?: number;
}): CombinedValue => {
  const usable = preferredObservations({ observations });
  if (usable.length === 0) {
    return {
      value: null,
      providers: [],
      dataKind: null,
      status: 'missing',
      disputed: false,
      spread: null,
      spreadKind: null,
      contributingValues: {}
    };
  }

  const values = usable.map((observation) => observation.value);
  const value = median({ values })!;
  const spread = providerSpread({ values });
  const thresholdRatio = new Decimal(disagreementThresholdPercent).dividedBy(100);
  const disputed = spread.spread !== null
    && (
      spread.kind === 'absolute'
        ? !new Decimal(spread.spread).isZero()
        : new Decimal(spread.spread).greaterThan(thresholdRatio)
    );
  const dataKind = usable.every((observation) => observation.dataKind === 'native') ? 'native' : 'derived';
  const contributingValues = Object.fromEntries(
    usable.map((observation) => [observation.provider, observation.value])
  );

  return {
    value,
    providers: usable.map((observation) => observation.provider).sort(),
    dataKind,
    status: disputed
      ? 'disputed'
      : usable.length === 1
        ? 'fallback'
        : dataKind,
    disputed,
    spread: spread.spread,
    spreadKind: spread.kind,
    contributingValues
  };
};

export const combineCandles = ({
  candles,
  disagreementThresholdPercent = 5
}: {
  candles: CandleObservation[];
  disagreementThresholdPercent?: number;
}): CombinedCandle => {
  const native = candles.filter((candle) => candle.dataKind === 'native');
  const usable = native.length > 0 ? native : candles;
  const component = (key: 'open' | 'high' | 'low' | 'close') => combinePriceObservations({
    observations: usable.map((candle) => ({
      provider: candle.provider,
      value: candle[key],
      dataKind: candle.dataKind
    })),
    disagreementThresholdPercent
  });
  const components = {
    open: component('open'),
    high: component('high'),
    low: component('low'),
    close: component('close')
  };
  let high = components.high.value;
  let low = components.low.value;

  if (components.open.value && components.close.value && high) {
    high = Decimal.max(high, components.open.value, components.close.value).toString();
  }

  if (components.open.value && components.close.value && low) {
    low = Decimal.min(low, components.open.value, components.close.value).toString();
  }

  return {
    open: components.open.value,
    high,
    low,
    close: components.close.value,
    volume: null,
    disputed: Object.values(components).some((value) => value.disputed),
    components,
    providers: [...new Set(usable.map((candle) => candle.provider))].sort(),
    dataKind: usable.length === 0
      ? null
      : usable.every((candle) => candle.dataKind === 'native')
        ? 'native'
        : 'derived'
  };
};

export interface PointSample {
  timestampMs: number;
  value: string;
  volume?: string | null;
}

export interface DerivedCandle {
  bucketStartMs: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  sampleCount: number;
  dataKind: 'derived';
}

export const deriveCandle = ({
  samples,
  bucketStartMs
}: {
  samples: PointSample[];
  bucketStartMs: number;
}): DerivedCandle | null => {
  const ordered = samples
    .filter((sample) => Number.isFinite(sample.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  const uniqueTimestamps = new Set(ordered.map((sample) => sample.timestampMs));
  if (ordered.length < 2 || uniqueTimestamps.size < 2) return null;
  const decimals = ordered.map((sample) => toDecimal({ value: sample.value }));
  const volumes = ordered
    .filter((sample) => sample.volume !== undefined && sample.volume !== null)
    .map((sample) => toDecimal({ value: sample.volume! }));

  return {
    bucketStartMs,
    open: decimals[0]!.toString(),
    high: Decimal.max(...decimals).toString(),
    low: Decimal.min(...decimals).toString(),
    close: decimals.at(-1)!.toString(),
    volume: volumes.length === 0 ? null : Decimal.sum(...volumes).toString(),
    sampleCount: ordered.length,
    dataKind: 'derived'
  };
};

export const convertQuote = ({
  sourceValue,
  conversionRatio,
  conversionProvider = 'coingecko'
}: {
  sourceValue: string | null;
  conversionRatio: string | null;
  conversionProvider?: string;
}) => {
  if (sourceValue === null || conversionRatio === null) return null;
  return {
    value: toDecimal({ value: sourceValue }).times(toDecimal({ value: conversionRatio })).toString(),
    status: 'converted' as const,
    conversionProvider
  };
};

export const hasMeaningfulVolume = ({
  source,
  volumes
}: {
  source: string;
  volumes: Array<string | null | undefined>;
}) => {
  if (source.toLowerCase() === 'combined') return false;
  return volumes.some((volume) => volume !== null && volume !== undefined && new Decimal(volume).greaterThanOrEqualTo(0));
};
