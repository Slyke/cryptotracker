<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import {
    normalizeChartLineWidth,
    resolvedChartSeriesLineStyle,
    resolvedChartSeriesLineStyles,
    type ChartLineType,
    type ChartSeriesLineStyles
  } from '$lib/chart-line-styles';

  export let idPrefix = 'chart';
  export let series: Array<{ id: string; label: string }> = [];
  export let visibleSeriesIds: string[] = [];
  export let value: ChartSeriesLineStyles = {};

  const dispatch = createEventDispatcher<{
    change: ChartSeriesLineStyles;
  }>();

  type VisibleLine = {
    id: string;
    label: string;
    index: number;
    style: ReturnType<typeof resolvedChartSeriesLineStyle>;
  };

  let visibleLines: VisibleLine[] = [];

  const inputId = (line: VisibleLine, suffix: string) => (
    `${idPrefix}-${line.index}-${line.id.replaceAll(/[^a-z0-9_-]+/gi, '-')}-${suffix}`
  );
  const updateStyle = ({
    line,
    change
  }: {
    line: VisibleLine;
    change: Partial<VisibleLine['style']>;
  }) => {
    const styles = resolvedChartSeriesLineStyles({ styles: value, series });
    dispatch('change', {
      ...styles,
      [line.id]: {
        ...styles[line.id]!,
        ...change
      }
    });
  };
  const lineTypeChanged = (event: Event, line: VisibleLine) => {
    const type = (event.currentTarget as HTMLSelectElement).value as ChartLineType;
    updateStyle({ line, change: { type } });
  };
  const colorChanged = (event: Event, line: VisibleLine) => {
    updateStyle({
      line,
      change: { color: (event.currentTarget as HTMLInputElement).value.toLowerCase() }
    });
  };
  const widthChanged = (event: Event, line: VisibleLine) => {
    updateStyle({
      line,
      change: {
        width: normalizeChartLineWidth(
          (event.currentTarget as HTMLInputElement).value,
          line.style.width
        )
      }
    });
  };

  $: {
    const visible = new Set(visibleSeriesIds);
    visibleLines = series.flatMap((item, index) => (
      visible.has(item.id)
        ? [{
            ...item,
            index,
            style: resolvedChartSeriesLineStyle({
              styles: value,
              seriesId: item.id,
              index
            })
          }]
        : []
    ));
  }
</script>

<details class="line-style-options">
  <summary>Visible line styles ({visibleLines.length})</summary>
  {#if visibleLines.length > 0}
    <div class="line-style-list">
      {#each visibleLines as line (line.id)}
        <fieldset class="line-style-row">
          <legend>
            <span
              class={`line-swatch ${line.style.type}`}
              style={`--line-color:${line.style.color};--line-width:${line.style.width}px`}
              aria-hidden="true"
            ></span>
            {line.label}
          </legend>
          <div class="field">
            <label for={inputId(line, 'type')}>Line type</label>
            <select
              id={inputId(line, 'type')}
              value={line.style.type}
              on:change={(event) => lineTypeChanged(event, line)}
            >
              <option value="solid">Straight</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
            </select>
          </div>
          <div class="field">
            <label for={inputId(line, 'color')}>Color</label>
            <div class="color-input">
              <input
                id={inputId(line, 'color')}
                type="color"
                value={line.style.color}
                on:change={(event) => colorChanged(event, line)}
              />
              <code>{line.style.color}</code>
            </div>
          </div>
          <div class="field">
            <label for={inputId(line, 'width')}>Thickness</label>
            <input
              id={inputId(line, 'width')}
              type="number"
              min="1"
              max="8"
              step="0.1"
              value={line.style.width}
              on:change={(event) => widthChanged(event, line)}
            />
          </div>
        </fieldset>
      {/each}
    </div>
  {:else}
    <p class="muted empty-line-styles">Select at least one displayed line to configure its style.</p>
  {/if}
</details>

<style>
  .line-style-options {
    margin-top: 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--color-panel-strong) 72%, transparent);
  }

  .line-style-options > summary {
    padding: 0.75rem 0.85rem;
    cursor: pointer;
    font-weight: 700;
  }

  .line-style-list {
    display: grid;
    gap: 0.7rem;
    padding: 0 0.85rem 0.85rem;
  }

  .line-style-row {
    display: grid;
    grid-template-columns: minmax(10rem, 1.4fr) minmax(11rem, 1fr) minmax(8rem, 0.65fr);
    align-items: end;
    gap: 0.75rem;
    min-width: 0;
    margin: 0;
    padding: 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }

  .line-style-row legend {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0 0.35rem;
    font-weight: 700;
  }

  .line-swatch {
    display: inline-block;
    width: 2.4rem;
    height: 0;
    border-top-width: var(--line-width);
    border-top-color: var(--line-color);
  }

  .line-swatch.solid {
    border-top-style: solid;
  }

  .line-swatch.dashed {
    border-top-style: dashed;
  }

  .line-swatch.dotted {
    border-top-style: dotted;
  }

  .line-style-row .field {
    min-width: 0;
  }

  .line-style-row select,
  .line-style-row input[type='number'] {
    width: 100%;
  }

  .color-input {
    display: flex;
    align-items: center;
    min-height: 2.75rem;
    gap: 0.6rem;
  }

  .color-input input {
    width: 4.5rem;
    min-height: 2.75rem;
    padding: 0.25rem;
  }

  .color-input code,
  .empty-line-styles {
    color: var(--color-muted);
  }

  .empty-line-styles {
    margin: 0;
    padding: 0 0.85rem 0.85rem;
  }

  @media (max-width: 760px) {
    .line-style-row {
      grid-template-columns: 1fr;
    }
  }
</style>
