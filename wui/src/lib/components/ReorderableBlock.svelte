<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let blockId: string;
  export let label: string;
  export let index: number;
  export let total: number;
  export let collapsed = false;
  export let hideControls = false;

  const dispatch = createEventDispatcher<{
    move: { id: string; direction: 'up' | 'down' };
    toggle: { id: string };
  }>();
</script>

<div
  class="reorderable-block"
  class:collapsed
  class:separated={index > 0}
  class:minimal={hideControls}
  data-block-id={blockId}
>
  {#if !hideControls}
    <div class="block-order" aria-label={`Rearrange ${label}`}>
      <span>{label}</span>
      <button
        class="ghost compact order-button"
        type="button"
        title={`Move ${label} up`}
        aria-label={`Move ${label} up`}
        disabled={index === 0}
        on:click={() => dispatch('move', { id: blockId, direction: 'up' })}
      >↑</button>
      <button
        class="ghost compact order-button"
        type="button"
        title={`Move ${label} down`}
        aria-label={`Move ${label} down`}
        disabled={index === total - 1}
        on:click={() => dispatch('move', { id: blockId, direction: 'down' })}
      >↓</button>
      <button
        class="ghost compact order-button collapse-button"
        type="button"
        title={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
        aria-expanded={!collapsed}
        on:click={() => dispatch('toggle', { id: blockId })}
      >{collapsed ? '+' : '−'}</button>
    </div>
  {/if}
  {#if !collapsed}
    <slot />
  {/if}
</div>

<style>
  .reorderable-block {
    position: relative;
    min-width: 0;
    padding: 0.85rem 0 1rem;
  }

  .reorderable-block.separated {
    margin-top: 0.75rem;
    padding-top: 1.15rem;
    border-top: 1px solid var(--color-border);
  }

  .reorderable-block.collapsed:not(:last-child) {
    padding-bottom: 0.85rem;
  }

  .reorderable-block.minimal {
    padding: 0.25rem 0;
  }

  .reorderable-block.minimal.separated {
    margin-top: 0.25rem;
    padding-top: 0.5rem;
  }

  .reorderable-block.minimal.collapsed:not(:last-child) {
    padding-bottom: 0.25rem;
  }

  .block-order {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.3rem;
    min-height: 2rem;
    margin-bottom: 0.65rem;
    color: var(--color-muted);
  }

  .collapsed .block-order {
    margin-bottom: 0.15rem;
  }

  .block-order span {
    max-width: min(18rem, 55vw);
    overflow: hidden;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .order-button {
    width: 2rem;
    min-height: 2rem;
    padding: 0.15rem;
    font-size: 1rem;
  }

  .collapse-button {
    margin-left: 0.15rem;
    font-weight: 800;
  }

  :global(.reorderable-block > .panel),
  :global(.reorderable-block > .chart-panel),
  :global(.reorderable-block > .card-grid),
  :global(.reorderable-block > .alert) {
    margin-top: 0;
  }
</style>
