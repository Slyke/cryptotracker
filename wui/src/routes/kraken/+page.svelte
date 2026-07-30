<script lang="ts">
  import { onMount } from 'svelte';
  import PortfolioChart from '../../lib/components/PortfolioChart.svelte';
  import PerformanceAnalytics from '../../lib/components/PerformanceAnalytics.svelte';
  import CurrencyValue from '../../lib/components/CurrencyValue.svelte';
  import LargeToggleButton from '../../lib/components/LargeToggleButton.svelte';
  import ColumnConfigurator from '../../lib/components/ColumnConfigurator.svelte';
  import DismissableNotice from '../../lib/components/DismissableNotice.svelte';
  import ReorderableBlock from '../../lib/components/ReorderableBlock.svelte';
  import type {
    ChartDenominationOption,
    ChartEvent,
    ChartSeries
  } from '../../lib/components/chart-types';
  import { apiRequest } from '$lib/api';
  import { persistAccordionState } from '$lib/accordion-state';
  import {
    chartDenominationOptionsFromAssets,
    type ChartAxisAsset
  } from '$lib/chart-axis-catalog';
  import { configuredCurrencies } from '$lib/currencies';
  import strings from '$lib/i18n/en-CA.json';
  import {
    createSavedGraph,
    formatDateTime,
    formatDisplayNumber,
    formatPercent,
    moveInOrder,
    normalizeOrder,
    normalizeTooltipUnits,
    relativeRangeWindow,
    savePreferences,
    savedGraphNameExists,
    toggleCollapsed,
    type SavedGraph
  } from '$lib/preferences';

  let status = {
    configured: false,
    connected: false,
    readOnly: null as boolean | null,
    permissionInspection: {
      available: false,
      safe: null as boolean | null,
      permissions: [] as string[],
      required: [
        'query-funds',
        'query-open-trades',
        'query-closed-trades',
        'query-ledger'
      ],
      missing: [] as string[],
      unsafe: [] as string[]
    },
    cursors: [] as Array<{
      endpoint: string;
      completeness: string;
      lastSuccessfulSync: string | null;
    }>
  };
  const permissionDetails: Record<string, { label: string; purpose: string }> = {
    'query-funds': {
      label: 'Query Funds',
      purpose: 'Read balances, trade balances, and current Earn allocations.'
    },
    'query-open-trades': {
      label: 'Query Open Orders & Trades',
      purpose: 'Read open margin positions.'
    },
    'query-closed-trades': {
      label: 'Query Closed Orders & Trades',
      purpose: 'Read trade history and closed orders.'
    },
    'query-ledger': {
      label: 'Query Ledger Entries',
      purpose: 'Read deposits, withdrawals, fees, rewards, and other ledger history.'
    },
    'add-funds': { label: 'Deposit Funds', purpose: 'Not used by CryptoTracker.' },
    'withdraw-funds': { label: 'Withdraw Funds', purpose: 'Not used by CryptoTracker.' },
    'earn-funds': { label: 'Earn Funds', purpose: 'Can allocate or deallocate funds and must be disabled.' },
    'modify-trades': { label: 'Create & Modify Orders', purpose: 'Can place or change orders and must be disabled.' },
    'close-trades': { label: 'Cancel & Close Orders', purpose: 'Can cancel orders or close positions and must be disabled.' },
    'export-data': { label: 'Export Data', purpose: 'Not used by CryptoTracker.' },
    'create-ws-token': { label: 'WebSocket Interface', purpose: 'Not used by CryptoTracker.' },
    'add-withdraw-address': { label: 'Add Withdrawal Addresses', purpose: 'Must be disabled.' },
    'update-withdraw-address': { label: 'Update Withdrawal Addresses', purpose: 'Must be disabled.' }
  };
  const permissionDetail = ({ permission }: { permission: string }) =>
    permissionDetails[permission] ?? {
      label: permission,
      purpose: 'Unknown or unnecessary permission; disable it for this key.'
    };
  const requiredPermissions = () => status.permissionInspection.required;
  const missingPermissions = () => status.permissionInspection.missing;
  const unsafePermissions = () => status.permissionInspection.unsafe;
  let locale = 'en-CA';
  let primaryCurrency = 'CAD';
  let tooltipCurrencies = ['CAD'];
  let summary = {
    totalCurrentValue: '0',
    currency: 'CAD',
    pricedValueCoveragePercent: '0',
    pricedAssetCount: 0,
    totalAssetCount: 0,
    latestSuccessfulSync: null as string | null,
    stale: false,
    values: {} as Record<string, string | null>,
    sections: {
      spot: false,
      earn: false,
      margin: false,
      futures: false
    }
  };
  type Holding = {
    assetRaw: string;
    assetId: string | null;
    category: string;
    quantity: string;
    valueCurrency: string | null;
    valueAmount: string | null;
    priced: boolean;
    capturedAt: string;
    currentPrice?: string | null;
    pricingReason?: string | null;
  };
  type EarnAllocation = {
    allocationId: string;
    assetRaw: string;
    assetId: string | null;
    productId: string | null;
    quantity: string;
    rewardQuantity: string | null;
    state: string;
    capturedAt: string;
  };
  type EarnAsset = {
    assetId: string;
    label: string;
    quantity: string;
    valueAmount: string | null;
    priced: boolean;
    rewardQuantity: string;
    allocationCount: number;
    states: string[];
    capturedAt: string | null;
    currentValues: Record<string, string | null>;
    rewardValues: Record<string, string | null>;
    apyLowPercent: string | null;
    apyHighPercent: string | null;
    apyCapturedAt: string | null;
  };
  type EarnOverview = {
    summary: {
      totalValue: string;
      totalRewardValue: string;
      currency: string;
      values: Record<string, string | null>;
      rewardValues: Record<string, string | null>;
      assetCount: number;
      pricedAssetCount: number;
      pricedRewardAssetCount: number;
      allocationCount: number;
    };
    assets: EarnAsset[];
    allocations: EarnAllocation[];
    series: ChartSeries[];
    apySeries: ChartSeries[];
    events: ChartEvent[];
    activity: ChartEvent[];
    payoutDistribution: Array<{
      assetId: string;
      label: string;
      quantity: string;
      payoutCount: number;
      lastPayoutAt: string;
    }>;
    denominationOptions: ChartDenominationOption[];
    granularitySeconds: number;
    coverage: {
      ledgerComplete: boolean;
      oldestLedgerAt: string | null;
      message: string;
    };
    apyCoverage: {
      available: boolean;
      oldestObservedAt: string | null;
      providerBackfillAvailable: boolean;
      complete: boolean;
      message: string;
    };
    partial: boolean;
  };
  const emptyEarnOverview = (): EarnOverview => ({
    summary: {
      totalValue: '0',
      totalRewardValue: '0',
      currency: 'CAD',
      values: {},
      rewardValues: {},
      assetCount: 0,
      pricedAssetCount: 0,
      pricedRewardAssetCount: 0,
      allocationCount: 0
    },
    assets: [],
    allocations: [],
    series: [],
    apySeries: [],
    events: [],
    activity: [],
    payoutDistribution: [],
    denominationOptions: [],
    granularitySeconds: 86_400,
    coverage: {
      ledgerComplete: false,
      oldestLedgerAt: null,
      message: 'Kraken Earn history has not loaded yet.'
    },
    apyCoverage: {
      available: false,
      oldestObservedAt: null,
      providerBackfillAvailable: false,
      complete: false,
      message: 'Kraken Earn rate estimates have not loaded yet.'
    },
    partial: false
  });
  let holdings: Holding[] = [];
  let earnAllocations: EarnAllocation[] = [];
  let earnOverview = emptyEarnOverview();
  let earnOverviewSeries: ChartSeries[] = [];
  let earnApyOverviewSeries: ChartSeries[] = [];
  let earnZoomRequestId = 0;
  let visibleEarnSeries = new Set<string>();
  let displayedEarnSeries: ChartSeries[] = [];
  let activity = {
    trades: [] as Array<Record<string, unknown>>,
    ledgers: [] as Array<Record<string, unknown>>
  };
  let pnl: Record<string, unknown> = {};
  let series: ChartSeries[] = [];
  let krakenOverviewSeries: ChartSeries[] = [];
  let krakenResolvedGranularity = 1_800;
  let krakenZoomRequestId = 0;
  let events: ChartEvent[] = [];
  let denominationOptions: ChartDenominationOption[] = [];
  let costBasisMethod: 'acb' | 'fifo' | 'lifo' = 'acb';
  let loading = true;
  let error = '';
  let message = '';
  let metrics: Record<string, {
    prices: Record<string, string | null>;
    changes: Record<string, string | null>;
  }> = {};
  let pageLayouts: Record<string, string[]> = {};
  let collapsedBlocks: Record<string, string[]> = {};
  let tableColumns: Record<string, string[]> = {};
  let tableRows: Record<string, string[]> = {};
  let graphDefaults: Record<string, unknown> = {};
  let savedGraphs: SavedGraph[] = [];
  let visibleKrakenSeries = new Set<string>(['kraken-total']);
  let selectableKrakenSeries: ChartSeries[] = [];
  let displayedKrakenSeries: ChartSeries[] = [];
  let krakenChartEmptyMessage = '';
  let tableDashboardName = 'Kraken balances';
  let earnTableDashboardName = 'Kraken Earn assets';
  let dismissedNotices: string[] = [];
  let enabledMarketAssets = new Set<string>();
  const defaultPageOrder = ['summary', 'balances', 'earn', 'margin', 'chart', 'performance', 'cost-basis', 'activity'];
  let pageOrder = [...defaultPageOrder];
  let krakenRowOrder: string[] = [];
  let balanceColumns: Array<{ id: string; label: string; description?: string }> = [];
  let selectedBalanceColumns: string[] = [];
  let earnColumnOptions: Array<{ id: string; label: string }> = [];
  let selectedEarnColumns: string[] = [];
  let earnActivityQuery = '';
  let earnActivityCategory = 'all';
  let earnActivityPage = 1;
  const earnActivityPageSize = 25;
  let earnActivityCategories: string[] = [];
  let filteredEarnActivityRows: ChartEvent[] = [];
  let visibleEarnActivityRows: ChartEvent[] = [];
  let earnActivityPageTotal = 1;
  type ChartQueryState = {
    range: string;
    granularity: string;
    customFromMs: number | null;
    customToMs: number | null;
    customRangeMode: 'dates' | 'ago';
    customAgoValue: number;
    customAgoUnit: 'hours' | 'days' | 'weeks' | 'months' | 'years';
  };
  type ChartDisplayState = {
    scale: 'linear' | 'log';
    normalized: boolean;
    showEvents: boolean;
    showVolume: boolean;
    yAxisUnit: string;
    tooltipUnits: string[];
  };
  const defaultChartQueryState = (): ChartQueryState => ({
    range: '1y',
    granularity: '1800',
    customFromMs: null,
    customToMs: null,
    customRangeMode: 'dates',
    customAgoValue: 365,
    customAgoUnit: 'days'
  });
  const defaultChartDisplayState = (
    currency: string,
    tooltipUnits: string[] = [currency]
  ): ChartDisplayState => ({
    scale: 'linear',
    normalized: false,
    showEvents: true,
    showVolume: false,
    yAxisUnit: currency,
    tooltipUnits: normalizeTooltipUnits({ value: tooltipUnits, fallback: [currency] })
  });
  let krakenChartState = defaultChartQueryState();
  let earnChartState = { ...defaultChartQueryState(), granularity: '86400' };
  let krakenDisplayState = defaultChartDisplayState(primaryCurrency);
  let earnDisplayState = defaultChartDisplayState(primaryCurrency);
  let earnApyDisplayState = defaultChartDisplayState('%', ['%']);
  let chartPreferencesReady = false;
  const changeColumns = [
    ['change24h', '24-hour change'],
    ['change7d', '7-day change'],
    ['change28d', '28-day change'],
    ['changeMoM', 'Month-over-month change'],
    ['changeMtD', 'Month-to-date change'],
    ['change3m', '3-month change'],
    ['change6m', '6-month change'],
    ['change1y', '1-year change'],
    ['change2y', '2-year change'],
    ['change4y', '4-year change']
  ] as const;
  const activeCurrencies = () => configuredCurrencies({
    primaryCurrency,
    listedCurrencies: tooltipCurrencies
  });
  const buildEarnColumnOptions = () => [
    { id: 'asset', label: 'Asset' },
    { id: 'quantity', label: 'Staked quantity' },
    { id: 'apy', label: 'Estimated APY' },
    ...activeCurrencies().map((currency) => ({
      id: `currentValue:${currency}`,
      label: `Current value (${currency})`
    })),
    { id: 'totalRewarded', label: 'Total rewarded' },
    { id: 'totalPaid', label: 'Payout distribution' },
    { id: 'payoutCount', label: 'Payouts' },
    { id: 'latestPayout', label: 'Latest payout' },
    { id: 'state', label: 'State' },
    { id: 'snapshot', label: 'Snapshot' }
  ];
  const chartStateFromSetting = ({
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
        ? agoUnit as ChartQueryState['customAgoUnit']
        : fallback.customAgoUnit
    };
  };
  const chartDisplayFromSetting = ({
    value,
    fallback
  }: {
    value: unknown;
    fallback: ChartDisplayState;
  }): ChartDisplayState => {
    if (!value || typeof value !== 'object') return fallback;
    const candidate = value as Record<string, unknown>;
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
      })
    };
  };
  const chartWindow = (state: ChartQueryState) => {
    const now = Date.now();
    if (state.range === 'custom' && state.customRangeMode === 'ago') {
      return relativeRangeWindow({
        value: state.customAgoValue,
        unit: state.customAgoUnit,
        toMs: now
      }) ?? { from: now - 365 * 24 * 60 * 60_000, to: now };
    }
    if (
      state.range === 'custom'
      && state.customFromMs !== null
      && state.customToMs !== null
    ) {
      return { from: state.customFromMs, to: state.customToMs };
    }
    const durations: Record<string, number> = {
      '24h': 24 * 60 * 60_000,
      '7d': 7 * 24 * 60 * 60_000,
      '30d': 30 * 24 * 60 * 60_000,
      '90d': 90 * 24 * 60 * 60_000,
      '1y': 365 * 24 * 60 * 60_000,
      '4y': 4 * 365 * 24 * 60 * 60_000,
      all: 0
    };
    const duration = durations[state.range] ?? durations['1y'];
    return { from: duration === 0 ? 0 : now - duration, to: now };
  };
  const chartGranularity = (state: ChartQueryState) => {
    if (state.granularity !== 'auto') {
      const value = Number(state.granularity);
      if (Number.isFinite(value) && value > 0) return value;
    }
    const window = chartWindow(state);
    const duration = window.from === 0 ? 5 * 365 * 24 * 60 * 60_000 : window.to - window.from;
    if (duration <= 2 * 24 * 60 * 60_000) return 1_800;
    if (duration <= 90 * 24 * 60 * 60_000) return 14_400;
    if (duration <= 2 * 365 * 24 * 60 * 60_000) return 86_400;
    return 604_800;
  };
  const buildBalanceColumns = () => [
    { id: 'asset', label: 'Asset' },
    { id: 'balance', label: 'Balance' },
    ...activeCurrencies().map((currency) => ({ id: `averageBuyPrice:${currency}`, label: `Average buy price (${currency})`, description: currency === primaryCurrency ? 'Calculated lot basis.' : 'Converted using current cross-currency pricing.' })),
    ...activeCurrencies().map((currency) => ({ id: `currentPrice:${currency}`, label: `Current price (${currency})` })),
    ...changeColumns.map(([id, label]) => ({ id, label })),
    { id: 'unrealisedReturn', label: 'Unrealised return' },
    ...activeCurrencies().map((currency) => ({ id: `walletValue:${currency}`, label: `Wallet value (${currency})` })),
    { id: 'pricing', label: 'Pricing status' },
    { id: 'capturedAt', label: 'Snapshot time' },
    { id: 'rawAsset', label: 'Raw Kraken asset' }
  ];

  const holdingRowId = (holding: Holding) => `${holding.category}:${holding.assetRaw}`;
  const spotHoldings = () => holdings.filter((holding) => holding.category === 'spot');
  let orderedSpotHoldings: Holding[] = [];
  $: {
    holdings;
    krakenRowOrder;
    const position = new Map(krakenRowOrder.map((id, index) => [id, index]));
    orderedSpotHoldings = [...holdings.filter((holding) => holding.category === 'spot')].sort((left, right) => (
      (position.get(holdingRowId(left)) ?? Number.MAX_SAFE_INTEGER)
      - (position.get(holdingRowId(right)) ?? Number.MAX_SAFE_INTEGER)
    ));
  }
  const blockVisible = (blockId: string) => {
    if (blockId === 'balances') return summary.sections.spot;
    if (blockId === 'earn') return true;
    if (blockId === 'margin') return summary.sections.margin;
    return true;
  };
  let visiblePageOrderItems: string[] = [];
  $: visiblePageOrderItems = pageOrder.filter((blockId) => {
    if (blockId === 'balances') return summary.sections.spot;
    if (blockId === 'earn') return true;
    if (blockId === 'margin') return summary.sections.margin;
    return true;
  });
  const seriesHasValues = (item: ChartSeries) => item.points.some((point) =>
    point.value !== null && point.value !== undefined);
  const pricedPointCount = (item: ChartSeries) => item.points.filter((point) =>
    point.value !== null && point.value !== undefined).length;

  const krakenSeriesAssetId = (item: ChartSeries) => (
    item.id.startsWith('kraken-asset:') ? item.id.slice('kraken-asset:'.length) : null
  );
  const seriesIsEnabled = (item: ChartSeries) => {
    const assetId = krakenSeriesAssetId(item);
    return assetId === null || enabledMarketAssets.has(assetId);
  };
  const seriesIsDisabled = (item: ChartSeries) => (
    !seriesHasValues(item) || !seriesIsEnabled(item)
  );
  const seriesStateDetail = (item: ChartSeries) => {
    if (!seriesHasValues(item)) return 'Disabled · no priced snapshots';
    if (!seriesIsEnabled(item)) return 'Disabled in Markets';
    const priced = pricedPointCount(item);
    const snapshots = `${priced} priced snapshot${priced === 1 ? '' : 's'}`;
    if (visibleKrakenSeries.has(item.id)) return `${snapshots} · active`;
    return `${snapshots} · enabled`;
  };

  $: selectableKrakenSeries = [...new Map(series.map((item) => [item.id, item])).values()];
  $: displayedKrakenSeries = selectableKrakenSeries.filter((item) => (
    visibleKrakenSeries.has(item.id) && !seriesIsDisabled(item)
  ));
  $: displayedEarnSeries = earnOverview.series.filter((item) => (
    visibleEarnSeries.has(item.id) && seriesHasValues(item)
  ));
  $: krakenChartEmptyMessage = selectableKrakenSeries.length > 0 && displayedKrakenSeries.length === 0
    ? 'No Kraken chart series is selected. Turn on Kraken total or an asset above.'
    : 'No Kraken portfolio history is cached yet. Use Manual refresh at the top of this page, then follow progress in Settings → Synchronization.';
  const disabledPriceAssets = () => [...new Set(
    spotHoldings()
      .map((holding) => holding.assetId)
      .filter((assetId): assetId is string => assetId !== null && !enabledMarketAssets.has(assetId))
  )];
  const balanceColumnLabel = (columnId: string) => (
    balanceColumns.find((column) => column.id === columnId)?.label ?? columnId
  );
  const earnColumnLabel = (columnId: string) => (
    earnColumnOptions.find((column) => column.id === columnId)?.label ?? columnId
  );
  const payoutForAsset = (assetId: string) => (
    earnOverview.payoutDistribution.find((payout) => payout.assetId === assetId)
  );
  const earnCellValue = ({ asset, columnId }: {
    asset: EarnAsset;
    columnId: string;
  }) => {
    const payout = payoutForAsset(asset.assetId);
    if (columnId === 'asset') return asset.label;
    if (columnId === 'quantity') return formatDisplayNumber({ value: asset.quantity, locale });
    if (columnId.startsWith('currentValue:')) {
      const currency = columnId.slice('currentValue:'.length);
      const value = asset.currentValues[currency];
      return value === null || value === undefined
        ? 'unavailable'
        : formatMoney({ value, currency });
    }
    if (columnId === 'apy') {
      if (asset.apyLowPercent === null || asset.apyHighPercent === null) return 'unavailable';
      const low = formatPercent(asset.apyLowPercent);
      const high = formatPercent(asset.apyHighPercent);
      return low === high ? `${low}%` : `${low}–${high}%`;
    }
    if (columnId === 'totalRewarded') {
      return formatDisplayNumber({ value: asset.rewardQuantity, locale });
    }
    if (columnId === 'totalPaid') {
      return payout
        ? formatDisplayNumber({ value: payout.quantity, locale })
        : 'none imported';
    }
    if (columnId === 'payoutCount') return payout?.payoutCount ?? 0;
    if (columnId === 'latestPayout') {
      return payout
        ? formatDateTime({ value: payout.lastPayoutAt, timezone })
        : 'none imported';
    }
    if (columnId === 'state') return asset.states.join(', ') || 'unavailable';
    if (columnId === 'snapshot') {
      return asset.capturedAt === null
        ? 'unavailable'
        : formatDateTime({ value: asset.capturedAt, timezone });
    }
    return 'unavailable';
  };
  const filterEarnActivity = () => {
    const query = earnActivityQuery.trim().toLowerCase();
    return earnOverview.activity.filter((event) => (
      (earnActivityCategory === 'all' || event.category === earnActivityCategory)
      && (
        !query
        || event.category.toLowerCase().includes(query)
        || String(event.asset ?? '').toLowerCase().includes(query)
        || String(event.quantity ?? '').toLowerCase().includes(query)
        || JSON.stringify(event.details ?? {}).toLowerCase().includes(query)
      )
    ));
  };
  $: earnActivityCategories = [...new Set(
    earnOverview.activity.map((event) => event.category)
  )].sort();
  $: if (
    earnActivityCategory !== 'all'
    && !earnActivityCategories.includes(earnActivityCategory)
  ) {
    earnActivityCategory = 'all';
  }
  $: filteredEarnActivityRows = (
    earnOverview.activity,
    earnActivityQuery,
    earnActivityCategory,
    filterEarnActivity()
  );
  $: earnActivityPageTotal = Math.max(
    1,
    Math.ceil(filteredEarnActivityRows.length / earnActivityPageSize)
  );
  $: if (earnActivityPage > earnActivityPageTotal) {
    earnActivityPage = earnActivityPageTotal;
  }
  $: visibleEarnActivityRows = filteredEarnActivityRows.slice(
    (Math.max(1, earnActivityPage) - 1) * earnActivityPageSize,
    Math.max(1, earnActivityPage) * earnActivityPageSize
  );

  const holdingMetric = ({ holding }: { holding: Holding }) => (
    holding.assetId ? metrics[holding.assetId] : undefined
  );

  const lotAverage = ({ assetId }: { assetId: string | null }) => {
    const lots = Array.isArray(pnl.lots)
      ? pnl.lots as Array<Record<string, unknown>>
      : [];
    const matching = lots.filter((lot) => lot.assetId === assetId && Number(lot.remainingQuantity ?? 0) > 0);
    const quantity = matching.reduce((total, lot) => total + Number(lot.remainingQuantity ?? 0), 0);
    const basis = matching.reduce((total, lot) => total + Number(lot.basis ?? 0), 0);
    return quantity > 0 ? basis / quantity : null;
  };

  const averageBuyPrice = ({ holding, currency }: { holding: Holding; currency: string }) => {
    const primaryAverage = lotAverage({ assetId: holding.assetId });
    if (primaryAverage === null) return null;
    if (currency === primaryCurrency) return primaryAverage;
    const prices = holdingMetric({ holding })?.prices;
    const primaryPrice = Number(prices?.[primaryCurrency] ?? 0);
    const targetPrice = Number(prices?.[currency] ?? 0);
    return primaryPrice > 0 && targetPrice > 0
      ? primaryAverage * (targetPrice / primaryPrice)
      : null;
  };

  const currentPrice = ({ holding, currency }: { holding: Holding; currency: string }) => (
    holdingMetric({ holding })?.prices?.[currency] ?? (
      currency === holding.valueCurrency ? holding.currentPrice ?? null : null
    )
  );

  const walletValue = ({ holding, currency }: { holding: Holding; currency: string }) => {
    const price = currentPrice({ holding, currency });
    return price === null ? null : Number(holding.quantity) * Number(price);
  };

  const unrealisedReturn = ({ holding }: { holding: Holding }) => {
    const average = averageBuyPrice({ holding, currency: primaryCurrency });
    const current = Number(currentPrice({ holding, currency: primaryCurrency }) ?? 0);
    return average && average > 0 && current > 0 ? ((current - average) / average) * 100 : null;
  };

  const unavailableReason = ({
    holding,
    columnId
  }: {
    holding: Holding;
    columnId: string;
  }) => {
    if (!holding.assetId) return 'Kraken’s raw asset code has no reviewed canonical asset mapping.';
    if (!enabledMarketAssets.has(holding.assetId) && (
      columnId.startsWith('currentPrice:')
      || columnId.startsWith('walletValue:')
      || columnId.startsWith('change')
      || columnId === 'unrealisedReturn'
    )) {
      return `${holding.assetId} is disabled in Markets. Enable it there to synchronize market prices.`;
    }
    if (columnId.startsWith('averageBuyPrice:')) {
      return 'No complete remaining cost-basis lot is available from the imported Kraken trade and ledger history.';
    }
    if (columnId.startsWith('currentPrice:') || columnId.startsWith('walletValue:')) {
      return 'No current cached price is available for this asset and currency.';
    }
    if (columnId.startsWith('change')) {
      return 'The stored market history does not yet cover both endpoints required for this change period.';
    }
    if (columnId === 'unrealisedReturn') {
      return 'Unrealised return requires both an average buy price and a current price.';
    }
    return 'This value is not available from the imported data.';
  };

  const balanceCellValue = ({ holding, columnId }: { holding: Holding; columnId: string }) => {
    if (columnId === 'asset') return holding.assetId ?? holding.assetRaw;
    if (columnId === 'balance') return formatDisplayNumber({ value: holding.quantity, locale });
    if (columnId === 'capturedAt') return formatDateTime({ value: holding.capturedAt, timezone });
    if (columnId === 'rawAsset') return holding.assetRaw;
    if (columnId.startsWith('averageBuyPrice:')) {
      const currency = columnId.split(':')[1]!;
      const value = averageBuyPrice({ holding, currency });
      return value === null ? null : formatMoney({ value, currency });
    }
    if (columnId.startsWith('currentPrice:')) {
      const currency = columnId.split(':')[1]!;
      const value = currentPrice({ holding, currency });
      return value === null ? null : formatMoney({ value, currency });
    }
    if (columnId.startsWith('walletValue:')) {
      const currency = columnId.split(':')[1]!;
      const value = walletValue({ holding, currency });
      return value === null ? null : formatMoney({ value, currency });
    }
    if (columnId === 'unrealisedReturn') {
      const value = unrealisedReturn({ holding });
      return value === null ? null : `${formatPercent(value)}%`;
    }
    if (columnId.startsWith('change')) {
      const value = holdingMetric({ holding })?.changes?.[columnId] ?? null;
      return value === null ? null : `${formatPercent(value)}%`;
    }
    return null;
  };

  const formatMoney = ({ value, currency }: { value: unknown; currency: string }) => (
    formatDisplayNumber({ value, currency, locale })
  );

  const lastConnectionCheck = () => {
    const times = [
      summary.latestSuccessfulSync,
      ...status.cursors.map((cursor) => cursor.lastSuccessfulSync)
    ].filter((value): value is string => Boolean(value));
    return times.length > 0
      ? formatDateTime({ value: Math.max(...times.map((value) => new Date(value).getTime())), timezone })
      : 'no successful check yet';
  };

  const unpricedHoldings = () => holdings.filter((holding) => !holding.priced);
  const krakenPartialMessage = () => {
    const unpriced = unpricedHoldings();
    if (unpriced.length === 0) return '';
    const names = unpriced.slice(0, 5).map((holding) => holding.assetId ?? holding.assetRaw).join(', ');
    return `${unpriced.length} Kraken balance${unpriced.length === 1 ? ' is' : 's are'} unpriced (${names}${unpriced.length > 5 ? ', …' : ''}). This is pricing coverage, not necessarily an active Kraken sync. Each balance row explains the missing price; Settings → Synchronization shows active work.`;
  };

  let timezone = 'America/Vancouver';

  const load = async () => {
    loading = true;
    error = '';
    try {
      const [settingsPayload, watchlistPayload] = await Promise.all([
        apiRequest<{ settings: {
          locale: string;
          timezone: string;
          primaryCurrency: string;
          tooltipCurrencies: string[];
          pageLayouts: Record<string, string[]>;
          collapsedBlocks: Record<string, string[]>;
          tableColumns: Record<string, string[]>;
          tableRows: Record<string, string[]>;
          graphDefaults: Record<string, unknown>;
          savedGraphs: SavedGraph[];
          dismissedNotices: string[];
        } }>({ url: '/api/settings' }),
        apiRequest<{ assets: ChartAxisAsset[] }>({
          url: '/api/watchlist/assets'
        })
      ]);
      locale = settingsPayload.settings.locale;
      timezone = settingsPayload.settings.timezone;
      primaryCurrency = settingsPayload.settings.primaryCurrency;
      tooltipCurrencies = settingsPayload.settings.tooltipCurrencies;
      pageLayouts = settingsPayload.settings.pageLayouts ?? {};
      collapsedBlocks = settingsPayload.settings.collapsedBlocks ?? {};
      tableColumns = settingsPayload.settings.tableColumns ?? {};
      tableRows = settingsPayload.settings.tableRows ?? {};
      graphDefaults = settingsPayload.settings.graphDefaults ?? {};
      savedGraphs = settingsPayload.settings.savedGraphs ?? [];
      dismissedNotices = settingsPayload.settings.dismissedNotices ?? [];
      enabledMarketAssets = new Set(
        watchlistPayload.assets.filter((asset) => asset.enabled).map((asset) => asset.canonicalId)
      );
      if (!chartPreferencesReady) {
        krakenChartState = chartStateFromSetting({
          value: graphDefaults.krakenChartState,
          fallback: defaultChartQueryState()
        });
        earnChartState = chartStateFromSetting({
          value: graphDefaults.krakenEarnChartState,
          fallback: { ...defaultChartQueryState(), granularity: '86400' }
        });
        krakenDisplayState = chartDisplayFromSetting({
          value: graphDefaults.krakenDisplayState,
          fallback: defaultChartDisplayState(primaryCurrency, activeCurrencies())
        });
        earnDisplayState = chartDisplayFromSetting({
          value: graphDefaults.krakenEarnDisplayState,
          fallback: defaultChartDisplayState(primaryCurrency, activeCurrencies())
        });
        earnApyDisplayState = chartDisplayFromSetting({
          value: graphDefaults.krakenEarnApyDisplayState,
          fallback: defaultChartDisplayState('%', ['%'])
        });
        chartPreferencesReady = true;
      }
      const mainWindow = chartWindow(krakenChartState);
      const earnWindow = chartWindow(earnChartState);
      const quoteCurrencies = encodeURIComponent(activeCurrencies().join(','));
      const [
        statusPayload,
        summaryPayload,
        holdingsPayload,
        earnPayload,
        activityPayload,
        pnlPayload,
        seriesPayload
      ] = await Promise.all([
        apiRequest<{ status: typeof status }>({ url: '/api/kraken/status' }),
        apiRequest<{ summary: typeof summary }>({ url: '/api/kraken/summary' }),
        apiRequest<{ holdings: Holding[] }>({ url: '/api/kraken/holdings' }),
        apiRequest<{ data: EarnOverview }>({
          url: `/api/kraken/earn/series?from=${earnWindow.from}&to=${earnWindow.to}&granularitySeconds=${chartGranularity(earnChartState)}&quoteCurrencies=${quoteCurrencies}`
        }),
        apiRequest<{ activity: typeof activity }>({ url: '/api/kraken/activity?limit=500' }),
        apiRequest<{ pnl: Record<string, unknown> }>({ url: `/api/kraken/pnl?method=${costBasisMethod}` }),
        apiRequest<{ data: {
          series: ChartSeries[];
          events: ChartEvent[];
          denominationOptions: ChartDenominationOption[];
          granularitySeconds: number;
          mixedGranularity: boolean;
        } }>({
          url: `/api/kraken/series?from=${mainWindow.from}&to=${mainWindow.to}&granularitySeconds=${krakenChartState.granularity}&quoteCurrencies=${quoteCurrencies}`
        })
      ]);
      status = statusPayload.status;
      summary = summaryPayload.summary;
      holdings = holdingsPayload.holdings;
      earnOverview = earnPayload.data;
      const activeDenominationOptions = chartDenominationOptionsFromAssets(watchlistPayload.assets);
      earnOverview.denominationOptions = [
        ...new Map([
          ...earnOverview.denominationOptions,
          ...activeDenominationOptions
        ].map((option) => [option.id, option])).values()
      ];
      earnOverviewSeries = earnOverview.series;
      earnApyOverviewSeries = earnOverview.apySeries;
      earnAllocations = earnOverview.allocations;
      activity = activityPayload.activity;
      pnl = pnlPayload.pnl;
      krakenOverviewSeries = seriesPayload.data.series;
      series = krakenOverviewSeries;
      krakenResolvedGranularity = seriesPayload.data.granularitySeconds;
      events = seriesPayload.data.events;
      denominationOptions = [
        ...new Map([
          ...seriesPayload.data.denominationOptions,
          ...activeDenominationOptions
        ].map((option) => [option.id, option])).values()
      ];
      const configuredSeries = graphDefaults.krakenVisibleSeries;
      const knownSeries = new Set(series.map((item) => item.id));
      const defaultSeries = knownSeries.has('kraken-total')
        ? ['kraken-total']
        : series.filter((item) => seriesHasValues(item) && seriesIsEnabled(item)).slice(0, 1).map((item) => item.id);
      visibleKrakenSeries = new Set(
        Array.isArray(configuredSeries)
          ? configuredSeries.map(String).filter((id) => knownSeries.has(id))
          : defaultSeries
      );
      const configuredEarnSeries = graphDefaults.krakenEarnVisibleSeries;
      const knownEarnSeries = new Set(earnOverview.series.map((item) => item.id));
      visibleEarnSeries = new Set(
        Array.isArray(configuredEarnSeries)
          ? configuredEarnSeries.map(String).filter((id) => knownEarnSeries.has(id))
          : earnOverview.series.filter(seriesHasValues).map((item) => item.id)
      );
      pageOrder = normalizeOrder({ saved: pageLayouts.kraken, defaults: defaultPageOrder });
      balanceColumns = buildBalanceColumns();
      selectedBalanceColumns = tableColumns.krakenBalances?.filter((id) =>
        balanceColumns.some((column) => column.id === id)) ?? balanceColumns.map((column) => column.id);
      earnColumnOptions = buildEarnColumnOptions();
      const savedEarnColumns = tableColumns.krakenEarnAssets?.flatMap((id) => (
        id === 'currentValue'
          ? activeCurrencies().map((currency) => `currentValue:${currency}`)
          : [id]
      ));
      selectedEarnColumns = savedEarnColumns?.filter((id) =>
        earnColumnOptions.some((column) => column.id === id))
        ?? earnColumnOptions.map((column) => column.id);
      krakenRowOrder = normalizeOrder({
        saved: tableRows.krakenBalances,
        defaults: spotHoldings().map(holdingRowId)
      });
      const assetIds = holdings.map((holding) => holding.assetId).filter((id): id is string => Boolean(id));
      if (assetIds.length > 0) {
        const metricsPayload = await apiRequest<{
          metrics: {
            assets: Array<{
              canonicalAssetId: string;
              prices: Record<string, string | null>;
              changes: Record<string, string | null>;
            }>;
          };
        }>({
          url: `/api/market/metrics?assetIds=${encodeURIComponent(assetIds.join(','))}&quoteCurrencies=${encodeURIComponent(activeCurrencies().join(','))}`
        });
        metrics = Object.fromEntries(metricsPayload.metrics.assets.map((asset) => [asset.canonicalAssetId, asset]));
      } else {
        metrics = {};
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Kraken failed to load.';
    } finally {
      loading = false;
    }
  };

  const moveBlock = async (event: CustomEvent<{ id: string; direction: 'up' | 'down' }>) => {
    const moved = moveInOrder({
      order: visiblePageOrderItems,
      id: event.detail.id,
      direction: event.detail.direction
    });
    let visibleIndex = 0;
    pageOrder = pageOrder.map((id) => (
      blockVisible(id) ? moved[visibleIndex++]! : id
    ));
    pageLayouts = { ...pageLayouts, kraken: pageOrder };
    await savePreferences({ pageLayouts });
  };

  const moveKrakenRow = async ({ id, direction }: { id: string; direction: 'up' | 'down' }) => {
    krakenRowOrder = moveInOrder({ order: krakenRowOrder, id, direction });
    tableRows = { ...tableRows, krakenBalances: krakenRowOrder };
    await savePreferences({ tableRows });
  };

  const toggleBlockCollapse = async (event: CustomEvent<{ id: string }>) => {
    collapsedBlocks = {
      ...collapsedBlocks,
      kraken: toggleCollapsed({ collapsed: collapsedBlocks.kraken ?? [], id: event.detail.id })
    };
    await savePreferences({ collapsedBlocks });
  };

  const updateBalanceColumns = async (event: CustomEvent<{ selected: string[] }>) => {
    selectedBalanceColumns = event.detail.selected;
    tableColumns = { ...tableColumns, krakenBalances: selectedBalanceColumns };
    await savePreferences({ tableColumns });
  };

  const updateEarnColumns = async (event: CustomEvent<{ selected: string[] }>) => {
    selectedEarnColumns = event.detail.selected;
    tableColumns = { ...tableColumns, krakenEarnAssets: selectedEarnColumns };
    await savePreferences({ tableColumns });
  };

  const saveTable = async () => {
    const name = tableDashboardName.trim() || 'Kraken balances';
    if (savedGraphNameExists({ savedGraphs, name })) {
      error = `A dashboard item named “${name}” already exists. Choose a unique name.`;
      message = '';
      return;
    }
    error = '';
    const table = createSavedGraph({
      name,
      type: 'kraken',
      config: {
        dashboardView: 'table',
        tableId: 'krakenBalances',
        columns: selectedBalanceColumns,
        currency: summary.currency,
        timezone
      }
    });
    savedGraphs = [...savedGraphs, table];
    await savePreferences({ savedGraphs });
    message = `Saved table “${table.name}” to the dashboard.`;
  };

  const saveEarnTable = async () => {
    const name = earnTableDashboardName.trim() || 'Kraken Earn assets';
    if (savedGraphNameExists({ savedGraphs, name })) {
      error = `A dashboard item named “${name}” already exists. Choose a unique name.`;
      message = '';
      return;
    }
    error = '';
    const table = createSavedGraph({
      name,
      type: 'kraken',
      config: {
        dashboardView: 'table',
        tableId: 'krakenEarnAssets',
        columns: selectedEarnColumns,
        currency: earnOverview.summary.currency,
        timezone
      }
    });
    savedGraphs = [...savedGraphs, table];
    await savePreferences({ savedGraphs });
    message = `Saved table “${table.name}” to the dashboard.`;
  };

  const dismissNotice = async (event: CustomEvent<{ id: string }>) => {
    dismissedNotices = [...new Set([...dismissedNotices, event.detail.id])];
    await savePreferences({ dismissedNotices });
  };

  const toggleKrakenSeries = async (id: string) => {
    const item = selectableKrakenSeries.find((candidate) => candidate.id === id);
    if (!item || seriesIsDisabled(item)) return;
    const next = new Set(visibleKrakenSeries);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    visibleKrakenSeries = next;
    graphDefaults = {
      ...graphDefaults,
      krakenVisibleSeries: [...visibleKrakenSeries]
    };
    await savePreferences({ graphDefaults });
  };

  const toggleEarnSeries = async (id: string) => {
    const item = earnOverview.series.find((candidate) => candidate.id === id);
    if (!item || !seriesHasValues(item)) return;
    const next = new Set(visibleEarnSeries);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    visibleEarnSeries = next;
    graphDefaults = {
      ...graphDefaults,
      krakenEarnVisibleSeries: [...visibleEarnSeries]
    };
    await savePreferences({ graphDefaults });
  };

  const downloadText = ({
    filename,
    mimeType,
    content
  }: {
    filename: string;
    mimeType: string;
    content: string;
  }) => {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  };
  const csvCell = (value: unknown) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const exportEarnActivity = (format: 'json' | 'csv') => {
    const rows = filteredEarnActivityRows;
    if (format === 'json') {
      downloadText({
        filename: 'kraken-earn-activity.json',
        mimeType: 'application/json;charset=utf-8',
        content: JSON.stringify({
          exportedAt: new Date().toISOString(),
          range: chartWindow(earnChartState),
          filters: {
            query: earnActivityQuery,
            category: earnActivityCategory
          },
          events: rows
        }, null, 2)
      });
      return;
    }
    const csv = [
      ['date', 'type', 'asset', 'quantity', 'source', 'details'],
      ...rows.map((event) => [
        new Date(event.timestampMs).toISOString(),
        event.category,
        event.asset ?? '',
        event.quantity ?? '',
        event.source ?? '',
        JSON.stringify(event.details ?? {})
      ])
    ].map((row) => row.map(csvCell).join(',')).join('\r\n');
    downloadText({
      filename: 'kraken-earn-activity.csv',
      mimeType: 'text/csv;charset=utf-8',
      content: csv
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
  }>) => {
    if (savedGraphNameExists({ savedGraphs, name: event.detail.name })) {
      error = `A dashboard item named “${event.detail.name.trim()}” already exists. Choose a unique name.`;
      message = '';
      return;
    }
    error = '';
    const graph = createSavedGraph({
      name: event.detail.name,
      type: 'kraken',
      config: {
        currency: summary.currency,
        tooltipCurrencies: activeCurrencies(),
        timezone,
        seriesIds: [...visibleKrakenSeries],
        ...event.detail
      }
    });
    savedGraphs = [...savedGraphs, graph];
    await savePreferences({ savedGraphs });
    message = `Saved “${graph.name}” to the dashboard.`;
  };

  const refresh = async () => {
    try {
      await apiRequest({
        url: '/api/kraken/refresh',
        method: 'POST',
        body: {}
      });
      await load();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Kraken refresh could not be queued.';
    }
  };

  const graphStateChanged = async ({
    target,
    event
  }: {
    target: 'portfolio' | 'earn';
    event: CustomEvent<ChartQueryState & { chartMode: 'line' | 'candlestick' }>;
  }) => {
    const next: ChartQueryState = {
      range: event.detail.range,
      granularity: event.detail.granularity,
      customFromMs: event.detail.customFromMs,
      customToMs: event.detail.customToMs,
      customRangeMode: event.detail.customRangeMode,
      customAgoValue: event.detail.customAgoValue,
      customAgoUnit: event.detail.customAgoUnit
    };
    if (target === 'portfolio') krakenChartState = next;
    else earnChartState = next;
    graphDefaults = {
      ...graphDefaults,
      [target === 'portfolio' ? 'krakenChartState' : 'krakenEarnChartState']: next
    };
    await savePreferences({ graphDefaults });
    await load();
  };

  const graphViewChanged = async ({
    target,
    event
  }: {
    target: 'portfolio' | 'earn' | 'earnApy';
    event: CustomEvent<ChartDisplayState>;
  }) => {
    const next = { ...event.detail };
    if (target === 'portfolio') krakenDisplayState = next;
    else if (target === 'earn') earnDisplayState = next;
    else earnApyDisplayState = next;
    graphDefaults = {
      ...graphDefaults,
      [target === 'portfolio'
        ? 'krakenDisplayState'
        : target === 'earn'
          ? 'krakenEarnDisplayState'
          : 'krakenEarnApyDisplayState']: next
    };
    await savePreferences({ graphDefaults });
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
      const points = new Map(item.points
        .filter((point) => point.timestampMs < fromMs || point.timestampMs > toMs)
        .map((point) => [point.timestampMs, point]));
      for (const point of detailById.get(item.id)?.points ?? []) {
        points.set(point.timestampMs, point);
      }
      return {
        ...item,
        points: [...points.values()].sort((left, right) => (
          left.timestampMs - right.timestampMs
        ))
      };
    });
  };

  const krakenGraphZoomed = async (
    event: CustomEvent<{ fromMs: number; toMs: number }>
  ) => {
    const requestedGranularity = Number(krakenChartState.granularity);
    if (
      krakenChartState.granularity === 'auto'
      || !Number.isFinite(requestedGranularity)
      || krakenResolvedGranularity <= requestedGranularity
    ) return;
    const requestId = ++krakenZoomRequestId;
    loading = true;
    try {
      const quoteCurrencies = encodeURIComponent(activeCurrencies().join(','));
      const payload = await apiRequest<{
        data: {
          series: ChartSeries[];
        };
      }>({
        url: `/api/kraken/series?from=${event.detail.fromMs}&to=${event.detail.toMs}&granularitySeconds=${krakenChartState.granularity}&quoteCurrencies=${quoteCurrencies}`
      });
      if (requestId !== krakenZoomRequestId) return;
      series = mergeDetailedWindow({
        overview: krakenOverviewSeries,
        detail: payload.data.series,
        fromMs: event.detail.fromMs,
        toMs: event.detail.toMs
      });
    } catch (caught) {
      if (requestId !== krakenZoomRequestId) return;
      error = caught instanceof Error ? caught.message : 'Kraken zoom detail failed.';
    } finally {
      if (requestId === krakenZoomRequestId) loading = false;
    }
  };

  const earnGraphZoomed = async (
    event: CustomEvent<{ fromMs: number; toMs: number }>
  ) => {
    const requestedGranularity = Number(earnChartState.granularity);
    if (
      earnChartState.granularity === 'auto'
      || !Number.isFinite(requestedGranularity)
      || earnOverview.granularitySeconds <= requestedGranularity
    ) return;
    const requestId = ++earnZoomRequestId;
    loading = true;
    try {
      const quoteCurrencies = encodeURIComponent(activeCurrencies().join(','));
      const payload = await apiRequest<{ data: EarnOverview }>({
        url: `/api/kraken/earn/series?from=${event.detail.fromMs}&to=${event.detail.toMs}&granularitySeconds=${requestedGranularity}&quoteCurrencies=${quoteCurrencies}`
      });
      if (requestId !== earnZoomRequestId) return;
      earnOverview = {
        ...earnOverview,
        series: mergeDetailedWindow({
          overview: earnOverviewSeries,
          detail: payload.data.series,
          fromMs: event.detail.fromMs,
          toMs: event.detail.toMs
        }),
        apySeries: mergeDetailedWindow({
          overview: earnApyOverviewSeries,
          detail: payload.data.apySeries,
          fromMs: event.detail.fromMs,
          toMs: event.detail.toMs
        })
      };
    } catch (caught) {
      if (requestId !== earnZoomRequestId) return;
      error = caught instanceof Error ? caught.message : 'Kraken Earn zoom detail failed.';
    } finally {
      if (requestId === earnZoomRequestId) loading = false;
    }
  };

  onMount(() => {
    void load();
  });
