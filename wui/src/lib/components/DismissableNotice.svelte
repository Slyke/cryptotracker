<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let noticeId: string;
  export let tone: 'start' | 'mid' | 'warning' | 'danger' = 'start';
  export let dismissed = false;

  const dispatch = createEventDispatcher<{ dismiss: { id: string } }>();
</script>

{#if !dismissed}
  <div class="alert {tone} dismissable" role="note">
    <div><slot /></div>
    <button
      type="button"
      class="ghost compact close"
      aria-label="Dismiss notice"
      title="Dismiss"
      on:click={() => dispatch('dismiss', { id: noticeId })}
    >Dismiss</button>
  </div>
{/if}

<style>
  .dismissable {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 0.8rem;
  }

  .close {
    width: auto;
    min-height: 2rem;
    padding: 0.25rem 0.55rem;
    font-size: 0.75rem;
    line-height: 1;
  }
</style>
