<script lang="ts">
  import { onMount } from 'svelte';
  import PortfolioChart from '../../lib/components/PortfolioChart.svelte';
  import PerformanceAnalytics from '../../lib/components/PerformanceAnalytics.svelte';
  import LargeToggleButton from '../../lib/components/LargeToggleButton.svelte';
  import ColumnConfigurator from '../../lib/components/ColumnConfigurator.svelte';
  import ReorderableBlock from '../../lib/components/ReorderableBlock.svelte';
  import type {
    ChartDenominationOption,
    ChartEvent,
    ChartSeries
  } from '../../lib/components/chart-types';
  import { apiRequest } from '$lib/api';
  import { configuredCurrencies } from '$lib/currencies';
  import strings from '$lib/i18n/en-CA.json';
  import {
    chartDisplayStateFromSetting,
    chartQueryStateFromSetting,
    createSavedGraph,
    defaultChartDisplayState,
    defaultChartQueryState,
    moveInOrder,
    normalizeOrder,
    relativeRangeWindow,
    replaceSavedGraph,
    savePreferences,
    savedGraphWithName,
    toggleCollapsed,
    type ChartDisplayState,
    type ChartQueryState,
    type RelativeRangeUnit,
    type SavedGraph
  } from '$lib/preferences';

  type WatchAsset = {
    id: string;
    canonicalId: string;
    symbol: string;
    name: string;
    enabled: boolean;
  };
  type CatalogAsset = {
    canonicalId: string;
    symbol: string;
    name: string;
    marketCapRank?: number | null;
    source?: string;
  };
  type MarketSeriesData = {
    partial: boolean;
    stale: boolean;
    resolvedGranularity: number;
    overviewGranularity: number;
    mixedGranularity: boolean;
    sourceGranularities: number[];
    missingIntervals?: Array<{ assetId: string; fromMs: number; toMs: number }>;
    events: ChartEvent[];
    series: ChartSeries[];
  };
  type CurrencyMarketSeries = {
    currency: string;
    data: MarketSeriesData;
  };

  let watchlist: WatchAsset[] = [];
  let catalog: CatalogAsset[] = [];
  let selected = new Set<string>();
  let source: 'combined' | 'coingecko' | 'coinbase' | 'kraken' = 'combined';
  let chartMode: 'line' | 'candlestick' = 'line';
  let primaryCurrency = 'CAD';
  let tooltipCurrencies = ['CAD'];
  let timezone = 'America/Vancouver';
  let customFromMs = Date.now() - 30 * 24 * 60 * 60_000;
  let customToMs = Date.now();
  let series: ChartSeries[] = [];
  let overviewSeries: ChartSeries[] = [];
  let events: ChartEvent[] = [];
  let performanceSeries: ChartSeries[] = [];
  let performanceLoading = true;
  let performanceFromMs = Date.now() - 30 * 24 * 60 * 60_000;
  let performanceToMs = Date.now();
  let portfolioSeries: ChartSeries[] = [];
  let portfolioOverviewSeries: ChartSeries[] = [];
  let portfolioEvents: ChartEvent[] = [];
  let portfolioDenominationOptions: ChartDenominationOption[] = [];
  let portfolioPartial = false;
  let portfolioStale = false;
  let portfolioLoading = true;
  let portfolioRange = '30d';
  let portfolioGranularity = 'auto';
  let portfolioResolvedGranularity = 1_800;
  let portfolioFromMs = Date.now() - 30 * 24 * 60 * 60_000;
  let portfolioToMs = Date.now();
  let watchedChartState = defaultChartQueryState();
  let portfolioChartState = defaultChartQueryState();
  let watchedDisplayState = defaultChartDisplayState(primaryCurrency);
  let portfolioDisplayState = defaultChartDisplayState(primaryCurrency);
  let graphDefaults: Record<string, unknown> = {};
  let chartPreferencesReady = false;
  let partial = false;
  let stale = false;
  let resolvedGranularity = 3_600;
  let tableDashboardName = 'Markets catalog';
  let range = '30d';
  let granularity = 'auto';
  let loading = true;
  let error = '';
  let exportQuery = '';
  let message = '';
  let catalogFilter = '';
  let savedGraphs: SavedGraph[] = [];
  let watchedEditConfig: Record<string, unknown> = {};
  let portfolioEditConfig: Record<string, unknown> = {};
  let watchedSaveName = 'Watched market prices';
  let portfolioSaveName = 'Combined portfolio history';
  let performanceEditConfig: Record<string, unknown> = {};
  let performanceSaveName = 'Market performance';
  let performanceVisibleSeriesIds: string[] | null = null;
  let pageLayouts: Record<string, string[]> = {};
  let collapsedBlocks: Record<string, string[]> = {};
  let tableColumns: Record<string, string[]> = {};
  const defaultPageOrder = ['controls', 'portfolio', 'chart', 'performance', 'watchlist'];
  let pageOrder = [...defaultPageOrder];
  const watchlistColumnOptions = [
    { id: 'asset', label: 'Asset' },
    { id: 'rank', label: 'Market-cap rank' },
    { id: 'identity', label: 'Canonical identity' },
    { id: 'state', label: 'State' },
    { id: 'source', label: 'Catalog source' },
    { id: 'action', label: 'Enable or disable' }
  ];
  const defaultWatchlistColumns = ['asset', 'rank', 'identity', 'state', 'action'];
  let watchlistColumns = [...defaultWatchlistColumns];
  let partialMessage = '';
  let seriesRequestId = 0;
  let performanceRequestId = 0;
  let zoomRequestId = 0;
  let portfolioRequestId = 0;
  let portfolioZoomRequestId = 0;

  const rangeMilliseconds = {
    '24h': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
    '30d': 30 * 24 * 60 * 60_000,
    '90d': 90 * 24 * 60 * 60_000,
    '1y': 365 * 24 * 60 * 60_000,
    '4y': 4 * 365 * 24 * 60 * 60_000,
    all: 5 * 365 * 24 * 60_000,
    custom: 30 * 24 * 60 * 60_000
  } as const;
  const granularityLabel = (seconds: number) => new Map([
    [300, '5 minutes'],
    [900, '15 minutes'],
    [1_800, '30 minutes'],
    [3_600, '1 hour'],
    [14_400, '4 hours'],
    [86_400, '1 day'],
    [604_800, '1 week']
  ]).get(seconds) ?? `${seconds.toLocaleString()} seconds`;
  const configString = (
    config: Record<string, unknown>,
    key: string,
    fallback = ''
  ) => typeof config[key] === 'string' ? String(config[key]) : fallback;
  const boundMode = (
    config: Record<string, unknown>,
    key: 'minimumMode' | 'maximumMode'
  ): 'auto' | 'absolute' | 'relative' => (
    ['absolute', 'relative'].includes(configString(config, key))
      ? configString(config, key) as 'absolute' | 'relative'
      : 'auto'
  );
  const chartWindow = (state: ChartQueryState) => {
    const now = Date.now();
    if (state.range === 'custom' && state.customRangeMode === 'ago') {
      return relativeRangeWindow({
        value: state.customAgoValue,
        unit: state.customAgoUnit,
        toMs: now
      }) ?? { from: now - rangeMilliseconds['30d'], to: now };
    }
    if (
      state.range === 'custom'
      && state.customFromMs !== null
      && state.customToMs !== null
    ) {
      return { from: state.customFromMs, to: state.customToMs };
    }
    const duration = rangeMilliseconds[state.range as keyof typeof rangeMilliseconds]
      ?? rangeMilliseconds['30d'];
    return {
      from: state.range === 'all' ? 0 : now - duration,
      to: now
    };
  };

  let enabledAssets: WatchAsset[] = [];
  let denominationOptions: ChartDenominationOption[] = [];
  let portfolioAxisDenominationOptions: ChartDenominationOption[] = [];
  let onlyBitcoinEnabled = false;
  let filteredCatalogAssets: CatalogAsset[] = [];
  let watchedAssetsByCanonicalId = new Map<string, WatchAsset>();
  const uniqueByCanonicalId = <Asset extends { canonicalId: string }>(assets: Asset[]) => (
    [...new Map(assets.map((asset) => [asset.canonicalId, asset])).values()]
  );

  $: enabledAssets = watchlist.filter((asset) => asset.enabled);
  $: denominationOptions = enabledAssets.map((asset) => ({
    id: asset.canonicalId,
    symbol: asset.symbol,
    label: `${asset.symbol} · ${asset.name}`
  }));
  $: portfolioAxisDenominationOptions = [
    ...new Map([
      ...denominationOptions,
      ...portfolioDenominationOptions
    ].map((option) => [option.id, option])).values()
  ];
  $: onlyBitcoinEnabled = enabledAssets.length === 1
    && enabledAssets[0]?.canonicalId === 'bitcoin';
  $: watchedAssetsByCanonicalId = new Map(
    watchlist.map((asset) => [asset.canonicalId, asset])
  );
  $: {
    const normalized = catalogFilter.trim().toLowerCase();
    filteredCatalogAssets = normalized
      ? catalog.filter((asset) => (
          asset.symbol.toLowerCase().includes(normalized)
          || asset.name.toLowerCase().includes(normalized)
          || asset.canonicalId.toLowerCase().includes(normalized)
          || String(asset.marketCapRank ?? '').includes(normalized)
        ))
      : catalog;
  }

  const watchState = ({ canonicalId }: { canonicalId: string }) => (
    watchedAssetsByCanonicalId.get(canonicalId) ?? null
  );

  const loadShell = async () => {
    const [watchPayload, catalogPayload, settingsPayload] = await Promise.all([
      apiRequest<{ assets: WatchAsset[] }>({ url: '/api/watchlist/assets' }),
      apiRequest<{ assets: CatalogAsset[] }>({ url: '/api/catalog/assets' }),
      apiRequest<{
        settings: {
          primaryCurrency: string;
          tooltipCurrencies: string[];
          marketSource: typeof source;
          timezone: string;
          pageLayouts: Record<string, string[]>;
          collapsedBlocks: Record<string, string[]>;
          tableColumns: Record<string, string[]>;
          graphDefaults: Record<string, unknown>;
          savedGraphs: SavedGraph[];
        };
      }>({ url: '/api/settings' })
    ]);
    watchlist = uniqueByCanonicalId(watchPayload.assets);
    catalog = uniqueByCanonicalId(catalogPayload.assets);
    const enabledIds = new Set(watchlist.filter((asset) => asset.enabled).map((asset) => asset.canonicalId));
    const urlAssets = new URLSearchParams(location.search).get('assets')
      ?.split(',')
      .filter((id) => enabledIds.has(id)) ?? [];
    const retained = [...selected].filter((id) => enabledIds.has(id));
    const initialSelection = urlAssets.length > 0
      ? urlAssets
      : retained.length > 0
        ? retained
        : enabledIds.has('bitcoin')
          ? ['bitcoin']
          : [...enabledIds].slice(0, 1);
    selected = new Set(initialSelection.slice(0, 10));
    primaryCurrency = settingsPayload.settings.primaryCurrency;
    tooltipCurrencies = settingsPayload.settings.tooltipCurrencies;
    source = settingsPayload.settings.marketSource;
    timezone = settingsPayload.settings.timezone;
    pageLayouts = settingsPayload.settings.pageLayouts ?? {};
    collapsedBlocks = settingsPayload.settings.collapsedBlocks ?? {};
    tableColumns = settingsPayload.settings.tableColumns ?? {};
    graphDefaults = settingsPayload.settings.graphDefaults ?? {};
    savedGraphs = settingsPayload.settings.savedGraphs ?? [];
    if (!chartPreferencesReady) {
      const editGraphId = new URLSearchParams(location.search).get('editGraph');
      const editGraph = savedGraphs.find((graph) => (
        graph.id === editGraphId
        && graph.config.dashboardView !== 'table'
        && (graph.type === 'market' || graph.type === 'portfolio')
      )) ?? null;
      if (editGraph?.type === 'portfolio') {
        portfolioEditConfig = editGraph.config;
        portfolioSaveName = editGraph.name;
        collapsedBlocks = {
          ...collapsedBlocks,
          markets: (collapsedBlocks.markets ?? []).filter((id) => id !== 'portfolio')
        };
      } else if (editGraph?.config.analytics === 'performance') {
        performanceEditConfig = editGraph.config;
        performanceSaveName = editGraph.name;
        performanceVisibleSeriesIds = Array.isArray(editGraph.config.visibleSeriesIds)
          ? editGraph.config.visibleSeriesIds.map(String)
          : null;
        collapsedBlocks = {
          ...collapsedBlocks,
          markets: (collapsedBlocks.markets ?? []).filter((id) => id !== 'performance')
        };
        const performanceState = chartQueryStateFromSetting({
          value: editGraph.config,
          fallback: defaultChartQueryState()
        });
        const performanceWindow = chartWindow(performanceState);
        performanceFromMs = performanceWindow.from;
        performanceToMs = performanceWindow.to;
        const savedAssetIds = Array.isArray(editGraph.config.assetIds)
          ? editGraph.config.assetIds.map(String).filter(Boolean)
          : [];
        if (savedAssetIds.length > 0) selected = new Set(savedAssetIds.slice(0, 10));
        if (['combined', 'coingecko', 'coinbase', 'kraken'].includes(String(editGraph.config.source))) {
          source = String(editGraph.config.source) as typeof source;
        }
      } else if (editGraph?.type === 'market') {
        watchedEditConfig = editGraph.config;
        watchedSaveName = editGraph.name;
        collapsedBlocks = {
          ...collapsedBlocks,
          markets: (collapsedBlocks.markets ?? []).filter((id) => id !== 'chart')
        };
        const savedAssetIds = Array.isArray(editGraph.config.assetIds)
          ? editGraph.config.assetIds.map(String).filter(Boolean)
          : [];
        if (savedAssetIds.length > 0) selected = new Set(savedAssetIds.slice(0, 10));
        if (['combined', 'coingecko', 'coinbase', 'kraken'].includes(String(editGraph.config.source))) {
          source = String(editGraph.config.source) as typeof source;
        }
      }
      if (
        performanceVisibleSeriesIds === null
        && Array.isArray(graphDefaults.marketsPerformanceVisibleSeries)
      ) {
        performanceVisibleSeriesIds = graphDefaults.marketsPerformanceVisibleSeries.map(String);
      }
      watchedChartState = chartQueryStateFromSetting({
        value: Object.keys(watchedEditConfig).length > 0
          ? watchedEditConfig
          : graphDefaults.marketsWatchedChartState,
        fallback: defaultChartQueryState()
      });
      portfolioChartState = chartQueryStateFromSetting({
        value: Object.keys(portfolioEditConfig).length > 0
          ? portfolioEditConfig
          : graphDefaults.marketsPortfolioChartState,
        fallback: defaultChartQueryState()
      });
      watchedDisplayState = chartDisplayStateFromSetting({
        value: Object.keys(watchedEditConfig).length > 0
          ? watchedEditConfig
          : graphDefaults.marketsWatchedDisplayState,
        fallback: defaultChartDisplayState(primaryCurrency, configuredCurrencies({
          primaryCurrency,
          listedCurrencies: tooltipCurrencies
        }))
      });
      portfolioDisplayState = chartDisplayStateFromSetting({
        value: Object.keys(portfolioEditConfig).length > 0
          ? portfolioEditConfig
          : graphDefaults.marketsPortfolioDisplayState,
        fallback: defaultChartDisplayState(primaryCurrency, configuredCurrencies({
          primaryCurrency,
          listedCurrencies: tooltipCurrencies
        }))
      });
      chartMode = (
        watchedEditConfig.chartMode === 'candlestick'
        || (
          Object.keys(watchedEditConfig).length === 0
          && graphDefaults.marketsWatchedChartMode === 'candlestick'
        )
      )
        ? 'candlestick'
        : 'line';
      range = watchedChartState.range;
      granularity = watchedChartState.granularity;
      customFromMs = chartWindow(watchedChartState).from;
      customToMs = chartWindow(watchedChartState).to;
      portfolioRange = portfolioChartState.range;
      portfolioGranularity = portfolioChartState.granularity;
      const portfolioWindow = chartWindow(portfolioChartState);
      portfolioFromMs = portfolioWindow.from;
      portfolioToMs = portfolioWindow.to;
      chartPreferencesReady = true;
    }
    pageOrder = normalizeOrder({ saved: pageLayouts.markets, defaults: defaultPageOrder });
    watchlistColumns = tableColumns.marketWatchlist?.filter((id) =>
      watchlistColumnOptions.some((column) => column.id === id)) ?? [...defaultWatchlistColumns];
  };

  const buildQuery = ({
    currency,
    assetIds = [...selected],
    fromMs,
    toMs,
    granularityOverride,
    chartModeOverride
  }: {
    currency: string;
    assetIds?: string[];
    fromMs?: number;
    toMs?: number;
    granularityOverride?: string;
    chartModeOverride?: 'line' | 'candlestick';
  }) => {
    const to = toMs ?? (range === 'custom' ? customToMs : Date.now());
    const from = fromMs ?? (range === 'all'
      ? 0
      : range === 'custom'
        ? customFromMs
        : to - rangeMilliseconds[range as keyof typeof rangeMilliseconds]);
    const params = new URLSearchParams({
      assetIds: assetIds.join(','),
      quoteCurrency: currency,
      source,
      from: String(from),
      to: String(to),
      granularity: granularityOverride ?? granularity,
      chartMode: chartModeOverride ?? chartMode
    });
    return params;
  };

  const fetchMarketSeries = async ({
    fromMs,
    toMs,
    granularityOverride,
    chartModeOverride
  }: {
    fromMs?: number;
    toMs?: number;
    granularityOverride?: string;
    chartModeOverride?: 'line' | 'candlestick';
  } = {}) => {
    const currencies = configuredCurrencies({
      primaryCurrency,
      listedCurrencies: [...tooltipCurrencies, 'USD']
    });
    const requestedAssetIds = [...new Set([
      ...selected,
      ...enabledAssets.map((asset) => asset.canonicalId)
    ])].slice(0, 50);
    return Promise.all(currencies.map(async (currency): Promise<CurrencyMarketSeries> => {
      const params = buildQuery({
        currency,
        assetIds: requestedAssetIds,
        fromMs,
        toMs,
        granularityOverride,
        chartModeOverride
      });
      const payload = await apiRequest<{ data: MarketSeriesData }>({
        url: `/api/market/series?${params}`
      });
      return { currency, data: payload.data };
    }));
  };

  const decorateMarketSeries = (payloads: CurrencyMarketSeries[]) => {
    const primary = payloads.find((payload) => payload.currency === primaryCurrency) ?? payloads[0]!;
    const pointsByCurrency = new Map(payloads.map((payload) => [
      payload.currency,
      new Map(payload.data.series.map((item) => [
        item.id,
        new Map(item.points.map((point) => [point.timestampMs, point]))
      ]))
    ]));
    const denominationCurrencies = [
      primary.currency,
      'USD'
    ].filter((currency, index, values) => values.indexOf(currency) === index);
    return primary.data.series.filter((item) => selected.has(item.id)).map((item) => ({
        ...item,
        points: item.points.map((point) => {
          const quotes = Object.fromEntries(payloads.map((payload) => {
            const matching = pointsByCurrency.get(payload.currency)
              ?.get(item.id)
              ?.get(point.timestampMs);
            return [payload.currency, matching?.value ?? matching?.close ?? null];
          }));
          const denominations: Record<string, string | null> = {};
          const denominationFallbacks: Record<string, string> = {};
          for (const option of denominationOptions) {
            denominations[option.id] = null;
            for (const quoteCurrency of denominationCurrencies) {
              const numeratorPoint = pointsByCurrency.get(quoteCurrency)
                ?.get(item.id)
                ?.get(point.timestampMs);
              const denominatorPoint = pointsByCurrency.get(quoteCurrency)
                ?.get(option.id)
                ?.get(point.timestampMs);
              const numerator = Number(numeratorPoint?.value ?? numeratorPoint?.close);
              const denominator = Number(denominatorPoint?.value ?? denominatorPoint?.close);
              if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
                continue;
              }
              denominations[option.id] = String(numerator / denominator);
              if (quoteCurrency !== primary.currency) {
                denominationFallbacks[option.id] = quoteCurrency;
              }
              break;
            }
          }
          return {
            ...point,
            quotes,
            denominations,
            denominationFallbacks
          };
        })
      }));
  };

  const loadSeries = async () => {
    const requestId = ++seriesRequestId;
    if (selected.size === 0) {
      series = [];
      overviewSeries = [];
      events = [];
      loading = false;
      return;
    }
    loading = true;
    error = '';
    try {
      const payloads = await fetchMarketSeries();
      if (requestId !== seriesRequestId) return;
      const primary = payloads.find((payload) => payload.currency === primaryCurrency) ?? payloads[0]!;
      overviewSeries = decorateMarketSeries(payloads);
      series = overviewSeries;
      partial = primary.data.partial || primary.data.mixedGranularity;
      const missingIntervals = primary.data.missingIntervals ?? [];
      const affectedAssets = new Set(missingIntervals.map((interval) => interval.assetId)).size;
      const requestedDetail = granularity === 'auto'
        ? 'automatic detail'
        : `${granularityLabel(Number(granularity))} detail`;
      const mixedResolutionMessage = primary.data.mixedGranularity
        ? ` ${requestedDetail} is selected, while the zoomed-out overview resolves to ${granularityLabel(primary.data.overviewGranularity)}. Older portions use their finest locally cached daily or weekly observations; zoomed periods use finer cached points where available.`
        : '';
      partialMessage = missingIntervals.length > 0
        ? `The plotted range contains ${missingIntervals.length} missing price interval${missingIntervals.length === 1 ? '' : 's'} across ${affectedAssets} asset${affectedAssets === 1 ? '' : 's'}.${mixedResolutionMessage} These are data gaps, not proof that synchronization is still running; Settings → Synchronization shows active progress.`
        : mixedResolutionMessage.trim();
      stale = primary.data.stale;
      events = primary.data.events;
      resolvedGranularity = primary.data.overviewGranularity;
      exportQuery = buildQuery({ currency: primaryCurrency }).toString();
      const urlState = new URLSearchParams({
        assets: [...selected].join(','),
        source,
        mode: chartMode,
        range,
        granularity
      });
      const editGraphId = new URLSearchParams(location.search).get('editGraph');
      if (editGraphId) urlState.set('editGraph', editGraphId);
      history.replaceState(null, '', `/markets?${urlState}${location.hash}`);
    } catch (caught) {
      if (requestId !== seriesRequestId) return;
      error = caught instanceof Error ? caught.message : 'Market series failed.';
      series = [];
      overviewSeries = [];
      events = [];
    } finally {
      if (requestId === seriesRequestId) loading = false;
    }
  };

  const loadPerformanceSeries = async () => {
    const requestId = ++performanceRequestId;
    if (selected.size === 0) {
      performanceSeries = [];
      performanceLoading = false;
      return;
    }
    performanceLoading = true;
    try {
      const payloads = await fetchMarketSeries({
        fromMs: performanceFromMs,
        toMs: performanceToMs,
        granularityOverride: 'auto',
        chartModeOverride: 'line'
      });
      if (requestId !== performanceRequestId) return;
      performanceSeries = decorateMarketSeries(payloads);
    } catch (caught) {
      if (requestId !== performanceRequestId) return;
      error = caught instanceof Error ? caught.message : 'Market performance failed.';
      performanceSeries = [];
    } finally {
      if (requestId === performanceRequestId) performanceLoading = false;
    }
  };

  const mergeDetailedWindow = ({
    overview,
    detail,
    fromMs,
    toMs
  }: {
    overview: ChartSeries[];
    detail: ChartSeries[];
    fromMs: number;
    toMs: number;
  }) => {
    const detailById = new Map(detail.map((item) => [item.id, item]));
    return overview.map((item) => {
      const merged = new Map(item.points
        .filter((point) => point.timestampMs < fromMs || point.timestampMs > toMs)
        .map((point) => [point.timestampMs, point]));
      for (const point of detailById.get(item.id)?.points ?? []) {
        merged.set(point.timestampMs, point);
      }
      return {
        ...item,
        points: [...merged.values()].sort((left, right) => left.timestampMs - right.timestampMs)
      };
    });
  };

  const graphZoomed = async (event: CustomEvent<{ fromMs: number; toMs: number }>) => {
    const requestedGranularity = Number(granularity);
    if (
      granularity === 'auto'
      || !Number.isFinite(requestedGranularity)
      || resolvedGranularity <= requestedGranularity
    ) return;
    const requestId = ++zoomRequestId;
    loading = true;
    try {
      const payloads = await fetchMarketSeries({
        fromMs: event.detail.fromMs,
        toMs: event.detail.toMs
      });
      if (requestId !== zoomRequestId) return;
      series = mergeDetailedWindow({
        overview: overviewSeries,
        detail: decorateMarketSeries(payloads),
        fromMs: event.detail.fromMs,
        toMs: event.detail.toMs
      });
    } catch (caught) {
      if (requestId !== zoomRequestId) return;
      error = caught instanceof Error ? caught.message : 'Zoom detail failed.';
    } finally {
      if (requestId === zoomRequestId) loading = false;
    }
  };

  const fetchPortfolioSeries = async ({
    fromMs = portfolioFromMs,
    toMs = portfolioToMs
  }: {
    fromMs?: number;
    toMs?: number;
  } = {}) => {
    const currencies = configuredCurrencies({
      primaryCurrency,
      listedCurrencies: tooltipCurrencies
    });
    return apiRequest<{
      data: {
        series: ChartSeries[];
        events: ChartEvent[];
        denominationOptions: ChartDenominationOption[];
        partial: boolean;
        stale: boolean;
        granularitySeconds: number;
        requestedGranularitySeconds: number;
        mixedGranularity: boolean;
      };
    }>({
      url: `/api/portfolio/series?from=${fromMs}&to=${toMs}&granularitySeconds=${portfolioGranularity}&quoteCurrencies=${encodeURIComponent(currencies.join(','))}`
    });
  };

  const loadPortfolioSeries = async () => {
    const requestId = ++portfolioRequestId;
    portfolioLoading = true;
    try {
      const payload = await fetchPortfolioSeries();
      if (requestId !== portfolioRequestId) return;
      portfolioResolvedGranularity = payload.data.granularitySeconds;
      portfolioOverviewSeries = payload.data.series;
      portfolioSeries = portfolioOverviewSeries;
      portfolioEvents = payload.data.events;
      portfolioDenominationOptions = payload.data.denominationOptions;
      portfolioPartial = payload.data.partial || payload.data.mixedGranularity;
      portfolioStale = payload.data.stale;
    } catch (caught) {
      if (requestId !== portfolioRequestId) return;
      error = caught instanceof Error ? caught.message : 'Combined portfolio series failed.';
      portfolioSeries = [];
      portfolioOverviewSeries = [];
      portfolioEvents = [];
    } finally {
      if (requestId === portfolioRequestId) portfolioLoading = false;
    }
  };

  const portfolioGraphZoomed = async (
    event: CustomEvent<{ fromMs: number; toMs: number }>
  ) => {
    const requestedGranularity = Number(portfolioGranularity);
    if (
      portfolioGranularity === 'auto'
      || !Number.isFinite(requestedGranularity)
      || portfolioResolvedGranularity <= requestedGranularity
    ) return;
    const requestId = ++portfolioZoomRequestId;
    portfolioLoading = true;
    try {
      const payload = await fetchPortfolioSeries({
        fromMs: event.detail.fromMs,
        toMs: event.detail.toMs
      });
      if (requestId !== portfolioZoomRequestId) return;
      portfolioSeries = mergeDetailedWindow({
        overview: portfolioOverviewSeries,
        detail: payload.data.series,
        fromMs: event.detail.fromMs,
        toMs: event.detail.toMs
      });
    } catch (caught) {
      if (requestId !== portfolioZoomRequestId) return;
      error = caught instanceof Error ? caught.message : 'Combined portfolio zoom detail failed.';
    } finally {
      if (requestId === portfolioZoomRequestId) portfolioLoading = false;
    }
  };

  const toggleAsset = ({ canonicalId }: { canonicalId: string }) => {
    if (!watchState({ canonicalId })?.enabled) return;
    const next = new Set(selected);
    if (next.has(canonicalId)) next.delete(canonicalId);
    else next.add(canonicalId);
    selected = next;
    void Promise.all([loadSeries(), loadPerformanceSeries()]);
  };

  const setAssetEnabled = async ({
    canonicalId,
    enabled
  }: {
    canonicalId: string;
    enabled: boolean;
  }) => {
    message = '';
    error = '';
    try {
      const watched = watchState({ canonicalId });
      if (enabled) {
        await apiRequest({
          url: '/api/watchlist/assets',
          method: 'POST',
          body: { canonicalId }
        });
      } else if (watched) {
        await apiRequest({
          url: `/api/watchlist/assets/${watched.id}`,
          method: 'PATCH',
          body: { enabled: false }
        });
      }
      await loadShell();
      if (enabled) {
        selected.add(canonicalId);
        selected = new Set(selected);
      } else {
        selected.delete(canonicalId);
        selected = new Set(selected);
      }
      if (enabled) await queueInitialAssetHistory(canonicalId);
      await Promise.all([loadSeries(), loadPerformanceSeries()]);
      const asset = catalog.find((candidate) => candidate.canonicalId === canonicalId);
      message = `${asset?.symbol ?? canonicalId} is ${enabled ? 'enabled' : 'disabled'}.`
        + (enabled ? ' It is selected on the chart and its initial history is queued.' : ' Pending market synchronization for it was cancelled.');
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'The asset state could not be changed.';
    }
  };

  const focusCatalogFilter = () => {
    requestAnimationFrame(() => {
      document.getElementById('market-asset-catalog')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });
      (document.getElementById('catalog-filter') as HTMLInputElement | null)?.focus();
    });
  };

  const queueInitialAssetHistory = async (canonicalAssetId: string) => {
    const toMs = Date.now();
    const fromMs = toMs - rangeMilliseconds['30d'];
    for (const provider of ['coingecko', 'coinbase', 'kraken'] as const) {
      await apiRequest({
        url: '/api/market/backfill',
        method: 'POST',
        body: {
          provider,
          canonicalAssetId,
          quoteCurrency: primaryCurrency,
          fromMs,
          toMs,
          granularitySeconds: resolvedGranularity
        }
      });
    }
  };

  const openCatalogFilter = () => {
    focusCatalogFilter();
    requestAnimationFrame(() => document.getElementById('market-asset-catalog')?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    }));
  };

  const refreshCatalog = async () => {
    catalogFilter = '';
    await apiRequest({
      url: '/api/catalog/refresh',
      method: 'POST',
      body: {}
    });
    message = 'Top-100 catalog refresh queued. Progress is visible in Settings.';
  };

  const moveBlock = async (event: CustomEvent<{ id: string; direction: 'up' | 'down' }>) => {
    pageOrder = moveInOrder({
      order: pageOrder,
      id: event.detail.id,
      direction: event.detail.direction
    });
    pageLayouts = { ...pageLayouts, markets: pageOrder };
    await savePreferences({ pageLayouts });
  };

  const toggleBlockCollapse = async (event: CustomEvent<{ id: string }>) => {
    collapsedBlocks = {
      ...collapsedBlocks,
      markets: toggleCollapsed({ collapsed: collapsedBlocks.markets ?? [], id: event.detail.id })
    };
    await savePreferences({ collapsedBlocks });
  };

  const updateWatchlistColumns = async (event: CustomEvent<{ selected: string[] }>) => {
    watchlistColumns = event.detail.selected;
    tableColumns = { ...tableColumns, marketWatchlist: watchlistColumns };
    await savePreferences({ tableColumns });
  };

  const persistDashboardItem = async ({
    item,
    successMessage
  }: {
    item: SavedGraph;
    successMessage: string;
  }) => {
    const duplicate = savedGraphWithName({ savedGraphs, name: item.name });
    if (
      duplicate
      && !confirm(`A dashboard item named “${duplicate.name}” already exists. Replace it?`)
    ) return;
    const nextSavedGraphs = duplicate
      ? replaceSavedGraph({
          savedGraphs,
          replacement: item,
          replacedId: duplicate.id
        })
      : [...savedGraphs, item];
    try {
      await savePreferences({ savedGraphs: nextSavedGraphs });
      savedGraphs = nextSavedGraphs;
      error = '';
      message = successMessage;
    } catch (caught) {
      error = caught instanceof Error
        ? `Dashboard save failed: ${caught.message}`
        : 'Dashboard save failed.';
      message = '';
    }
  };

  const saveTable = async () => {
    const name = tableDashboardName.trim() || 'Markets catalog';
    error = '';
    const table = createSavedGraph({
      name,
      type: 'market',
      config: {
        dashboardView: 'table',
        tableId: 'marketWatchlist',
        columns: watchlistColumns,
        filter: catalogFilter,
        primaryCurrency,
        timezone
      }
    });
    await persistDashboardItem({
      item: table,
      successMessage: `Saved table “${table.name}” to the dashboard.`
    });
  };

  const saveGraph = async (event: CustomEvent<{
    name: string;
    range: string;
    granularity: string;
    chartMode: 'line' | 'candlestick';
    scale: 'linear' | 'log';
    normalized: boolean;
    showEvents: boolean;
    showVolume: boolean;
    yAxisUnit: string;
    customFromMs: number | null;
    customToMs: number | null;
    customRangeMode: 'dates' | 'ago';
    customAgoValue: number;
    customAgoUnit: 'hours' | 'days' | 'weeks' | 'months' | 'years';
    visibleSeriesIds: string[];
  }>) => {
    error = '';
    const graph = createSavedGraph({
      name: event.detail.name,
      type: 'market',
      config: {
        assetIds: [...selected],
        source,
        primaryCurrency,
        tooltipCurrencies,
        timezone,
        ...event.detail
      }
    });
    await persistDashboardItem({
      item: graph,
      successMessage: `Saved “${graph.name}” to the dashboard.`
    });
  };

  const portfolioGraphStateChanged = async (
    event: CustomEvent<ChartQueryState & { chartMode: 'line' | 'candlestick' }>
  ) => {
    portfolioChartState = {
      range: event.detail.range,
      granularity: event.detail.granularity,
      customFromMs: event.detail.customFromMs,
      customToMs: event.detail.customToMs,
      customRangeMode: event.detail.customRangeMode,
      customAgoValue: event.detail.customAgoValue,
      customAgoUnit: event.detail.customAgoUnit
    };
    portfolioRange = portfolioChartState.range;
    portfolioGranularity = portfolioChartState.granularity;
    const window = chartWindow(portfolioChartState);
    portfolioFromMs = window.from;
    portfolioToMs = window.to;
    graphDefaults = {
      ...graphDefaults,
      marketsPortfolioChartState: portfolioChartState
    };
    await savePreferences({ graphDefaults });
    void loadPortfolioSeries();
  };

  const portfolioGraphViewChanged = async (
    event: CustomEvent<ChartDisplayState>
  ) => {
    portfolioDisplayState = { ...event.detail };
    graphDefaults = {
      ...graphDefaults,
      marketsPortfolioDisplayState: portfolioDisplayState
    };
    await savePreferences({ graphDefaults });
  };

  const savePortfolioGraph = async (event: CustomEvent<{
    name: string;
    range: string;
    granularity: string;
    chartMode: 'line' | 'candlestick';
    scale: 'linear' | 'log';
    normalized: boolean;
    showEvents: boolean;
    showVolume: boolean;
    yAxisUnit: string;
    customFromMs: number | null;
    customToMs: number | null;
    customRangeMode: 'dates' | 'ago';
    customAgoValue: number;
    customAgoUnit: 'hours' | 'days' | 'weeks' | 'months' | 'years';
    visibleSeriesIds: string[];
  }>) => {
    const graph = createSavedGraph({
      name: event.detail.name,
      type: 'portfolio',
      config: {
        primaryCurrency,
        tooltipCurrencies,
        timezone,
        ...event.detail
      }
    });
    await persistDashboardItem({
      item: graph,
      successMessage: `Saved “${graph.name}” to the dashboard.`
    });
  };

  const performanceRangeChanged = (event: CustomEvent<{
    range: string;
    fromMs: number;
    toMs: number;
    customAgoValue: number;
    customAgoUnit: 'hours' | 'days' | 'weeks' | 'months' | 'years';
  }>) => {
    performanceFromMs = event.detail.fromMs;
    performanceToMs = event.detail.toMs;
    void loadPerformanceSeries();
  };

  const performanceDisplayChanged = async (
    event: CustomEvent<{ visibleSeriesIds: string[] }>
  ) => {
    performanceVisibleSeriesIds = event.detail.visibleSeriesIds;
    graphDefaults = {
      ...graphDefaults,
      marketsPerformanceVisibleSeries: performanceVisibleSeriesIds
    };
    await savePreferences({ graphDefaults });
  };

  const savePerformanceGraph = async (event: CustomEvent<{
    name: string;
    performanceMode: 'return' | 'drawdown';
    performanceAnalysisId: string;
    performanceBenchmarkId: string;
    range: string;
    customRangeMode: 'ago';
    customAgoValue: number;
    customAgoUnit: 'hours' | 'days' | 'weeks' | 'months' | 'years';
    visibleSeriesIds: string[];
  }>) => {
    error = '';
    const graph = createSavedGraph({
      name: event.detail.name,
      type: 'market',
      config: {
        analytics: 'performance',
        assetIds: [...selected],
        source,
        primaryCurrency,
        tooltipCurrencies,
        timezone,
        granularity: 'auto',
        chartMode: 'line',
        ...event.detail
      }
    });
    await persistDashboardItem({
      item: graph,
      successMessage: `Saved performance chart “${graph.name}” to the dashboard.`
    });
  };

  const queueBackfill = async () => {
    const toMs = Date.now();
    const fromMs = range === 'all'
      ? 0
      : range === 'custom'
        ? customFromMs
        : toMs - rangeMilliseconds[range as keyof typeof rangeMilliseconds];
    const providers = source === 'combined' ? ['coingecko', 'coinbase', 'kraken'] : [source];
    let queued = 0;
    let skipped = 0;
    for (const canonicalAssetId of selected) {
      for (const provider of providers) {
        const result = await apiRequest<{ skipped?: boolean }>({
          url: '/api/market/backfill',
          method: 'POST',
          body: {
            provider,
            canonicalAssetId,
            quoteCurrency: primaryCurrency,
            fromMs,
            toMs,
            granularitySeconds: granularity === 'auto' ? resolvedGranularity : Number(granularity)
          }
        });
        if (result.skipped) skipped += 1;
        else queued += 1;
      }
      if (providers.includes('coinbase') && primaryCurrency !== 'USD') {
        for (const quoteCurrency of [primaryCurrency, 'USD']) {
          if (providers.includes('coingecko') && quoteCurrency === primaryCurrency) continue;
          await apiRequest({
            url: '/api/market/backfill',
            method: 'POST',
            body: {
              provider: 'coingecko',
              canonicalAssetId,
              quoteCurrency,
              fromMs,
              toMs,
              granularitySeconds: granularity === 'auto' ? resolvedGranularity : Number(granularity)
            }
          });
          queued += 1;
        }
      }
    }
    message = `${queued} supported backfill job${queued === 1 ? '' : 's'} queued${skipped > 0 ? `; ${skipped} unsupported provider/asset pair${skipped === 1 ? '' : 's'} skipped` : ''}. Settings shows live progress and the oldest point reached.`;
  };

  const graphStateChanged = async (
    event: CustomEvent<ChartQueryState & { chartMode: 'line' | 'candlestick' }>
  ) => {
    watchedChartState = {
      range: event.detail.range,
      granularity: event.detail.granularity,
      customFromMs: event.detail.customFromMs,
      customToMs: event.detail.customToMs,
      customRangeMode: event.detail.customRangeMode,
      customAgoValue: event.detail.customAgoValue,
      customAgoUnit: event.detail.customAgoUnit
    };
    range = watchedChartState.range;
    const window = chartWindow(watchedChartState);
    customFromMs = window.from;
    customToMs = window.to;
    granularity = watchedChartState.granularity;
    chartMode = event.detail.chartMode;
    graphDefaults = {
      ...graphDefaults,
      marketsWatchedChartState: watchedChartState,
      marketsWatchedChartMode: chartMode
    };
    await savePreferences({ graphDefaults });
    void loadSeries();
  };

  const graphViewChanged = async (event: CustomEvent<ChartDisplayState>) => {
    watchedDisplayState = { ...event.detail };
    graphDefaults = {
      ...graphDefaults,
      marketsWatchedDisplayState: watchedDisplayState
    };
    await savePreferences({ graphDefaults });
  };

  onMount(async () => {
    try {
      await loadShell();
      if (location.hash === '#asset-catalog') {
        focusCatalogFilter();
      }
      await Promise.all([
        loadSeries(),
        loadPerformanceSeries(),
        loadPortfolioSeries()
      ]);
      if (location.hash) {
        requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView({
          block: 'start'
        }));
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Markets failed to load.';
      loading = false;
    }
  });
