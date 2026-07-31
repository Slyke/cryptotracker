<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import PortfolioChart from './PortfolioChart.svelte';
  import type {
    ChartDenominationOption,
    ChartEvent,
    ChartSeries
  } from './chart-types';
  import {
    normalizeTooltipUnits,
    relativeRangeWindow,
    type RelativeRangeUnit,
    type SavedGraph
  } from '$lib/preferences';
  import { apiRequest } from '$lib/api';
  import { bucketChartSeries } from '$lib/chart-data';
  import { configuredCurrencies } from '$lib/currencies';
  import { normalizeChartSeriesLineStyles } from '$lib/chart-line-styles';
  import {
    transformPerformanceSeries,
    type PerformanceMode
  } from '$lib/performance';

  export let graph: SavedGraph;
  export let minimalChrome = false;

  const dispatch = createEventDispatcher<{
    hide: { id: string };
  }>();
  let series: ChartSeries[] = [];
  let events: ChartEvent[] = [];
  let denominationOptions: ChartDenominationOption[] = [];
  let loading = true;
  let error = '';
  let partial = false;
  let stale = false;
  let resolvedGranularity = 86_400;
  let fallbackTooltipCurrencies: string[] = [];
  let currentPrimaryCurrency = '';

  const stringConfig = (key: string, fallback: string) => (
    typeof graph.config[key] === 'string' ? String(graph.config[key]) : fallback
  );
  const numberConfig = (key: string, fallback: number | null) => (
    typeof graph.config[key] === 'number' && Number.isFinite(graph.config[key])
      ? Number(graph.config[key])
      : fallback
  );
  const stringArrayConfig = (key: string, fallback: string[] | null = null) => (
    Array.isArray(graph.config[key])
      ? [...new Set((graph.config[key] as unknown[]).map(String).filter(Boolean))]
      : fallback
  );
  const sourceRoute = () => graph.type === 'portfolio'
    ? '/markets'
    : graph.type === 'market'
      ? '/markets'
      : graph.type === 'addresses'
        ? '/addresses'
        : '/kraken';
  const editHref = () => {
    const params = new URLSearchParams({ editGraph: graph.id });
    const anchor = graph.type === 'portfolio'
      ? 'combined-portfolio-chart'
      : graph.type === 'market' && graph.config.analytics === 'performance'
        ? 'market-performance-chart'
        : graph.type === 'market'
          ? 'market-price-chart'
          : graph.type === 'addresses'
            ? 'address-portfolio-chart'
            : 'kraken-portfolio-chart';
    return `${sourceRoute()}?${params}#${anchor}`;
  };
  const requestRemove = () => {
    if (!confirm(`Remove the dashboard graph “${graph.name}”?`)) return;
    dispatch('hide', { id: graph.id });
  };
  const isPerformanceChart = () => (
    graph.type === 'market' && graph.config.analytics === 'performance'
  );
  const chartCurrency = () => (
    isPerformanceChart()
      ? '%'
      : currentPrimaryCurrency
        || stringConfig('primaryCurrency', stringConfig('currency', 'CAD')).toUpperCase()
  );
  const chartYAxisUnit = () => {
    const savedPrimary = stringConfig('primaryCurrency', stringConfig('currency', 'CAD'));
    const savedAxis = stringConfig('yAxisUnit', savedPrimary);
    return savedAxis.toUpperCase() === savedPrimary.toUpperCase()
      ? chartCurrency()
      : savedAxis;
  };
  const chartRightYAxisUnit = () => {
    const savedAxis = stringConfig('rightYAxisUnit', '');
    if (!savedAxis) return '';
    const savedPrimary = stringConfig('primaryCurrency', stringConfig('currency', 'CAD'));
    return savedAxis.toUpperCase() === savedPrimary.toUpperCase()
      ? chartCurrency()
      : savedAxis;
  };
  const savedTooltipUnits = () => isPerformanceChart()
    ? ['%']
    : normalizeTooltipUnits({
        value: graph.config.tooltipUnits,
        fallback: Array.isArray(graph.config.tooltipCurrencies)
          ? graph.config.tooltipCurrencies.map(String)
          : fallbackTooltipCurrencies
      });
  const configuredTooltipCurrencies = () => {
    if (isPerformanceChart()) return ['%'];
    return configuredCurrencies({
      primaryCurrency: chartCurrency(),
      listedCurrencies: [
        ...(Array.isArray(graph.config.tooltipCurrencies)
          ? graph.config.tooltipCurrencies.map(String)
          : []),
        ...savedTooltipUnits(),
        chartRightYAxisUnit()
      ].filter((unit) => /^[A-Z]{3}$/.test(unit))
    });
  };
  const rangeWindow = () => {
    const now = Date.now();
    const range = stringConfig('range', '30d');
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
      if (relative) return relative;
    }
    if (
      range === 'custom'
      && typeof graph.config.customFromMs === 'number'
      && typeof graph.config.customToMs === 'number'
    ) {
      return { from: graph.config.customFromMs, to: graph.config.customToMs };
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
      to: now
    };
  };

  const load = async () => {
    loading = true;
    error = '';
    const { from, to } = rangeWindow();
    try {
      const settingsPayload = await apiRequest<{
        settings: {
          primaryCurrency: string;
          tooltipCurrencies: string[];
        };
      }>({ url: '/api/settings' });
      currentPrimaryCurrency = settingsPayload.settings.primaryCurrency.toUpperCase();
      fallbackTooltipCurrencies = settingsPayload.settings.tooltipCurrencies ?? [];
      if (graph.type === 'portfolio') {
        const currencies = configuredTooltipCurrencies();
        const payload = await apiRequest<{
          data: {
            series: ChartSeries[];
            events: ChartEvent[];
            denominationOptions: ChartDenominationOption[];
            partial: boolean;
            stale: boolean;
            granularitySeconds: number;
          };
        }>({
          url: `/api/portfolio/series?from=${from}&to=${to}&granularitySeconds=${stringConfig('granularity', 'auto')}&quoteCurrencies=${encodeURIComponent(currencies.join(','))}`
        });
        const selectedGranularity = Number(stringConfig('granularity', 'auto'));
        resolvedGranularity = Number.isFinite(selectedGranularity)
          ? Math.max(payload.data.granularitySeconds, selectedGranularity)
          : payload.data.granularitySeconds;
        series = bucketChartSeries({
          series: payload.data.series,
          granularitySeconds: resolvedGranularity
        });
        events = payload.data.events;
        denominationOptions = payload.data.denominationOptions;
        partial = payload.data.partial;
        stale = payload.data.stale;
      } else if (graph.type === 'market') {
        const assetIds = Array.isArray(graph.config.assetIds)
          ? graph.config.assetIds.map(String).filter(Boolean)
          : [];
        if (assetIds.length === 0) {
          series = [];
          return;
        }
        const currency = currentPrimaryCurrency
          || stringConfig('primaryCurrency', 'CAD').toUpperCase();
        const currencies = configuredTooltipCurrencies();
        const requestCurrencies = [...new Set([...currencies, 'USD'])];
        const yAxisUnit = stringConfig('yAxisUnit', currency);
        const yAxisIsFiat = currencies.includes(yAxisUnit.toUpperCase());
        const rightYAxisUnit = chartRightYAxisUnit();
        const rightYAxisIsFiat = !rightYAxisUnit
          || currencies.includes(rightYAxisUnit.toUpperCase());
        const tooltipCryptoIds = savedTooltipUnits()
          .filter((unit) => unit !== '%' && !/^[A-Z]{3}$/.test(unit));
        const requestedAssetIds = [...new Set([
          ...assetIds,
          ...(yAxisIsFiat ? [] : [yAxisUnit]),
          ...(rightYAxisIsFiat ? [] : [rightYAxisUnit]),
          ...tooltipCryptoIds
        ])];
        type MarketSeriesPayload = {
          data: {
            series: ChartSeries[];
            events: ChartEvent[];
            partial: boolean;
            stale: boolean;
            resolvedGranularity: number;
            overviewGranularity: number;
            mixedGranularity: boolean;
          };
        };
        const payloads = await Promise.all(requestCurrencies.map(async (quoteCurrency) => {
          const params = new URLSearchParams({
            assetIds: requestedAssetIds.join(','),
            quoteCurrency,
            source: stringConfig('source', 'combined'),
            from: String(from),
            to: String(to),
            granularity: stringConfig('granularity', 'auto'),
            chartMode: stringConfig('chartMode', 'line')
          });
          return [
            quoteCurrency,
            await apiRequest<MarketSeriesPayload>({ url: `/api/market/series?${params}` })
          ] as const;
        }));
        const payloadByCurrency = new Map(payloads);
        const payload = payloadByCurrency.get(currency) ?? payloads[0]?.[1];
        if (!payload) {
          series = [];
          return;
        }
        const pointValuesByCurrency = new Map(requestCurrencies.map((quoteCurrency) => [
          quoteCurrency,
          new Map((payloadByCurrency.get(quoteCurrency)?.data.series ?? []).flatMap((item) => (
            item.points.map((point) => [
              `${item.id}:${point.timestampMs}`,
              point.value ?? point.close ?? null
            ] as const)
          )))
        ]));
        const denominationIds = [...new Set([
          ...(yAxisIsFiat ? [] : [yAxisUnit]),
          ...(rightYAxisIsFiat ? [] : [rightYAxisUnit]),
          ...tooltipCryptoIds
        ])];
        denominationOptions = denominationIds.map((denominationId) => {
          const denominatorSeries = payload.data.series.find((item) => item.id === denominationId);
          return {
            id: denominationId,
            symbol: denominatorSeries?.label.split(' · ')[0] ?? denominationId.toUpperCase(),
            label: denominatorSeries?.label ?? denominationId
          };
        });
        series = payload.data.series
          .filter((item) => assetIds.includes(item.id))
          .map((item) => ({
            ...item,
            points: item.points.map((point) => {
              const denominationCurrencies = [currency, 'USD']
                .filter((candidate, index, values) => values.indexOf(candidate) === index);
              const denominations: Record<string, string | null> = {};
              const denominationFallbacks: Record<string, string> = {};
              for (const denominationId of denominationIds) {
                denominations[denominationId] = null;
                for (const quoteCurrency of denominationCurrencies) {
                  const numerator = Number(pointValuesByCurrency.get(quoteCurrency)
                    ?.get(`${item.id}:${point.timestampMs}`));
                  const denominator = Number(pointValuesByCurrency.get(quoteCurrency)
                    ?.get(`${denominationId}:${point.timestampMs}`));
                  if (
                    !Number.isFinite(numerator)
                    || !Number.isFinite(denominator)
                    || denominator <= 0
                  ) continue;
                  denominations[denominationId] = String(numerator / denominator);
                  if (quoteCurrency !== currency) {
                    denominationFallbacks[denominationId] = quoteCurrency;
                  }
                  break;
                }
              }
              return {
                ...point,
                quotes: Object.fromEntries(requestCurrencies.map((quoteCurrency) => [
                  quoteCurrency,
                  pointValuesByCurrency.get(quoteCurrency)
                    ?.get(`${item.id}:${point.timestampMs}`) ?? null
                ])),
                denominations,
                denominationFallbacks
              };
            })
          }));
        if (isPerformanceChart()) {
          const performanceMode = stringConfig('performanceMode', 'return') as PerformanceMode;
          series = transformPerformanceSeries({ series, mode: performanceMode });
          events = [];
          denominationOptions = [];
        } else {
          events = payload.data.events;
        }
        partial = payloads.some(([, candidate]) => (
          candidate.data.partial || candidate.data.mixedGranularity
        ));
        stale = payloads.some(([, candidate]) => candidate.data.stale);
        resolvedGranularity = payload.data.overviewGranularity;
      } else if (graph.type === 'kraken') {
        const tooltipCurrencyQuery = encodeURIComponent(configuredTooltipCurrencies().join(','));
        const payload = await apiRequest<{
          data: {
            series: ChartSeries[];
            events: ChartEvent[];
            denominationOptions: ChartDenominationOption[];
            partial?: boolean;
            granularitySeconds: number;
          };
        }>({
          url: `/api/kraken/series?from=${from}&to=${to}&granularitySeconds=${stringConfig('granularity', 'auto')}&quoteCurrencies=${tooltipCurrencyQuery}`
        });
        const configured = Array.isArray(graph.config.seriesIds)
          ? graph.config.seriesIds.map(String)
          : ['kraken-total'];
        const visible = new Set(configured);
        resolvedGranularity = payload.data.granularitySeconds;
        series = payload.data.series.filter((item) => visible.has(item.id));
        events = payload.data.events;
        denominationOptions = payload.data.denominationOptions;
        partial = Boolean(payload.data.partial);
      } else {
        const currency = currentPrimaryCurrency || stringConfig('currency', 'CAD');
        const granularity = stringConfig('granularity', 'auto');
        const tooltipCurrencyQuery = encodeURIComponent(configuredTooltipCurrencies().join(','));
        const payload = await apiRequest<{
          data: {
            series: ChartSeries[];
            events: ChartEvent[];
            partial: boolean;
            stale: boolean;
            granularitySeconds: number;
            denominationOptions: ChartDenominationOption[];
          };
        }>({
          url: `/api/addresses/series?quoteCurrency=${currency}&quoteCurrencies=${tooltipCurrencyQuery}&from=${from}&to=${to}&granularitySeconds=${granularity}`
        });
        series = payload.data.series;
        events = payload.data.events;
        denominationOptions = payload.data.denominationOptions;
        partial = payload.data.partial;
        stale = payload.data.stale;
        resolvedGranularity = payload.data.granularitySeconds;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Saved graph could not load.';
      series = [];
    } finally {
      loading = false;
    }
  };

  onMount(() => {
    void load();
  });
</script>

<article class:minimal-chrome={minimalChrome} class="saved-chart">
  {#if !minimalChrome}
    <div class="saved-chart-header">
      <div>
        <span class="badge start">{graph.type}</span>
        <h3>{graph.name}</h3>
      </div>
      <div class="saved-chart-actions">
        <a class="button ghost compact" href={editHref()}>Edit</a>
        <button class="ghost compact" type="button" on:click={requestRemove}>Remove</button>
      </div>
    </div>
  {/if}
  {#if error}<div class="alert danger">{error}</div>{/if}
  <PortfolioChart
    title={graph.name}
    {series}
    {events}
    chartMode={stringConfig('chartMode', 'line') === 'candlestick' ? 'candlestick' : 'line'}
    currency={chartCurrency()}
    tooltipCurrencies={configuredTooltipCurrencies()}
    {denominationOptions}
    source={isPerformanceChart()
      ? 'derived analytics'
      : graph.type === 'market'
        ? stringConfig('source', 'combined')
        : graph.type}
    timezone={stringConfig('timezone', 'America/Vancouver')}
    granularity={resolvedGranularity}
    selectedGranularitySetting={stringConfig('granularity', 'auto')}
    partial={partial && !minimalChrome}
    partialMessage="This saved graph contains missing data. Settings → Synchronization identifies active work and cached coverage."
    {stale}
    busy={loading}
    compact
    preferenceKey={`dashboard:${graph.id}`}
    {minimalChrome}
    initialRange={stringConfig('range', '30d')}
    initialCustomFromMs={numberConfig('customFromMs', null)}
    initialCustomToMs={numberConfig('customToMs', null)}
    initialCustomRangeMode={graph.config.customRangeMode === 'ago' ? 'ago' : 'dates'}
    initialCustomAgoValue={numberConfig('customAgoValue', 30) ?? 30}
    initialCustomAgoUnit={['hours', 'days', 'weeks', 'months', 'years'].includes(
      String(graph.config.customAgoUnit)
    )
      ? String(graph.config.customAgoUnit) as RelativeRangeUnit
      : 'days'}
    initialScale={stringConfig('scale', 'linear') === 'log' ? 'log' : 'linear'}
    initialYAxisUnit={isPerformanceChart() ? '%' : chartYAxisUnit()}
    initialTooltipUnits={savedTooltipUnits()}
    initialMinimumMode={['absolute', 'relative'].includes(stringConfig('minimumMode', 'auto'))
      ? stringConfig('minimumMode', 'auto') as 'absolute' | 'relative'
      : 'auto'}
    initialMaximumMode={['absolute', 'relative'].includes(stringConfig('maximumMode', 'auto'))
      ? stringConfig('maximumMode', 'auto') as 'absolute' | 'relative'
      : 'auto'}
    initialMinimumValue={stringConfig('minimumValue', '')}
    initialMaximumValue={stringConfig('maximumValue', '')}
    initialNormalized={Boolean(graph.config.normalized)}
    initialShowWicks={graph.config.showWicks !== false}
    initialShowEvents={graph.config.showEvents !== false}
    initialShowVolume={Boolean(graph.config.showVolume)}
    initialVisibleSeriesIds={stringArrayConfig(
      'visibleSeriesIds',
      stringArrayConfig('seriesIds')
    )}
    initialLeftYAxisSeriesIds={stringArrayConfig(
      'leftYAxisSeriesIds',
      stringArrayConfig('visibleSeriesIds', stringArrayConfig('seriesIds'))
    )}
    initialRightYAxisUnit={chartRightYAxisUnit()}
    initialRightYAxisSeriesIds={stringArrayConfig('rightYAxisSeriesIds', []) ?? []}
    initialLeftYAxisLineColor={stringConfig('leftYAxisLineColor', '#364255')}
    initialRightYAxisLineColor={stringConfig('rightYAxisLineColor', '#ffbc3a')}
    initialSeriesLineStyles={normalizeChartSeriesLineStyles(graph.config.seriesLineStyles)}
  />
</article>

<style>
  .saved-chart {
    min-width: 0;
    padding: 1rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-panel);
  }

  .saved-chart.minimal-chrome {
    padding: 0.55rem;
  }

  .saved-chart-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.7rem;
  }

  .saved-chart-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.4rem;
  }

  h3 {
    margin: 0.35rem 0 0;
  }

  :global(.saved-chart .chart) {
    min-height: 25rem;
  }
</style>
