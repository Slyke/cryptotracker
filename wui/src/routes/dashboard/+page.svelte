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
  import strings from '$lib/i18n/en-CA.json';
  import {
    formatPercent,
    moveInOrder,
    normalizeOrder,
    savePreferences,
    toggleCollapsed,
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
    dashboardRows: [] as DashboardRow[],
    dashboardGraphColumns: 2 as 1 | 2 | 3 | 4,
    dismissedNotices: [] as string[]
  };
  let jobs: Array<{ status: string }> = [];
  const defaultPageOrder = ['summary', 'graphs', 'watchlist', 'kraken', 'diagnostics'];
  let pageOrder = [...defaultPageOrder];
  let showDashboardOptions = false;
  let removeFluff = false;
  let autoRefreshEnabled = false;
  let refreshIntervalSeconds = 60;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let addressValues = { CAD: '0' } as Record<string, string | null>;
  let krakenValues = { CAD: '0' } as Record<string, string | null>;
  let knownValues = { CAD: '0' } as Record<string, string | null>;

  const refreshIntervals = [
    { seconds: 30, label: 'Every 30 seconds' },
    { seconds: 60, label: 'Every minute' },
    { seconds: 120, label: 'Every 2 minutes' },
    { seconds: 300, label: 'Every 5 minutes' },
    { seconds: 600, label: 'Every 10 minutes' },
    { seconds: 1_800, label: 'Every 30 minutes' },
    { seconds: 3_600, label: 'Every hour' }
  ];

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
      dashboardRemoveFluff: removeFluff,
      dashboardAutoRefreshEnabled: autoRefreshEnabled,
      dashboardRefreshIntervalSeconds: refreshIntervalSeconds
    };
    settings = { ...settings };
    scheduleRefresh();
    await savePreferences({ graphDefaults: settings.graphDefaults });
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
      pageOrder = normalizeOrder({ saved: settings.pageLayouts.dashboard, defaults: defaultPageOrder });
      settings.dashboardRows = normalizeDashboardRows(settings.dashboardRows ?? []);
      removeFluff = settings.graphDefaults.dashboardRemoveFluff === true;
      autoRefreshEnabled = settings.graphDefaults.dashboardAutoRefreshEnabled === true;
      const savedRefreshSeconds = Number(settings.graphDefaults.dashboardRefreshIntervalSeconds);
      refreshIntervalSeconds = refreshIntervals.some((option) => option.seconds === savedRefreshSeconds)
        ? savedRefreshSeconds
        : 60;
      scheduleRefresh();
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

  const normalizeDashboardRows = (savedRows: DashboardRow[]) => {
    const visibleIds = settings.savedGraphs.filter((item) => !item.hidden).map((item) => item.id);
    const known = new Set(visibleIds);
    const used = new Set<string>();
    const normalized = savedRows.map((row, index) => ({
      id: row.id || `dashboard-row-${index + 1}`,
      name: row.name || `Row ${index + 1}`,
      columns: ([1, 2, 3, 4].includes(Number(row.columns)) ? Number(row.columns) : 2) as 1 | 2 | 3 | 4,
      itemIds: row.itemIds.filter((id) => {
        if (!known.has(id) || used.has(id)) return false;
        used.add(id);
        return true;
      })
    }));
    const unplaced = visibleIds.filter((id) => !used.has(id));
    if (normalized.length === 0) {
      normalized.push({
        id: crypto.randomUUID(),
        name: 'Row 1',
        columns: settings.dashboardGraphColumns,
        itemIds: unplaced
      });
    } else {
      normalized[0]!.itemIds.push(...unplaced);
    }
    return normalized;
  };

  const itemForId = (id: string) => settings.savedGraphs.find((item) => item.id === id) ?? null;
  const saveDashboardRows = async () => {
    settings = { ...settings, dashboardRows: [...settings.dashboardRows] };
    await savePreferences({ dashboardRows: settings.dashboardRows });
  };

  const moveBlock = async (event: CustomEvent<{ id: string; direction: 'up' | 'down' }>) => {
    pageOrder = moveInOrder({ order: pageOrder, id: event.detail.id, direction: event.detail.direction });
    settings.pageLayouts = { ...settings.pageLayouts, dashboard: pageOrder };
    settings = { ...settings };
    await savePreferences({ pageLayouts: settings.pageLayouts });
  };

  const toggleBlockCollapse = async (event: CustomEvent<{ id: string }>) => {
    const collapsed = toggleCollapsed({
      collapsed: settings.collapsedBlocks.dashboard ?? [],
      id: event.detail.id
    });
    settings.collapsedBlocks = { ...settings.collapsedBlocks, dashboard: collapsed };
    settings = { ...settings };
    await savePreferences({ collapsedBlocks: settings.collapsedBlocks });
  };

  const hideGraph = async (event: CustomEvent<{ id: string }>) => {
    settings.savedGraphs = settings.savedGraphs.map((graph) => (
      graph.id === event.detail.id ? { ...graph, hidden: true } : graph
    ));
    settings.dashboardRows = settings.dashboardRows.map((row) => ({
      ...row,
      itemIds: row.itemIds.filter((id) => id !== event.detail.id)
    }));
    settings = { ...settings };
    await savePreferences({
      savedGraphs: settings.savedGraphs,
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
    settings.dashboardRows = [
      ...settings.dashboardRows,
      {
        id: crypto.randomUUID(),
        name: `Row ${settings.dashboardRows.length + 1}`,
        columns: 2,
        itemIds: []
      }
    ];
    await saveDashboardRows();
  };

  const removeDashboardRow = async (id: string) => {
    if (settings.dashboardRows.length <= 1) return;
    const removed = settings.dashboardRows.find((row) => row.id === id);
    const remaining = settings.dashboardRows.filter((row) => row.id !== id);
    if (removed && remaining[0]) {
      remaining[0] = {
        ...remaining[0],
        itemIds: [...remaining[0].itemIds, ...removed.itemIds]
      };
    }
    settings.dashboardRows = remaining;
    await saveDashboardRows();
  };

  const moveItemToRow = async ({ itemId, rowId }: { itemId: string; rowId: string }) => {
    settings.dashboardRows = settings.dashboardRows.map((row) => ({
      ...row,
      itemIds: [
        ...row.itemIds.filter((id) => id !== itemId),
        ...(row.id === rowId ? [itemId] : [])
      ]
    }));
    await saveDashboardRows();
  };

  onMount(() => {
    void load();
  });

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });
</script>