</script>

<main class="page">
  <header>
    <p class="eyebrow">Public read-only price sources</p>
    <h1>{strings['cryptotracker-markets-title']}</h1>
    <p class="muted">Provider-native and derived candles remain attributable; Combined uses the median or a clearly marked single-provider fallback.</p>
  </header>

  {#if error}<div class="alert danger" role="alert">{error}</div>{/if}
  {#if message}<div class="alert mid" role="status">{message}</div>{/if}

  {#each pageOrder as blockId, index}
    <ReorderableBlock
      {blockId}
      label={blockId === 'controls'
        ? 'Market controls'
        : blockId === 'portfolio'
          ? 'Combined portfolio chart'
          : blockId === 'chart'
            ? 'Market chart'
            : blockId === 'performance'
              ? 'Performance analytics'
              : 'Watchlist'}
      {index}
      total={pageOrder.length}
      collapsed={collapsedBlocks.markets?.includes(blockId) ?? false}
      on:move={moveBlock}
      on:toggle={toggleBlockCollapse}
    >
  {#if blockId === 'controls'}
  <section class="panel">
    <div class="toolbar">
      <div class="field">
        <label for="source">Price source</label>
        <select id="source" bind:value={source} on:change={loadSeries}>
          <option value="combined">Combined</option>
          <option value="coingecko">CoinGecko</option>
          <option value="coinbase">Coinbase</option>
          <option value="kraken">Kraken</option>
        </select>
      </div>
      <button class="secondary" type="button" on:click={queueBackfill}>Queue backfill</button>
    </div>
    <div class="series-heading">
      <strong>Visible chart assets</strong>
      <span class="muted">Click any enabled asset to add it to or remove it from the chart.</span>
    </div>
    {#if loading && watchlist.length === 0}
      <p class="series-empty muted">Loading enabled assets…</p>
    {:else if enabledAssets.length === 0}
      <div class="series-empty alert warning">
        No market assets are enabled.
        <button class="link-button" type="button" on:click={openCatalogFilter}>Enable assets below</button>
      </div>
    {:else}
      <div class="series-toggles" aria-label="Visible market series">
        {#each enabledAssets as asset (asset.canonicalId)}
          <LargeToggleButton
            label={asset.symbol}
            detail={asset.name}
            pressed={selected.has(asset.canonicalId)}
            ariaLabel={`Toggle ${asset.name} on the market chart`}
            on:click={() => toggleAsset({ canonicalId: asset.canonicalId })}
          />
        {/each}
      </div>
    {/if}
    {#if onlyBitcoinEnabled && catalog.length > 1}
      <p class="enable-more">
        Only BTC is enabled. <button class="link-button" type="button" on:click={openCatalogFilter}>Enable more assets</button>
      </p>
    {/if}
  </section>
  {:else if blockId === 'portfolio'}

  {#if chartPreferencesReady}
  <div id="combined-portfolio-chart">
  <PortfolioChart
    title="Combined portfolio history"
    series={portfolioSeries}
    chartMode="line"
    currency={primaryCurrency}
    tooltipCurrencies={configuredCurrencies({
      primaryCurrency,
      listedCurrencies: tooltipCurrencies
    })}
    denominationOptions={portfolioAxisDenominationOptions}
    source="portfolio snapshots"
    {timezone}
    granularity={portfolioResolvedGranularity}
    selectedGranularitySetting={portfolioGranularity}
    partial={portfolioPartial}
    stale={portfolioStale}
    events={portfolioEvents}
    busy={portfolioLoading}
    saveable
    initialRange={portfolioRange}
    initialCustomFromMs={portfolioChartState.customFromMs}
    initialCustomToMs={portfolioChartState.customToMs}
    initialCustomRangeMode={portfolioChartState.customRangeMode}
    initialCustomAgoValue={portfolioChartState.customAgoValue}
    initialCustomAgoUnit={portfolioChartState.customAgoUnit}
    initialScale={portfolioDisplayState.scale}
    initialYAxisUnit={portfolioDisplayState.yAxisUnit}
    initialTooltipUnits={portfolioDisplayState.tooltipUnits}
    initialNormalized={portfolioDisplayState.normalized}
    initialShowEvents={portfolioDisplayState.showEvents}
    initialShowVolume={portfolioDisplayState.showVolume}
    initialVisibleSeriesIds={portfolioDisplayState.visibleSeriesIds}
    initialRightYAxisUnit={portfolioDisplayState.rightYAxisUnit}
    initialMinimumMode={boundMode(portfolioEditConfig, 'minimumMode')}
    initialMaximumMode={boundMode(portfolioEditConfig, 'maximumMode')}
    initialMinimumValue={configString(portfolioEditConfig, 'minimumValue')}
    initialMaximumValue={configString(portfolioEditConfig, 'maximumValue')}
    initialShowWicks={portfolioEditConfig.showWicks !== false}
    initialSaveGraphName={portfolioSaveName}
    preferenceKey="markets:combined-portfolio"
    partialMessage="Some observed balances or market valuations are unavailable. Portfolio history starts with locally retained snapshots and is not retroactively fabricated."
    emptyMessage="No combined portfolio snapshot exists yet. The first locally observed snapshot is recorded when this chart loads; historical balances are not guessed."
    on:stateChange={portfolioGraphStateChanged}
    on:viewChange={portfolioGraphViewChanged}
    on:zoomRange={portfolioGraphZoomed}
    on:saveGraph={savePortfolioGraph}
  />
  </div>
  {/if}

  {:else if blockId === 'chart'}

  {#if chartPreferencesReady}
  <div id="market-price-chart">
  <PortfolioChart
    title="Watched market prices"
    {series}
    {chartMode}
    allowCandlesticks
    showFourYearRange
    currency={primaryCurrency}
    {tooltipCurrencies}
    {denominationOptions}
    {source}
    {timezone}
    granularity={resolvedGranularity}
    selectedGranularitySetting={granularity}
    {partial}
    {stale}
    {events}
    {exportQuery}
    busy={loading}
    saveable
    initialRange={watchedChartState.range}
    initialCustomFromMs={watchedChartState.customFromMs}
    initialCustomToMs={watchedChartState.customToMs}
    initialCustomRangeMode={watchedChartState.customRangeMode}
    initialCustomAgoValue={watchedChartState.customAgoValue}
    initialCustomAgoUnit={watchedChartState.customAgoUnit}
    initialScale={watchedDisplayState.scale}
    initialYAxisUnit={watchedDisplayState.yAxisUnit}
    initialTooltipUnits={watchedDisplayState.tooltipUnits}
    initialNormalized={watchedDisplayState.normalized}
    initialShowEvents={watchedDisplayState.showEvents}
    initialShowVolume={watchedDisplayState.showVolume}
    initialVisibleSeriesIds={watchedDisplayState.visibleSeriesIds}
    initialRightYAxisUnit={watchedDisplayState.rightYAxisUnit}
    initialMinimumMode={boundMode(watchedEditConfig, 'minimumMode')}
    initialMaximumMode={boundMode(watchedEditConfig, 'maximumMode')}
    initialMinimumValue={configString(watchedEditConfig, 'minimumValue')}
    initialMaximumValue={configString(watchedEditConfig, 'maximumValue')}
    initialShowWicks={watchedEditConfig.showWicks !== false}
    initialSaveGraphName={watchedSaveName}
    preferenceKey="markets:watched-prices"
    partialMessage={partialMessage || strings['cryptotracker-data_partial-label']}
    emptyMessage="No cached market prices are available for the selected assets and range. Use Queue backfill in Market controls, then follow progress in Settings → Synchronization."
    on:stateChange={graphStateChanged}
    on:viewChange={graphViewChanged}
    on:zoomRange={graphZoomed}
    on:saveGraph={saveGraph}
  />
  </div>
  {/if}

  {:else if blockId === 'performance'}
  <div id="market-performance-chart">
  <PerformanceAnalytics
    title="Market performance"
    series={performanceSeries}
    {timezone}
    returnMethod="price"
    busy={performanceLoading}
    saveable
    initialMode={configString(performanceEditConfig, 'performanceMode', 'return') === 'drawdown'
      ? 'drawdown'
      : 'return'}
    initialAnalysisId={configString(performanceEditConfig, 'performanceAnalysisId')}
    initialBenchmarkId={configString(performanceEditConfig, 'performanceBenchmarkId')}
    initialRange={configString(performanceEditConfig, 'range', '30d')}
    initialCustomAgoValue={typeof performanceEditConfig.customAgoValue === 'number'
      ? performanceEditConfig.customAgoValue
      : 1}
    initialCustomAgoUnit={['hours', 'days', 'weeks', 'months', 'years'].includes(
      configString(performanceEditConfig, 'customAgoUnit')
    )
      ? configString(performanceEditConfig, 'customAgoUnit') as RelativeRangeUnit
      : 'years'}
    initialVisibleSeriesIds={performanceVisibleSeriesIds}
    initialSaveGraphName={performanceSaveName}
    on:rangeChange={performanceRangeChanged}
    on:displayChange={performanceDisplayChanged}
    on:saveGraph={savePerformanceGraph}
  />
  </div>

  {:else if blockId === 'watchlist'}
  <section class="panel" id="market-asset-catalog">
    <p class="eyebrow">Watchlist</p>
    <h2>Enable assets from the top-100 catalog</h2>
    <p class="catalog-help muted">
      BTC is the only asset enabled by default. Disabled assets do not appear in charts or market synchronization.
    </p>
    <div class="catalog-actions toolbar">
      <div class="field grow">
        <label for="catalog-filter">Filter catalog table</label>
        <input
          id="catalog-filter"
          type="search"
          placeholder="Symbol, name, rank, or canonical ID"
          bind:value={catalogFilter}
        />
      </div>
      <button class="ghost" type="button" on:click={refreshCatalog}>Refresh catalog</button>
    </div>
    <p class="muted">{filteredCatalogAssets.length} of {catalog.length} catalog assets shown.</p>
    <ColumnConfigurator
      label="Configure watchlist columns"
      columns={watchlistColumnOptions}
      selected={watchlistColumns}
      defaults={defaultWatchlistColumns}
      on:change={updateWatchlistColumns}
    />
    <div class="toolbar save-table">
      <div class="field grow">
        <label for="market-table-dashboard-name">Dashboard table name</label>
        <input id="market-table-dashboard-name" maxlength="120" bind:value={tableDashboardName} />
      </div>
      <button class="secondary" type="button" on:click={saveTable}>Save table to dashboard</button>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          {#each watchlistColumns as columnId}
            <th>{watchlistColumnOptions.find((column) => column.id === columnId)?.label ?? columnId}</th>
          {/each}
        </tr></thead>
        <tbody>
          {#each filteredCatalogAssets as catalogAsset (catalogAsset.canonicalId)}
            {@const watched = watchedAssetsByCanonicalId.get(catalogAsset.canonicalId) ?? null}
            <tr>
              {#each watchlistColumns as columnId}
                <td>
                  {#if columnId === 'asset'}
                    {catalogAsset.symbol} · {catalogAsset.name}
                  {:else if columnId === 'rank'}
                    {catalogAsset.marketCapRank ?? '—'}
                  {:else if columnId === 'identity'}
                    {catalogAsset.canonicalId}
                  {:else if columnId === 'state'}
                    <span
                      class="badge {watched?.enabled ? selected.has(catalogAsset.canonicalId) ? 'mid' : 'start' : 'danger'}"
                    >{watched?.enabled ? selected.has(catalogAsset.canonicalId) ? 'active' : 'enabled' : 'disabled'}</span>
                  {:else if columnId === 'source'}
                    {catalogAsset.source ?? 'cached'}
                  {:else if columnId === 'action'}
                    <button
                      class={watched?.enabled ? 'danger' : 'secondary'}
                      type="button"
                      on:click={() => setAssetEnabled({
                        canonicalId: catalogAsset.canonicalId,
                        enabled: !watched?.enabled
                      })}
                    >{watched?.enabled ? 'Disable' : 'Enable'}</button>
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
  {/if}
    </ReorderableBlock>
  {/each}
</main>

<style>
  .series-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.45rem 0.8rem;
    margin-top: 1rem;
  }

  .series-empty {
    margin-top: 0.75rem;
  }

  .series-toggles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10.5rem, 14rem));
    justify-content: start;
    gap: 0.65rem;
    margin-top: 0.55rem;
  }

  .catalog-help {
    margin-bottom: 1rem;
  }

  .catalog-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.65rem;
    margin-bottom: 1rem;
  }

  .enable-more {
    margin: 0.8rem 0 0;
    color: var(--color-muted);
  }

  .link-button {
    min-height: auto;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    color: var(--color-mid);
    text-decoration: underline;
  }

  .link-button:hover,
  .link-button:active {
    border: 0;
    background: transparent;
    box-shadow: none;
    transform: none;
  }

  .table-wrap {
    margin-top: 1rem;
  }
</style>