</script>

<main class="page">
  <header class="row">
    <div>
      <p class="eyebrow">Kraken Spot API · query-only endpoints</p>
      <h1>{strings['cryptotracker-kraken-title']}</h1>
      <p class="muted">Spot, Earn/staking, and margin data appear only when used. Kraken Futures is deliberately absent.</p>
    </div>
    <button
      type="button"
      disabled={!status.configured || loading || status.readOnly === false || missingPermissions().length > 0}
      on:click={refresh}
    >
      Manual refresh
    </button>
  </header>

  {#if error}<div class="alert danger" role="alert">{error}</div>{/if}
  {#if message}<div class="alert mid" role="status">{message}</div>{/if}
  {#if status.readOnly === false || missingPermissions().length > 0}
    <div class="alert {status.readOnly === false ? 'danger' : 'warning'}" role="alert">
      <strong>
        {status.readOnly === false
          ? 'The supplied Kraken key reports unsafe permissions. Integration activation is refused.'
          : 'The supplied Kraken key is missing required query permissions.'}
      </strong>
      <p class="permission-summary">
        CryptoTracker accepts a dedicated query-only key with four permissions.
        It never needs permission to trade, transfer, withdraw, export, or change Earn allocations.
      </p>
      <details
        class="permission-help"
        use:persistAccordionState={{ key: 'kraken:permission-help' }}
      >
        <summary>How to fix Kraken API permissions</summary>
        <div class="details-body permission-help-body">
          <ol class="permission-steps">
            <li>Open Kraken Pro, select your profile icon, then go to <strong>Settings → API</strong>.</li>
            <li>Edit this API key, or create a dedicated key named <strong>CryptoTracker</strong>.</li>
            <li>Enable every permission in the “Allow” list below and disable every other permission.</li>
            <li>Save the key, then restart CryptoTracker so it can inspect the permissions again.</li>
          </ol>

          <div class="permission-grid">
            <section class="permission-group">
              <h3>Allow exactly these</h3>
              <ul class="permission-list">
                {#each requiredPermissions() as permission}
                  {@const detail = permissionDetail({ permission })}
                  <li>
                    <span>
                      <strong>{detail.label}</strong>
                      <small>{detail.purpose}</small>
                    </span>
                    {#if missingPermissions().includes(permission)}
                      <span class="badge warning">missing</span>
                    {:else}
                      <span class="badge mid">allowed</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            </section>

            <section class="permission-group">
              <h3>Revoke from this key</h3>
              {#if unsafePermissions().length > 0}
                <ul class="permission-list">
                  {#each unsafePermissions() as permission}
                    {@const detail = permissionDetail({ permission })}
                    <li>
                      <span>
                        <strong>{detail.label}</strong>
                        <small>{detail.purpose}</small>
                      </span>
                      <span class="badge danger">revoke</span>
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="muted">No extra permission was reported. Enable the missing query permissions shown on the left.</p>
              {/if}
            </section>
          </div>

          <p class="permission-reference">
            <a href="https://support.kraken.com/articles/how-to-create-an-api-key-on-kraken-pro" target="_blank" rel="noreferrer">
              Open Kraken’s API-key instructions
            </a>
          </p>
        </div>
      </details>
    </div>
  {:else if status.configured && status.permissionInspection.available === false}
    <div class="alert warning">Kraken did not expose key permission inspection. Only immutable query endpoints exist in this application.</div>
  {/if}
  {#each visiblePageOrderItems as blockId, index (blockId)}
    <ReorderableBlock
      {blockId}
      label={blockId.replace('-', ' ')}
      {index}
      total={visiblePageOrderItems.length}
      collapsed={collapsedBlocks.kraken?.includes(blockId) ?? false}
      on:move={moveBlock}
      on:toggle={toggleBlockCollapse}
    >
  {#if blockId === 'summary'}
    <DismissableNotice
      noticeId="kraken-cost-basis-estimate"
      dismissed={dismissedNotices.includes('kraken-cost-basis-estimate')}
      on:dismiss={dismissNotice}
    >{strings['cryptotracker-cost_basis-label']}</DismissableNotice>

    <section class="card-grid">
      <article class="card">
        <span class="label">Current known value</span>
        <CurrencyValue
          values={summary.values}
          currency={summary.currency}
          {locale}
          label="Current known value"
        />
        <span class="badge {Number(summary.pricedValueCoveragePercent) < 100 ? 'warning' : 'mid'}">
          {summary.pricedAssetCount} of {summary.totalAssetCount} non-zero asset balances priced ({formatPercent(summary.pricedValueCoveragePercent)}%)
        </span>
        {#if Number(summary.pricedValueCoveragePercent) < 100}
          <small class="coverage-explanation">
            Unpriced balances are excluded from this subtotal.
            <a href="/markets#asset-catalog">Enable supported assets in Markets</a>.
          </small>
        {/if}
      </article>
      <article class="card">
        <span class="label">Earn / staking</span>
        <CurrencyValue
          values={earnOverview.summary.values}
          currency={earnOverview.summary.currency}
          {locale}
          label="Currently staked value"
        />
        <span class="muted">currently staked</span>
        <CurrencyValue
          values={earnOverview.summary.rewardValues}
          currency={earnOverview.summary.currency}
          {locale}
          label="Lifetime Earn rewards"
        />
        <span class="muted">earned to date</span>
      </article>
      <article class="card connection-card">
        <span class="label">Connection</span>
        <strong class="stat">{status.connected ? 'Connected' : status.configured ? 'Waiting' : 'Not configured'}</strong>
        <span class="badge {status.connected ? 'mid' : 'warning'}">last successful check: {lastConnectionCheck()}</span>
        <span class="label">Latest snapshot</span>
        <strong class="stat compact-stat">{summary.latestSuccessfulSync ? formatDateTime({ value: summary.latestSuccessfulSync, timezone }) : 'none'}</strong>
      </article>
    </section>

  {:else if blockId === 'balances'}
    <section class="panel">
      <p class="eyebrow">Spot</p>
      <h2>Balances</h2>
      <ColumnConfigurator
        label="Configure balance columns"
        columns={balanceColumns}
        selected={selectedBalanceColumns}
        defaults={balanceColumns.map((column) => column.id)}
        on:change={updateBalanceColumns}
      />
      <div class="toolbar save-table">
        <div class="field grow">
          <label for="kraken-table-dashboard-name">Dashboard table name</label>
          <input id="kraken-table-dashboard-name" maxlength="120" bind:value={tableDashboardName} />
        </div>
        <button class="secondary" type="button" on:click={saveTable}>Save table to dashboard</button>
      </div>
      {#if disabledPriceAssets().length > 0}
        <div class="alert start">
          Market-derived fields are unavailable for {disabledPriceAssets().join(', ')} while those assets are disabled.
          <a href="/markets#asset-catalog">Enable assets in Markets</a>.
        </div>
      {/if}
      <div class="table-wrap sticky-table">
        <table>
          <thead><tr>
            <th>Row order</th>
            {#each selectedBalanceColumns as columnId}
              <th>{balanceColumnLabel(columnId)}</th>
            {/each}
          </tr></thead>
          <tbody>
            {#each orderedSpotHoldings as holding, rowIndex (holdingRowId(holding))}
              <tr>
                <td>
                  <div class="row-order-actions" aria-label={`Reorder ${holding.assetId ?? holding.assetRaw}`}>
                    <button class="ghost compact" type="button" aria-label={`Move ${holding.assetId ?? holding.assetRaw} up`} disabled={rowIndex === 0} on:click={() => moveKrakenRow({ id: holdingRowId(holding), direction: 'up' })}>↑</button>
                    <button class="ghost compact" type="button" aria-label={`Move ${holding.assetId ?? holding.assetRaw} down`} disabled={rowIndex === orderedSpotHoldings.length - 1} on:click={() => moveKrakenRow({ id: holdingRowId(holding), direction: 'down' })}>↓</button>
                  </div>
                </td>
                {#each selectedBalanceColumns as columnId}
                  <td>
                    {#if columnId === 'pricing'}
                      <span class="badge {holding.priced ? 'mid' : 'warning'}">{holding.priced ? 'priced' : 'unpriced'}</span>
                      {#if holding.pricingReason}
                        <button class="info-tip" type="button" aria-label={holding.pricingReason}>
                          ⓘ<span class="info-popup" role="tooltip">{holding.pricingReason}</span>
                        </button>
                      {/if}
                    {:else}
                      {@const value = balanceCellValue({ holding, columnId })}
                      {#if value === null}
                        <span class="unavailable" title={unavailableReason({ holding, columnId })}>unavailable</span>
                      {:else}
                        {value}
                      {/if}
                    {/if}
                  </td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

  {:else if blockId === 'earn'}
    <section class="panel">
      <p class="eyebrow">Earn / staking</p>
      <h2>Staked value, rewards, and activity</h2>
      <p class="muted">
        {earnOverview.summary.pricedAssetCount} of {earnOverview.summary.assetCount} staked assets priced ·
        {earnOverview.summary.allocationCount} active allocation records
      </p>
      <p class="muted">{earnOverview.coverage.message}</p>

      <div class="earn-chart-heading">
        <div>
          <h3>Earn portfolio history</h3>
        </div>
        <div class="kraken-series-toggles" aria-label="Visible Kraken Earn series">
          {#each earnOverview.series as item (item.id)}
            <LargeToggleButton
              label={item.label}
              detail={seriesHasValues(item) ? `${pricedPointCount(item)} priced snapshots` : 'No priced snapshots'}
              pressed={visibleEarnSeries.has(item.id) && seriesHasValues(item)}
              unavailable={!seriesHasValues(item)}
              disabled={!seriesHasValues(item)}
              ariaLabel={seriesHasValues(item)
                ? `Toggle ${item.label} on the Earn chart`
                : `${item.label} has no priced Earn history`}
              on:click={() => toggleEarnSeries(item.id)}
            />
          {/each}
        </div>
      </div>

      {#if chartPreferencesReady}
      <PortfolioChart
        title="Kraken Earn history"
        series={displayedEarnSeries}
        chartMode="line"
        currency={earnOverview.summary.currency}
        tooltipCurrencies={activeCurrencies()}
        denominationOptions={earnOverview.denominationOptions}
        source="kraken earn"
        {timezone}
        granularity={earnOverview.granularitySeconds}
        selectedGranularitySetting={earnChartState.granularity}
        partial={earnOverview.partial}
        partialMessage={`${earnOverview.coverage.message} One or more balances or valuations in this range is unavailable.`}
        emptyMessage="No priced Earn history is cached for the selected assets yet. Use Manual refresh, then follow the Kraken job in Settings → Synchronization."
        events={earnOverview.events}
        busy={loading}
        initialRange={earnChartState.range}
        initialCustomFromMs={earnChartState.customFromMs}
        initialCustomToMs={earnChartState.customToMs}
        initialCustomRangeMode={earnChartState.customRangeMode}
        initialCustomAgoValue={earnChartState.customAgoValue}
        initialCustomAgoUnit={earnChartState.customAgoUnit}
        initialScale={earnDisplayState.scale}
        initialYAxisUnit={earnDisplayState.yAxisUnit}
        initialTooltipUnits={earnDisplayState.tooltipUnits}
        initialNormalized={earnDisplayState.normalized}
        initialShowEvents={earnDisplayState.showEvents}
        initialShowVolume={earnDisplayState.showVolume}
        on:stateChange={(event) => void graphStateChanged({ target: 'earn', event })}
        on:viewChange={(event) => void graphViewChanged({ target: 'earn', event })}
        on:zoomRange={earnGraphZoomed}
      />
      {/if}

      <div class="earn-chart-heading">
        <div>
          <h3>Estimated APY history</h3>
          <p class="muted">{earnOverview.apyCoverage.message}</p>
        </div>
      </div>
      {#if chartPreferencesReady}
      <PortfolioChart
        title="Kraken Earn estimated APY"
        series={earnOverview.apySeries}
        chartMode="line"
        currency="%"
        tooltipCurrencies={[]}
        source="kraken strategy estimate"
        {timezone}
        granularity={earnOverview.granularitySeconds}
        selectedGranularitySetting={earnChartState.granularity}
        emptyMessage="No observed Kraken Earn rate estimates are available yet. Refresh Kraken to capture the current strategy rates."
        busy={loading}
        initialRange={earnChartState.range}
        initialCustomFromMs={earnChartState.customFromMs}
        initialCustomToMs={earnChartState.customToMs}
        initialCustomRangeMode={earnChartState.customRangeMode}
        initialCustomAgoValue={earnChartState.customAgoValue}
        initialCustomAgoUnit={earnChartState.customAgoUnit}
        initialScale={earnApyDisplayState.scale}
        initialYAxisUnit={earnApyDisplayState.yAxisUnit}
        initialTooltipUnits={earnApyDisplayState.tooltipUnits}
        initialNormalized={earnApyDisplayState.normalized}
        initialShowEvents={earnApyDisplayState.showEvents}
        initialShowVolume={earnApyDisplayState.showVolume}
        on:stateChange={(event) => void graphStateChanged({ target: 'earn', event })}
        on:viewChange={(event) => void graphViewChanged({ target: 'earnApy', event })}
        on:zoomRange={earnGraphZoomed}
      />
      {/if}

      <div class="earn-table-heading">
        <div>
          <h3>Staked assets and payout distribution</h3>
          <p class="muted">Current allocations and imported payouts share one asset row.</p>
        </div>
      </div>
      <ColumnConfigurator
        label="Configure Earn columns"
        columns={earnColumnOptions}
        selected={selectedEarnColumns}
        defaults={earnColumnOptions.map((column) => column.id)}
        on:change={updateEarnColumns}
      />
      <div class="toolbar save-table">
        <div class="field grow">
          <label for="kraken-earn-table-dashboard-name">Dashboard table name</label>
          <input id="kraken-earn-table-dashboard-name" maxlength="120" bind:value={earnTableDashboardName} />
        </div>
        <button class="secondary" type="button" on:click={saveEarnTable}>Save table to dashboard</button>
      </div>
      <div class="table-wrap earn-assets-table">
        <table>
          <thead>
            <tr>
              {#each selectedEarnColumns as columnId}
                <th>{earnColumnLabel(columnId)}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each earnOverview.assets as asset (asset.assetId)}
              <tr>
                {#each selectedEarnColumns as columnId}
                  <td>{earnCellValue({ asset, columnId })}</td>
                {/each}
              </tr>
            {:else}
              <tr>
                <td colspan={Math.max(1, selectedEarnColumns.length)} class="muted">
                  No current Kraken Earn allocations were imported.
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <details
        class="earn-activity"
        use:persistAccordionState={{ key: 'kraken:earn-activity' }}
      >
        <summary>Earn payouts, stakes, purchases, and sales ({earnOverview.activity.length})</summary>
        <div class="details-body">
          <div class="toolbar earn-activity-controls">
            <div class="field grow">
              <label for="earn-activity-filter">Filter activity</label>
              <input
                id="earn-activity-filter"
                type="search"
                bind:value={earnActivityQuery}
                on:input={() => (earnActivityPage = 1)}
                placeholder="Asset, type, quantity, or details"
              />
            </div>
            <div class="field">
              <label for="earn-activity-category">Type</label>
              <select
                id="earn-activity-category"
                bind:value={earnActivityCategory}
                on:change={() => (earnActivityPage = 1)}
              >
                <option value="all">All types</option>
                {#each earnActivityCategories as category}
                  <option value={category}>{category}</option>
                {/each}
              </select>
            </div>
            <button class="secondary compact" type="button" on:click={() => exportEarnActivity('csv')}>Export CSV</button>
            <button class="secondary compact" type="button" on:click={() => exportEarnActivity('json')}>Export JSON</button>
          </div>
          <div class="table-wrap earn-activity-table-wrap">
          <table class="earn-activity-table">
            <colgroup>
              <col class="activity-date" />
              <col class="activity-type" />
              <col class="activity-asset" />
              <col class="activity-quantity" />
              <col class="activity-details-column" />
            </colgroup>
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Asset</th>
                <th>Quantity</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {#each visibleEarnActivityRows as event, eventIndex (`${event.id}:${event.timestampMs}:${eventIndex}`)}
                <tr>
                  <td>{formatDateTime({ value: event.timestampMs, timezone })}</td>
                  <td><span class="badge start">{event.category}</span></td>
                  <td>{event.asset ?? 'unavailable'}</td>
                  <td>{event.quantity === undefined ? 'unavailable' : formatDisplayNumber({ value: event.quantity, locale })}</td>
                  <td>
                    <details
                      class="activity-details"
                      use:persistAccordionState={{ key: `kraken:activity:${event.id}` }}
                    >
                      <summary>View details</summary>
                      <pre>{JSON.stringify(event.details ?? {}, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              {:else}
                <tr><td colspan="5" class="muted">No Earn activity matches these filters.</td></tr>
              {/each}
            </tbody>
          </table>
          </div>
          <div class="table-pagination">
            <span class="muted">{filteredEarnActivityRows.length} matching events</span>
            <button
              class="ghost compact"
              type="button"
              disabled={earnActivityPage <= 1}
              on:click={() => (earnActivityPage -= 1)}
            >Previous</button>
            <span>{Math.min(earnActivityPage, earnActivityPageTotal)}/{earnActivityPageTotal}</span>
            <button
              class="ghost compact"
              type="button"
              disabled={earnActivityPage >= earnActivityPageTotal}
              on:click={() => (earnActivityPage += 1)}
            >Next</button>
          </div>
        </div>
      </details>

      <details use:persistAccordionState={{ key: 'kraken:earn-raw-allocations' }}>
        <summary>Raw Kraken Earn allocations ({earnAllocations.length})</summary>
        <div class="details-body"><pre>{JSON.stringify(earnAllocations, null, 2)}</pre></div>
      </details>
    </section>

  {:else if blockId === 'margin'}
    <section class="panel">
      <p class="eyebrow">Margin</p>
      <h2>Provider-reported positions</h2>
      <p>Margin values prefer provider-reported realised and unrealised fields where available.</p>
    </section>

  {:else if blockId === 'chart'}
  <section class="panel kraken-series-panel">
    <div>
      <p class="eyebrow">Visible chart series</p>
      <h2>Total and asset values</h2>
      <p class="muted">Turn the portfolio total or any individual Kraken asset on and off.</p>
    </div>
    <div class="kraken-series-toggles" aria-label="Visible Kraken chart series">
      {#each selectableKrakenSeries as item (item.id)}
        <LargeToggleButton
          label={item.label}
          detail={seriesStateDetail(item)}
          pressed={visibleKrakenSeries.has(item.id) && !seriesIsDisabled(item)}
          unavailable={seriesIsDisabled(item)}
          disabled={seriesIsDisabled(item)}
          title={!seriesHasValues(item)
            ? `${item.label} is currently unpriced`
            : !seriesIsEnabled(item)
              ? `${item.label} must be enabled in Markets before it can be added to this chart`
              : item.label}
          ariaLabel={seriesIsDisabled(item)
            ? `${item.label} is disabled and cannot be added to the Kraken chart`
            : `Toggle ${item.label} on the Kraken chart`}
          on:click={() => toggleKrakenSeries(item.id)}
        />
      {/each}
    </div>
  </section>
  {#if chartPreferencesReady}
  <PortfolioChart
    title="Kraken portfolio history"
    series={displayedKrakenSeries}
    chartMode="line"
    currency={summary.currency}
    tooltipCurrencies={activeCurrencies()}
    {denominationOptions}
    source="kraken"
    {timezone}
    granularity={krakenResolvedGranularity}
    selectedGranularitySetting={krakenChartState.granularity}
    partial={unpricedHoldings().length > 0}
    partialMessage={krakenPartialMessage()}
    emptyMessage={krakenChartEmptyMessage}
    stale={summary.stale}
    {events}
    busy={loading}
    tooltipEnabledAssetIds={[...enabledMarketAssets]}
    showAllTooltipAssetsControl
    initialRange={krakenChartState.range}
    initialCustomFromMs={krakenChartState.customFromMs}
    initialCustomToMs={krakenChartState.customToMs}
    initialCustomRangeMode={krakenChartState.customRangeMode}
    initialCustomAgoValue={krakenChartState.customAgoValue}
    initialCustomAgoUnit={krakenChartState.customAgoUnit}
    initialScale={krakenDisplayState.scale}
    initialYAxisUnit={krakenDisplayState.yAxisUnit}
    initialTooltipUnits={krakenDisplayState.tooltipUnits}
    initialNormalized={krakenDisplayState.normalized}
    initialShowEvents={krakenDisplayState.showEvents}
    initialShowVolume={krakenDisplayState.showVolume}
    saveable
    on:stateChange={(event) => void graphStateChanged({ target: 'portfolio', event })}
    on:viewChange={(event) => void graphViewChanged({ target: 'portfolio', event })}
    on:zoomRange={krakenGraphZoomed}
    on:saveGraph={saveGraph}
  />
  {/if}

  {:else if blockId === 'performance'}
  <PerformanceAnalytics
    title="Kraken portfolio performance"
    series={displayedKrakenSeries}
    {timezone}
    returnMethod="value"
  />

  {:else if blockId === 'cost-basis'}
  <section class="panel">
    <div class="toolbar">
      <div>
        <p class="eyebrow">Gain / loss estimate</p>
        <h2>Cost basis and coverage</h2>
      </div>
      <div class="field">
        <label for="cost-basis">Method</label>
        <select id="cost-basis" bind:value={costBasisMethod} on:change={load}>
          <option value="acb">Average cost basis</option>
          <option value="fifo">FIFO</option>
          <option value="lifo">LIFO</option>
        </select>
      </div>
    </div>
    <div class="card-grid">
      <article class="card">
        <span class="label">Realised estimate ({String(pnl.currency ?? summary.currency)})</span>
        <strong class="stat">{pnl.realisedPnl === null || pnl.realisedPnl === undefined ? 'unavailable' : formatMoney({ value: pnl.realisedPnl, currency: String(pnl.currency ?? summary.currency) })}</strong>
      </article>
      <article class="card">
        <span class="label">Basis coverage</span>
        <strong class="stat">{formatPercent(pnl.basisCoveragePercent ?? 0)}%</strong>
        {#if pnl.incompleteBasis}<span class="badge warning">unknown basis present</span>{/if}
      </article>
    </div>
    <details use:persistAccordionState={{ key: 'kraken:cost-basis-lots' }}>
      <summary>Calculation details</summary>
      <div class="details-body"><pre>{JSON.stringify(pnl, null, 2)}</pre></div>
    </details>
  </section>

  {:else if blockId === 'activity'}
  <section class="panel">
    <p class="eyebrow">Activity</p>
    <h2>Imported trades and ledger entries</h2>
    <details use:persistAccordionState={{ key: 'kraken:cost-basis-dispositions' }}>
      <summary>Trades ({activity.trades.length})</summary>
      <div class="details-body"><pre>{JSON.stringify(activity.trades, null, 2)}</pre></div>
    </details>
    <details use:persistAccordionState={{ key: 'kraken:cost-basis-raw' }}>
      <summary>Ledgers ({activity.ledgers.length})</summary>
      <div class="details-body"><pre>{JSON.stringify(activity.ledgers, null, 2)}</pre></div>
    </details>
  </section>
  {/if}
    </ReorderableBlock>
  {/each}
</main>

<style>
  header > div {
    flex: 1 1 20rem;
  }

  .compact-stat {
    font-size: 1rem;
  }

  .connection-card .label:not(:first-child) {
    margin-top: 0.9rem;
  }

  .permission-summary {
    margin: 0.45rem 0 0;
  }

  .permission-help {
    margin-top: 0.75rem;
    background: var(--color-panel);
  }

  .permission-help-body {
    display: grid;
    gap: 1rem;
  }

  .permission-steps,
  .permission-list {
    margin: 0;
    padding-left: 1.25rem;
  }

  .permission-list {
    padding-left: 0;
    list-style: none;
  }

  .permission-steps li + li {
    margin-top: 0.45rem;
  }

  .permission-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr));
    gap: 0.85rem;
  }

  .permission-group {
    min-width: 0;
    padding: 0.9rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-panel-strong);
  }

  .permission-group h3 {
    margin-bottom: 0.65rem;
    font-size: 0.9rem;
  }

  .permission-list li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.6rem;
  }

  .permission-list li + li {
    margin-top: 0.7rem;
  }

  .permission-list li > span:first-child {
    display: grid;
    min-width: 0;
  }

  .permission-list small {
    color: var(--color-muted);
  }

  .permission-list .badge {
    margin-top: 0.1rem;
  }

  .permission-reference {
    margin: 0;
  }

  pre {
    max-height: 24rem;
    overflow: auto;
    white-space: pre-wrap;
  }

  .card-grid + details {
    margin-top: 1rem;
  }

  details + details {
    margin-top: 0.7rem;
  }

  .info-tip {
    position: relative;
    display: inline-flex;
    margin-left: 0.4rem;
    color: var(--color-muted);
    cursor: help;
    width: auto;
    min-height: 0;
    padding: 0;
    border: 0;
  }

  .info-popup {
    position: absolute;
    z-index: 20;
    bottom: calc(100% + 0.4rem);
    left: 50%;
    display: none;
    width: min(22rem, 70vw);
    padding: 0.6rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    background: var(--color-panel-strong);
    color: var(--color-text);
    font-size: 0.78rem;
    line-height: 1.35;
    transform: translateX(-50%);
    white-space: normal;
  }

  .info-tip:hover .info-popup,
  .info-tip:focus .info-popup {
    display: block;
  }

  .sticky-table {
    max-height: min(70vh, 48rem);
    overflow: auto;
    scrollbar-gutter: stable both-edges;
  }

  .sticky-table th {
    position: sticky;
    z-index: 2;
    top: 0;
    background: var(--color-panel-strong);
  }

  .row-order-actions {
    display: flex;
    gap: 0.25rem;
    min-width: 4rem;
  }

  .row-order-actions button {
    width: 1.85rem;
    min-height: 1.85rem;
    padding: 0.1rem;
  }

  .unavailable {
    color: var(--color-muted);
    text-decoration: underline dotted;
    text-underline-offset: 0.2rem;
    cursor: help;
  }

  .coverage-explanation {
    display: block;
    color: var(--color-muted);
    line-height: 1.4;
  }

  .kraken-series-panel {
    margin-bottom: 0.8rem;
  }

  .earn-chart-heading {
    margin: 1.2rem 0 0.8rem;
  }

  .earn-chart-heading h3 {
    margin-bottom: 0.25rem;
  }

  .earn-activity {
    margin-top: 1rem;
  }

  .earn-table-heading {
    margin-top: 1.4rem;
  }

  .earn-table-heading h3 {
    margin-bottom: 0.25rem;
  }

  .earn-assets-table {
    margin-top: 0.8rem;
  }

  .earn-activity-controls {
    align-items: flex-end;
    margin-bottom: 0.8rem;
  }

  .table-pagination {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0.55rem;
    margin-top: 0.7rem;
  }

  .table-pagination .muted {
    margin-right: auto;
  }

  .earn-activity-table {
    min-width: 62rem;
    table-layout: fixed;
  }

  .earn-activity-table .activity-date {
    width: 12rem;
  }

  .earn-activity-table .activity-type {
    width: 8.5rem;
  }

  .earn-activity-table .activity-asset {
    width: 8rem;
  }

  .earn-activity-table .activity-quantity {
    width: 10rem;
  }

  .earn-activity-table th,
  .earn-activity-table td {
    vertical-align: middle;
  }

  .earn-activity-table td:first-child,
  .earn-activity-table td:nth-child(3),
  .earn-activity-table td:nth-child(4) {
    white-space: nowrap;
  }

  .activity-details {
    border: 0;
    background: transparent;
  }

  .activity-details summary {
    width: fit-content;
    padding: 0;
    color: var(--color-start);
    font-size: 0.8rem;
  }

  .activity-details[open] > summary {
    border: 0;
  }

  .activity-details pre {
    max-height: 18rem;
    margin: 0.65rem 0 0;
    padding: 0.65rem;
    overflow: auto;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-panel);
    white-space: pre-wrap;
  }

  .kraken-series-toggles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10.5rem, 14rem));
    justify-content: start;
    gap: 0.65rem;
    margin-top: 0.8rem;
  }
</style>