<main class="page">
  <header class="dashboard-title-row">
    <h1>{strings['cryptotracker-dashboard-title']}</h1>
    <div class="dashboard-refresh">
      <label class="check dashboard-refresh-toggle">
        <input
          type="checkbox"
          role="switch"
          bind:checked={autoRefreshEnabled}
          on:change={saveDashboardDisplay}
        />
        Enable refresh
      </label>
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
      label={blockId}
      {index}
      total={pageOrder.length}
      collapsed={settings.collapsedBlocks.dashboard?.includes(blockId) ?? false}
      on:move={moveBlock}
      on:toggle={toggleBlockCollapse}
    >
  {#if blockId === 'summary'}
  <section class="card-grid" aria-busy={loading}>
    <article class="card">
      <span class="label">Known portfolio</span>
      <CurrencyValue
        values={knownValues}
        currency={settings.primaryCurrency}
        locale={settings.locale}
        label="Known portfolio"
      />
      <span class="portfolio-value-status">
        <span class="badge mid">priced known value</span>
        <span class="portfolio-currency-code">{settings.primaryCurrency.toUpperCase()}</span>
      </span>
    </article>
    <article class="card">
      <span class="label">Tracked addresses</span>
      <CurrencyValue
        values={addressValues}
        currency={settings.primaryCurrency}
        locale={settings.locale}
        label="Tracked addresses"
      />
      <span class="badge {hasPartialHoldings ? 'warning' : 'mid'}">{hasPartialHoldings ? 'partial history' : 'complete according to providers'}</span>
    </article>
    <article class="card">
      <span class="label">Kraken</span>
      <CurrencyValue
        values={krakenValues}
        currency={settings.primaryCurrency}
        locale={settings.locale}
        label="Kraken"
      />
      <span class="badge {Number(kraken.pricedValueCoveragePercent) < 100 ? 'warning' : 'mid'}">{formatPercent(kraken.pricedValueCoveragePercent)}% priced</span>
    </article>
    <article class="card">
      <span class="label">Synchronization</span>
      <strong class="stat">{activeJobCount}</strong>
      <span class="badge {activeJobCount > 0 ? 'start' : 'mid'}">active / pending jobs</span>
    </article>
  </section>

  {:else if blockId === 'graphs'}
  <section class="panel">
    <div class:fluff-hidden={removeFluff} class="row dashboard-heading">
      {#if !removeFluff}
        <div>
          <p class="eyebrow">Saved dashboard items</p>
          <h2>{settings.savedGraphs.filter((item) => !item.hidden).length} visible charts and tables</h2>
          <p class="muted">Each row has its own one-to-four-column layout. Save charts or tables from Markets, Addresses, or Kraken.</p>
        </div>
      {/if}
      <div class="dashboard-heading-actions">
        <button
          class="ghost compact"
          type="button"
          aria-pressed={removeFluff}
          on:click={() => {
            removeFluff = !removeFluff;
            void saveDashboardDisplay();
          }}
        >{removeFluff ? 'Show fluff' : 'Remove fluff'}</button>
        <button
          class="ghost compact"
          type="button"
          aria-pressed={showDashboardOptions}
          on:click={() => (showDashboardOptions = !showDashboardOptions)}
        >{showDashboardOptions ? 'Hide options' : 'Show options'}</button>
        {#if showDashboardOptions}
          <button class="secondary compact" type="button" aria-label="Add dashboard row" on:click={addDashboardRow}>Add row</button>
        {/if}
      </div>
    </div>
    {#if settings.savedGraphs.some((graph) => !graph.hidden)}
      <div class="dashboard-rows">
        {#each settings.dashboardRows as dashboardRow, rowIndex (dashboardRow.id)}
          <section class="dashboard-row">
            {#if showDashboardOptions}
              <div class="dashboard-row-controls">
                <div class="field grow">
                  <label for={`dashboard-row-name-${dashboardRow.id}`}>Row name</label>
                  <input
                    id={`dashboard-row-name-${dashboardRow.id}`}
                    maxlength="120"
                    bind:value={dashboardRow.name}
                    on:change={saveDashboardRows}
                  />
                </div>
                <div class="field">
                  <label for={`dashboard-row-columns-${dashboardRow.id}`}>Items per row</label>
                  <select
                    id={`dashboard-row-columns-${dashboardRow.id}`}
                    bind:value={dashboardRow.columns}
                    on:change={saveDashboardRows}
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                    <option value={4}>4</option>
                  </select>
                </div>
                <button class="danger compact" type="button" disabled={settings.dashboardRows.length <= 1} on:click={() => removeDashboardRow(dashboardRow.id)}>Remove row</button>
              </div>
            {/if}
            {#if dashboardRow.itemIds.length > 0}
              <div class="dashboard-row-grid" style={`--dashboard-columns:${dashboardRow.columns}`}>
                {#each dashboardRow.itemIds as itemId (itemId)}
                  {@const item = itemForId(itemId)}
                  {#if item}
                    <div class="dashboard-item-shell">
                      {#if showDashboardOptions}
                        <div class="item-row-selector field">
                          <label for={`item-row-${item.id}`}>Dashboard row</label>
                          <select
                            id={`item-row-${item.id}`}
                            value={dashboardRow.id}
                            on:change={(event) => moveItemToRow({
                              itemId: item.id,
                              rowId: event.currentTarget.value
                            })}
                          >
                            {#each settings.dashboardRows as candidate, candidateIndex}
                              <option value={candidate.id}>{candidate.name || `Row ${candidateIndex + 1}`}</option>
                            {/each}
                          </select>
                        </div>
                      {/if}
                      {#if item.config.dashboardView === 'table'}
                        <SavedDashboardTable {item} minimalChrome={removeFluff} on:hide={hideGraph} />
                      {:else}
                        <SavedDashboardChart
                          graph={item}
                          minimalChrome={removeFluff}
                          on:hide={hideGraph}
                        />
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
      <p class="muted">Configure a chart or table on Markets, Addresses, or Kraken, then choose “Save to dashboard”.</p>
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
    justify-content: flex-end;
    min-width: 0;
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

  .portfolio-value-status {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  .portfolio-currency-code {
    color: var(--color-muted);
    font-size: 0.76rem;
    font-weight: 800;
    letter-spacing: 0.08em;
  }

  .row > div:first-child {
    flex: 1 1 15rem;
  }

  pre {
    max-height: 24rem;
    overflow: auto;
    white-space: pre-wrap;
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

  .item-row-selector {
    margin-bottom: 0.45rem;
    padding: 0.55rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-panel);
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
