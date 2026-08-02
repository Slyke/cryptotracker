<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import ReorderableBlock from '../../lib/components/ReorderableBlock.svelte';
  import SavedDashboardChart from '../../lib/components/SavedDashboardChart.svelte';
  import SavedDashboardTable from '../../lib/components/SavedDashboardTable.svelte';
  import DismissableNotice from '../../lib/components/DismissableNotice.svelte';
  import CurrencyValue from '../../lib/components/CurrencyValue.svelte';
  import { apiRequest, setDocumentPreferences } from '$lib/api';
  import { persistAccordionState } from '$lib/accordion-state';
  import { configuredCurrencies } from '$lib/currencies';
  import { dashboardMinimalMode } from '$lib/dashboard-display';
  import strings from '$lib/i18n/en-CA.json';
  import {
    dashboardNumberFromSearch,
    moveInOrder,
    normalizeDashboards,
    normalizeOrder,
    savePreferences,
    toggleCollapsed,
    type Dashboard,
    type DashboardRow,
    type SavedGraph
  } from '$lib/preferences';

  let loading = true;
  let error = '';
  let watchlist: Array<{
    id: string;
    canonicalId: string;
    symbol: string;
    name: string;
    enabled: boolean;
  }> = [];
  let holdings: Array<{
    currentValue: string | null;
    currentValues: Record<string, string | null>;
    pricedCoveragePercent: string;
    completeness: string;
    label: string;
    assetId: string;
    lastSuccessfulSync: string | null;
  }> = [];
  let kraken = {
    totalCurrentValue: '0',
    currency: 'CAD',
    values: { CAD: '0' } as Record<string, string | null>,
    pricedValueCoveragePercent: '0',
    latestSuccessfulSync: null as string | null,
    sections: {
      spot: false,
      earn: false,
      margin: false,
      futures: false
    }
  };
  let providers: Record<string, unknown> = {};
  let settings = {
    locale: 'en-CA',
    timezone: 'America/Vancouver',
    theme: 'dark',
    font: 'ui-mono',
    contentWidth: 'standard',
    primaryCurrency: 'CAD',
    tooltipCurrencies: ['CAD'],
    graphDefaults: {} as Record<string, unknown>,
    pageLayouts: {} as Record<string, string[]>,
    collapsedBlocks: {} as Record<string, string[]>,
    savedGraphs: [] as SavedGraph[],
    dashboards: [] as Dashboard[],
    dashboardRows: [] as DashboardRow[],
    dashboardGraphColumns: 2 as 1 | 2 | 3 | 4,
    dismissedNotices: [] as string[]
  };
  let jobs: Array<{ status: string }> = [];
  const defaultContentOrder = ['graphs', 'watchlist', 'kraken', 'diagnostics'];
  let pageOrder = [...defaultContentOrder];
  let dashboardPageDefaults = [...defaultContentOrder];
  let activeCollapsedBlocks: string[] = [];
  let activeDashboardId = '';
  let activeDashboard: Dashboard | null = null;
  let activeDashboardIndex = 0;
  let showDashboardOptions = false;
  let hideFluff = false;
  let minimalMode = false;
  let autoRefreshEnabled = false;
  let refreshIntervalSeconds = 60;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let cycleEnabled = false;
  let cycleIntervalSeconds = 60;
  let cycleTimer: ReturnType<typeof setTimeout> | null = null;
  let nextCycleAt = 0;
  let lastMouseMovementAt = 0;
  let addressValues = { CAD: '0' } as Record<string, string | null>;
  let krakenValues = { CAD: '0' } as Record<string, string | null>;
  let knownValues = { CAD: '0' } as Record<string, string | null>;
  let graphRangeEndMs = 0;

  const refreshIntervals = [
    { seconds: 30, label: 'Every 30 seconds' },
    { seconds: 60, label: 'Every minute' },
    { seconds: 120, label: 'Every 2 minutes' },
    { seconds: 300, label: 'Every 5 minutes' },
    { seconds: 600, label: 'Every 10 minutes' },
    { seconds: 1_800, label: 'Every 30 minutes' },
    { seconds: 3_600, label: 'Every hour' }
  ];

  const cycleIntervals = [
    { seconds: 10, label: 'Every 10 seconds' },
    { seconds: 30, label: 'Every 30 seconds' },
    { seconds: 60, label: 'Every minute' },
    { seconds: 120, label: 'Every 2 minutes' },
    { seconds: 300, label: 'Every 5 minutes' },
    { seconds: 600, label: 'Every 10 minutes' }
  ];

  $: activeDashboard = settings.dashboards.find((dashboard) => (
    dashboard.id === activeDashboardId
  )) ?? settings.dashboards[0] ?? null;
  $: activeDashboardIndex = Math.max(0, settings.dashboards.findIndex((dashboard) => (
    dashboard.id === activeDashboard?.id
  )));

  const dashboardLayoutKey = (dashboardId: string) => `dashboard:${dashboardId}`;

  const restoreDashboardLayout = (dashboardId: string) => {
    const savedOrder = (
      settings.pageLayouts[dashboardLayoutKey(dashboardId)]
      ?? settings.pageLayouts.dashboard
      ?? []
    ).flatMap((id) => (
      id === 'summary'
        ? dashboardPageDefaults.filter((blockId) => blockId.startsWith('summary:'))
        : [id]
    ));
    pageOrder = normalizeOrder({ saved: savedOrder, defaults: dashboardPageDefaults });
    activeCollapsedBlocks = [...(
      settings.collapsedBlocks[dashboardLayoutKey(dashboardId)]
      ?? settings.collapsedBlocks.dashboard
      ?? []
    )];
  };

  const updateDashboardQuery = (index: number) => {
    const url = new URL(window.location.href);
    url.searchParams.set('dashboard', String(index + 1));
    window.history.replaceState(window.history.state, '', url);
  };

  const scheduleCycle = () => {
    if (cycleTimer) clearTimeout(cycleTimer);
    cycleTimer = null;
    if (!cycleEnabled || settings.dashboards.length < 2) return;
    if (nextCycleAt <= 0) nextCycleAt = Date.now() + (cycleIntervalSeconds * 1_000);
    const dueAt = Math.max(nextCycleAt, lastMouseMovementAt + 10_000);
    cycleTimer = setTimeout(() => {
      const nextIndex = (activeDashboardIndex + 1) % settings.dashboards.length;
      graphRangeEndMs = Date.now();
      activeDashboardId = settings.dashboards[nextIndex]!.id;
      restoreDashboardLayout(activeDashboardId);
      updateDashboardQuery(nextIndex);
      nextCycleAt = Date.now() + (cycleIntervalSeconds * 1_000);
      scheduleCycle();
    }, Math.max(100, dueAt - Date.now()));
  };

  const resetCycle = () => {
    nextCycleAt = Date.now() + (cycleIntervalSeconds * 1_000);
    scheduleCycle();
  };

  const selectDashboard = (index: number) => {
    const selected = settings.dashboards[index];
    if (!selected) return;
    graphRangeEndMs = Date.now();
    activeDashboardId = selected.id;
    restoreDashboardLayout(activeDashboardId);
    updateDashboardQuery(index);
    resetCycle();
  };

  const handleMouseMovement = () => {
    lastMouseMovementAt = Date.now();
    if (cycleEnabled && nextCycleAt < lastMouseMovementAt + 10_000) scheduleCycle();
  };

  const scheduleRefresh = () => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = autoRefreshEnabled
      ? setInterval(() => {
          if (!loading) void load();
        }, refreshIntervalSeconds * 1_000)
      : null;
  };

  const saveDashboardDisplay = async () => {
    settings.graphDefaults = {
      ...settings.graphDefaults,
      dashboardHideFluff: hideFluff,
      dashboardMinimalMode: minimalMode,
      dashboardAutoRefreshEnabled: autoRefreshEnabled,
      dashboardRefreshIntervalSeconds: refreshIntervalSeconds,
      dashboardCycleEnabled: cycleEnabled,
      dashboardCycleIntervalSeconds: cycleIntervalSeconds
    };
    settings = { ...settings };
    scheduleRefresh();
    resetCycle();
    await savePreferences({ graphDefaults: settings.graphDefaults });
  };

  const saveMinimalMode = async () => {
    if (minimalMode) {
      hideFluff = true;
      showDashboardOptions = false;
    }
    dashboardMinimalMode.set(minimalMode);
    await saveDashboardDisplay();
  };

  const handleDashboardKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !minimalMode) return;
    minimalMode = false;
    dashboardMinimalMode.set(false);
    void saveDashboardDisplay();
  };

  const load = async () => {
    loading = true;
    error = '';
    try {
      const settingsPayload = await apiRequest<{ settings: typeof settings }>({ url: '/api/settings' });
      settings = settingsPayload.settings;
      const currencies = configuredCurrencies({
        primaryCurrency: settings.primaryCurrency,
        listedCurrencies: settings.tooltipCurrencies ?? []
      });
      const currencyQuery = encodeURIComponent(currencies.join(','));
      const [watchlistPayload, holdingsPayload, krakenPayload, providerPayload, jobsPayload] = await Promise.all([
        apiRequest<{ assets: typeof watchlist }>({ url: '/api/watchlist/assets' }),
        apiRequest<{ holdings: typeof holdings }>({
          url: `/api/addresses/holdings?quoteCurrency=${settings.primaryCurrency}&quoteCurrencies=${currencyQuery}`
        }),
        apiRequest<{ summary: typeof kraken }>({
          url: `/api/kraken/summary?quoteCurrencies=${currencyQuery}`
        }),
        apiRequest<{ providers: Record<string, unknown> }>({ url: '/api/providers/status' }),
        apiRequest<{ progress: { jobs: typeof jobs } }>({ url: '/api/sync/progress' })
      ]);
      watchlist = watchlistPayload.assets;
      holdings = holdingsPayload.holdings;
      kraken = krakenPayload.summary;
      addressValues = Object.fromEntries(currencies.map((currency) => {
        const pricedValues = holdings
          .map((holding) => holding.currentValues[currency])
          .filter((value): value is string => value !== null);
        return [
          currency,
          pricedValues.length === 0
            ? null
            : pricedValues.reduce((total, value) => total + Number(value), 0).toString()
        ];
      }));
      krakenValues = Object.fromEntries(currencies.map((currency) => [
        currency,
        kraken.values[currency] ?? (
          currency === kraken.currency ? kraken.totalCurrentValue : null
        )
      ]));
      knownValues = Object.fromEntries(currencies.map((currency) => {
        const addressValue = addressValues[currency];
        const krakenValue = krakenValues[currency];
        return [
          currency,
          addressValue === null && krakenValue === null
            ? null
            : (Number(addressValue ?? 0) + Number(krakenValue ?? 0)).toString()
        ];
      }));
      providers = providerPayload.providers;
      jobs = jobsPayload.progress.jobs;
      const summaryBlockIds = currencies.map((currency) => `summary:${currency}`);
      dashboardPageDefaults = [...summaryBlockIds, ...defaultContentOrder];
      settings.dashboards = normalizeDashboards({
        dashboards: settings.dashboards,
        legacyRows: settings.dashboardRows ?? [],
        savedGraphs: settings.savedGraphs,
        defaultColumns: settings.dashboardGraphColumns
      });
      const requestedDashboard = dashboardNumberFromSearch({
        search: window.location.search,
        count: settings.dashboards.length
      });
      const currentDashboardStillExists = settings.dashboards.some((dashboard) => (
        dashboard.id === activeDashboardId
      ));
      activeDashboardId = currentDashboardStillExists
        ? activeDashboardId
        : settings.dashboards[requestedDashboard - 1]!.id;
      restoreDashboardLayout(activeDashboardId);
      updateDashboardQuery(settings.dashboards.findIndex((dashboard) => (
        dashboard.id === activeDashboardId
      )));
      hideFluff = settings.graphDefaults.dashboardHideFluff === true
        || (
          settings.graphDefaults.dashboardHideFluff === undefined
          && settings.graphDefaults.dashboardRemoveFluff === true
        );
      minimalMode = settings.graphDefaults.dashboardMinimalMode === true;
      if (minimalMode) {
        hideFluff = true;
        showDashboardOptions = false;
      }
      dashboardMinimalMode.set(minimalMode);
      autoRefreshEnabled = settings.graphDefaults.dashboardAutoRefreshEnabled === true;
      const savedRefreshSeconds = Number(settings.graphDefaults.dashboardRefreshIntervalSeconds);
      refreshIntervalSeconds = refreshIntervals.some((option) => option.seconds === savedRefreshSeconds)
        ? savedRefreshSeconds
        : 60;
      cycleEnabled = settings.graphDefaults.dashboardCycleEnabled === true;
      const savedCycleSeconds = Number(settings.graphDefaults.dashboardCycleIntervalSeconds);
      cycleIntervalSeconds = cycleIntervals.some((option) => option.seconds === savedCycleSeconds)
        ? savedCycleSeconds
        : 60;
      scheduleRefresh();
      resetCycle();
      graphRangeEndMs = Date.now();
      settings = { ...settings };
      setDocumentPreferences(settings);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Dashboard load failed.';
    } finally {
      loading = false;
    }
  };

  let enabledAssets: typeof watchlist = [];
  let onlyBitcoinEnabled = false;
  let hasPartialHoldings = false;
  let hasUnpricedHoldings = false;
  let activeJobCount = 0;

  $: enabledAssets = watchlist.filter((asset) => asset.enabled);
  $: onlyBitcoinEnabled = enabledAssets.length === 1
    && enabledAssets[0]?.canonicalId === 'bitcoin';
  $: hasPartialHoldings = holdings.some((holding) => holding.completeness !== 'complete');
  $: hasUnpricedHoldings = holdings.some((holding) => Number(holding.pricedCoveragePercent) < 100)
    || Number(kraken.pricedValueCoveragePercent) < 100;
  $: activeJobCount = jobs.filter((job) => ['queued', 'running', 'retry'].includes(job.status)).length;

  const partialDescription = () => {
    const affected = holdings.filter((holding) => holding.completeness !== 'complete');
    const labels = [...new Set(affected.map((holding) => holding.label))];
    return `Partial address history: ${labels.join(', ') || `${affected.length} holding rows`}. Settings → Synchronization shows active work and the oldest point reached.`;
  };

  const itemForId = (id: string) => settings.savedGraphs.find((item) => item.id === id) ?? null;
  const saveDashboards = async () => {
    settings = {
      ...settings,
      dashboards: [...settings.dashboards],
      dashboardRows: [...(settings.dashboards[0]?.rows ?? [])]
    };
    await savePreferences({
      dashboards: settings.dashboards,
      dashboardRows: settings.dashboardRows
    });
  };

  const blockLabel = (blockId: string) => blockId.startsWith('summary:')
    ? `${blockId.slice('summary:'.length)} portfolio values`
    : blockId;

  const moveBlock = async (event: CustomEvent<{ id: string; direction: 'up' | 'down' }>) => {
    pageOrder = moveInOrder({ order: pageOrder, id: event.detail.id, direction: event.detail.direction });
    settings.pageLayouts = {
      ...settings.pageLayouts,
      [dashboardLayoutKey(activeDashboardId)]: pageOrder
    };
    settings = { ...settings };
    await savePreferences({ pageLayouts: settings.pageLayouts });
  };

  const toggleBlockCollapse = async (event: CustomEvent<{ id: string }>) => {
    activeCollapsedBlocks = toggleCollapsed({
      collapsed: activeCollapsedBlocks,
      id: event.detail.id
    });
    settings.collapsedBlocks = {
      ...settings.collapsedBlocks,
      [dashboardLayoutKey(activeDashboardId)]: activeCollapsedBlocks
    };
    settings = { ...settings };
    await savePreferences({ collapsedBlocks: settings.collapsedBlocks });
  };

  const hideGraph = async (event: CustomEvent<{ id: string }>) => {
    settings.savedGraphs = settings.savedGraphs.map((graph) => (
      graph.id === event.detail.id ? { ...graph, hidden: true } : graph
    ));
    settings.dashboards = settings.dashboards.map((dashboard) => ({
      ...dashboard,
      rows: dashboard.rows.map((row) => ({
        ...row,
        itemIds: row.itemIds.filter((id) => id !== event.detail.id)
      }))
    }));
    settings.dashboardRows = settings.dashboards[0]?.rows ?? [];
    settings = { ...settings };
    await savePreferences({
      savedGraphs: settings.savedGraphs,
      dashboards: settings.dashboards,
      dashboardRows: settings.dashboardRows
    });
  };

  const removeGraph = async (event: CustomEvent<{ id: string }>) => {
    settings.savedGraphs = settings.savedGraphs.filter((graph) => graph.id !== event.detail.id);
    settings.dashboards = settings.dashboards.map((dashboard) => ({
      ...dashboard,
      rows: dashboard.rows.map((row) => ({
        ...row,
        itemIds: row.itemIds.filter((id) => id !== event.detail.id)
      }))
    }));
    settings.dashboardRows = settings.dashboards[0]?.rows ?? [];
    settings = { ...settings };
    await savePreferences({
      savedGraphs: settings.savedGraphs,
      dashboards: settings.dashboards,
      dashboardRows: settings.dashboardRows
    });
  };

  const dismissNotice = async (event: CustomEvent<{ id: string }>) => {
    settings.dismissedNotices = [...new Set([
      ...settings.dismissedNotices,
      event.detail.id
    ])];
    settings = { ...settings };
    await savePreferences({ dismissedNotices: settings.dismissedNotices });
  };

  const addDashboardRow = async () => {
    if (!activeDashboard) return;
    const rows = [
      ...activeDashboard.rows,
      {
        id: crypto.randomUUID(),
        name: `Row ${activeDashboard.rows.length + 1}`,
        columns: 2 as const,
        itemIds: []
      }
    ];
    settings.dashboards = settings.dashboards.map((dashboard) => (
      dashboard.id === activeDashboard?.id ? { ...dashboard, rows } : dashboard
    ));
    await saveDashboards();
  };

  const removeDashboardRow = async (id: string) => {
    if (!activeDashboard || activeDashboard.rows.length <= 1) return;
    const removed = activeDashboard.rows.find((row) => row.id === id);
    const remaining = activeDashboard.rows.filter((row) => row.id !== id);
    if (removed && remaining[0]) {
      remaining[0] = {
        ...remaining[0],
        itemIds: [...remaining[0].itemIds, ...removed.itemIds]
      };
    }
    settings.dashboards = settings.dashboards.map((dashboard) => (
      dashboard.id === activeDashboard?.id ? { ...dashboard, rows: remaining } : dashboard
    ));
    await saveDashboards();
  };

  const moveItem = async ({
    itemId,
    dashboardId,
    rowId
  }: {
    itemId: string;
    dashboardId: string;
    rowId: string;
  }) => {
    settings.dashboards = settings.dashboards.map((dashboard) => ({
      ...dashboard,
      rows: dashboard.rows.map((row) => ({
        ...row,
        itemIds: [
          ...row.itemIds.filter((id) => id !== itemId),
          ...(dashboard.id === dashboardId && row.id === rowId ? [itemId] : [])
        ]
      }))
    }));
    await saveDashboards();
  };

  const moveItemWithinRow = async ({
    itemId,
    rowId,
    direction
  }: {
    itemId: string;
    rowId: string;
    direction: 'left' | 'right';
  }) => {
    if (!activeDashboard) return;
    const row = activeDashboard.rows.find((candidate) => candidate.id === rowId);
    if (!row) return;
    const itemIndex = row.itemIds.indexOf(itemId);
    const destination = direction === 'left' ? itemIndex - 1 : itemIndex + 1;
    if (itemIndex < 0 || destination < 0 || destination >= row.itemIds.length) return;
    settings.dashboards = settings.dashboards.map((dashboard) => (
      dashboard.id !== activeDashboard?.id
        ? dashboard
        : {
            ...dashboard,
            rows: dashboard.rows.map((candidate) => (
              candidate.id !== rowId
                ? candidate
                : {
                    ...candidate,
                    itemIds: moveInOrder({
                      order: candidate.itemIds,
                      id: itemId,
                      direction: direction === 'left' ? 'up' : 'down'
                    })
                  }
            ))
          }
    ));
    await saveDashboards();
  };

  const addDashboard = async () => {
    const dashboard: Dashboard = {
      id: crypto.randomUUID(),
      rows: [{
        id: crypto.randomUUID(),
        name: 'Row 1',
        columns: settings.dashboardGraphColumns,
        itemIds: []
      }]
    };
    settings.dashboards = [...settings.dashboards, dashboard];
    activeDashboardId = dashboard.id;
    restoreDashboardLayout(activeDashboardId);
    await saveDashboards();
    updateDashboardQuery(settings.dashboards.length - 1);
    resetCycle();
  };

  const removeDashboard = async () => {
    if (!activeDashboard || settings.dashboards.length <= 1) return;
    if (!confirm(`Remove dashboard ${activeDashboardIndex + 1}? Its items will move to dashboard 1.`)) return;
    const removedItemIds = activeDashboard.rows.flatMap((row) => row.itemIds);
    const remaining = settings.dashboards.filter((dashboard) => dashboard.id !== activeDashboard?.id);
    if (remaining[0]?.rows[0]) {
      remaining[0].rows[0].itemIds = [
        ...remaining[0].rows[0].itemIds,
        ...removedItemIds.filter((id) => !remaining[0]!.rows.some((row) => row.itemIds.includes(id)))
      ];
    }
    settings.dashboards = remaining;
    const nextIndex = Math.min(activeDashboardIndex, remaining.length - 1);
    activeDashboardId = remaining[nextIndex]!.id;
    restoreDashboardLayout(activeDashboardId);
    await saveDashboards();
    updateDashboardQuery(nextIndex);
    resetCycle();
  };

  const moveDashboard = async (direction: 'left' | 'right') => {
    const destination = direction === 'left'
      ? activeDashboardIndex - 1
      : activeDashboardIndex + 1;
    if (destination < 0 || destination >= settings.dashboards.length) return;
    const dashboards = [...settings.dashboards];
    [dashboards[activeDashboardIndex], dashboards[destination]] = [
      dashboards[destination]!,
      dashboards[activeDashboardIndex]!
    ];
    settings.dashboards = dashboards;
    await saveDashboards();
    updateDashboardQuery(destination);
    resetCycle();
  };

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
    if (cycleTimer) clearTimeout(cycleTimer);
    dashboardMinimalMode.set(false);
  });
