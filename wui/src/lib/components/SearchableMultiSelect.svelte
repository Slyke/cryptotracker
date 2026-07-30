<script lang="ts">
  import { createEventDispatcher, tick } from 'svelte';
  import {
    filterChartAxisOptions,
    type ChartAxisOption
  } from '$lib/chart-axis-options';

  export let id: string;
  export let value: string[] = [];
  export let options: ChartAxisOption[] = [];
  export let disabled = false;
  export let label = 'options';
  export let maximum = 5;

  const dispatch = createEventDispatcher<{ change: { value: string[] } }>();
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let searchInput: HTMLInputElement;
  let open = false;
  let query = '';
  let filteredOptions: ChartAxisOption[] = [];
  let limitMessage = '';

  $: filteredOptions = filterChartAxisOptions({ options, query });
  $: selectedLabels = value.map((selectedValue) => (
    options.find((option) => option.value === selectedValue)?.label ?? selectedValue
  ));
  $: triggerLabel = value.length === 0
    ? 'None selected'
    : value.length === 1
      ? selectedLabels[0]!
      : `${value.length} selected · ${selectedLabels.join(', ')}`;

  const openDropdown = async () => {
    if (disabled) return;
    query = '';
    limitMessage = '';
    open = true;
    await tick();
    searchInput?.focus();
  };

  const closeDropdown = async ({ restoreFocus = false } = {}) => {
    open = false;
    query = '';
    limitMessage = '';
    if (restoreFocus) {
      await tick();
      trigger?.focus();
    }
  };

  const toggleOption = (option: ChartAxisOption) => {
    if (value.includes(option.value)) {
      value = value.filter((selectedValue) => selectedValue !== option.value);
      limitMessage = '';
    } else {
      if (value.length >= maximum) {
        limitMessage = `Choose up to ${maximum} popup units. Untick one before adding another.`;
        return;
      }
      value = [...value, option.value];
      limitMessage = '';
    }
    dispatch('change', { value });
  };

  const handleOutsidePointer = (event: PointerEvent) => {
    if (
      open
      && event.target instanceof Node
      && !root?.contains(event.target)
    ) void closeDropdown();
  };

  const handleFocusOut = (event: FocusEvent) => {
    if (
      open
      && event.relatedTarget instanceof Node
      && !root?.contains(event.relatedTarget)
    ) void closeDropdown();
  };

  const handleSearchKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    void closeDropdown({ restoreFocus: true });
  };

  const optionId = (option: ChartAxisOption) => (
    `${id}-option-${option.value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`
  );
</script>

<svelte:window on:pointerdown={handleOutsidePointer} />

<div class="searchable-multi-select" bind:this={root} on:focusout={handleFocusOut}>
  <button
    class="select-trigger"
    bind:this={trigger}
    type="button"
    {id}
    {disabled}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-controls={`${id}-listbox`}
    on:click={() => (open ? void closeDropdown() : void openDropdown())}
  >
    <span>{triggerLabel}</span>
    <span class="chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
  </button>

  {#if open}
    <div class="select-popover">
      <label class="sr-only" for={`${id}-search`}>Search {label}</label>
      <input
        bind:this={searchInput}
        id={`${id}-search`}
        type="search"
        placeholder={`Search ${label}`}
        autocomplete="off"
        aria-controls={`${id}-listbox`}
        bind:value={query}
        on:keydown={handleSearchKeydown}
      />
      <div
        class="select-options"
        id={`${id}-listbox`}
        role="listbox"
        aria-label={label}
        aria-multiselectable="true"
      >
        {#each filteredOptions as option, index (option.value)}
          {#if index === 0 || filteredOptions[index - 1]?.group !== option.group}
            <div class="option-group" aria-hidden="true">{option.group}</div>
          {/if}
          <button
            class="select-option"
            id={optionId(option)}
            type="button"
            role="option"
            aria-selected={value.includes(option.value)}
            on:click={() => toggleOption(option)}
          >
            <span class="tick" aria-hidden="true">{value.includes(option.value) ? '✓' : ''}</span>
            <span>{option.label}</span>
          </button>
        {/each}
        {#if filteredOptions.length === 0}
          <p class="no-results" role="status">No {label} match “{query}”.</p>
        {/if}
      </div>
      <div class="selection-footer">
        <span>{value.length} of {maximum} selected</span>
        {#if value.length > 0}
          <button
            class="ghost compact"
            type="button"
            on:click={() => {
              value = [];
              limitMessage = '';
              dispatch('change', { value });
            }}
          >Clear</button>
        {/if}
      </div>
      {#if limitMessage}<p class="limit-message" role="status">{limitMessage}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .searchable-multi-select {
    position: relative;
    min-width: min(100%, 20rem);
  }

  .select-trigger {
    --button-bg: var(--color-panel-strong);
    --button-border: var(--color-border);
    --button-text: var(--color-text);
    --button-hover-bg: var(--color-panel-strong);
    --button-hover-border: var(--color-start);
    width: 100%;
    min-height: 2.75rem;
    justify-content: space-between;
    padding: 0.55rem 0.75rem;
    border-bottom-width: 1px;
    box-shadow: none;
    font-weight: 400;
    letter-spacing: 0;
    text-align: left;
  }

  .select-trigger:hover,
  .select-trigger:active {
    box-shadow: none;
    transform: none;
  }

  .select-trigger::before {
    display: none;
  }

  .select-trigger span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chevron {
    color: var(--color-muted);
  }

  .select-popover {
    position: absolute;
    z-index: 45;
    top: calc(100% + 0.35rem);
    left: 0;
    width: min(30rem, calc(100vw - 2rem));
    padding: 0.65rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-panel-strong);
    box-shadow: var(--shadow-panel);
  }

  .select-options {
    display: grid;
    max-height: 20rem;
    margin-top: 0.5rem;
    overflow-y: auto;
  }

  .option-group {
    padding: 0.6rem 0.55rem 0.25rem;
    color: var(--color-muted);
    font-size: 0.7rem;
    font-weight: 800;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .select-option {
    --button-bg: transparent;
    --button-border: transparent;
    --button-text: var(--color-text);
    --button-hover-bg: var(--color-start-fill);
    --button-hover-border: var(--color-start-border);
    display: grid;
    grid-template-columns: 1.35rem minmax(0, 1fr);
    justify-content: stretch;
    width: 100%;
    min-height: 2.35rem;
    padding: 0.45rem 0.55rem;
    border-bottom-width: 1px;
    box-shadow: none;
    font-weight: 500;
    letter-spacing: 0;
    text-align: left;
  }

  .select-option:hover,
  .select-option:active {
    border-color: var(--color-start-border);
    background: var(--color-start-fill);
    box-shadow: none;
    transform: none;
  }

  .tick {
    color: var(--color-start);
    font-weight: 900;
  }

  .selection-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    min-height: 2.3rem;
    padding: 0.45rem 0.2rem 0;
    color: var(--color-muted);
    font-size: 0.82rem;
  }

  .limit-message,
  .no-results {
    margin: 0.5rem 0.35rem;
    color: var(--color-mid);
    font-size: 0.82rem;
  }
</style>
