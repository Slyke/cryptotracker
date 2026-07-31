<script lang="ts">
  import { onMount } from 'svelte';
  import ColumnConfigurator from '../../lib/components/ColumnConfigurator.svelte';
  import DismissableNotice from '../../lib/components/DismissableNotice.svelte';
  import PortfolioChart from '../../lib/components/PortfolioChart.svelte';
  import PerformanceAnalytics from '../../lib/components/PerformanceAnalytics.svelte';
  import ReorderableBlock from '../../lib/components/ReorderableBlock.svelte';
  import type {
    ChartDenominationOption,
    ChartEvent,
    ChartSeries
  } from '../../lib/components/chart-types';
  import { apiRequest } from '$lib/api';
  import {
    chartDenominationOptionsFromAssets,
    type ChartAxisAsset
  } from '$lib/chart-axis-catalog';
  import { configuredCurrencies } from '$lib/currencies';
  import {
    chartDisplayStateFromSetting,
    chartQueryStateFromSetting,
    createSavedGraph,
    defaultChartDisplayState,
    defaultChartQueryState,
    defaultPerformanceChartDisplayState,
    formatDateTime,
    formatDisplayNumber,
    formatPercent,
    moveInOrder,
    normalizeOrder,
    performanceChartDisplayStateFromSetting,
    relativeRangeWindow,
    replaceSavedGraph,
    savePreferences,
    savedGraphWithName,
    toggleCollapsed,
    type ChartDisplayState,
    type ChartQueryState,
    type PerformanceChartDisplayState,
    type SavedGraph
  } from '$lib/preferences';
  import strings from '$lib/i18n/en-CA.json';

  type Network = 'bitcoin' | 'dogecoin' | 'ethereum' | 'polkadot' | 'solana';
  type MainnetOption = {
    id: string;
    label: string;
    nativeAssetId: string;
    enabledAssets: Array<{
      id: string;
      symbol: string;
      contractOrMint: string | null;
    }>;
    supported: boolean;
    reason: string | null;
  };
  type AddressCurrencyOption = {
    id: string;
    label: string;
    network: Network;
    assetId: string;
    symbol: string;
    contractOrMint: string | null;
    native: boolean;
    supported: boolean;
    reason: string | null;
  };
  type TrackedAddress = {
    id: string;
    network: Network;
    address: string;
    label: string;
    enabled: boolean;
    history: {
      status: string;
      oldestReconstructedAt: string | null;
      lastSuccessfulSync: string | null;
      warnings: unknown[];
      workActive: boolean;
      providerHistoryAvailable: boolean;
    };
    assets: Array<{
      canonicalAssetId: string;
      contractOrMint: string | null;
      enabled: boolean;
    }>;
  };

  type Holding = {
    addressId: string;
    address: string;
    label: string;
    network: Network;
    assetId: string;
    assetSymbol: string;
    assetName: string;
    quantity: string | null;
    currentValue: string | null;
    currentValues: Record<string, string | null>;
    valueCurrency: string;
    completeness: string;
    oldestReconstructedAt: string | null;
    lastSuccessfulSync: string | null;
    pricedCoveragePercent: string;
    balanceObserved: boolean;
    balanceReason: string | null;
  };

  type AddressSeriesPayload = {
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
  };

  const buildHoldingColumnOptions = (currencies: string[]) => [
    { id: 'label', label: 'Address label' },
    { id: 'address', label: 'Public address' },
    { id: 'network', label: 'Network' },
    { id: 'asset', label: 'Asset' },
    { id: 'quantity', label: 'Quantity' },
    ...currencies.map((currency) => ({
      id: `value:${currency}`,
      label: `Current value (${currency})`
    })),
    { id: 'coverage', label: 'Pricing coverage' },
    { id: 'history', label: 'History state' },
    { id: 'oldest', label: 'Oldest reconstructed' },
    { id: 'lastSync', label: 'Last successful check' }
  ];
  const buildDefaultHoldingColumns = (currency: string) => [
    'label',
    'network',
    'asset',
    'quantity',
    `value:${currency}`,
    'coverage',
    'history'
  ];
  const defaultPageOrder = ['add', 'tracked', 'chart', 'performance', 'holdings'];
  const nativeAssetSymbols: Record<Network, string> = {
    bitcoin: 'BTC',
    dogecoin: 'DOGE',
    ethereum: 'ETH',
    polkadot: 'DOT',
    solana: 'SOL'
  };

  let addresses: TrackedAddress[] = [];
  let mainnets: MainnetOption[] = [];
  let unmappedMainnetAssets: Array<{ id: string; symbol: string }> = [];
  let holdings: Holding[] = [];
  let series: ChartSeries[] = [];
  let overviewSeries: ChartSeries[] = [];
  let events: ChartEvent[] = [];
  let denominationOptions: ChartDenominationOption[] = [];
  let network: Network = 'bitcoin';
  let addressCurrencyOptions: AddressCurrencyOption[] = [];
  let selectedAddressCurrencyId = '';
  let selectedAddressCurrency: AddressCurrencyOption | null = null;
  let address = '';
  let label = '';
  let optionalAssetId = '';
  let contractOrMint = '';
  let loading = true;
  let error = '';
  let message = '';
  let partial = false;
  let stale = false;
  let primaryCurrency = 'CAD';
  let tooltipCurrencies = ['CAD'];
  let timezone = 'America/Vancouver';
  let granularity = 86_400;
  let selectedGranularity = '86400';
  let chartRange = '90d';
  let fromMs = Date.now() - (90 * 24 * 60 * 60_000);
  let toMs = Date.now();
  let pageLayouts: Record<string, string[]> = {};
  let collapsedBlocks: Record<string, string[]> = {};
  let tableColumns: Record<string, string[]> = {};
  let tableDashboardName = 'Address holdings';
  let savedGraphs: SavedGraph[] = [];
  let graphDefaults: Record<string, unknown> = {};
  let addressChartState = defaultChartQueryState({
    range: '90d',
    granularity: '86400'
  });
  let addressDisplayState = defaultChartDisplayState(primaryCurrency);
  let chartPreferencesReady = false;
  let addressEditConfig: Record<string, unknown> = {};
  let addressSaveName = 'Address portfolio history';
  let addressPerformanceDisplayState = defaultPerformanceChartDisplayState();
  let loadRequestId = 0;
  let zoomRequestId = 0;
  let dismissedNotices: string[] = [];
  let pageOrder = [...defaultPageOrder];
  let holdingColumnOptions = buildHoldingColumnOptions(['CAD']);
  let defaultHoldingColumns = buildDefaultHoldingColumns('CAD');
  let selectedHoldingColumns = [...defaultHoldingColumns];
  let holdingGroups: Array<{ addressId: string; rows: Holding[] }> = [];
  $: activeCurrencies = configuredCurrencies({
    primaryCurrency,
    listedCurrencies: tooltipCurrencies
  });
  $: selectedAddressCurrency = addressCurrencyOptions.find((option) => (
    option.id === selectedAddressCurrencyId
  )) ?? null;
  $: {
    const grouped = new Map<string, Holding[]>();
    for (const holding of holdings) {
      const rows = grouped.get(holding.addressId) ?? [];
      rows.push(holding);
      grouped.set(holding.addressId, rows);
    }
    holdingGroups = [...grouped.entries()].map(([addressId, rows]) => ({
      addressId,
      rows
    }));
  }

  const mainnetFor = (networkId: string) => mainnets.find((option) => option.id === networkId);
  const buildAddressCurrencyOptions = (options: MainnetOption[]) => options.flatMap((mainnet) => {
    const native = mainnet.enabledAssets.find((asset) => asset.id === mainnet.nativeAssetId) ?? {
      id: mainnet.nativeAssetId,
      symbol: nativeAssetSymbols[mainnet.id as Network] ?? mainnet.nativeAssetId.toUpperCase(),
      contractOrMint: null
    };
    const assets = [
      native,
      ...mainnet.enabledAssets.filter((asset) => asset.id !== mainnet.nativeAssetId)
    ];
    return assets.map((asset) => {
      const isNative = asset.id === mainnet.nativeAssetId;
      const contractUnavailable = !isNative && !asset.contractOrMint;
      return {
        id: `${mainnet.id}:${asset.id}`,
        label: `${asset.symbol} · ${mainnet.label}${contractUnavailable ? ' · contract unavailable' : ''}`,
        network: mainnet.id as Network,
        assetId: asset.id,
        symbol: asset.symbol,
        contractOrMint: asset.contractOrMint,
        native: isNative,
        supported: mainnet.supported && !contractUnavailable,
        reason: contractUnavailable
          ? `${asset.symbol} needs a configured contract address before it can be tracked.`
          : mainnet.reason
      };
    });
  });
  const addressCurrencyChanged = () => {
    const selected = addressCurrencyOptions.find((option) => (
      option.id === selectedAddressCurrencyId
    ));
    if (!selected) return;
    network = selected.network;
    if (selected.native) {
      optionalAssetId = '';
      contractOrMint = '';
      return;
    }
    optionalAssetId = selected.assetId;
    contractOrMint = selected.contractOrMint ?? '';
  };
  const configString = (key: string, fallback = '') => (
    typeof addressEditConfig[key] === 'string'
      ? String(addressEditConfig[key])
      : fallback
  );
  const boundMode = (
    key: 'minimumMode' | 'maximumMode'
  ): 'auto' | 'absolute' | 'relative' => (
    ['absolute', 'relative'].includes(configString(key))
      ? configString(key) as 'absolute' | 'relative'
      : 'auto'
  );
  const chartWindow = (state: ChartQueryState) => {
    const now = Date.now();
    if (state.range === 'custom' && state.customRangeMode === 'ago') {
      return relativeRangeWindow({
        value: state.customAgoValue,
        unit: state.customAgoUnit,
        toMs: now
      }) ?? { from: now - 90 * 24 * 60 * 60_000, to: now };
    }
    if (
      state.range === 'custom'
      && state.customFromMs !== null
      && state.customToMs !== null
    ) {
      return { from: state.customFromMs, to: state.customToMs };
    }
    const ranges: Record<string, number> = {
      '24h': 24 * 60 * 60_000,
      '7d': 7 * 24 * 60 * 60_000,
      '30d': 30 * 24 * 60 * 60_000,
      '90d': 90 * 24 * 60 * 60_000,
      '1y': 365 * 24 * 60 * 60_000,
      '4y': 4 * 365 * 24 * 60 * 60_000
    };
    return {
      from: state.range === 'all'
        ? 0
        : now - (ranges[state.range] ?? ranges['90d']),
      to: now
    };
  };

  const fetchAddressSeries = ({
    windowFromMs = fromMs,
    windowToMs = toMs
  }: {
    windowFromMs?: number;
    windowToMs?: number;
  } = {}) => apiRequest<AddressSeriesPayload>({
    url: `/api/addresses/series?quoteCurrency=${primaryCurrency}&quoteCurrencies=${encodeURIComponent(configuredCurrencies({
      primaryCurrency,
      listedCurrencies: tooltipCurrencies
    }).join(','))}&from=${windowFromMs}&to=${windowToMs}&granularitySeconds=${selectedGranularity}`
  });

  const mergeDetailedWindow = ({
    overview,
    detail,
    windowFromMs,
    windowToMs
  }: {
    overview: ChartSeries[];
    detail: ChartSeries[];
    windowFromMs: number;
    windowToMs: number;
  }) => {
    const detailById = new Map(detail.map((item) => [item.id, item]));
    return overview.map((item) => {
      const merged = new Map(item.points
        .filter((point) => (
          point.timestampMs < windowFromMs || point.timestampMs > windowToMs
        ))
        .map((point) => [point.timestampMs, point]));
      for (const point of detailById.get(item.id)?.points ?? []) {
        merged.set(point.timestampMs, point);
      }
      return {
        ...item,
        points: [...merged.values()].sort((left, right) => (
          left.timestampMs - right.timestampMs
        ))
      };
    });
  };
  const formatDate = (value: string | null) => (
    value
      ? formatDateTime({ value, timezone })
      : 'not reached'
  );

  const formatCurrentValue = ({
    holding,
    currency
  }: {
    holding: Holding;
    currency: string;
  }) => {
    if (!holding.balanceObserved) return 'balance unavailable';
    const value = holding.currentValues[currency];
    if (value === null || value === undefined) return `unpriced (${currency})`;
    return Number(value).toLocaleString(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  };

  const partialMessage = () => {
    const unavailable = addresses
      .filter((item) => !item.history.providerHistoryAvailable)
      .map((item) => item.label);
    const incomplete = addresses
      .filter((item) => (
        item.history.status !== 'complete'
        && item.history.providerHistoryAvailable
      ))
      .map((item) => `${item.label} (${item.history.status})`);
    const workActive = addresses.some((item) => item.history.workActive);
    const unpricedCount = holdings.filter((holding) => Number(holding.pricedCoveragePercent) < 100).length;
    const parts = [];
    if (unavailable.length > 0) {
      parts.push(`Historical transaction provider unavailable for ${unavailable.join(', ')}. Current balances are still sampled and retained, but earlier ETH/ERC-20 balances require a configured Etherscan API key.`);
    }
    if (incomplete.length > 0) parts.push(`Incomplete provider history: ${incomplete.join(', ')}.`);
    if (unpricedCount > 0) parts.push(`${unpricedCount} holding${unpricedCount === 1 ? ' is' : 's are'} not fully priced.`);
    if (workActive) {
      parts.push('Synchronization is active. Settings → Synchronization shows live work and the oldest point reached.');
    }
    return parts.join(' ');
  };

  const load = async () => {
    const requestId = ++loadRequestId;
    loading = true;
    error = '';
    try {
      const settingsPayload = await apiRequest<{
        settings: {
          primaryCurrency: string;
          tooltipCurrencies: string[];
          timezone: string;
          pageLayouts: Record<string, string[]>;
          collapsedBlocks: Record<string, string[]>;
          tableColumns: Record<string, string[]>;
          graphDefaults: Record<string, unknown>;
          savedGraphs: SavedGraph[];
          dismissedNotices: string[];
        };
      }>({ url: '/api/settings' });
      primaryCurrency = settingsPayload.settings.primaryCurrency;
      tooltipCurrencies = settingsPayload.settings.tooltipCurrencies;
      timezone = settingsPayload.settings.timezone;
      pageLayouts = settingsPayload.settings.pageLayouts;
      collapsedBlocks = settingsPayload.settings.collapsedBlocks ?? {};
      tableColumns = settingsPayload.settings.tableColumns;
      graphDefaults = settingsPayload.settings.graphDefaults ?? {};
      savedGraphs = settingsPayload.settings.savedGraphs;
      dismissedNotices = settingsPayload.settings.dismissedNotices ?? [];
      if (!chartPreferencesReady) {
        const editGraphId = new URLSearchParams(location.search).get('editGraph');
        const editGraph = savedGraphs.find((graph) => (
          graph.id === editGraphId
          && graph.type === 'addresses'
          && graph.config.dashboardView !== 'table'
        )) ?? null;
        addressEditConfig = editGraph?.config ?? {};
        addressSaveName = editGraph?.name ?? 'Address portfolio history';
        if (editGraph) {
          collapsedBlocks = {
            ...collapsedBlocks,
            addresses: (collapsedBlocks.addresses ?? []).filter((id) => id !== 'chart')
          };
        }
        addressChartState = chartQueryStateFromSetting({
          value: editGraph?.config ?? graphDefaults.addressesChartState,
          fallback: defaultChartQueryState({
            range: '90d',
            granularity: '86400'
          })
        });
        addressDisplayState = chartDisplayStateFromSetting({
          value: editGraph?.config ?? graphDefaults.addressesDisplayState,
          fallback: defaultChartDisplayState(primaryCurrency, configuredCurrencies({
            primaryCurrency,
            listedCurrencies: tooltipCurrencies
          }))
        });
        addressPerformanceDisplayState = performanceChartDisplayStateFromSetting({
          value: graphDefaults.addressesPerformanceDisplayState,
          legacyVisibleSeriesIds: Array.isArray(graphDefaults.addressesPerformanceVisibleSeries)
            ? graphDefaults.addressesPerformanceVisibleSeries.map(String)
            : null
        });
        chartRange = addressChartState.range;
        selectedGranularity = addressChartState.granularity;
        const window = chartWindow(addressChartState);
        fromMs = window.from;
        toMs = window.to;
        chartPreferencesReady = true;
      }
      const requestedCurrencies = configuredCurrencies({
        primaryCurrency,
        listedCurrencies: tooltipCurrencies
      });
      holdingColumnOptions = buildHoldingColumnOptions(requestedCurrencies);
      defaultHoldingColumns = buildDefaultHoldingColumns(primaryCurrency);
      pageOrder = normalizeOrder({ saved: pageLayouts.addresses, defaults: defaultPageOrder });
      const savedHoldingColumns = tableColumns.addressHoldings?.flatMap((id) => (
        id === 'value' ? [`value:${primaryCurrency}`] : [id]
      ));
      selectedHoldingColumns = savedHoldingColumns?.length
        ? savedHoldingColumns.filter((id) => holdingColumnOptions.some((column) => column.id === id))
        : [...defaultHoldingColumns];
      const [addressPayload, networkPayload, holdingPayload, seriesPayload, watchlistPayload] = await Promise.all([
        apiRequest<{ addresses: TrackedAddress[] }>({ url: '/api/addresses' }),
        apiRequest<{
          mainnets: MainnetOption[];
          unmappedAssets: Array<{ id: string; symbol: string }>;
        }>({ url: '/api/addresses/networks' }),
        apiRequest<{ holdings: Holding[] }>({
          url: `/api/addresses/holdings?quoteCurrency=${primaryCurrency}&quoteCurrencies=${encodeURIComponent(requestedCurrencies.join(','))}`
        }),
        fetchAddressSeries(),
        apiRequest<{ assets: ChartAxisAsset[] }>({ url: '/api/watchlist/assets' })
      ]);
      if (requestId !== loadRequestId) return;
      addresses = addressPayload.addresses;
      mainnets = networkPayload.mainnets;
      addressCurrencyOptions = buildAddressCurrencyOptions(mainnets);
      if (!addressCurrencyOptions.some((option) => (
        option.id === selectedAddressCurrencyId && option.supported
      ))) {
        selectedAddressCurrencyId = addressCurrencyOptions.find((option) => option.supported)?.id ?? '';
        addressCurrencyChanged();
      }
      unmappedMainnetAssets = networkPayload.unmappedAssets;
      holdings = holdingPayload.holdings;
      overviewSeries = seriesPayload.data.series;
      series = overviewSeries;
      events = seriesPayload.data.events;
      denominationOptions = [
        ...new Map([
          ...seriesPayload.data.denominationOptions,
          ...chartDenominationOptionsFromAssets(watchlistPayload.assets)
        ].map((option) => [option.id, option])).values()
      ];
      partial = seriesPayload.data.partial || seriesPayload.data.mixedGranularity;
      stale = seriesPayload.data.stale;
      granularity = seriesPayload.data.granularitySeconds;
    } catch (caught) {
      if (requestId !== loadRequestId) return;
      error = caught instanceof Error ? caught.message : 'Addresses failed to load.';
    } finally {
      if (requestId === loadRequestId) loading = false;
    }
  };

  const addAddress = async () => {
    error = '';
    const selectedCurrency = addressCurrencyOptions.find((option) => (
      option.id === selectedAddressCurrencyId
    ));
    if (!selectedCurrency?.supported) {
      error = selectedCurrency?.reason ?? 'Choose a configured currency before adding an address.';
      return;
    }
    const selectedMainnet = mainnets.find((option) => option.id === network);
    if (!selectedMainnet?.supported) {
      error = selectedMainnet?.reason ?? 'Choose a configured mainnet before adding an address.';
      return;
    }
    const assetId = optionalAssetId.trim();
    const contract = contractOrMint.trim();
    if (network === 'ethereum' && Boolean(assetId) !== Boolean(contract)) {
      error = 'Enter both the ERC-20 canonical asset ID and contract, or leave both blank to track ETH.';
      return;
    }
    const assets = network === 'ethereum' && assetId && contract
      ? [{ canonicalAssetId: assetId, contractOrMint: contract }]
      : [];
    try {
      await apiRequest({
        url: '/api/addresses',
        method: 'POST',
        body: {
          network,
          address,
          label,
          enabled: true,
          includeNative: assets.length === 0,
          assets
        }
      });
      address = '';
      label = '';
      if (selectedCurrency.native) {
        optionalAssetId = '';
        contractOrMint = '';
      }
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Address could not be added.';
    }
  };

  const toggle = async ({ item }: { item: TrackedAddress }) => {
    await apiRequest({
      url: `/api/addresses/${item.id}`,
      method: 'PATCH',
      body: {
        enabled: !item.enabled
      }
    });
    await load();
  };

  const refresh = async ({ item }: { item: TrackedAddress }) => {
    const result = await apiRequest<{ skipped?: boolean }>({
      url: `/api/addresses/${item.id}/refresh`,
      method: 'POST',
      body: {}
    });
    message = result.skipped
      ? `${item.label} was not queued because its chain-history provider is not configured.`
      : `Refresh queued for ${item.label}. Settings shows its live progress and oldest point reached.`;
    await load();
  };

  const remove = async ({ item }: { item: TrackedAddress }) => {
    if (!confirm(`Delete ${item.label}? Address-specific history will be removed; shared market cache remains.`)) return;
    await apiRequest({
      url: `/api/addresses/${item.id}`,
      method: 'DELETE'
    });
    await load();
  };

  const moveBlock = async (event: CustomEvent<{ id: string; direction: 'up' | 'down' }>) => {
    pageOrder = moveInOrder({ order: pageOrder, id: event.detail.id, direction: event.detail.direction });
    pageLayouts = { ...pageLayouts, addresses: pageOrder };
    await savePreferences({ pageLayouts });
  };

  const toggleBlockCollapse = async (event: CustomEvent<{ id: string }>) => {
    collapsedBlocks = {
      ...collapsedBlocks,
      addresses: toggleCollapsed({ collapsed: collapsedBlocks.addresses ?? [], id: event.detail.id })
    };
    await savePreferences({ collapsedBlocks });
  };

  const updateHoldingColumns = async (event: CustomEvent<{ selected: string[] }>) => {
    selectedHoldingColumns = event.detail.selected;
    tableColumns = { ...tableColumns, addressHoldings: selectedHoldingColumns };
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
    savedGraphs = duplicate
      ? replaceSavedGraph({
          savedGraphs,
          replacement: item,
          replacedId: duplicate.id
        })
      : [...savedGraphs, item];
    await savePreferences({ savedGraphs });
    error = '';
    message = successMessage;
  };

  const saveTable = async () => {
    const name = tableDashboardName.trim() || 'Address holdings';
    error = '';
    const table = createSavedGraph({
      name,
      type: 'addresses',
      config: {
        dashboardView: 'table',
        tableId: 'addressHoldings',
        columns: selectedHoldingColumns,
        currency: primaryCurrency,
        timezone
      }
    });
    await persistDashboardItem({
      item: table,
      successMessage: `Saved table “${table.name}” to the dashboard.`
    });
  };

  const dismissNotice = async (event: CustomEvent<{ id: string }>) => {
    dismissedNotices = [...new Set([...dismissedNotices, event.detail.id])];
    await savePreferences({ dismissedNotices });
  };

  const graphStateChanged = async (
    event: CustomEvent<ChartQueryState & { chartMode: 'line' | 'candlestick' }>
  ) => {
    addressChartState = {
      range: event.detail.range,
      granularity: event.detail.granularity,
      customFromMs: event.detail.customFromMs,
      customToMs: event.detail.customToMs,
      customRangeMode: event.detail.customRangeMode,
      customAgoValue: event.detail.customAgoValue,
      customAgoUnit: event.detail.customAgoUnit
    };
    chartRange = addressChartState.range;
    selectedGranularity = addressChartState.granularity;
    const window = chartWindow(addressChartState);
    fromMs = window.from;
    toMs = window.to;
    graphDefaults = {
      ...graphDefaults,
      addressesChartState: addressChartState
    };
    await savePreferences({ graphDefaults });
    void load();
  };

  const graphViewChanged = async (event: CustomEvent<ChartDisplayState>) => {
    addressDisplayState = { ...event.detail };
    graphDefaults = {
      ...graphDefaults,
      addressesDisplayState: addressDisplayState
    };
    await savePreferences({ graphDefaults });
  };

  const performanceDisplayChanged = async (
    event: CustomEvent<PerformanceChartDisplayState>
  ) => {
    addressPerformanceDisplayState = { ...event.detail };
    graphDefaults = {
      ...graphDefaults,
      addressesPerformanceVisibleSeries: addressPerformanceDisplayState.visibleSeriesIds,
      addressesPerformanceDisplayState: addressPerformanceDisplayState
    };
    await savePreferences({ graphDefaults });
  };

  const graphZoomed = async (
    event: CustomEvent<{ fromMs: number; toMs: number }>
  ) => {
    const requestedGranularity = Number(selectedGranularity);
    if (
      selectedGranularity === 'auto'
      || !Number.isFinite(requestedGranularity)
      || granularity <= requestedGranularity
    ) return;
    const requestId = ++zoomRequestId;
    loading = true;
    try {
      const payload = await fetchAddressSeries({
        windowFromMs: event.detail.fromMs,
        windowToMs: event.detail.toMs
      });
      if (requestId !== zoomRequestId) return;
      series = mergeDetailedWindow({
        overview: overviewSeries,
        detail: payload.data.series,
        windowFromMs: event.detail.fromMs,
        windowToMs: event.detail.toMs
      });
    } catch (caught) {
      if (requestId !== zoomRequestId) return;
      error = caught instanceof Error ? caught.message : 'Address zoom detail failed.';
    } finally {
      if (requestId === zoomRequestId) loading = false;
    }
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
    error = '';
    const graph = createSavedGraph({
      name: event.detail.name,
      type: 'addresses',
      config: {
        currency: primaryCurrency,
        tooltipCurrencies: [...new Set([primaryCurrency, ...tooltipCurrencies])],
        timezone,
        ...event.detail
      }
    });
    await persistDashboardItem({
      item: graph,
      successMessage: `Saved “${graph.name}” to the dashboard.`
    });
  };

  onMount(() => {
    void load().then(() => {
      if (!location.hash) return;
      requestAnimationFrame(() => document.querySelector(location.hash)?.scrollIntoView({
        block: 'start'
      }));
    });
  });
</script>

<main class="page">
  <header>
    <p class="eyebrow">Public blockchain history</p>
    <h1>{strings['cryptotracker-addresses-title']}</h1>
    <p class="muted">Track only public addresses and explicitly selected assets. CryptoTracker never asks for a private key, seed phrase, xpub, or signature.</p>
  </header>

  {#if error}<div class="alert danger" role="alert">{error}</div>{/if}
  {#if message}<div class="alert mid" role="status">{message}</div>{/if}
  {#if addresses.some((item) => item.history.status !== 'complete')}
    <div class="alert warning">{partialMessage()}</div>
  {/if}

  <div class="address-page-grid">
  {#each pageOrder as blockId, index (blockId)}
    <div class:wide-address-block={blockId === 'chart' || blockId === 'performance' || blockId === 'holdings'}>
    <ReorderableBlock
      {blockId}
      label={blockId}
      {index}
      total={pageOrder.length}
      collapsed={collapsedBlocks.addresses?.includes(blockId) ?? false}
      on:move={moveBlock}
      on:toggle={toggleBlockCollapse}
    >
      {#if blockId === 'add'}
        <section class="panel">
          <p class="eyebrow">Add an address</p>
          <h2>Track a public address</h2>
          <DismissableNotice
            noticeId="addresses-provider-privacy"
            dismissed={dismissedNotices.includes('addresses-provider-privacy')}
            on:dismiss={dismissNotice}
          >{strings['cryptotracker-address_privacy-label']}</DismissableNotice>
          <form class="address-form" on:submit|preventDefault={addAddress}>
            <div class="field">
              <label for="address-currency">Currency</label>
              <select
                id="address-currency"
                bind:value={selectedAddressCurrencyId}
                on:change={addressCurrencyChanged}
              >
                {#each addressCurrencyOptions as currency (currency.id)}
                  <option value={currency.id} disabled={!currency.supported}>
                    {currency.label}
                    {currency.supported ? '' : ' · unavailable'}
                  </option>
                {/each}
              </select>
            </div>
            <div class="field grow">
              <label for="address">Public address</label>
              <input id="address" bind:value={address} required autocomplete="off" />
            </div>
            <div class="field">
              <label for="label">Label</label>
              <input id="label" bind:value={label} required />
            </div>
            {#if network === 'ethereum'}
              <fieldset class="optional-token-options">
                <legend>Ethereum currency details</legend>
                <p class="muted">
                  {selectedAddressCurrency?.native
                    ? 'ETH is selected. Enter both fields only to track a custom ERC-20 currency instead.'
                    : `${selectedAddressCurrency?.symbol ?? 'The selected ERC-20'} is activated, so its canonical ID and contract are filled automatically.`}
                </p>
                <div class="optional-token-fields">
                  <div class="field">
                    <label for="optional-asset">ERC-20 canonical asset ID</label>
                    <input
                      id="optional-asset"
                      bind:value={optionalAssetId}
                      placeholder="usd-coin-ethereum"
                      disabled={Boolean(selectedAddressCurrency && !selectedAddressCurrency.native)}
                    />
                  </div>
                  <div class="field grow">
                    <label for="contract-mint">ERC-20 contract</label>
                    <input
                      id="contract-mint"
                      bind:value={contractOrMint}
                      disabled={Boolean(selectedAddressCurrency && !selectedAddressCurrency.native)}
                    />
                  </div>
                </div>
              </fieldset>
            {/if}
            <button
              class="address-submit"
              type="submit"
              disabled={!selectedAddressCurrency?.supported}
            >Add and synchronize</button>
          </form>
          {#each mainnets.filter((mainnet) => !mainnet.supported) as mainnet (mainnet.id)}
            <p class="muted">{mainnet.label} is shown because {mainnet.enabledAssets.map((asset) => asset.symbol).join(', ')} is enabled. {mainnet.reason}</p>
          {/each}
          {#if mainnets.some((mainnet) => !mainnet.supported)}
            <p class="muted">
              Kraken, Coinbase, and CoinGecko provide market prices; they do not provide transaction history for arbitrary public wallet addresses.
            </p>
          {/if}
          {#if unmappedMainnetAssets.length > 0}
            <p class="muted">
              No reviewed mainnet mapping is available yet for
              {unmappedMainnetAssets.map((asset) => asset.symbol).join(', ')}.
            </p>
          {/if}
        </section>

      {:else if blockId === 'tracked'}
        <section class="panel">
          <p class="eyebrow">Tracked addresses</p>
          <h2>Synchronization and series state</h2>
          <div class="address-list">
            {#each addresses as item}
              <article class="card address-card">
                <div>
                  <span class="badge {item.enabled ? 'mid' : 'warning'}">{item.enabled ? 'enabled' : 'disabled'}</span>
                  <span class="badge {item.history.status === 'complete' ? 'mid' : item.history.status === 'error' ? 'danger' : 'warning'}">{item.history.status}</span>
                </div>
                <h3>{item.label}</h3>
                <code>{item.address}</code>
                <p class="muted">Oldest reconstructed: {formatDate(item.history.oldestReconstructedAt)} · last successful check: {formatDate(item.history.lastSuccessfulSync)}</p>
                <div class="asset-badges">
                  {#each item.assets.filter((asset) => asset.enabled) as asset}
                    <span class="badge start">{asset.canonicalAssetId}</span>
                  {/each}
                </div>
                {#if mainnetFor(item.network) && !mainnetFor(item.network)?.supported}
                  <div class="alert warning provider-required">
                    <strong>{mainnetFor(item.network)?.label} synchronization is unavailable.</strong>
                    {mainnetFor(item.network)?.reason}
                  </div>
                {/if}
                <div class="toolbar">
                  <button class="secondary" type="button" on:click={() => toggle({ item })}>{item.enabled ? 'Disable' : 'Enable'}</button>
                  <button class="ghost" type="button" on:click={() => refresh({ item })}>Refresh</button>
                  <button class="danger" type="button" on:click={() => remove({ item })}>Delete</button>
                </div>
              </article>
            {/each}
          </div>
        </section>

      {:else if blockId === 'chart'}
        {#if chartPreferencesReady}
        <div id="address-portfolio-chart">
        <PortfolioChart
          title="Address portfolio history"
          {series}
          chartMode="line"
          currency={primaryCurrency}
          tooltipCurrencies={activeCurrencies}
          {denominationOptions}
          source="combined"
          {timezone}
          {granularity}
          selectedGranularitySetting={selectedGranularity}
          {partial}
          {stale}
          {events}
          busy={loading}
          saveable
          initialRange={chartRange}
          initialCustomFromMs={addressChartState.customFromMs}
          initialCustomToMs={addressChartState.customToMs}
          initialCustomRangeMode={addressChartState.customRangeMode}
          initialCustomAgoValue={addressChartState.customAgoValue}
          initialCustomAgoUnit={addressChartState.customAgoUnit}
          initialScale={addressDisplayState.scale}
          initialYAxisUnit={addressDisplayState.yAxisUnit}
          initialTooltipUnits={addressDisplayState.tooltipUnits}
          initialNormalized={addressDisplayState.normalized}
          initialShowEvents={addressDisplayState.showEvents}
          initialShowVolume={addressDisplayState.showVolume}
          initialVisibleSeriesIds={addressDisplayState.visibleSeriesIds}
          initialLeftYAxisSeriesIds={addressDisplayState.leftYAxisSeriesIds}
          initialRightYAxisUnit={addressDisplayState.rightYAxisUnit}
          initialRightYAxisSeriesIds={addressDisplayState.rightYAxisSeriesIds}
          initialLeftYAxisLineColor={addressDisplayState.leftYAxisLineColor}
          initialRightYAxisLineColor={addressDisplayState.rightYAxisLineColor}
          initialMinimumMode={boundMode('minimumMode')}
          initialMaximumMode={boundMode('maximumMode')}
          initialMinimumValue={configString('minimumValue')}
          initialMaximumValue={configString('maximumValue')}
          initialShowWicks={addressEditConfig.showWicks !== false}
          initialSaveGraphName={addressSaveName}
          preferenceKey="addresses:portfolio"
          partialMessage={partialMessage()}
          emptyMessage="No address portfolio history is cached yet. Add a public address or use Refresh on a tracked address, then follow progress in Settings → Synchronization."
          on:stateChange={graphStateChanged}
          on:viewChange={graphViewChanged}
          on:zoomRange={graphZoomed}
          on:saveGraph={saveGraph}
        />
        </div>
        {/if}

      {:else if blockId === 'performance'}
        <PerformanceAnalytics
          title="Address portfolio performance"
          {series}
          {timezone}
          returnMethod="value"
          initialVisibleSeriesIds={addressPerformanceDisplayState.visibleSeriesIds}
          initialLeftYAxisSeriesIds={addressPerformanceDisplayState.leftYAxisSeriesIds}
          initialRightYAxisSeriesIds={addressPerformanceDisplayState.rightYAxisSeriesIds}
          initialRightYAxisUnit={addressPerformanceDisplayState.rightYAxisUnit}
          initialLeftYAxisLineColor={addressPerformanceDisplayState.leftYAxisLineColor}
          initialRightYAxisLineColor={addressPerformanceDisplayState.rightYAxisLineColor}
          initialTooltipUnits={addressPerformanceDisplayState.tooltipUnits}
          initialMinimumMode={addressPerformanceDisplayState.minimumMode}
          initialMaximumMode={addressPerformanceDisplayState.maximumMode}
          initialMinimumValue={addressPerformanceDisplayState.minimumValue}
          initialMaximumValue={addressPerformanceDisplayState.maximumValue}
          on:displayChange={performanceDisplayChanged}
        />

      {:else if blockId === 'holdings'}
        <section class="panel">
          <p class="eyebrow">Holdings</p>
          <h2>Quantity, priced value, and coverage</h2>
          <ColumnConfigurator
            label="Configure holdings columns"
            columns={holdingColumnOptions}
            selected={selectedHoldingColumns}
            defaults={defaultHoldingColumns}
            on:change={updateHoldingColumns}
          />
          <div class="toolbar save-table">
            <div class="field grow">
              <label for="address-table-dashboard-name">Dashboard table name</label>
              <input id="address-table-dashboard-name" maxlength="120" bind:value={tableDashboardName} />
            </div>
            <button class="secondary" type="button" on:click={saveTable}>Save table to dashboard</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  {#each selectedHoldingColumns as columnId}
                    <th>{holdingColumnOptions.find((column) => column.id === columnId)?.label ?? columnId}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each holdingGroups as group (group.addressId)}
                  {#each group.rows as holding, holdingIndex (`${holding.addressId}:${holding.assetId}`)}
                    <tr>
                      {#each selectedHoldingColumns as columnId}
                        {#if !['label', 'address'].includes(columnId) || holdingIndex === 0}
                        <td rowspan={['label', 'address'].includes(columnId) ? group.rows.length : undefined}>
                        {#if columnId === 'label'}
                          {holding.label}
                        {:else if columnId === 'address'}
                          <code>{holding.address}</code>
                        {:else if columnId === 'network'}
                          {holding.network}
                        {:else if columnId === 'asset'}
                          <strong>{holding.assetSymbol}</strong>
                          <span class="asset-name">{holding.assetName}</span>
                        {:else if columnId === 'quantity'}
                          {#if holding.balanceObserved}
                            {formatDisplayNumber({ value: holding.quantity })}
                          {:else}
                            <span class="unavailable" title={holding.balanceReason ?? ''}>unavailable</span>
                          {/if}
                        {:else if columnId.startsWith('value:')}
                          {@const currency = columnId.slice('value:'.length)}
                          <span class:unavailable={!holding.balanceObserved} title={holding.balanceReason ?? ''}>
                            {formatCurrentValue({ holding, currency })}
                          </span>
                        {:else if columnId === 'coverage'}
                          {holding.balanceObserved
                            ? `${formatPercent(holding.pricedCoveragePercent)}% priced`
                            : 'unavailable'}
                        {:else if columnId === 'history'}
                          {holding.completeness}
                        {:else if columnId === 'oldest'}
                          {formatDate(holding.oldestReconstructedAt)}
                        {:else if columnId === 'lastSync'}
                          {formatDate(holding.lastSuccessfulSync)}
                        {/if}
                      </td>
                        {/if}
                      {/each}
                    </tr>
                  {/each}
                {/each}
              </tbody>
            </table>
          </div>
        </section>
      {/if}
    </ReorderableBlock>
    </div>
  {/each}
  </div>
</main>

<style>
  .address-page-grid {
    display: block;
  }

  .unavailable {
    color: var(--color-warning);
    text-decoration: underline dotted;
    text-underline-offset: 0.2rem;
    cursor: help;
  }

  .asset-name {
    display: block;
    color: var(--color-muted);
    font-size: 0.8rem;
  }

  .address-form {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.7rem;
  }

  .address-list {
    display: grid;
    gap: 0.8rem;
  }

  .address-card code,
  td code {
    display: block;
    max-width: 28rem;
    overflow-wrap: anywhere;
  }

  .address-card h3 {
    margin: 0.7rem 0 0.3rem;
  }

  .asset-badges {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-bottom: 0.8rem;
  }

  .optional-token-options {
    width: 100%;
    min-width: 0;
    margin: 0;
    padding: 0.8rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-panel);
  }

  .optional-token-options legend {
    padding: 0 0.35rem;
    color: var(--color-text);
    font-size: 0.82rem;
    font-weight: 700;
  }

  .optional-token-options p {
    margin: 0 0 0.7rem;
  }

  .optional-token-fields {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.7rem;
  }

  .optional-token-fields .grow {
    flex: 1 1 24rem;
  }

  .address-submit {
    margin-left: auto;
  }

  .provider-required {
    margin: 0 0 0.8rem;
  }

  @media (min-width: 80rem) {
    .address-list {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
