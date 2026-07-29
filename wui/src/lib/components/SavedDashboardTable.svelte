<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { apiRequest } from '$lib/api';
  import { formatDateTime, formatDisplayNumber, formatPercent, type SavedGraph } from '$lib/preferences';

  export let item: SavedGraph;
  export let minimalChrome = false;

  type Cell = string | number | null;
  const dispatch = createEventDispatcher<{ hide: { id: string } }>();
  type DashboardRow = Record<string, Cell>;
  let loading = true;
  let error = '';
  let rows: DashboardRow[] = [];
  let labels: Record<string, string> = {};
  let query = String(item.config.filter ?? '');
  let page = 1;
  const pageSize = 10;

  const configuredColumns = () => {
    const value = item.config.columns;
    return Array.isArray(value) ? value.map(String) : [];
  };
  const timezone = () => String(item.config.timezone ?? 'America/Vancouver');
  const currency = () => String(item.config.currency ?? item.config.primaryCurrency ?? 'CAD');
  const filteredRows = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return rows;
    return rows.filter((row) => Object.values(row).some((cell) =>
      String(cell ?? '').toLowerCase().includes(normalized)));
  };
  const pageCount = (value: string) => Math.max(1, Math.ceil(filteredRows(value).length / pageSize));
  const visibleRows = (value: string, pageNumber: number) => {
    const safePage = Math.min(pageNumber, pageCount(value));
    return filteredRows(value).slice((safePage - 1) * pageSize, safePage * pageSize);
  };

  const loadMarkets = async () => {
    const [catalogPayload, watchlistPayload] = await Promise.all([
      apiRequest<{
        assets: Array<{
          canonicalId: string;
          symbol: string;
          name: string;
          marketCapRank: number | null;
          source?: string;
        }>;
      }>({ url: '/api/catalog/assets' }),
      apiRequest<{
        assets: Array<{ canonicalId: string; enabled: boolean }>;
      }>({ url: '/api/watchlist/assets' })
    ]);
    const states = new Map(watchlistPayload.assets.map((asset) => [asset.canonicalId, asset.enabled]));
    labels = {
      asset: 'Asset',
      rank: 'Rank',
      identity: 'Canonical identity',
      state: 'State',
      source: 'Catalog source',
      action: 'Manage'
    };
    rows = catalogPayload.assets.map((asset) => ({
      asset: `${asset.symbol} · ${asset.name}`,
      rank: asset.marketCapRank ?? '—',
      identity: asset.canonicalId,
      state: states.get(asset.canonicalId) ? 'enabled' : 'disabled',
      source: asset.source ?? 'cached',
      action: 'Markets'
    }));
  };

  const loadKraken = async () => {
    const payload = await apiRequest<{
      holdings: Array<{
        assetRaw: string;
        assetId: string | null;
        category: string;
        quantity: string;
        valueCurrency: string | null;
        valueAmount: string | null;
        currentPrice: string | null;
        priced: boolean;
        pricingReason: string | null;
        capturedAt: string;
      }>;
    }>({ url: '/api/kraken/holdings' });
    labels = {
      asset: 'Asset',
      balance: 'Balance',
      pricing: 'Pricing',
      capturedAt: 'Snapshot',
      rawAsset: 'Raw Kraken asset'
    };
    rows = payload.holdings
      .filter((holding) => holding.category === 'spot')
      .map((holding) => {
        const row: DashboardRow = {
          asset: holding.assetId ?? holding.assetRaw,
          balance: formatDisplayNumber({ value: holding.quantity }),
          pricing: holding.priced ? 'priced' : `unpriced${holding.pricingReason ? ' ⓘ' : ''}`,
          capturedAt: formatDateTime({ value: holding.capturedAt, timezone: timezone() }),
          rawAsset: holding.assetRaw
        };
        for (const column of configuredColumns()) {
          if (column.startsWith('currentPrice:')) {
            const requested = column.split(':')[1]!;
            labels[column] = `Current price (${requested})`;
            row[column] = requested === holding.valueCurrency && holding.currentPrice !== null
              ? formatDisplayNumber({ value: holding.currentPrice, currency: requested })
              : 'unavailable';
          } else if (column.startsWith('walletValue:')) {
            const requested = column.split(':')[1]!;
            labels[column] = `Wallet value (${requested})`;
            row[column] = requested === holding.valueCurrency && holding.valueAmount !== null
              ? formatDisplayNumber({ value: holding.valueAmount, currency: requested })
              : 'unavailable';
          } else if (column.startsWith('averageBuyPrice:')) {
            labels[column] = `Average buy price (${column.split(':')[1]})`;
            row[column] = 'Open Kraken for cost basis';
          } else if (column.startsWith('change')) {
            labels[column] = column.replaceAll(/([A-Z])/g, ' $1').trim();
            row[column] = 'Open Kraken for market history';
          }
        }
        return row;
      });
  };

  const loadKrakenEarn = async () => {
    const payload = await apiRequest<{
      data: {
        summary: { currency: string };
        assets: Array<{
          assetId: string;
          label: string;
          quantity: string;
          valueAmount: string | null;
          currentValues: Record<string, string | null>;
          rewardQuantity: string;
          apyLowPercent: string | null;
          apyHighPercent: string | null;
          states: string[];
          capturedAt: string | null;
        }>;
        payoutDistribution: Array<{
          assetId: string;
          quantity: string;
          payoutCount: number;
          lastPayoutAt: string;
        }>;
      };
    }>({
      url: `/api/kraken/earn/series?from=0&to=${Date.now()}&quoteCurrencies=${encodeURIComponent([
        currency(),
        ...configuredColumns()
          .filter((column) => column.startsWith('currentValue:'))
          .map((column) => column.slice('currentValue:'.length))
      ].join(','))}`
    });
    labels = {
      asset: 'Asset',
      quantity: 'Staked quantity',
      apy: 'Estimated APY',
      currentValue: 'Current value',
      totalRewarded: 'Total rewarded',
      totalPaid: 'Payout distribution',
      payoutCount: 'Payouts',
      latestPayout: 'Latest payout',
      state: 'State',
      snapshot: 'Snapshot'
    };
    const payouts = new Map(
      payload.data.payoutDistribution.map((payout) => [payout.assetId, payout])
    );
    rows = payload.data.assets.map((asset) => {
      const payout = payouts.get(asset.assetId);
      const row: DashboardRow = {
        asset: asset.label,
        quantity: formatDisplayNumber({ value: asset.quantity }),
        apy: asset.apyLowPercent === null || asset.apyHighPercent === null
          ? 'unavailable'
          : asset.apyLowPercent === asset.apyHighPercent
            ? `${formatPercent(asset.apyLowPercent)}%`
            : `${formatPercent(asset.apyLowPercent)}–${formatPercent(asset.apyHighPercent)}%`,
        currentValue: asset.valueAmount === null
          ? 'unavailable'
          : formatDisplayNumber({
              value: asset.valueAmount,
              currency: payload.data.summary.currency
            }),
        totalRewarded: formatDisplayNumber({ value: asset.rewardQuantity }),
        totalPaid: payout
          ? formatDisplayNumber({ value: payout.quantity })
          : 'none imported',
        payoutCount: payout?.payoutCount ?? 0,
        latestPayout: payout
          ? formatDateTime({ value: payout.lastPayoutAt, timezone: timezone() })
          : 'none imported',
        state: asset.states.join(', ') || 'unavailable',
        snapshot: asset.capturedAt
          ? formatDateTime({ value: asset.capturedAt, timezone: timezone() })
          : 'unavailable'
      };
      for (const column of configuredColumns()) {
        if (!column.startsWith('currentValue:')) continue;
        const requested = column.slice('currentValue:'.length);
        labels[column] = `Current value (${requested})`;
        const value = asset.currentValues[requested];
        row[column] = value === null || value === undefined
          ? 'unavailable'
          : formatDisplayNumber({ value, currency: requested });
      }
      return row;
    });
  };

  const loadAddresses = async () => {
    const requestedCurrencies = [
      currency(),
      ...configuredColumns()
        .filter((column) => column.startsWith('value:'))
        .map((column) => column.slice('value:'.length))
    ];
    const payload = await apiRequest<{
      holdings: Array<{
        label: string;
        address: string;
        network: string;
        assetId: string;
        quantity: string;
        currentValue: string | null;
        currentValues: Record<string, string | null>;
        valueCurrency: string;
        pricedCoveragePercent: string;
        completeness: string;
        oldestReconstructedAt: string | null;
        lastSuccessfulSync: string | null;
      }>;
    }>({
      url: `/api/addresses/holdings?quoteCurrency=${currency()}&quoteCurrencies=${encodeURIComponent(requestedCurrencies.join(','))}`
    });
    labels = {
      label: 'Address label',
      address: 'Public address',
      network: 'Network',
      asset: 'Asset',
      quantity: 'Quantity',
      value: 'Current value',
      coverage: 'Pricing coverage',
      history: 'History state',
      oldest: 'Oldest reconstructed',
      lastSync: 'Last successful check'
    };
    rows = payload.holdings.map((holding) => {
      const row: DashboardRow = {
        label: holding.label,
        address: holding.address,
        network: holding.network,
        asset: holding.assetId,
        quantity: formatDisplayNumber({ value: holding.quantity }),
        value: holding.currentValue === null
          ? `unpriced (${holding.valueCurrency})`
          : formatDisplayNumber({
              value: holding.currentValue,
              currency: holding.valueCurrency
            }),
        coverage: `${formatPercent(holding.pricedCoveragePercent)}%`,
        history: holding.completeness,
        oldest: holding.oldestReconstructedAt
          ? formatDateTime({ value: holding.oldestReconstructedAt, timezone: timezone() })
          : 'not reached',
        lastSync: holding.lastSuccessfulSync
          ? formatDateTime({ value: holding.lastSuccessfulSync, timezone: timezone() })
          : 'not reached'
      };
      for (const column of configuredColumns()) {
        if (!column.startsWith('value:')) continue;
        const requested = column.slice('value:'.length);
        labels[column] = `Current value (${requested})`;
        const value = holding.currentValues[requested];
        row[column] = value === null || value === undefined
          ? `unpriced (${requested})`
          : formatDisplayNumber({ value, currency: requested });
      }
      return row;
    });
  };

  const load = async () => {
    loading = true;
    error = '';
    try {
      if (item.type === 'market') await loadMarkets();
      else if (item.type === 'kraken' && item.config.tableId === 'krakenEarnAssets') {
        await loadKrakenEarn();
      } else if (item.type === 'kraken') await loadKraken();
      else await loadAddresses();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : 'Saved table could not load.';
      rows = [];
    } finally {
      loading = false;
    }
  };

  onMount(() => {
    void load();
  });
