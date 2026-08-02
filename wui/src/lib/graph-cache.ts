import { configuredCurrencies } from '$lib/currencies';
import { normalizeTooltipUnits, relativeRangeWindow, type RelativeRangeUnit, type SavedGraph } from '$lib/preferences';

export type GraphCacheScope = 'market' | 'portfolio' | 'addresses' | 'kraken' | 'kraken-earn';

export interface GraphCachePlan {
  id: string;
  revision: string;
  scope: GraphCacheScope;
  input: Record<string, unknown>;
  sliding: boolean;
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonical(child)]));
};

const fingerprint = (value: unknown) => {
  const input = JSON.stringify(canonical(value));
  let hash = 14_695_981_039_346_656_037n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(36);
};

const stringConfig = (graph: SavedGraph, key: string, fallback: string) => (
  typeof graph.config[key] === 'string' ? String(graph.config[key]) : fallback
);

const granularityConfig = (graph: SavedGraph, key = 'granularity'): number | 'auto' => {
  const value = stringConfig(graph, key, 'auto');
  const numeric = Number(value);
  return value === 'auto' || !Number.isFinite(numeric) || numeric <= 0
    ? 'auto'
    : Math.floor(numeric);
};

const stringArrayConfig = (graph: SavedGraph, key: string, fallback: string[] | null = null) => (
  Array.isArray(graph.config[key])
    ? [...new Set((graph.config[key] as unknown[]).map(String).filter(Boolean))]
    : fallback
);

const isPerformanceChart = (graph: SavedGraph) => (
  graph.type === 'market' && graph.config.analytics === 'performance'
);

const primaryCurrencyFor = (graph: SavedGraph, primaryCurrency: string) => (
  primaryCurrency.trim().toUpperCase()
    || stringConfig(graph, 'primaryCurrency', stringConfig(graph, 'currency', 'CAD')).toUpperCase()
);

const currenciesFor = ({
  graph,
  primaryCurrency,
  tooltipCurrencies
}: {
  graph: SavedGraph;
  primaryCurrency: string;
  tooltipCurrencies: string[];
}) => {
  const primary = primaryCurrencyFor(graph, primaryCurrency);
  if (isPerformanceChart(graph)) return configuredCurrencies({
    primaryCurrency: primary,
    listedCurrencies: ['USD']
  });
  const savedPrimary = stringConfig(graph, 'primaryCurrency', stringConfig(graph, 'currency', 'CAD'));
  const rightAxis = stringConfig(graph, 'rightYAxisUnit', '');
  const tooltipUnits = normalizeTooltipUnits({
    value: graph.config.tooltipUnits,
    fallback: Array.isArray(graph.config.tooltipCurrencies)
      ? graph.config.tooltipCurrencies.map(String)
      : tooltipCurrencies
  });
  return configuredCurrencies({
    primaryCurrency: primary,
    listedCurrencies: [
      ...(Array.isArray(graph.config.tooltipCurrencies)
        ? graph.config.tooltipCurrencies.map(String)
        : []),
      ...tooltipUnits,
      rightAxis.toUpperCase() === savedPrimary.toUpperCase() ? primary : rightAxis
    ].filter((unit) => /^[A-Z]{3}$/.test(unit))
  });
};

const graphRange = ({ graph, now }: { graph: SavedGraph; now: number }) => {
  const range = stringConfig(graph, 'range', '30d');
  if (
    range === 'custom'
    && graph.config.customRangeMode === 'ago'
    && typeof graph.config.customAgoValue === 'number'
    && ['hours', 'days', 'weeks', 'months', 'years'].includes(String(graph.config.customAgoUnit))
  ) {
    const relative = relativeRangeWindow({
      value: graph.config.customAgoValue,
      unit: String(graph.config.customAgoUnit) as RelativeRangeUnit,
      toMs: now
    });
    if (relative) return { ...relative, sliding: true };
  }
  if (
    range === 'custom'
    && typeof graph.config.customFromMs === 'number'
    && typeof graph.config.customToMs === 'number'
  ) {
    return {
      from: graph.config.customFromMs,
      to: graph.config.customToMs,
      sliding: false
    };
  }
  const durations: Record<string, number> = {
    '24h': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
    '30d': 30 * 24 * 60 * 60_000,
    '90d': 90 * 24 * 60 * 60_000,
    '1y': 365 * 24 * 60 * 60_000,
    '4y': 4 * 365 * 24 * 60 * 60_000,
    all: 5 * 365 * 24 * 60 * 60_000
  };
  return {
    from: range === 'all' ? 0 : now - (durations[range] ?? durations['30d']),
    to: now,
    sliding: true
  };
};