</script>

<svelte:window on:keydown={handleDashboardKeydown} on:mousemove={handleMouseMovement} />

<main class="page" class:minimal={minimalMode}>
  <header class="dashboard-title-row" data-dashboard-top-controls>
    <h1>{strings['cryptotracker-dashboard-title']}</h1>
    <div class="dashboard-refresh">
      <nav class="dashboard-switcher" aria-label="Dashboards">
        {#each settings.dashboards as dashboard, dashboardIndex (dashboard.id)}
          <button
            class:secondary={dashboard.id === activeDashboard?.id}
            class:ghost={dashboard.id !== activeDashboard?.id}
            class="compact dashboard-number"
            type="button"
            aria-label={`Open dashboard ${dashboardIndex + 1}`}
            aria-pressed={dashboard.id === activeDashboard?.id}
            on:click={() => selectDashboard(dashboardIndex)}
          >{dashboardIndex + 1}</button>
        {/each}
        {#if !minimalMode}
          <button class="ghost compact dashboard-number" type="button" aria-label="Add dashboard" title="Add dashboard" on:click={addDashboard}>+</button>
          <button class="ghost compact dashboard-number" type="button" aria-label="Move dashboard left" title="Move dashboard left" disabled={activeDashboardIndex === 0} on:click={() => moveDashboard('left')}>&lt;</button>
          <button class="ghost compact dashboard-number" type="button" aria-label="Move dashboard right" title="Move dashboard right" disabled={activeDashboardIndex === settings.dashboards.length - 1} on:click={() => moveDashboard('right')}>&gt;</button>
          <button class="danger compact" type="button" disabled={settings.dashboards.length <= 1} on:click={removeDashboard}>Remove dashboard</button>
        {/if}
      </nav>
      <label class="check dashboard-minimal-toggle">
        <input
          type="checkbox"
          role="switch"
          aria-label="Minimal mode"
          bind:checked={minimalMode}
          on:change={saveMinimalMode}
        />
        Minimal
      </label>
      <label class="check dashboard-cycle-toggle">
        <input
          type="checkbox"
          role="switch"
          bind:checked={cycleEnabled}
          on:change={saveDashboardDisplay}
        />
        Cycle
      </label>
      {#if !minimalMode}
        <div class="field">
          <label for="dashboard-cycle-interval">Cycle interval</label>
          <select
            id="dashboard-cycle-interval"
            bind:value={cycleIntervalSeconds}
            disabled={!cycleEnabled}
            on:change={saveDashboardDisplay}
          >
            {#each cycleIntervals as option (option.seconds)}
              <option value={option.seconds}>{option.label}</option>
            {/each}
          </select>
        </div>
      {/if}
      <label class="check dashboard-refresh-toggle">
        <input
          type="checkbox"
          role="switch"
          bind:checked={autoRefreshEnabled}
          on:change={saveDashboardDisplay}
        />
        Enable refresh
      </label>
      {#if !minimalMode}
        <div class="field">
          <label for="dashboard-refresh-interval">Refresh interval</label>
          <select
            id="dashboard-refresh-interval"
            bind:value={refreshIntervalSeconds}
            disabled={!autoRefreshEnabled}
            on:change={saveDashboardDisplay}
          >
            {#each refreshIntervals as option (option.seconds)}
              <option value={option.seconds}>{option.label}</option>
            {/each}
          </select>
        </div>
      {/if}
    </div>
  </header>

  {#if error}
    <div class="alert danger" role="alert">{error}</div>
  {/if}
  {#if hasPartialHoldings}
    <div class="alert warning">{partialDescription()}</div>
  {/if}
  {#if hasUnpricedHoldings}
    <DismissableNotice
      noticeId="dashboard-unpriced-holdings"
      tone="warning"
      dismissed={settings.dismissedNotices.includes('dashboard-unpriced-holdings')}
      on:dismiss={dismissNotice}
    >{strings['cryptotracker-unpriced-label']}</DismissableNotice>
  {/if}

  {#each pageOrder as blockId, index}
    <ReorderableBlock
      {blockId}
      label={blockLabel(blockId)}
      {index}
      total={pageOrder.length}
      collapsed={activeCollapsedBlocks.includes(blockId)}
      hideControls={minimalMode}
      on:move={moveBlock}
      on:toggle={toggleBlockCollapse}
    >
  {#if blockId.startsWith('summary:')}
  {@const summaryCurrency = blockId.slice('summary:'.length)}
  <section class="card-grid" aria-busy={loading}>
    <article class="card">
      <span class="label">Known portfolio</span>
      <CurrencyValue
        values={knownValues}
        currency={summaryCurrency}
        locale={settings.locale}
        label="Known portfolio"
        showCurrencyCode
      />
    </article>
    <article class="card">
      <span class="label">Tracked addresses</span>
      <CurrencyValue
        values={addressValues}
        currency={summaryCurrency}
        locale={settings.locale}
        label="Tracked addresses"
        showCurrencyCode
      />
    </article>
    <article class="card">
      <span class="label">Kraken</span>
      <CurrencyValue
        values={krakenValues}
        currency={summaryCurrency}
        locale={settings.locale}
        label="Kraken"
        showCurrencyCode
      />
    </article>
  </section>

  {:else if blockId === 'graphs'}
  <section class="panel">
    <div class:fluff-hidden={hideFluff} class="row dashboard-heading">
      {#if !hideFluff}
        <div>
          <p class="eyebrow">Saved dashboard items</p>
          <h2>{activeDashboard?.rows.flatMap((row) => row.itemIds).length ?? 0} charts and tables on dashboard {activeDashboardIndex + 1}</h2>
          <p class="muted">Each row has its own one-to-four-column layout. Save charts or tables from Markets, Addresses, or Kraken.</p>
        </div>
      {/if}
      <div class="dashboard-heading-actions">
        {#if !minimalMode}
          <button
            class="ghost compact"
            type="button"
            aria-pressed={hideFluff}
            on:click={() => {
              hideFluff = !hideFluff;
              void saveDashboardDisplay();
            }}
          >{hideFluff ? 'Show fluff' : 'Hide fluff'}</button>
          <button
            class="ghost compact"
            type="button"
            aria-pressed={showDashboardOptions}
            on:click={() => (showDashboardOptions = !showDashboardOptions)}
          >{showDashboardOptions ? 'Hide options' : 'Show options'}</button>
        {/if}
        {#if showDashboardOptions}
          <button class="secondary compact" type="button" aria-label="Add dashboard row" on:click={addDashboardRow}>Add row</button>
          <a class="button secondary compact" href="/settings#dashboard-items">Go to hidden dashboards</a>
        {/if}
      </div>
    </div>
    {#if activeDashboard && activeDashboard.rows.some((row) => row.itemIds.length > 0)}
      <div class="dashboard-rows">
        {#each activeDashboard.rows as dashboardRow, rowIndex (dashboardRow.id)}
          <section class="dashboard-row">
            {#if showDashboardOptions}
              <div class="dashboard-row-controls">
                <div class="field grow">
                  <label for={`dashboard-row-name-${dashboardRow.id}`}>Row name</label>
                  <input
                    id={`dashboard-row-name-${dashboardRow.id}`}
                    maxlength="120"
                    bind:value={dashboardRow.name}
                    on:change={saveDashboards}
                  />
                </div>
                <div class="field">
                  <label for={`dashboard-row-columns-${dashboardRow.id}`}>Items per row</label>
                  <select
                    id={`dashboard-row-columns-${dashboardRow.id}`}
                    bind:value={dashboardRow.columns}
                    on:change={saveDashboards}
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={4}>4</option>
                  </select>
                </div>
                <button class="danger compact" type="button" disabled={activeDashboard.rows.length <= 1} on:click={() => removeDashboardRow(dashboardRow.id)}>Remove row</button>
              </div>
            {/if}
            {#if dashboardRow.itemIds.length > 0}
              <div class="dashboard-row-grid" style={`--dashboard-columns:${dashboardRow.columns}`}>
                {#each dashboardRow.itemIds as itemId, itemIndex (itemId)}
                  {@const item = itemForId(itemId)}
                  {#if item}
                    <div class="dashboard-item-shell">
                      {#if showDashboardOptions}
                        <div class="item-placement-controls">
                          <div class="item-row-selector field">
                            <label for={`item-row-${item.id}`}>Dashboard and row</label>
                            <select
                              id={`item-row-${item.id}`}
                              value={`${activeDashboard.id}::${dashboardRow.id}`}
                              on:change={(event) => {
                                const [dashboardId, rowId] = event.currentTarget.value.split('::');
                                if (dashboardId && rowId) void moveItem({ itemId: item.id, dashboardId, rowId });
                              }}
                            >
                              {#each settings.dashboards as candidateDashboard, candidateDashboardIndex (candidateDashboard.id)}
                                {#each candidateDashboard.rows as candidate, candidateIndex (candidate.id)}
                                  <option value={`${candidateDashboard.id}::${candidate.id}`}>Dashboard {candidateDashboardIndex + 1} — {candidate.name || `Row ${candidateIndex + 1}`}</option>
                                {/each}
                              {/each}
                            </select>
                          </div>
                          <div class="item-order-actions" role="group" aria-label={`Order ${item.name} within row`}>
                            <button
                              class="ghost compact"
                              type="button"
                              aria-label={`Move ${item.name} left within row`}
                              title="Move left within row"
                              disabled={itemIndex === 0}
                              on:click={() => moveItemWithinRow({ itemId: item.id, rowId: dashboardRow.id, direction: 'left' })}
                            >&lt;</button>
                            <button
                              class="ghost compact"
                              type="button"
                              aria-label={`Move ${item.name} right within row`}
                              title="Move right within row"
                              disabled={itemIndex === dashboardRow.itemIds.length - 1}
                              on:click={() => moveItemWithinRow({ itemId: item.id, rowId: dashboardRow.id, direction: 'right' })}
                            >&gt;</button>
                          </div>
                        </div>
                      {/if}
                      {#if item.config.dashboardView === 'table'}
                        <SavedDashboardTable {item} minimalChrome={hideFluff} on:hide={hideGraph} on:remove={removeGraph} />
                      {:else if graphRangeEndMs > 0}
                        {#key graphRangeEndMs}
                          <SavedDashboardChart
                            graph={item}
                            minimalChrome={hideFluff}
                            hideActions={minimalMode}
                            primaryCurrency={settings.primaryCurrency}
                            tooltipCurrencies={settings.tooltipCurrencies}
                            rangeEndMs={graphRangeEndMs}
                            on:hide={hideGraph}
                            on:remove={removeGraph}
                          />
                        {/key}
                      {/if}
                    </div>
                  {/if}
                {/each}
              </div>
            {:else}
              <p class="muted">This row is empty. Move an item here with its Dashboard row selector.</p>
            {/if}
          </section>
        {/each}
      </div>
    {:else}
      <p class="muted">This dashboard is empty. Configure a chart or table on Markets, Addresses, or Kraken, or move an item here from another dashboard.</p>
    {/if}
  </section>

  {:else if blockId === 'watchlist'}
  <section class="panel">
    <div class="row">
      <div>
        <p class="eyebrow">Watched markets</p>
        <h2>{enabledAssets.length} enabled assets</h2>
      </div>
      <a class="button compact" href="/markets">Open markets</a>
    </div>
    <div class="card-grid">
      {#each enabledAssets as asset}
        <article class="card">
          <span class="badge start">{asset.symbol}</span>
          <strong class="stat">{asset.name}</strong>
          <span class="muted">{asset.canonicalId}</span>
        </article>
      {/each}
    </div>
    {#if onlyBitcoinEnabled}
      <p class="muted">Only BTC is enabled. <a href="/markets#asset-catalog">Enable more assets in Markets</a>.</p>
    {/if}
  </section>

  {:else if blockId === 'diagnostics'}
  <section class="panel">
    <p class="eyebrow">Capability visibility</p>
    <h2>Used Kraken surfaces</h2>
    <div class="row">
      {#if kraken.sections.spot}<span class="badge mid">spot</span>{/if}
      {#if kraken.sections.earn}<span class="badge mid">Earn / staking</span>{/if}
      {#if kraken.sections.margin}<span class="badge warning">margin</span>{/if}
      {#if !kraken.sections.spot && !kraken.sections.earn && !kraken.sections.margin}
        <span class="muted">No Kraken account data has been imported.</span>
      {/if}
    </div>
  </section>

  {:else if blockId === 'kraken'}
  <section class="panel">
    <div class="row">
      <div>
        <p class="eyebrow">Upstream diagnostics</p>
        <h2>Provider and cache health</h2>
      </div>
      <a class="button secondary compact" href="/settings">Inspect diagnostics</a>
    </div>
    <div class="card-grid diagnostics-summary">
      <article class="card">
        <span class="label">Synchronization</span>
        <strong class="stat">{activeJobCount}</strong>
        <span class="badge {activeJobCount > 0 ? 'start' : 'mid'}">active / pending jobs</span>
      </article>
    </div>
    <details use:persistAccordionState={{ key: 'dashboard:row-layout-help' }}>
      <summary>Provider state</summary>
      <div class="details-body"><pre>{JSON.stringify(providers, null, 2)}</pre></div>
    </details>
  </section>
  {/if}
    </ReorderableBlock>
  {/each}
</main>

<style>
  header {
    margin-bottom: 1rem;
  }

  .minimal {
    padding-top: 0.75rem;
  }

  .minimal header {
    margin-bottom: 0.35rem;
  }

  .dashboard-title-row,
  .dashboard-refresh {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.8rem;
  }

  .dashboard-title-row h1 {
    margin: 0;
  }

  .dashboard-refresh {
    flex-wrap: wrap;
    justify-content: flex-end;
    min-width: 0;
  }

  .dashboard-switcher {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
  }

  .dashboard-number {
    width: 2rem;
    min-height: 2rem;
    padding: 0.15rem;
  }

  .dashboard-refresh .field {
    display: flex;
    flex-flow: row nowrap;
    align-items: center;
    min-width: 0;
    gap: 0.5rem;
  }

  .dashboard-refresh label {
    white-space: nowrap;
  }

  .dashboard-refresh-toggle {
    flex: 0 0 auto;
  }

  .dashboard-minimal-toggle {
    flex: 0 0 auto;
  }

  .dashboard-refresh select {
    width: auto;
    min-width: 12.5rem;
  }

  .dashboard-refresh select:disabled,
  .dashboard-refresh select:disabled:hover {
    border-color: var(--color-border);
    background: var(--color-panel);
    box-shadow: none;
    transform: none;
    cursor: not-allowed;
  }

  .row > div:first-child {
    flex: 1 1 15rem;
  }

  pre {
    max-height: 24rem;
    overflow: auto;
    white-space: pre-wrap;
  }

  .diagnostics-summary {
    margin: 1rem 0;
  }

  .dashboard-heading {
    align-items: flex-end;
  }

  .dashboard-heading.fluff-hidden {
    align-items: center;
    justify-content: flex-end;
  }

  .dashboard-heading-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .dashboard-rows {
    display: grid;
    gap: 1.25rem;
    margin-top: 1rem;
  }

  .dashboard-row {
    min-width: 0;
    padding: 1rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-panel-strong);
  }

  .dashboard-row-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.7rem;
    margin-bottom: 0.9rem;
  }

  .dashboard-row-grid {
    display: grid;
    grid-template-columns: repeat(var(--dashboard-columns, 2), minmax(0, 1fr));
    gap: 1rem;
  }

  .dashboard-item-shell {
    min-width: 0;
  }

  .minimal .panel {
    padding: 0.65rem;
  }

  .minimal .panel > .row + * {
    margin-top: 0.5rem;
  }

  .minimal .card-grid,
  .minimal .dashboard-row-grid {
    gap: 0.5rem;
  }

  .minimal .card {
    padding: 0.65rem;
  }

  .minimal .dashboard-rows {
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .minimal .dashboard-row {
    padding: 0.5rem;
  }

  .item-row-selector {
    min-width: 0;
  }

  .item-placement-controls {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: 0.55rem;
    margin-bottom: 0.45rem;
    padding: 0.55rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-panel);
  }

  .item-order-actions {
    display: flex;
    gap: 0.3rem;
  }

  .item-order-actions button {
    width: 2rem;
    padding-inline: 0.25rem;
  }

  @media (max-width: 72rem) {
    .dashboard-row-grid { grid-template-columns: 1fr; }
  }

  @media (max-width: 42rem) {
    .dashboard-title-row {
      flex-wrap: wrap;
      align-items: flex-start;
    }

    .dashboard-refresh {
      flex-wrap: wrap;
      justify-content: flex-start;
    }
  }
</style>
