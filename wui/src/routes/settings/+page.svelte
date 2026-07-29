<script lang="ts">
  import { onMount } from 'svelte';
  import ReorderableBlock from '../../lib/components/ReorderableBlock.svelte';
  import { apiRequest, setDocumentPreferences } from '$lib/api';
  import { persistAccordionState } from '$lib/accordion-state';
  import {
    formatDateTime,
    moveInOrder,
    normalizeOrder,
    savePreferences,
    savedGraphNameExists,
    toggleCollapsed,
    type DashboardRow,
    type SavedGraph
  } from '$lib/preferences';
  import strings from '$lib/i18n/en-CA.json';

  type Settings = {
    locale: string;
    timezone: string;
    theme: 'dark' | 'light';
    font: string;
    contentWidth: 'min' | '1080' | 'standard' | '1440' | '1920' | 'full';
    primaryCurrency: string;
    tooltipCurrencies: string[];
    marketSource: 'combined' | 'coingecko' | 'coinbase' | 'kraken';
    providerDisagreementThresholdPercent: number;
    costBasisMethod: 'acb' | 'fifo' | 'lifo';
    graphDefaults: Record<string, unknown>;
    pageLayouts: Record<string, string[]>;
    collapsedBlocks: Record<string, string[]>;
    tableColumns: Record<string, string[]>;
    tableRows: Record<string, string[]>;
    savedGraphs: SavedGraph[];
    dashboardRows: DashboardRow[];
    dashboardGraphColumns: 1 | 2 | 3 | 4;
    dismissedNotices: string[];
    retentionDays: number | null;
    failedJobRetentionHours: number | null;
    pollingIntervalsMinutes: {
      marketCoinGecko: number;
      marketCoinbase: number;
      marketKraken: number;
      assetCatalog: number;
      addresses: number;
      krakenAccount: number;
    };
  };

  type SyncJob = {
    id: string;
    type: string;
    target: string;
    status: string;
    current: number;
    total: number | null;
    percent: number | null;
    requestedFrom: string | null;
    requestedTo: string | null;
    processedThrough: string | null;
    error: Record<string, unknown>;
    createdAt: string | null;
    updatedAt: string | null;
    completedAt: string | null;
  };

  type MarketCursor = {
    provider: string;
    asset: string;
    currency: string;
    granularitySeconds: number;
    oldest: string | null;
    newest: string | null;
    completeness: string;
    lastSuccessfulSync: string | null;
    updatedAt: string | null;
  };

  type KrakenCursor = {
    endpoint: string;
    completeness: string;
    oldest: string | null;
    newest: string | null;
    lastSuccessfulSync: string | null;
    updatedAt: string | null;
    cursor: Record<string, unknown>;
  };

  type SyncProgress = {
    generatedAt: string;
    jobs: SyncJob[];
    failedJobs: {
      items: SyncJob[];
      total: number;
      page: number;
      pageSize: number;
      pageCount: number;
      types: string[];
    };
    market: MarketCursor[];
    kraken: KrakenCursor[];
  };

  let settings: Settings = {
    locale: 'en-CA',
    timezone: 'America/Vancouver',
    theme: 'dark',
    font: 'ui-mono',
    contentWidth: 'standard',
    primaryCurrency: 'CAD',
    tooltipCurrencies: ['CAD'],
    marketSource: 'combined',
    providerDisagreementThresholdPercent: 5,
    costBasisMethod: 'acb',
    graphDefaults: {},
    pageLayouts: {},
    collapsedBlocks: {},
    tableColumns: {},
    tableRows: {},
    savedGraphs: [],
    dashboardRows: [],
    dashboardGraphColumns: 2,
    dismissedNotices: [],
    retentionDays: null,
    failedJobRetentionHours: null,
    pollingIntervalsMinutes: {
      marketCoinGecko: 30,
      marketCoinbase: 15,
      marketKraken: 15,
      assetCatalog: 1_440,
      addresses: 30,
      krakenAccount: 5
    }
  };
  let tooltipCurrencyText = 'CAD';
  let retentionMode: 'forever' | 'limited' = 'forever';
  let originalRetentionDays: number | null = null;
  let failedJobRetentionValue = 'forever';
  let originalFailedJobRetentionHours: number | null = null;
  let storage: {
    databaseKind: string;
    databaseEstimatedBytes: number;
    totalRows: number;
    categories: Array<{
      category: string;
      rowCount: number;
      estimatedBytes: number;
      tables: Array<{ table: string; rowCount: number }>;
    }>;
    retainedRanges: Array<{
      category: string;
      oldest: string | null;
      newest: string | null;
    }>;
    retention: {
      policy: string;
      explanation: string;
    };
  } | null = null;
  let providers: unknown = null;
  let syncProgress: SyncProgress | null = null;
  let exportState: {
    id: string;
    status: string;
    bytesWritten?: number | null;
    downloadable?: boolean;
    expiresAt?: string | null;
    error?: unknown;
  } | null = null;
  let exportTimer: ReturnType<typeof setInterval> | null = null;
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let saving = false;
  let error = '';
  let message = '';
  let failedJobSearch = '';
  let failedJobType = '';
  let failedJobPage = 1;
  let failedJobPageSize = 10;
  let failedJobItems: SyncJob[] = [];
  let marketCoverageSearch = '';
  let marketCoverageProvider = '';
  let marketCoverageState = '';
  let filteredMarketCoverage: MarketCursor[] = [];
  const pollingIntervalOptions = [
    { minutes: 5, label: 'Every 5 minutes' },
    { minutes: 10, label: 'Every 10 minutes' },
    { minutes: 15, label: 'Every 15 minutes' },
    { minutes: 30, label: 'Every 30 minutes' },
    { minutes: 60, label: 'Every hour' },
    { minutes: 180, label: 'Every 3 hours' },
    { minutes: 360, label: 'Every 6 hours' },
    { minutes: 720, label: 'Every 12 hours' },
    { minutes: 1_440, label: 'Every day' },
    { minutes: 10_080, label: 'Every week' }
  ];
  const defaultPageOrder = ['preferences', 'sync', 'storage', 'graphs', 'export', 'providers'];
  let pageOrder = [...defaultPageOrder];

  const formatBytes = (value: number) => {
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
    if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MiB`;
    return `${(value / (1024 ** 3)).toFixed(2)} GiB`;
  };

  const formatDate = (value: string | null) => (
    value
      ? formatDateTime({ value, timezone: settings.timezone })
      : 'not reached'
  );

  const activeJobs = () => syncProgress?.jobs.filter((job) => (
    ['queued', 'running', 'retry'].includes(job.status)
  )) ?? [];
  $: failedJobItems = syncProgress?.failedJobs.items ?? [];
  const marketCoverageProviders = () => [...new Set(
    (syncProgress?.market ?? []).map((cursor) => cursor.provider)
  )].sort();
  const marketCoverageStates = () => [...new Set(
    (syncProgress?.market ?? []).map((cursor) => cursor.completeness)
  )].sort();
  $: {
    const normalized = marketCoverageSearch.trim().toLowerCase();
    filteredMarketCoverage = (syncProgress?.market ?? []).filter((cursor) => (
      (!marketCoverageProvider || cursor.provider === marketCoverageProvider)
      && (!marketCoverageState || cursor.completeness === marketCoverageState)
      && (!normalized || [
        cursor.asset,
        cursor.provider,
        cursor.currency,
        cursor.granularitySeconds,
        cursor.completeness,
        cursor.oldest,
        cursor.newest,
        cursor.lastSuccessfulSync
      ].some((value) => String(value ?? '').toLowerCase().includes(normalized)))
    ));
  }
  const jobDisplayStatus = (job: SyncJob) => {
    if (
      job.status === 'running'
      && job.updatedAt
      && Date.now() - Date.parse(job.updatedAt) > 10 * 60_000
    ) {
      return 'possibly stalled';
    }
    return job.status;
  };

  const oldestMarketPoint = () => {
    const values = (syncProgress?.market ?? [])
      .map((cursor) => cursor.oldest ? Date.parse(cursor.oldest) : Number.NaN)
      .filter(Number.isFinite);
    return values.length > 0 ? new Date(Math.min(...values)).toISOString() : null;
  };

  const oldestKrakenRecord = () => {
    const values = (syncProgress?.kraken ?? [])
      .map((cursor) => cursor.oldest ? Date.parse(cursor.oldest) : Number.NaN)
      .filter(Number.isFinite);
    return values.length > 0 ? new Date(Math.min(...values)).toISOString() : null;
  };

  const coverageFor = (job: SyncJob) => (
    syncProgress?.market.find((cursor) => (
      job.target === `${cursor.provider}:${cursor.asset}:${cursor.currency}:${cursor.granularitySeconds}`
    )) ?? null
  );

  const pollSync = async () => {
    try {
      const params = new URLSearchParams({
        failedQuery: failedJobSearch,
        failedType: failedJobType,
        failedPage: String(failedJobPage),
        failedPageSize: String(failedJobPageSize)
      });
      const payload = await apiRequest<{ progress: SyncProgress }>({
        url: `/api/sync/progress?${params}`
      });
      syncProgress = payload.progress;
      failedJobPage = payload.progress.failedJobs.page;
    } catch {
      // Keep the last successful progress snapshot while the next poll retries.
    }
  };

  const load = async () => {
    error = '';
    try {
      const [settingsPayload, storagePayload, providerPayload, progressPayload] = await Promise.all([
        apiRequest<{ settings: Settings }>({ url: '/api/settings' }),
        apiRequest<{ storage: NonNullable<typeof storage> }>({ url: '/api/diagnostics/storage' }),
        apiRequest<{ providers: unknown }>({ url: '/api/providers/status' }),
        apiRequest<{ progress: SyncProgress }>({ url: '/api/sync/progress' })
      ]);
      settings = settingsPayload.settings;
      tooltipCurrencyText = settings.tooltipCurrencies.join(', ');
      originalRetentionDays = settings.retentionDays;
      retentionMode = settings.retentionDays === null ? 'forever' : 'limited';
      originalFailedJobRetentionHours = settings.failedJobRetentionHours;
      failedJobRetentionValue = settings.failedJobRetentionHours === null
        ? 'forever'
        : String(settings.failedJobRetentionHours);
      storage = storagePayload.storage;
      providers = providerPayload.providers;
      syncProgress = progressPayload.progress;
      pageOrder = normalizeOrder({ saved: settings.pageLayouts.settings, defaults: defaultPageOrder });
      setDocumentPreferences(settings);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Settings failed to load.';
    }
  };

  const save = async () => {
    saving = true;
    error = '';
    message = '';
    try {
      const tooltipCurrencies = [...new Set(
        tooltipCurrencyText.split(',').map((currency) => currency.trim().toUpperCase()).filter(Boolean)
      )].slice(0, 5);
      const retentionDays = retentionMode === 'forever'
        ? null
        : Math.max(1, Math.round(Number(settings.retentionDays ?? 365)));
      const failedJobRetentionHours = failedJobRetentionValue === 'forever'
        ? null
        : Number(failedJobRetentionValue);
      if (
        retentionDays !== null
        && retentionDays !== originalRetentionDays
        && !confirm(
          `Keep only ${retentionDays} days of market points and derived portfolio snapshots? `
          + 'Older points will be permanently removed. Transactions, exchange activity, and cost-basis records are preserved.'
        )
      ) {
        return;
      }
      if (
        failedJobRetentionHours !== null
        && failedJobRetentionHours !== originalFailedJobRetentionHours
        && !confirm(`Remove failed synchronization jobs older than ${failedJobRetentionHours} hours? This cannot be undone.`)
      ) {
        return;
      }
      const payload = await apiRequest<{ settings: Settings }>({
        url: '/api/settings',
        method: 'PATCH',
        body: {
          locale: settings.locale,
          timezone: settings.timezone,
          theme: settings.theme,
          font: settings.font,
          contentWidth: settings.contentWidth,
          primaryCurrency: settings.primaryCurrency,
          tooltipCurrencies,
          marketSource: settings.marketSource,
          providerDisagreementThresholdPercent: settings.providerDisagreementThresholdPercent,
          costBasisMethod: settings.costBasisMethod,
          retentionDays,
          failedJobRetentionHours,
          pollingIntervalsMinutes: settings.pollingIntervalsMinutes
        }
      });
      settings = payload.settings;
      originalRetentionDays = settings.retentionDays;
      originalFailedJobRetentionHours = settings.failedJobRetentionHours;
      failedJobRetentionValue = settings.failedJobRetentionHours === null
        ? 'forever'
        : String(settings.failedJobRetentionHours);
      tooltipCurrencyText = settings.tooltipCurrencies.join(', ');
      setDocumentPreferences(settings);
      message = settings.retentionDays === null
        ? 'Settings saved. Historical points and snapshots will be kept forever.'
        : `Settings saved. Historical points and snapshots are limited to ${settings.retentionDays} days.`;
      const storagePayload = await apiRequest<{ storage: NonNullable<typeof storage> }>({
        url: '/api/diagnostics/storage'
      });
      storage = storagePayload.storage;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Settings could not be saved.';
    } finally {
      saving = false;
    }
  };

  const moveBlock = async (event: CustomEvent<{ id: string; direction: 'up' | 'down' }>) => {
    pageOrder = moveInOrder({ order: pageOrder, id: event.detail.id, direction: event.detail.direction });
    settings.pageLayouts = { ...settings.pageLayouts, settings: pageOrder };
    settings = { ...settings };
    await savePreferences({ pageLayouts: settings.pageLayouts });
  };

  const toggleBlockCollapse = async (event: CustomEvent<{ id: string }>) => {
    const collapsed = toggleCollapsed({
      collapsed: settings.collapsedBlocks.settings ?? [],
      id: event.detail.id
    });
    settings.collapsedBlocks = { ...settings.collapsedBlocks, settings: collapsed };
    settings = { ...settings };
    await savePreferences({ collapsedBlocks: settings.collapsedBlocks });
  };

  const showDismissedMessages = async () => {
    if (settings.dismissedNotices.length === 0) return;
    error = '';
    message = '';
    const restoredCount = settings.dismissedNotices.length;
    try {
      await savePreferences({ dismissedNotices: [] });
      settings = {
        ...settings,
        dismissedNotices: []
      };
      message = `${restoredCount} dismissed message${restoredCount === 1 ? '' : 's'} restored. Revisit the relevant page to see ${restoredCount === 1 ? 'it' : 'them'}.`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Dismissed messages could not be restored.';
    }
  };

  const saveGraphPreferences = async () => {
    const duplicate = settings.savedGraphs.find((graph) => (
      savedGraphNameExists({
        savedGraphs: settings.savedGraphs,
        name: graph.name,
        excludingId: graph.id
      })
    ));
    if (duplicate) {
      error = `A dashboard item named “${duplicate.name.trim()}” already exists. Choose a unique name.`;
      message = '';
      return;
    }
    try {
      await savePreferences({
        savedGraphs: settings.savedGraphs,
        dashboardRows: settings.dashboardRows
      });
      settings = { ...settings };
      error = '';
      message = 'Dashboard item settings saved.';
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Dashboard item settings could not be saved.';
      message = '';
    }
  };

  const toggleGraph = (id: string) => {
    settings.savedGraphs = settings.savedGraphs.map((graph) => (
      graph.id === id ? { ...graph, hidden: !graph.hidden } : graph
    ));
    settings = { ...settings };
  };

  const deleteGraph = (graph: SavedGraph) => {
    if (!confirm(`Delete the saved dashboard item “${graph.name}”?`)) return;
    settings.savedGraphs = settings.savedGraphs.filter((item) => item.id !== graph.id);
    settings.dashboardRows = settings.dashboardRows.map((row) => ({
      ...row,
      itemIds: row.itemIds.filter((id) => id !== graph.id)
    }));
    settings = { ...settings };
  };

  const pollExport = async () => {
    if (!exportState?.id) return;
    try {
      const payload = await apiRequest<{ export: typeof exportState }>({
        url: `/api/exports/application/${exportState.id}`
      });
      exportState = payload.export;
      if (['completed', 'failed'].includes(exportState?.status ?? '') && exportTimer) {
        clearInterval(exportTimer);
        exportTimer = null;
      }
    } catch {
      if (exportTimer) clearInterval(exportTimer);
      exportTimer = null;
    }
  };

  const startExport = async () => {
    error = '';
    const payload = await apiRequest<{ export: { id: string; status: string } }>({
      url: '/api/exports/application',
      method: 'POST',
      body: {}
    });
    exportState = payload.export;
    if (exportTimer) clearInterval(exportTimer);
    exportTimer = setInterval(() => void pollExport(), 1_000);
  };

  const applyFailedJobFilters = () => {
    failedJobPage = 1;
    void pollSync();
  };

  const setFailedJobPageSize = (pageSize: number) => {
    failedJobPageSize = pageSize;
    failedJobPage = 1;
    void pollSync();
  };

  const changeFailedJobPage = (direction: -1 | 1) => {
    const pageCount = syncProgress?.failedJobs.pageCount ?? 1;
    failedJobPage = Math.min(pageCount, Math.max(1, failedJobPage + direction));
    void pollSync();
  };

  onMount(() => {
    void load();
    syncTimer = setInterval(() => void pollSync(), 3_000);
    return () => {
      if (exportTimer) clearInterval(exportTimer);
      if (syncTimer) clearInterval(syncTimer);
    };
  });
</script>

<main class="page">
  <header>
    <p class="eyebrow">Instance preferences and diagnostics</p>
    <h1>{strings['cryptotracker-settings-title']}</h1>
    <p class="muted">Secrets, provider credentials, and trusted-proxy material are startup-only and never appear here.</p>
  </header>

  {#if error}<div class="alert danger" role="alert">{error}</div>{/if}
  {#if message}<div class="alert mid" role="status">{message}</div>{/if}

  {#each pageOrder as blockId, index}
    <ReorderableBlock
      {blockId}
      label={blockId}
      {index}
      total={pageOrder.length}
      collapsed={settings.collapsedBlocks.settings?.includes(blockId) ?? false}
      on:move={moveBlock}
      on:toggle={toggleBlockCollapse}
    >
      {#if blockId === 'preferences'}
        <section class="panel">
          <p class="eyebrow">User context</p>
          <h2>Locale, appearance, currency, and calculations</h2>
          <form class="settings-form" on:submit|preventDefault={save}>
            <fieldset>
              <legend>Time and locale</legend>
              <div class="settings-grid two">
                <div class="field">
                  <label for="locale">Locale</label>
                  <input id="locale" bind:value={settings.locale} />
                </div>
                <div class="field">
                  <label for="timezone">Timezone</label>
                  <input id="timezone" bind:value={settings.timezone} />
                </div>
              </div>
            </fieldset>

            <fieldset>
              <legend>Appearance</legend>
              <div class="settings-grid three">
                <div class="field">
                  <label for="theme">Theme</label>
                  <select id="theme" bind:value={settings.theme} on:change={() => setDocumentPreferences(settings)}>
                    <option value="dark">Dark</option>
                    <option value="light">Light</option>
                  </select>
                </div>
                <div class="field">
                  <label for="font">Font</label>
                  <select id="font" bind:value={settings.font} on:change={() => setDocumentPreferences(settings)}>
                    <option value="ui-mono">UI mono stack</option>
                    <option value="generic-mono">Generic mono</option>
                    <option value="sf-mono">SF Mono</option>
                    <option value="menlo">Menlo</option>
                    <option value="monaco">Monaco</option>
                    <option value="cascadia-mono">Cascadia Mono</option>
                    <option value="consolas">Consolas</option>
                    <option value="courier-new">Courier New</option>
                  </select>
                </div>
                <div class="field">
                  <label for="content-width">Content width</label>
                  <select id="content-width" bind:value={settings.contentWidth} on:change={() => setDocumentPreferences(settings)}>
                    <option value="min">Minimum</option>
                    <option value="1080">1080px</option>
                    <option value="standard">Standard</option>
                    <option value="1440">1440px</option>
                    <option value="1920">1920px</option>
                    <option value="full">Full</option>
                  </select>
                </div>
              </div>
            </fieldset>

            <fieldset>
              <legend>Currencies and market data</legend>
              <div class="settings-grid">
                <div class="field">
                  <label for="primary-currency">Primary currency</label>
                  <input id="primary-currency" maxlength="3" bind:value={settings.primaryCurrency} />
                </div>
                <div class="field span-two">
                  <label for="tooltip-currencies">Displayed currencies (up to five, comma separated)</label>
                  <input id="tooltip-currencies" bind:value={tooltipCurrencyText} />
                </div>
                <div class="field">
                  <label for="market-source">Default provider</label>
                  <select id="market-source" bind:value={settings.marketSource}>
                    <option value="combined">Combined</option>
                    <option value="coingecko">CoinGecko</option>
                    <option value="coinbase">Coinbase</option>
                    <option value="kraken">Kraken</option>
                  </select>
                </div>
              </div>
            </fieldset>

            <fieldset>
              <legend>Calculations</legend>
              <div class="settings-grid two">
                <div class="field">
                  <label for="disagreement">Provider disagreement threshold %</label>
                  <input id="disagreement" type="number" min="0" step="0.1" bind:value={settings.providerDisagreementThresholdPercent} />
                </div>
                <div class="field">
                  <label for="cost-basis">Cost basis method</label>
                  <select id="cost-basis" bind:value={settings.costBasisMethod}>
                    <option value="acb">Average cost basis</option>
                    <option value="fifo">FIFO</option>
                    <option value="lifo">LIFO</option>
                  </select>
                </div>
              </div>
            </fieldset>

            <fieldset>
              <legend>Dismissed messages</legend>
              <div class="dismissed-message-controls">
                <p class="muted">
                  {settings.dismissedNotices.length === 0
                    ? 'No messages are currently dismissed.'
                    : `${settings.dismissedNotices.length} message${settings.dismissedNotices.length === 1 ? ' is' : 's are'} currently dismissed.`}
                </p>
                <button
                  class="secondary"
                  type="button"
                  disabled={settings.dismissedNotices.length === 0}
                  on:click={showDismissedMessages}
                >Show dismissed messages</button>
              </div>
            </fieldset>

            <fieldset>
              <legend>Automatic polling</legend>
              <div class="settings-grid three">
                <div class="field">
                  <label for="poll-coingecko">CoinGecko market prices</label>
                  <select id="poll-coingecko" bind:value={settings.pollingIntervalsMinutes.marketCoinGecko}>
                    {#each pollingIntervalOptions as option}
                      <option value={option.minutes}>{option.label}</option>
                    {/each}
                  </select>
                </div>
                <div class="field">
                  <label for="poll-coinbase">Coinbase market prices</label>
                  <select id="poll-coinbase" bind:value={settings.pollingIntervalsMinutes.marketCoinbase}>
                    {#each pollingIntervalOptions as option}
                      <option value={option.minutes}>{option.label}</option>
                    {/each}
                  </select>
                </div>
                <div class="field">
                  <label for="poll-kraken-market">Kraken public market prices</label>
                  <select id="poll-kraken-market" bind:value={settings.pollingIntervalsMinutes.marketKraken}>
                    {#each pollingIntervalOptions as option}
                      <option value={option.minutes}>{option.label}</option>
                    {/each}
                  </select>
                </div>
                <div class="field">
                  <label for="poll-addresses">Tracked address providers</label>
                  <select id="poll-addresses" bind:value={settings.pollingIntervalsMinutes.addresses}>
                    {#each pollingIntervalOptions as option}
                      <option value={option.minutes}>{option.label}</option>
                    {/each}
                  </select>
                </div>
                <div class="field">
                  <label for="poll-kraken-account">Kraken account and Earn</label>
                  <select id="poll-kraken-account" bind:value={settings.pollingIntervalsMinutes.krakenAccount}>
                    {#each pollingIntervalOptions as option}
                      <option value={option.minutes}>{option.label}</option>
                    {/each}
                  </select>
                </div>
                <div class="field">
                  <label for="poll-catalog">Market asset catalog</label>
                  <select id="poll-catalog" bind:value={settings.pollingIntervalsMinutes.assetCatalog}>
                    {#each pollingIntervalOptions as option}
                      <option value={option.minutes}>{option.label}</option>
                    {/each}
                  </select>
                </div>
              </div>
              <p class="muted retention-copy">
                Five minutes is the minimum and the default for Kraken account and Earn state,
                which has no upstream history to recover between observations. Saved changes take
                effect on the next scheduler check.
              </p>
            </fieldset>

            <fieldset>
              <legend>Historical data retention</legend>
              <div class="settings-grid three">
                <div class="field">
                  <label for="retention-mode">Maximum age</label>
                  <select id="retention-mode" bind:value={retentionMode}>
                    <option value="forever">Forever (default)</option>
                    <option value="limited">Limit by days</option>
                  </select>
                </div>
                {#if retentionMode === 'limited'}
                  <div class="field">
                    <label for="retention-days">Keep points and snapshots for</label>
                    <div class="suffix-input">
                      <input id="retention-days" type="number" min="1" max="36500" step="1" bind:value={settings.retentionDays} />
                      <span>days</span>
                    </div>
                  </div>
                {/if}
                <div class="field">
                  <label for="failed-job-retention">Remove failed synchronization jobs after</label>
                  <select id="failed-job-retention" bind:value={failedJobRetentionValue}>
                    <option value="1">1 hour</option>
                    <option value="24">1 day</option>
                    <option value="168">7 days</option>
                    <option value="720">1 month</option>
                    <option value="8760">1 year</option>
                    <option value="forever">Keep forever</option>
                  </select>
                </div>
              </div>
              <p class="muted retention-copy">Historical retention controls market points and derived portfolio snapshots. Failed-job retention only removes terminal failure records. Transactions, Kraken activity, address events, and cost-basis records are retained.</p>
            </fieldset>

            <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button>
          </form>
        </section>

      {:else if blockId === 'sync'}
        <section class="panel">
          <div class="sync-heading">
            <p class="eyebrow">Live synchronization</p>
            {#if syncProgress}
              <span class="muted sync-updated">Updated {formatDate(syncProgress.generatedAt)}</span>
            {/if}
            <h2>How far back each source has reached</h2>
          </div>
          <p class="muted">“Requested from” is the target start. “Oldest reached” is the earliest point currently stored. This panel refreshes every three seconds.</p>

          <details
            class="failed-jobs"
            open
            use:persistAccordionState={{ key: 'settings:failed-jobs', defaultOpen: true }}
          >
            <summary>Recent failed jobs ({syncProgress?.failedJobs.total ?? 0})</summary>
            <div class="details-body">
              <div class="diagnostic-filter-toolbar">
                <div class="field grow">
                  <label for="failed-job-search">Filter failed jobs</label>
                  <input
                    id="failed-job-search"
                    type="search"
                    placeholder="Job type, target, or error"
                    bind:value={failedJobSearch}
                    on:input={applyFailedJobFilters}
                  />
                </div>
                <div class="field">
                  <label for="failed-job-type">Job type</label>
                  <select id="failed-job-type" bind:value={failedJobType} on:change={applyFailedJobFilters}>
                    <option value="">All types</option>
                    {#each syncProgress?.failedJobs.types ?? [] as jobType}
                      <option value={jobType}>{jobType}</option>
                    {/each}
                  </select>
                </div>
                <div class="limit-buttons" aria-label="Failed jobs per page">
                  <span class="field-label">Rows</span>
                  <div class="pill-row">
                    {#each [10, 20, 50, 100] as pageSize}
                      <button
                        class={failedJobPageSize === pageSize ? 'start compact' : 'ghost compact'}
                        type="button"
                        aria-pressed={failedJobPageSize === pageSize}
                        on:click={() => setFailedJobPageSize(pageSize)}
                      >{pageSize}</button>
                    {/each}
                  </div>
                </div>
              </div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Job</th><th>Target</th><th>Last activity</th><th>Error</th></tr></thead>
                  <tbody>
                    {#if failedJobItems.length > 0}
                      {#each failedJobItems as job (job.id)}
                        <tr>
                          <td>{job.type}</td>
                          <td>{job.target}</td>
                          <td>{formatDate(job.updatedAt)}</td>
                          <td><code>{JSON.stringify(job.error)}</code></td>
                        </tr>
                      {/each}
                    {:else}
                      <tr>
                        <td colspan="4" class="muted empty-table-cell">No failed jobs match these filters.</td>
                      </tr>
                    {/if}
                  </tbody>
                </table>
              </div>
              <div class="pagination">
                <span class="muted">
                  Page {syncProgress?.failedJobs.page ?? 1} of {syncProgress?.failedJobs.pageCount ?? 1}
                </span>
                <button
                  class="ghost compact"
                  type="button"
                  disabled={(syncProgress?.failedJobs.page ?? 1) <= 1}
                  on:click={() => changeFailedJobPage(-1)}
                >Previous</button>
                <button
                  class="ghost compact"
                  type="button"
                  disabled={(syncProgress?.failedJobs.page ?? 1) >= (syncProgress?.failedJobs.pageCount ?? 1)}
                  on:click={() => changeFailedJobPage(1)}
                >Next</button>
              </div>
            </div>
          </details>

          <div class="card-grid">
            <article class="card">
              <span class="label">Active / pending</span>
              <strong class="stat">{activeJobs().length}</strong>
              <span>jobs</span>
            </article>
            <article class="card">
              <span class="label">Earliest market point</span>
              <strong>{formatDate(oldestMarketPoint())}</strong>
            </article>
            <article class="card">
              <span class="label">Earliest Kraken record</span>
              <strong>{formatDate(oldestKrakenRecord())}</strong>
            </article>
          </div>

          {#if activeJobs().length > 0}
            <div class="sync-jobs">
              {#each activeJobs() as job}
                {@const coverage = coverageFor(job)}
                <article class="card sync-job">
                  <div class="row">
                    <div>
                      <span class="badge {jobDisplayStatus(job) === 'running' ? 'start' : jobDisplayStatus(job) === 'queued' ? '' : 'warning'}">{jobDisplayStatus(job)}</span>
                      <strong>{job.type}</strong>
                    </div>
                    <span>{job.total === null ? `${job.current} processed` : `${job.current} / ${job.total}`}</span>
                  </div>
                  {#if job.percent !== null}
                    <progress max="100" value={job.percent}>{job.percent}%</progress>
                    <span class="muted">{job.percent.toFixed(2)}%</span>
                  {/if}
                  <dl class="coverage-grid">
                    <div><dt>Target</dt><dd>{job.target}</dd></div>
                    <div><dt>Requested from</dt><dd>{formatDate(job.requestedFrom)}</dd></div>
                    <div><dt>Requested to</dt><dd>{formatDate(job.requestedTo)}</dd></div>
                    <div><dt>Oldest reached</dt><dd>{formatDate(coverage?.oldest ?? null)}</dd></div>
                    <div><dt>Newest stored</dt><dd>{formatDate(coverage?.newest ?? null)}</dd></div>
                    <div><dt>Last activity</dt><dd>{formatDate(job.updatedAt)}</dd></div>
                  </dl>
                </article>
              {/each}
            </div>
          {:else}
            <div class="alert mid">No synchronization jobs are currently running or queued. The tables below show the latest stored coverage.</div>
          {/if}

          <details
            open
            use:persistAccordionState={{ key: 'settings:market-coverage', defaultOpen: true }}
          >
            <summary>Market coverage ({filteredMarketCoverage.length} of {syncProgress?.market.length ?? 0})</summary>
            <div class="details-body">
              <div class="diagnostic-filter-toolbar">
                <div class="field grow">
                  <label for="market-coverage-search">Filter market coverage</label>
                  <input
                    id="market-coverage-search"
                    type="search"
                    placeholder="Asset, provider, quote, granularity, state, or date"
                    bind:value={marketCoverageSearch}
                  />
                </div>
                <div class="field">
                  <label for="market-coverage-provider">Provider</label>
                  <select id="market-coverage-provider" bind:value={marketCoverageProvider}>
                    <option value="">All providers</option>
                    {#each marketCoverageProviders() as provider}
                      <option value={provider}>{provider}</option>
                    {/each}
                  </select>
                </div>
                <div class="field">
                  <label for="market-coverage-state">Coverage</label>
                  <select id="market-coverage-state" bind:value={marketCoverageState}>
                    <option value="">All states</option>
                    {#each marketCoverageStates() as state}
                      <option value={state}>{state}</option>
                    {/each}
                  </select>
                </div>
              </div>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr><th>Asset</th><th>Provider</th><th>Quote</th><th>Granularity</th><th>Oldest reached</th><th>Newest stored</th><th>Coverage</th><th>Last check</th></tr>
                  </thead>
                  <tbody>
                    {#if filteredMarketCoverage.length > 0}
                      {#each filteredMarketCoverage as cursor}
                        <tr>
                          <td>{cursor.asset}</td>
                          <td>{cursor.provider}</td>
                          <td>{cursor.currency}</td>
                          <td>{cursor.granularitySeconds}s</td>
                          <td>{formatDate(cursor.oldest)}</td>
                          <td>{formatDate(cursor.newest)}</td>
                          <td>{cursor.completeness}</td>
                          <td>{formatDate(cursor.lastSuccessfulSync)}</td>
                        </tr>
                      {/each}
                    {:else}
                      <tr>
                        <td colspan="8" class="muted empty-table-cell">No market coverage rows match these filters.</td>
                      </tr>
                    {/if}
                  </tbody>
                </table>
              </div>
            </div>
          </details>

          <details use:persistAccordionState={{ key: 'settings:kraken-coverage' }}>
            <summary>Kraken import coverage ({syncProgress?.kraken.length ?? 0})</summary>
            <div class="details-body table-wrap">
              <table>
                <thead><tr><th>Endpoint</th><th>Oldest reached</th><th>Newest stored</th><th>Coverage</th><th>Last check</th></tr></thead>
                <tbody>
                  {#each syncProgress?.kraken ?? [] as cursor}
                    <tr>
                      <td>{cursor.endpoint}</td>
                      <td>{formatDate(cursor.oldest)}</td>
                      <td>{formatDate(cursor.newest)}</td>
                      <td>{cursor.completeness}</td>
                      <td>{formatDate(cursor.lastSuccessfulSync)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </details>
        </section>

      {:else if blockId === 'storage'}
        <section class="panel">
          <p class="eyebrow">Storage diagnostics</p>
          <h2>Stored data</h2>
          {#if storage}
            <div class="card-grid">
              <article class="card">
                <span class="label">Database</span>
                <strong class="stat">{storage.databaseKind}</strong>
                <span>{formatBytes(storage.databaseEstimatedBytes)}</span>
              </article>
              <article class="card">
                <span class="label">Canonical + operational rows</span>
                <strong class="stat">{storage.totalRows.toLocaleString()}</strong>
              </article>
              <article class="card">
                <span class="label">Point retention</span>
                <strong>{settings.retentionDays === null ? 'Forever' : `${settings.retentionDays} days`}</strong>
              </article>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Category</th><th>Rows</th><th>Estimated bytes</th><th>Tables</th></tr></thead>
                <tbody>
                  {#each storage.categories as category}
                    <tr>
                      <td>{category.category}</td>
                      <td>{category.rowCount.toLocaleString()}</td>
                      <td>{formatBytes(category.estimatedBytes)}</td>
                      <td>{category.tables.map((table) => `${table.table} (${table.rowCount})`).join(', ')}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Category</th><th>Oldest retained</th><th>Newest retained</th></tr></thead>
                <tbody>
                  {#each storage.retainedRanges as retained}
                    <tr>
                      <td>{retained.category}</td>
                      <td>{formatDate(retained.oldest)}</td>
                      <td>{formatDate(retained.newest)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>

      {:else if blockId === 'graphs'}
        <section class="panel">
          <p class="eyebrow">Dashboard items</p>
          <h2>Saved chart and table visibility</h2>
          <p class="muted">Row placement and each row’s one-to-four-column layout are configured directly on the Dashboard.</p>
          {#if settings.savedGraphs.length > 0}
            <div class="saved-graph-list">
              {#each settings.savedGraphs as graph (graph.id)}
                <article class="card saved-graph">
                  <div class="field grow">
                    <label for={`graph-name-${graph.id}`}>Item name</label>
                    <input id={`graph-name-${graph.id}`} maxlength="120" bind:value={graph.name} />
                  </div>
                  <span class="badge start">{graph.type}</span>
                  <span class="badge">{graph.config.dashboardView === 'table' ? 'table' : 'chart'}</span>
                  <button class="ghost" type="button" on:click={() => toggleGraph(graph.id)}>{graph.hidden ? 'Show' : 'Hide'}</button>
                  <button class="danger" type="button" on:click={() => deleteGraph(graph)}>Delete</button>
                </article>
              {/each}
            </div>
          {:else}
            <p class="muted">No dashboard items have been saved yet. Save a chart or table from Markets, Addresses, or Kraken.</p>
          {/if}
          <button type="button" on:click={saveGraphPreferences}>Save dashboard item settings</button>
        </section>

      {:else if blockId === 'export'}
        <section class="panel">
          <p class="eyebrow">Data portability</p>
          <h2>Complete application export</h2>
          <div class="alert start">{strings['cryptotracker-export-backup_notice-label']}</div>
          <button type="button" disabled={exportState?.status === 'queued' || exportState?.status === 'running'} on:click={startExport}>
            {strings['cryptotracker-export-start-label']}
          </button>
          {#if exportState}
            <div class="export-status">
              <span class="badge {exportState.status === 'completed' ? 'mid' : exportState.status === 'failed' ? 'danger' : 'start'}">{exportState.status}</span>
              <span>{exportState.bytesWritten ? formatBytes(exportState.bytesWritten) : 'size pending'}</span>
              {#if exportState.downloadable}
                <a class="button secondary" href={`/api/exports/application/${exportState.id}/download`}>Download archive</a>
              {/if}
              {#if exportState.error}<pre>{JSON.stringify(exportState.error, null, 2)}</pre>{/if}
            </div>
          {/if}
        </section>

      {:else if blockId === 'providers'}
        <section class="panel">
          <p class="eyebrow">Provider diagnostics</p>
          <h2>Enablement, contribution, cooldown, and Kraken safety</h2>
          <details use:persistAccordionState={{ key: 'settings:provider-state' }}>
            <summary>Inspect provider state</summary>
            <div class="details-body"><pre>{JSON.stringify(providers, null, 2)}</pre></div>
          </details>
        </section>
      {/if}
    </ReorderableBlock>
  {/each}
</main>

<style>
  .settings-form {
    display: grid;
    gap: 1rem;
  }

  .dismissed-message-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .dismissed-message-controls p {
    margin: 0;
  }

  fieldset {
    min-width: 0;
    margin: 0;
    padding: 0.9rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  legend {
    padding: 0 0.45rem;
    color: var(--color-muted);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .settings-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    align-items: end;
    gap: 0.7rem;
  }

  .settings-grid.two {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .settings-grid.three {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .span-two {
    grid-column: span 2;
  }

  .suffix-input {
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }

  .suffix-input input {
    flex: 1 1 auto;
  }

  .retention-copy {
    margin: 0.7rem 0 0;
  }

  .table-wrap {
    margin-top: 1rem;
  }

  .sync-heading {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: baseline;
    column-gap: 1rem;
  }

  .sync-heading .eyebrow,
  .sync-heading h2 {
    grid-column: 1;
  }

  .sync-heading h2 {
    margin-bottom: 0;
  }

  .sync-updated {
    grid-column: 2;
    grid-row: 1;
    white-space: nowrap;
  }

  .failed-jobs {
    margin: 0.9rem 0 1rem;
  }

  .diagnostic-filter-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.7rem;
  }

  .limit-buttons {
    display: grid;
    gap: 0.3rem;
  }

  .field-label {
    color: var(--color-muted);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .pagination {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 0.55rem;
    margin-top: 0.7rem;
  }

  .empty-table-cell {
    padding: 1rem;
    text-align: center;
  }

  .sync-jobs,
  .saved-graph-list {
    display: grid;
    gap: 0.8rem;
    margin: 1rem 0;
  }

  .sync-job progress {
    width: calc(100% - 5rem);
    margin: 0.8rem 0.5rem 0.5rem 0;
  }

  .coverage-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.7rem;
    margin: 0.7rem 0 0;
  }

  .coverage-grid div {
    min-width: 0;
  }

  dt {
    color: var(--color-muted);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  dd {
    margin: 0.1rem 0 0;
    overflow-wrap: anywhere;
  }

  .saved-graph {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.7rem;
  }

  .export-status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.8rem;
    margin-top: 1rem;
  }

  pre {
    max-height: 24rem;
    overflow: auto;
    white-space: pre-wrap;
  }

  @media (max-width: 60rem) {
    .sync-heading {
      grid-template-columns: 1fr;
    }

    .sync-updated {
      grid-column: 1;
      grid-row: auto;
    }

    .settings-grid,
    .settings-grid.three,
    .coverage-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .span-two {
      grid-column: auto;
    }
  }

  @media (max-width: 38rem) {
    .settings-grid,
    .settings-grid.two,
    .settings-grid.three,
    .coverage-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
