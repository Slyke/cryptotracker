<script lang="ts">
  import { onMount } from 'svelte';
  import PortfolioChart from '../../lib/components/PortfolioChart.svelte';
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
    createSavedGraph,
    moveInOrder,
    normalizeOrder,
    savePreferences,
    savedGraphNameExists,
    toggleCollapsed,
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
  let events: ChartEvent[] = [];
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
  let pageLayouts: Record<string, string[]> = {};
  let collapsedBlocks: Record<string, string[]> = {};
  let tableColumns: Record<string, string[]> = {};
  const defaultPageOrder = ['controls', 'chart', 'watchlist'];
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

  let enabledAssets: WatchAsset[] = [];
  let denominationOptions: ChartDenominationOption[] = [];
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
    savedGraphs = settingsPayload.settings.savedGraphs ?? [];
    pageOrder = normalizeOrder({ saved: pageLayouts.markets, defaults: defaultPageOrder });
    watchlistColumns = tableColumns.marketWatchlist?.filter((id) =>
      watchlistColumnOptions.some((column) => column.id === id)) ?? [...defaultWatchlistColumns];
  };

  const buildQuery = ({
    currency,
    assetIds = [...selected]
  }: {
    currency: string;
    assetIds?: string[];
  }) => {
    const to = range === 'custom' ? customToMs : Date.now();
    const from = range === 'all'
      ? 0
      : range === 'custom'
        ? customFromMs
        : to - rangeMilliseconds[range as keyof typeof rangeMilliseconds];
    const params = new URLSearchParams({
      assetIds: assetIds.join(','),
      quoteCurrency: currency,
      source,
      from: String(from),
      to: String(to),
      granularity,
      chartMode
    });
    return params;
  };

  const loadSeries = async () => {
    if (selected.size === 0) {
      series = [];
      events = [];
      loading = false;
      return;
    }
    loading = true;
    error = '';
    try {
      const currencies = configuredCurrencies({
        primaryCurrency,
        listedCurrencies: tooltipCurrencies
      });
      const requestedAssetIds = [...new Set([
        ...selected,
        ...enabledAssets.map((asset) => asset.canonicalId)
      ])].slice(0, 50);
      const payloads = await Promise.all(currencies.map(async (currency) => {
        const params = buildQuery({ currency, assetIds: requestedAssetIds });
        const payload = await apiRequest<{
          data: {
            partial: boolean;
            stale: boolean;
            resolvedGranularity: number;
            events: ChartEvent[];
            series: ChartSeries[];
          };
        }>({ url: `/api/market/series?${params}` });
        return { currency, data: payload.data };
      }));
      const primary = payloads.find((payload) => payload.currency === primaryCurrency) ?? payloads[0]!;
      const primaryByAsset = new Map(primary.data.series.map((item) => [item.id, item]));
      series = primary.data.series.filter((item) => selected.has(item.id)).map((item) => ({
        ...item,
        points: item.points.map((point) => ({
          ...point,
          quotes: Object.fromEntries(payloads.map((payload) => {
            const matching = payload.data.series
              .find((candidate) => candidate.id === item.id)
              ?.points.find((candidate) => candidate.timestampMs === point.timestampMs);
            return [
              payload.currency,
              matching?.value ?? matching?.close ?? null
            ];
          })),
          denominations: Object.fromEntries(denominationOptions.map((option) => {
            const denominatorPoint = primaryByAsset.get(option.id)
              ?.points.find((candidate) => candidate.timestampMs === point.timestampMs);
            const numerator = Number(point.value ?? point.close);
            const denominator = Number(denominatorPoint?.value ?? denominatorPoint?.close);
            return [
              option.id,
              Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
                ? String(numerator / denominator)
                : null
            ];
          }))
        }))
      }));
      partial = primary.data.partial;
      const missingIntervals = (primary.data as typeof primary.data & {
        missingIntervals?: Array<{ assetId: string; fromMs: number; toMs: number }>;
      }).missingIntervals ?? [];
      const affectedAssets = new Set(missingIntervals.map((interval) => interval.assetId)).size;
      partialMessage = missingIntervals.length > 0
        ? `The plotted range contains ${missingIntervals.length} missing price interval${missingIntervals.length === 1 ? '' : 's'} across ${affectedAssets} asset${affectedAssets === 1 ? '' : 's'}. These are data gaps, not proof that synchronization is still running; Settings → Synchronization shows active progress.`
        : '';
      stale = primary.data.stale;
      events = primary.data.events;
      resolvedGranularity = primary.data.resolvedGranularity;
      exportQuery = buildQuery({ currency: primaryCurrency }).toString();
      const urlState = new URLSearchParams({
        assets: [...selected].join(','),
        source,
        mode: chartMode,
        range,
        granularity
      });
      history.replaceState(null, '', `/markets?${urlState}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Market series failed.';
      series = [];
      events = [];
    } finally {
      loading = false;
    }
  };

  const toggleAsset = ({ canonicalId }: { canonicalId: string }) => {
    if (!watchState({ canonicalId })?.enabled) return;
    const next = new Set(selected);
    if (next.has(canonicalId)) next.delete(canonicalId);
    else next.add(canonicalId);
    selected = next;
    if (chartMode === 'candlestick' && selected.size > 1) {
      selected = new Set([canonicalId]);
    }
    void loadSeries();
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
      if (enabled && chartMode === 'candlestick' && selected.size > 1) {
        chartMode = 'line';
      }
      if (enabled) await queueInitialAssetHistory(canonicalId);
      await loadSeries();
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

  const saveTable = async () => {
    const name = tableDashboardName.trim() || 'Markets catalog';
    if (savedGraphNameExists({ savedGraphs, name })) {
      error = `A dashboard item named “${name}” already exists. Choose a unique name.`;
      message = '';
      return;
    }
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
    savedGraphs = [...savedGraphs, table];
    await savePreferences({ savedGraphs });
    message = `Saved table “${table.name}” to the dashboard.`;
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
  }>) => {
    if (savedGraphNameExists({ savedGraphs, name: event.detail.name })) {
      error = `A dashboard item named “${event.detail.name.trim()}” already exists. Choose a unique name.`;
      message = '';
      return;
    }
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
    savedGraphs = [...savedGraphs, graph];
    await savePreferences({ savedGraphs });
    message = `Saved “${graph.name}” to the dashboard.`;
  };

  const queueBackfill = async () => {
    const toMs = Date.now();
    const fromMs = toMs - rangeMilliseconds[range as keyof typeof rangeMilliseconds];
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

  const graphStateChanged = (event: CustomEvent<{
    range: string;
    granularity: string;
    chartMode: 'line' | 'candlestick';
    customFromMs: number | null;
    customToMs: number | null;
    customRangeMode: 'dates' | 'ago';
    customAgoValue: number;
    customAgoUnit: 'hours' | 'days' | 'weeks' | 'months' | 'years';
  }>) => {
    range = event.detail.range;
    if (event.detail.customFromMs !== null) customFromMs = event.detail.customFromMs;
    if (event.detail.customToMs !== null) customToMs = event.detail.customToMs;
    granularity = event.detail.granularity;
    chartMode = event.detail.chartMode;
    if (chartMode === 'candlestick' && selected.size > 1) {
      selected = new Set([[...selected][0]!]);
    }
    void loadSeries();
  };

  onMount(async () => {
    try {
      await loadShell();
      if (location.hash === '#asset-catalog') {
        focusCatalogFilter();
      }
      await loadSeries();
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
      label={blockId === 'controls' ? 'Market controls' : blockId === 'chart' ? 'Market chart' : 'Watchlist'}
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
  {:else if blockId === 'chart'}

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
    {partial}
    {stale}
    {events}
    {exportQuery}
    busy={loading}
    saveable
    partialMessage={partialMessage || strings['cryptotracker-data_partial-label']}
    emptyMessage="No cached market prices are available for the selected assets and range. Use Queue backfill in Market controls, then follow progress in Settings → Synchronization."
    on:stateChange={graphStateChanged}
    on:saveGraph={saveGraph}
  />

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
