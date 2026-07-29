<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  interface AssetOption {
    canonicalId: string;
    symbol: string;
    name: string;
    marketCapRank?: number | null;
  }

  export let assets: AssetOption[] = [];
  export let open = false;
  export let label = 'Enable an asset';
  let query = '';
  let results: AssetOption[] = [];

  const dispatch = createEventDispatcher<{ select: { canonicalId: string } }>();

  $: {
    const normalized = query.trim().toLowerCase();
    results = assets.filter((asset) => (
      !normalized
      || asset.symbol.toLowerCase().includes(normalized)
      || asset.name.toLowerCase().includes(normalized)
      || asset.canonicalId.toLowerCase().includes(normalized)
      || String(asset.marketCapRank ?? '').includes(normalized)
    ));
  }

  const select = (canonicalId: string) => {
    dispatch('select', { canonicalId });
    query = '';
    open = false;
  };
</script>

<details class="asset-picker" id="asset-catalog" bind:open>
  <summary>{label} <span class="muted">({assets.length} disabled)</span></summary>
  <div class="picker-dropdown">
    <div class="field">
      <label for="asset-catalog-search">Search catalog</label>
      <input
        id="asset-catalog-search"
        type="search"
        placeholder="Symbol, name, rank, or canonical ID"
        autocomplete="off"
        bind:value={query}
      />
    </div>
    <div class="asset-results" role="listbox" aria-label="Disabled catalog assets">
      {#each results as asset (asset.canonicalId)}
        <button
          class="asset-result ghost"
          type="button"
          role="option"
          aria-selected="false"
          on:click={() => select(asset.canonicalId)}
        >
          <span class="rank">#{asset.marketCapRank ?? '—'}</span>
          <strong>{asset.symbol}</strong>
          <span>{asset.name}</span>
        </button>
      {/each}
      {#if results.length === 0}
        <p class="muted">No disabled assets match “{query}”.</p>
      {/if}
    </div>
  </div>
</details>

<style>
  .asset-picker {
    position: relative;
    width: min(100%, 30rem);
  }

  .asset-picker > summary {
    min-height: 2.35rem;
  }

  .picker-dropdown {
    position: absolute;
    z-index: 30;
    top: calc(100% + 0.35rem);
    left: 0;
    width: min(42rem, calc(100vw - 3rem));
    padding: 0.75rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-panel-strong);
    box-shadow: var(--shadow-panel);
  }

  .asset-results {
    display: grid;
    gap: 0.3rem;
    max-height: 22rem;
    margin-top: 0.6rem;
    overflow-y: auto;
  }

  .asset-result {
    display: grid;
    grid-template-columns: 3.5rem 4rem minmax(0, 1fr);
    align-items: center;
    width: 100%;
    text-align: left;
  }

  .rank {
    color: var(--color-muted);
  }
</style>
