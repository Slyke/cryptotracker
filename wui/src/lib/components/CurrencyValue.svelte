<script lang="ts">
  import { formatDisplayNumber } from '$lib/preferences';

  export let values: Record<string, string | number | null | undefined> = {};
  export let currency = 'CAD';
  export let locale = 'en-CA';
  export let label = 'Value';
  export let showCurrencyCode = false;

  $: normalizedCurrency = currency.toUpperCase();
  $: currencies = [...new Set(Object.keys(values).map((item) => item.toUpperCase()))];
  $: orderedCurrencies = currencies.includes(normalizedCurrency)
    ? currencies
    : [normalizedCurrency, ...currencies];
  $: formattedValues = Object.fromEntries(orderedCurrencies.map((requestedCurrency) => {
    const value = values[requestedCurrency];
    return [
      requestedCurrency,
      value === null || value === undefined
        ? 'unavailable'
        : formatDisplayNumber({
            value,
            currency: showCurrencyCode ? undefined : requestedCurrency,
            locale
          })
    ];
  }));
</script>

<!-- Focus is intentional: it is the keyboard equivalent of hovering to reveal the selectable valuation popup. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<span
  class="currency-value"
  role="group"
  tabindex="0"
  aria-label={`${label}: ${formattedValues[normalizedCurrency]} ${normalizedCurrency}. Focus or hover for all configured currencies.`}
>
  <span class="currency-value-line">
    <strong class="stat">{formattedValues[normalizedCurrency]}</strong>
    {#if showCurrencyCode}<small>{normalizedCurrency}</small>{/if}
  </span>
  <div class="currency-popup" role="tooltip">
    <strong>All configured currencies</strong>
    {#each orderedCurrencies as requestedCurrency (requestedCurrency)}
      <span>{requestedCurrency}</span>
      <strong>{formattedValues[requestedCurrency]}</strong>
    {/each}
  </div>
</span>

<style>
  .currency-value {
    position: relative;
    display: flex;
    width: fit-content;
    flex-direction: column;
    align-items: flex-start;
    min-height: 0;
    padding: 0;
    border: 0;
    background: transparent;
    box-shadow: none;
    color: inherit;
    font: inherit;
    text-align: left;
    outline: none;
    user-select: text;
  }

  .currency-value:hover {
    border: 0;
    background: transparent;
    box-shadow: none;
    transform: none;
  }

  .currency-value:focus-visible {
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-focus);
  }

  .currency-value-line {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
  }

  .currency-value-line small {
    color: var(--color-muted);
    font-size: 0.76rem;
    font-weight: 800;
    letter-spacing: 0.08em;
  }

  .currency-popup {
    position: absolute;
    z-index: 20;
    top: 100%;
    left: 0;
    display: none;
    grid-template-columns: auto minmax(max-content, 1fr);
    gap: 0.35rem 0.9rem;
    min-width: 15rem;
    padding: 0.75rem;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-md);
    background: var(--color-panel-strong);
    box-shadow: var(--shadow-hover);
    color: var(--color-text);
    font-size: 0.82rem;
    line-height: 1.35;
    user-select: text;
  }

  .currency-popup > :first-child {
    grid-column: 1 / -1;
    margin-bottom: 0.2rem;
  }

  .currency-popup > strong:not(:first-child) {
    text-align: right;
  }

  .currency-value:hover .currency-popup,
  .currency-value:focus .currency-popup,
  .currency-value:focus-within .currency-popup {
    display: grid;
  }
</style>