export const graphCacheIdentity = ({
  graph,
  scope,
  suffix = 'main',
  primaryCurrency,
  tooltipCurrencies
}: {
  graph: SavedGraph;
  scope: GraphCacheScope;
  suffix?: string;
  primaryCurrency: string;
  tooltipCurrencies: string[];
}) => ({
  id: `dashboard:${fingerprint(graph.id)}:${scope}:${suffix.toLowerCase()}`,
  revision: fingerprint({ graph: graph.config, primaryCurrency, tooltipCurrencies }),
  sliding: graphRange({ graph, now: Date.now() }).sliding
});

export const graphCacheQuery = (identity: ReturnType<typeof graphCacheIdentity>) => {
  const query = new URLSearchParams({
    cachePlan: identity.id,
    cacheRevision: identity.revision,
    cacheSliding: identity.sliding ? '1' : '0'
  });
  return query.toString();
};

export const dashboardGraphCachePlans = ({
  graphs,
  primaryCurrency,
  tooltipCurrencies,
  now = Date.now()
}: {
  graphs: SavedGraph[];
  primaryCurrency: string;
  tooltipCurrencies: string[];
  now?: number;
}): GraphCachePlan[] => graphs.flatMap<GraphCachePlan>((graph) => {
  if (graph.hidden || graph.config.dashboardView === 'table') return [];
  const { from, to, sliding } = graphRange({ graph, now });
  const currencies = currenciesFor({ graph, primaryCurrency, tooltipCurrencies });
  if (graph.type === 'portfolio') {
    return [{
      ...graphCacheIdentity({ graph, scope: 'portfolio', primaryCurrency, tooltipCurrencies }),
      scope: 'portfolio' as const,
      input: {
        fromMs: from,
        toMs: to,
        granularitySeconds: granularityConfig(graph),
        quoteCurrencies: currencies
      },
      sliding
    }];
  }
  if (graph.type === 'kraken') {
    return [{
      ...graphCacheIdentity({ graph, scope: 'kraken', primaryCurrency, tooltipCurrencies }),
      scope: 'kraken' as const,
      input: {
        fromMs: from,
        toMs: to,
        granularitySeconds: granularityConfig(graph),
        quoteCurrencies: currencies
      },
      sliding
    }];
  }
  if (graph.type === 'addresses') {
    return [{
      ...graphCacheIdentity({ graph, scope: 'addresses', primaryCurrency, tooltipCurrencies }),
      scope: 'addresses' as const,
      input: {
        quoteCurrency: primaryCurrencyFor(graph, primaryCurrency),
        quoteCurrencies: currencies,
        fromMs: from,
        toMs: to,
        granularitySeconds: granularityConfig(graph)
      },
      sliding
    }];
  }
  const assetIds = Array.isArray(graph.config.assetIds)
    ? graph.config.assetIds.map(String).filter(Boolean)
    : [];
  if (assetIds.length === 0) return [];
  const primary = primaryCurrencyFor(graph, primaryCurrency);
  const yAxisUnit = stringConfig(graph, 'yAxisUnit', primary);
  const rightYAxisUnit = stringConfig(graph, 'rightYAxisUnit', '');
  const yAxisIsFiat = currencies.includes(yAxisUnit.toUpperCase());
  const rightYAxisIsFiat = !rightYAxisUnit || currencies.includes(rightYAxisUnit.toUpperCase());
  const tooltipCryptoIds = normalizeTooltipUnits({
    value: graph.config.tooltipUnits,
    fallback: tooltipCurrencies
  }).filter((unit) => unit !== '%' && !/^[A-Z]{3}$/.test(unit));
  const visible = stringArrayConfig(
    graph,
    'visibleSeriesIds',
    stringArrayConfig(graph, 'seriesIds', assetIds)
  ) ?? assetIds;
  const plotted = visible.length > 0
    ? visible.filter((assetId) => assetIds.includes(assetId))
    : assetIds;
  const requestedAssetIds = [...new Set([
    ...plotted,
    ...(stringArrayConfig(graph, 'leftYAxisSeriesIds', []) ?? []),
    ...(stringArrayConfig(graph, 'rightYAxisSeriesIds', []) ?? []),
    ...(yAxisIsFiat ? [] : [yAxisUnit]),
    ...(rightYAxisIsFiat ? [] : [rightYAxisUnit]),
    ...tooltipCryptoIds
  ].filter(Boolean))];
  return [...new Set([...currencies, 'USD'])].map((quoteCurrency) => ({
    ...graphCacheIdentity({
      graph,
      scope: 'market',
      suffix: quoteCurrency,
      primaryCurrency,
      tooltipCurrencies
    }),
    scope: 'market' as const,
    input: {
      assetIds: requestedAssetIds,
      quoteCurrency,
      source: stringConfig(graph, 'source', 'combined'),
      fromMs: from,
      toMs: to,
      granularity: granularityConfig(graph),
      chartMode: stringConfig(graph, 'chartMode', 'line')
    },
    sliding
  }));
});
