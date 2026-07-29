<script lang="ts">
  import { createEventDispatcher, tick } from 'svelte';
  import {
    filterChartAxisOptions,
    type ChartAxisOption
  } from '$lib/chart-axis-options';

  export let id: string;
  export let value: string;
  export let options: ChartAxisOption[] = [];
  export let disabled = false;
  export let label = 'option';

  const dispatch = createEventDispatcher<{ change: { value: string } }>();
  let root: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let searchInput: HTMLInputElement;
  let open = false;
  let query = '';
  let filteredOptions: ChartAxisOption[] = [];
  let activeIndex = 0;

  $: {
    filteredOptions = filterChartAxisOptions({ options, query });
    activeIndex = 0;
  }
  $: selectedLabel = options.find((option) => option.value === value)?.label ?? value;

  const openDropdown = async () => {
    if (disabled) return;
    query = '';
    open = true;
    await tick();
    searchInput?.focus();
  };

  const closeDropdown = async ({ restoreFocus = false } = {}) => {
    open = false;
    query = '';
    if (restoreFocus) {
      await tick();
      trigger?.focus();
    }
  };

  const selectOption = async (option: ChartAxisOption) => {
    value = option.value;
    dispatch('change', { value });
    await closeDropdown({ restoreFocus: true });
  };

  const handleTriggerKeydown = (event: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    void openDropdown();
  };

  const handleSearchKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void closeDropdown({ restoreFocus: true });
      return;
    }
    if (filteredOptions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = (activeIndex + 1) % filteredOptions.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = (activeIndex - 1 + filteredOptions.length) % filteredOptions.length;
    } else if (event.key === 'Home') {
      event.preventDefault();
      activeIndex = 0;
    } else if (event.key === 'End') {
      event.preventDefault();
      activeIndex = filteredOptions.length - 1;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void selectOption(filteredOptions[activeIndex]!);
    }
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

  const optionId = (option: ChartAxisOption) => (
    `${id}-option-${option.value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`
  );
</script>

<svelte:window on:pointerdown={handleOutsidePointer} />

<div class="searchable-select" bind:this={root} on:focusout={handleFocusOut}>
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
    on:keydown={handleTriggerKeydown}
  >
    <span>{selectedLabel}</span>
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
        aria-activedescendant={filteredOptions[activeIndex]
          ? optionId(filteredOptions[activeIndex]!)
          : undefined}
        bind:value={query}
        on:keydown={handleSearchKeydown}
      />
      <div
        class="select-options"
        id={`${id}-listbox`}
        role="listbox"
        aria-label={label}
      >
        {#each filteredOptions as option, index (option.value)}
          {#if index === 0 || filteredOptions[index - 1]?.group !== option.group}
            <div class="option-group" aria-hidden="true">{option.group}</div>
          {/if}
          <button
            class:active={index === activeIndex}
            class="select-option"
            id={optionId(option)}
            type="button"
            role="option"
            aria-selected={option.value === value}
            on:mousemove={() => (activeIndex = index)}
            on:click={() => void selectOption(option)}
          >{option.label}</button>
        {/each}
        {#if filteredOptions.length === 0}
          <p class="no-results" role="status">No {label} matches “{query}”.</p>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .searchable-select {
    position: relative;
    min-width: min(100%, 17rem);
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
    z-index: 40;
    top: calc(100% + 0.35rem);
    left: 0;
    width: min(28rem, calc(100vw - 2rem));
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
    justify-content: flex-start;
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
  .select-option:active,
  .select-option.active {
    border-color: var(--color-start-border);
    background: var(--color-start-fill);
    box-shadow: none;
    transform: none;
  }

  .select-option[aria-selected="true"] {
    color: var(--color-start);
    font-weight: 800;
  }

  .no-results {
    margin: 0;
    padding: 0.8rem 0.55rem;
    color: var(--color-muted);
  }
</style>
