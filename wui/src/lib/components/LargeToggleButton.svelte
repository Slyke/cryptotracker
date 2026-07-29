<script lang="ts">
  export let label: string;
  export let detail: string | null = null;
  export let pressed = false;
  export let unavailable = false;
  export let disabled = unavailable;
  export let title = '';
  export let ariaLabel = '';
</script>

<button
  type="button"
  class="large-toggle"
  class:unavailable
  {disabled}
  aria-label={ariaLabel || label}
  aria-pressed={pressed}
  title={title || undefined}
  on:click
>
  <span class="large-toggle-content">
    <strong>{label}</strong>
    {#if detail}<small>{detail}</small>{/if}
  </span>
</button>

<style>
  .large-toggle {
    --large-toggle-off-bg: color-mix(in srgb, var(--color-start) 28%, var(--color-panel));
    --large-toggle-on-bg: color-mix(in srgb, var(--color-mid) 42%, var(--color-panel));
    --large-toggle-border: var(--color-mid-border);
    appearance: none;
    position: relative;
    display: grid;
    place-items: end start;
    width: 100%;
    min-width: 0;
    min-height: 5rem;
    padding: 0.8rem;
    overflow: hidden;
    border: solid var(--color-start-border);
    border-width: 1px 1px 0.24rem;
    border-radius: var(--radius-md);
    background: var(--large-toggle-off-bg);
    box-shadow: var(--shadow-control-rest);
    color: var(--color-text);
    cursor: pointer;
    transform: translateY(0);
  }

  .large-toggle:hover {
    border-color: var(--color-start-border);
    background: var(--large-toggle-off-bg);
    box-shadow:
      var(--shadow-control-hover),
      var(--shadow-hover);
    transform: translateY(-0.06rem);
  }

  .large-toggle:focus-visible {
    outline: 2px solid var(--color-warning);
    outline-offset: 2px;
    border-color: var(--color-warning);
    background: var(--large-toggle-off-bg);
    box-shadow:
      var(--shadow-control-rest),
      var(--shadow-focus);
  }

  .large-toggle:active {
    box-shadow: var(--shadow-control-active);
    transform: translateY(0.16rem);
  }

  .large-toggle::after {
    top: 0.7rem;
    right: 0.7rem;
    bottom: auto;
    left: auto;
    width: 0.62rem;
    height: 0.62rem;
    border: 1px solid var(--color-mid-border);
    border-radius: 999px;
    background: var(--color-mid);
    box-shadow: 0 0 0.75rem color-mix(in srgb, var(--color-mid) 50%, transparent);
    opacity: 0;
    content: "";
    transform: scale(0.75);
    transition:
      opacity var(--transition),
      transform var(--transition);
  }

  .large-toggle[aria-pressed="true"] {
    border-color: var(--large-toggle-border);
    border-width: 0.24rem 1px 1px;
    background: var(--large-toggle-on-bg);
    box-shadow:
      inset 0 0.2rem 0 rgba(0, 0, 0, 0.18),
      inset 0 0 0 1px var(--large-toggle-border),
      inset 0 -1px 0 rgba(255, 255, 255, 0.14),
      0 0.08rem 0 rgba(0, 0, 0, 0.28);
    color: var(--color-text);
    transform: translateY(0.12rem);
  }

  .large-toggle[aria-pressed="true"]:hover,
  .large-toggle[aria-pressed="true"]:active {
    border-color: var(--large-toggle-border);
    background: var(--large-toggle-on-bg);
    box-shadow:
      inset 0 0.2rem 0 rgba(0, 0, 0, 0.18),
      inset 0 0 0 1px var(--large-toggle-border),
      inset 0 -1px 0 rgba(255, 255, 255, 0.14),
      0 0.08rem 0 rgba(0, 0, 0, 0.28);
    transform: translateY(0.12rem);
  }

  .large-toggle[aria-pressed="true"]:focus-visible {
    border-color: var(--color-warning);
    background: var(--large-toggle-on-bg);
    box-shadow:
      inset 0 0.2rem 0 rgba(0, 0, 0, 0.18),
      inset 0 0 0 1px var(--large-toggle-border),
      inset 0 -1px 0 rgba(255, 255, 255, 0.14),
      0 0.08rem 0 rgba(0, 0, 0, 0.28),
      var(--shadow-focus);
  }

  .large-toggle[aria-pressed="true"]::before {
    top: 0.42rem;
    background: var(--color-control-bottom-shade);
    opacity: 0.18;
  }

  .large-toggle[aria-pressed="true"]::after {
    opacity: 1;
    transform: scale(1);
  }

  .large-toggle.unavailable {
    --large-toggle-off-bg: color-mix(in srgb, var(--color-danger) 28%, var(--color-panel));
    border-color: var(--color-danger-border);
    border-style: dashed;
    color: var(--color-text);
  }

  .large-toggle.unavailable:hover,
  .large-toggle.unavailable:active {
    border-color: var(--color-danger-border);
    background: var(--large-toggle-off-bg);
    box-shadow: var(--shadow-control-rest);
    transform: none;
  }

  .large-toggle:disabled {
    cursor: not-allowed;
    opacity: 0.78;
  }

  .large-toggle-content {
    position: relative;
    z-index: 1;
    display: grid;
    min-width: 0;
    gap: 0.12rem;
    text-align: left;
  }

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  strong {
    color: inherit;
    line-height: 1.25;
    white-space: nowrap;
  }

  small {
    display: -webkit-box;
    color: inherit;
    line-height: 1.25;
    -webkit-box-orient: vertical;
    line-clamp: 2;
    -webkit-line-clamp: 2;
  }
</style>