</script>

<article class="saved-table">
  <div class="saved-table-header">
    <div>
      {#if !minimalChrome}
        <span class="badge start">{item.type}</span>
        <span class="badge">table</span>
      {/if}
      <h3 class:compact-title={minimalChrome}>{item.name}</h3>
    </div>
    <div class="table-actions">
      {#if !minimalChrome}
        <a class="button ghost compact" href={`/${item.type === 'market' ? 'markets' : item.type}`}>Open source</a>
      {/if}
      <button class="ghost compact" type="button" on:click={() => dispatch('hide', { id: item.id })}>Remove</button>
    </div>
  </div>
  {#if error}<div class="alert danger">{error}</div>{/if}
  <div class="field table-filter">
    <label for={`dashboard-table-filter-${item.id}`}>Filter rows</label>
    <input
      id={`dashboard-table-filter-${item.id}`}
      type="search"
      bind:value={query}
      on:input={() => (page = 1)}
    />
  </div>
  <div class="table-wrap dashboard-table" aria-busy={loading}>
    <table>
      <thead>
        <tr>
          {#each configuredColumns() as column}
            <th>{labels[column] ?? column}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each visibleRows(query, page) as row}
          <tr>
            {#each configuredColumns() as column}
              <td title={String(row[column] ?? 'unavailable')}>{row[column] ?? 'unavailable'}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <div class="table-pagination">
    <span class="muted">{filteredRows(query).length} rows</span>
    <button class="ghost compact" type="button" disabled={page <= 1} on:click={() => (page -= 1)}>Previous</button>
    <span>{Math.min(page, pageCount(query))}/{pageCount(query)}</span>
    <button class="ghost compact" type="button" disabled={page >= pageCount(query)} on:click={() => (page += 1)}>Next</button>
  </div>
</article>

<style>
  .saved-table {
    min-width: 0;
    padding: 1rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-panel);
  }

  .table-actions {
    display: flex;
    gap: 0.4rem;
  }

  .saved-table-header,
  .table-pagination {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.6rem;
  }

  h3 {
    margin: 0.35rem 0 0;
  }

  h3.compact-title {
    margin-top: 0;
  }

  .table-filter {
    margin-top: 0.8rem;
  }

  .dashboard-table {
    max-height: 24rem;
    margin-top: 0.7rem;
  }

  .dashboard-table td {
    max-width: 18rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .table-pagination {
    align-items: center;
    justify-content: flex-end;
    margin-top: 0.7rem;
  }
</style>
