<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { persistAccordionState } from '$lib/accordion-state';

  interface ColumnOption {
    id: string;
    label: string;
    description?: string;
  }

  export let label = 'Configure columns';
  export let columns: ColumnOption[] = [];
  export let selected: string[] = [];
  export let defaults: string[] = [];
  let query = '';
  let filteredColumns: ColumnOption[] = [];

  const dispatch = createEventDispatcher<{ change: { selected: string[] } }>();

  $: {
    const normalized = query.trim().toLowerCase();
    filteredColumns = columns.filter((column) => (
      !normalized
      || column.label.toLowerCase().includes(normalized)
      || column.id.toLowerCase().includes(normalized)
      || column.description?.toLowerCase().includes(normalized)
    ));
  }

  const setSelected = (next: string[]) => {
    const known = new Set(columns.map((column) => column.id));
    selected = next.filter((id, index, values) => known.has(id) && values.indexOf(id) === index);
    dispatch('change', { selected });
  };

  const toggle = ({ id }: { id: string }) => {
    setSelected(selected.includes(id)
      ? selected.filter((columnId) => columnId !== id)
      : [...selected, id]);
  };

  const move = ({ id, direction }: { id: string; direction: 'left' | 'right' }) => {
    const index = selected.indexOf(id);
    const destination = direction === 'left' ? index - 1 : index + 1;
    if (index < 0 || destination < 0 || destination >= selected.length) return;
    const next = [...selected];
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    setSelected(next);
  };
</script>

<details
  class="column-configurator"
  use:persistAccordionState={{
    key: `columns:${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`
  }}
>
  <summary>{label} ({selected.length}/{columns.length})</summary>
  <div class="details-body">
    <div class="toolbar">
      <div class="field grow">
        <label for="column-search">Search columns</label>
        <input
          id="column-search"
          type="search"
          placeholder="Price, return, value…"
          autocomplete="off"
          bind:value={query}
        />
      </div>
      <button class="ghost compact" type="button" on:click={() => setSelected(defaults)}>Defaults</button>
      <button class="ghost compact" type="button" on:click={() => setSelected(columns.map((column) => column.id))}>All</button>
      <button class="ghost compact" type="button" on:click={() => setSelected([])}>None</button>
    </div>
    <p class="search-count muted" aria-live="polite">
      {filteredColumns.length} column{filteredColumns.length === 1 ? '' : 's'} shown
    </p>
    <div class="column-options">
      {#each filteredColumns as column (column.id)}
        {@const selectedIndex = selected.indexOf(column.id)}
        <div class="column-option">
          <label class="option-selection">
            <input
              type="checkbox"
              checked={selectedIndex >= 0}
              on:change={() => toggle({ id: column.id })}
            />
            <span>
              <strong>{column.label}</strong>
              {#if column.description}<small>{column.description}</small>{/if}
            </span>
          </label>
          {#if selectedIndex >= 0}
            <div class="column-order-actions" aria-label={`Reorder ${column.label}`}>
              <button
                class="ghost compact"
                type="button"
                title={`Move ${column.label} left`}
                aria-label={`Move ${column.label} left`}
                disabled={selectedIndex === 0}
                on:click={() => move({ id: column.id, direction: 'left' })}
              >←</button>
              <button
                class="ghost compact"
                type="button"
                title={`Move ${column.label} right`}
                aria-label={`Move ${column.label} right`}
                disabled={selectedIndex === selected.length - 1}
                on:click={() => move({ id: column.id, direction: 'right' })}
              >→</button>
            </div>
          {/if}
        </div>
      {/each}
      {#if filteredColumns.length === 0}
        <p class="muted">No columns match “{query}”.</p>
      {/if}
    </div>
  </div>
</details>

<style>
  .column-configurator {
    margin: 0.8rem 0;
  }

  .search-count {
    margin: 0.55rem 0 0;
    font-size: 0.78rem;
  }

  .column-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr));
    gap: 0.45rem;
    margin-top: 0.55rem;
  }

  .column-option {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.55rem;
    min-height: 4.4rem;
    padding: 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    color: var(--color-text);
    font-size: 0.82rem;
  }

  .option-selection {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: 0.55rem;
    min-width: 0;
    color: var(--color-text);
    font-size: inherit;
    letter-spacing: 0;
    text-transform: none;
    cursor: pointer;
  }

  .option-selection input[type="checkbox"] {
    width: 1.15rem;
    height: 1.15rem;
    min-height: 1.15rem;
    margin: 0.08rem 0 0;
    padding: 0;
  }

  .option-selection span,
  .option-selection small {
    display: block;
  }

  .option-selection small {
    margin-top: 0.15rem;
    color: var(--color-muted);
  }

  .column-order-actions {
    display: flex;
    gap: 0.25rem;
  }

  .column-order-actions button {
    width: 1.85rem;
    min-height: 1.85rem;
    padding: 0.1rem;
  }
</style>
