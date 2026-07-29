<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import PortfolioChart from './PortfolioChart.svelte';
  import DismissableNotice from './DismissableNotice.svelte';
  import type {
    ChartDenominationOption,
    ChartEvent,
    ChartSeries
  } from './chart-types';
  import {
    relativeRangeWindow,
    type RelativeRangeUnit,
    type SavedGraph
  } from '$lib/preferences';
  import { apiRequest } from '$lib/api';
  import { configuredCurrencies } from '$lib/currencies';

  export let graph: SavedGraph;
  export let partialDismissed = false;
  export let minimalChrome = false;

  const dispatch = createEventDispatcher<{
    hide: { id: string };
    dismiss: { id: string };
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
  const chartCurrency = () => (
    currentPrimaryCurrency
    || stringConfig('primaryCurrency', stringConfig('currency', 'CAD')).toUpperCase()
  );
  const chartYAxisUnit = () => {
    const savedPrimary = stringConfig('primaryCurrency', stringConfig('currency', 'CAD'));
    const savedAxis = stringConfig('yAxisUnit', savedPrimary);
    return savedAxis.toUpperCase() === savedPrimary.toUpperCase()
      ? chartCurrency()
      : savedAxis;
  };
  const configuredTooltipCurrencies = () => {
    return configuredCurrencies({
      primaryCurrency: chartCurrency(),
      listedCurrencies: fallbackTooltipCurrencies
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
          url: `/api/portfolio/series?from=${from}&to=${to}&quoteCurrencies=${encodeURIComponent(currencies.join(','))}`
        });
        series = payload.data.series;
        events = payload.data.events;
        denominationOptions = payload.data.denominationOptions;
        partial = payload.data.partial;
        stale = payload.data.stale;
        resolvedGranularity = payload.data.granularitySeconds;
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
        const yAxisUnit = stringConfig('yAxisUnit', currency);
        const yAxisIsFiat = currencies.includes(yAxisUnit.toUpperCase());
        const requestedAssetIds = [...new Set([
          ...assetIds,
          ...(yAxisIsFiat ? [] : [yAxisUnit])
        ])];
        type MarketSeriesPayload = {
          data: {
            series: ChartSeries[];
            events: ChartEvent[];
            partial: boolean;
            stale: boolean;
            resolvedGranularity: number;
          };
        };
        const payloads = await Promise.all(currencies.map(async (quoteCurrency) => {
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
        const pointValuesByCurrency = new Map(currencies.map((quoteCurrency) => [
          quoteCurrency,
          new Map((payloadByCurrency.get(quoteCurrency)?.data.series ?? []).flatMap((item) => (
            item.points.map((point) => [
              `${item.id}:${point.timestampMs}`,
              point.value ?? point.close ?? null
            ] as const)
          )))
        ]));
        const denominatorSeries = yAxisIsFiat
          ? undefined
          : payload.data.series.find((item) => item.id === yAxisUnit);
        denominationOptions = yAxisIsFiat
          ? []
          : [{
              id: yAxisUnit,
              symbol: denominatorSeries?.label.split(' · ')[0] ?? yAxisUnit.toUpperCase(),
              label: denominatorSeries?.label ?? yAxisUnit
            }];
        series = payload.data.series
          .filter((item) => assetIds.includes(item.id))
          .map((item) => ({
            ...item,
            points: item.points.map((point) => {
              const denominatorPoint = denominatorSeries?.points
                .find((candidate) => candidate.timestampMs === point.timestampMs);
              const numerator = Number(point.value ?? point.close);
              const denominator = Number(denominatorPoint?.value ?? denominatorPoint?.close);
              return {
                ...point,
                quotes: Object.fromEntries(currencies.map((quoteCurrency) => [
                  quoteCurrency,
                  pointValuesByCurrency.get(quoteCurrency)
                    ?.get(`${item.id}:${point.timestampMs}`) ?? null
                ])),
                denominations: yAxisIsFiat
                  ? {}
                  : {
                      [yAxisUnit]: Number.isFinite(numerator)
                        && Number.isFinite(denominator)
                        && denominator > 0
                        ? String(numerator / denominator)
                        : null
                    }
              };
            })
          }));
        events = payload.data.events;
        partial = payloads.some(([, candidate]) => candidate.data.partial);
        stale = payloads.some(([, candidate]) => candidate.data.stale);
        resolvedGranularity = payload.data.resolvedGranularity;
      } else if (graph.type === 'kraken') {
        const tooltipCurrencyQuery = encodeURIComponent(configuredTooltipCurrencies().join(','));
        const payload = await apiRequest<{
          data: {
            series: ChartSeries[];
            events: ChartEvent[];
            denominationOptions: ChartDenominationOption[];
            partial?: boolean;
          };
        }>({ url: `/api/kraken/series?from=${from}&to=${to}&quoteCurrencies=${tooltipCurrencyQuery}` });
        const configured = Array.isArray(graph.config.seriesIds)
          ? graph.config.seriesIds.map(String)
          : ['kraken-total'];
        const visible = new Set(configured);
        series = payload.data.series.filter((item) => visible.has(item.id));
        events = payload.data.events;
        denominationOptions = payload.data.denominationOptions;
        partial = Boolean(payload.data.partial);
        resolvedGranularity = 1_800;
      } else {
        const currency = currentPrimaryCurrency || stringConfig('currency', 'CAD');
        const granularity = Number(stringConfig('granularity', '86400')) || 86_400;
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

<article class="saved-chart">
  <div class="saved-chart-header">
    <div>
      {#if !minimalChrome}<span class="badge start">{graph.type}</span>{/if}
      <h3 class:compact-title={minimalChrome}>{graph.name}</h3>
    </div>
    <button class="ghost compact" type="button" on:click={() => dispatch('hide', { id: graph.id })}>Remove</button>
  </div>
  {#if error}<div class="alert danger">{error}</div>{/if}
  {#if partial}
    <DismissableNotice
      noticeId="dashboard-saved-graph-missing-data"
      tone="warning"
      dismissed={partialDismissed}
      on:dismiss={(event) => dispatch('dismiss', event.detail)}
    >This saved graph contains missing data. Settings → Synchronization identifies active work and cached coverage.</DismissableNotice>
  {/if}
  <PortfolioChart
    title={graph.name}
    {series}
    {events}
    chartMode={stringConfig('chartMode', 'line') === 'candlestick' ? 'candlestick' : 'line'}
    currency={chartCurrency()}
    tooltipCurrencies={configuredTooltipCurrencies()}
    {denominationOptions}
    source={graph.type === 'market' ? stringConfig('source', 'combined') : graph.type}
    timezone={stringConfig('timezone', 'America/Vancouver')}
    granularity={resolvedGranularity}
    partial={false}
    {stale}
    busy={loading}
    compact
    preferenceKey={`dashboard:${graph.id}`}
    {minimalChrome}
    initialRange={stringConfig('range', '30d')}
    initialScale={stringConfig('scale', 'linear') === 'log' ? 'log' : 'linear'}
    initialYAxisUnit={chartYAxisUnit()}
    initialNormalized={Boolean(graph.config.normalized)}
    initialShowEvents={graph.config.showEvents !== false}
    initialShowVolume={Boolean(graph.config.showVolume)}
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

  .saved-chart-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.7rem;
  }

  h3 {
    margin: 0.35rem 0 0;
  }

  h3.compact-title {
    margin-top: 0;
  }

  :global(.saved-chart .chart) {
    min-height: 25rem;
  }
</style>
