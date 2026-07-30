<script lang="ts">
  import PortfolioChart from './PortfolioChart.svelte';
  import { formatPercent } from '$lib/preferences';
  import type { ChartSeries } from './chart-types';

  export let title = 'Performance analytics';
  export let series: ChartSeries[] = [];
  export let timezone = 'America/Vancouver';
  export let returnMethod: 'price' | 'value' = 'value';

  type Metric = {
    id: string;
    label: string;
    observations: number;
    totalReturn: number | null;
    annualizedReturn: number | null;
    annualizedVolatility: number | null;
    maxDrawdown: number | null;
  };

  let mode: 'return' | 'drawdown' = 'return';
  let analysisId = '';
  let benchmarkId = '';
  let metrics: Metric[] = [];
  let transformedSeries: ChartSeries[] = [];
  let selectedMetric: Metric | null = null;
  let benchmarkMetric: Metric | null = null;

  const numericPoints = (item: ChartSeries) => item.points
    .flatMap((point) => {
      const rawValue = point.value ?? point.close;
      if (rawValue === null || rawValue === undefined) return [];
      const numericValue = Number(rawValue);
      return Number.isFinite(numericValue)
        ? [{ ...point, numericValue }]
        : [];
    })
    .sort((left, right) => left.timestampMs - right.timestampMs);

  const median = (values: number[]) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
  };

  const metricFor = (item: ChartSeries): Metric => {
    const points = numericPoints(item);
    const first = points.find((point) => point.numericValue !== 0);
    const last = points.at(-1);
    const totalReturn = first && last
      ? ((last.numericValue / first.numericValue) - 1) * 100
      : null;
    const durationDays = first && last
      ? (last.timestampMs - first.timestampMs) / 86_400_000
      : 0;
    const annualizedReturn = (
      first
      && last
      && first.numericValue > 0
      && last.numericValue > 0
      && durationDays >= 1
    )
      ? (Math.pow(last.numericValue / first.numericValue, 365.25 / durationDays) - 1) * 100
      : null;
    const intervalReturns: number[] = [];
    const intervalDays: number[] = [];
    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1]!;
      const current = points[index]!;
      if (previous.numericValue <= 0) continue;
      intervalReturns.push((current.numericValue / previous.numericValue) - 1);
      intervalDays.push((current.timestampMs - previous.timestampMs) / 86_400_000);
    }
    const mean = intervalReturns.length > 0
      ? intervalReturns.reduce((sum, value) => sum + value, 0) / intervalReturns.length
      : 0;
    const intervalVariance = intervalReturns.length > 1
      ? intervalReturns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (intervalReturns.length - 1)
      : null;
    const typicalIntervalDays = median(intervalDays.filter((value) => value > 0));
    const annualizedVolatility = intervalVariance !== null && typicalIntervalDays
      ? Math.sqrt(intervalVariance) * Math.sqrt(365.25 / typicalIntervalDays) * 100
      : null;
    let peak: number | null = null;
    let maxDrawdown: number | null = null;
    for (const point of points) {
      peak = peak === null ? point.numericValue : Math.max(peak, point.numericValue);
      if (peak <= 0) continue;
      const drawdown = ((point.numericValue / peak) - 1) * 100;
      maxDrawdown = maxDrawdown === null ? drawdown : Math.min(maxDrawdown, drawdown);
    }
    return {
      id: item.id,
      label: item.label,
      observations: points.length,
      totalReturn,
      annualizedReturn,
      annualizedVolatility,
      maxDrawdown
    };
  };

  const transform = (
    item: ChartSeries,
    selectedMode: 'return' | 'drawdown'
  ): ChartSeries => {
    const points = numericPoints(item);
    const first = points.find((point) => point.numericValue !== 0);
    let peak: number | null = null;
    return {
      id: `${item.id}:${selectedMode}`,
      label: `${item.label} · ${selectedMode === 'return' ? 'return' : 'drawdown'}`,
      points: points.map((point) => {
        peak = peak === null ? point.numericValue : Math.max(peak, point.numericValue);
        const value = selectedMode === 'return'
          ? first
            ? ((point.numericValue / first.numericValue) - 1) * 100
            : null
          : peak > 0
            ? ((point.numericValue / peak) - 1) * 100
            : null;
        return {
          timestampMs: point.timestampMs,
          value: value === null ? null : String(value),
          status: 'derived',
          provenance: {
            sourceSeriesId: item.id,
            calculation: selectedMode === 'return'
              ? 'cumulative change from first non-zero observation'
              : 'change from preceding peak'
          }
        };
      })
    };
  };

  const percent = (value: number | null) => value === null || !Number.isFinite(value)
    ? 'unavailable'
    : `${formatPercent(value)}%`;
  const controlId = (suffix: string) => (
    `${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '')}-${suffix}`
  );

  $: metrics = series.map(metricFor);
  $: if (!metrics.some((metric) => metric.id === analysisId)) analysisId = metrics[0]?.id ?? '';
  $: if (benchmarkId && !metrics.some((metric) => metric.id === benchmarkId)) benchmarkId = '';
  $: selectedMetric = metrics.find((metric) => metric.id === analysisId) ?? null;
  $: benchmarkMetric = metrics.find((metric) => metric.id === benchmarkId) ?? null;
  $: transformedSeries = series.map((item) => transform(item, mode));
</script>

<section class="panel performance-panel">
  <div class="performance-heading">
    <div>
      <p class="eyebrow">Risk and return</p>
      <h2>{title}</h2>
    </div>
    <div class="performance-controls">
      <div class="field">
        <label for={controlId('mode')}>Graph</label>
        <select id={controlId('mode')} bind:value={mode}>
          <option value="return">Cumulative return</option>
          <option value="drawdown">Drawdown from peak</option>
        </select>
      </div>
      <div class="field">
        <label for={controlId('series')}>Metrics for</label>
        <select id={controlId('series')} bind:value={analysisId}>
          {#each metrics as metric (metric.id)}
            <option value={metric.id}>{metric.label}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label for={controlId('benchmark')}>Benchmark</label>
        <select id={controlId('benchmark')} bind:value={benchmarkId}>
          <option value="">None</option>
          {#each metrics.filter((metric) => metric.id !== analysisId) as metric (metric.id)}
            <option value={metric.id}>{metric.label}</option>
          {/each}
        </select>
      </div>
    </div>
  </div>

  {#if selectedMetric}
    <dl class="metric-grid">
      <div>
        <dt>Total return</dt>
        <dd>{percent(selectedMetric.totalReturn)}</dd>
      </div>
      <div>
        <dt>Annualized return</dt>
        <dd>{percent(selectedMetric.annualizedReturn)}</dd>
      </div>
      <div>
        <dt>Annualized volatility</dt>
        <dd>{percent(selectedMetric.annualizedVolatility)}</dd>
      </div>
      <div>
        <dt>Maximum drawdown</dt>
        <dd>{percent(selectedMetric.maxDrawdown)}</dd>
      </div>
      {#if benchmarkMetric}
        <div>
          <dt>Return vs benchmark</dt>
          <dd>{percent(
            selectedMetric.totalReturn === null || benchmarkMetric.totalReturn === null
              ? null
              : selectedMetric.totalReturn - benchmarkMetric.totalReturn
          )}</dd>
        </div>
      {/if}
      <div>
        <dt>Observations</dt>
        <dd>{selectedMetric.observations.toLocaleString()}</dd>
      </div>
    </dl>
  {/if}

  <p class="muted method-note">
    {returnMethod === 'price'
      ? 'Returns use the first non-zero cached price in the currently loaded range.'
      : 'Returns use observed portfolio value. Deposits and withdrawals are not removed, so this is not a cash-flow-adjusted time-weighted return.'}
    Volatility is annualized from the median observation interval.
  </p>

  <PortfolioChart
    title={`${title} ${mode}`}
    series={transformedSeries}
    chartMode="line"
    currency="%"
    tooltipCurrencies={['%']}
    source="derived analytics"
    {timezone}
    granularity={86_400}
    compact
    minimalChrome
    initialRange="all"
    minimumValuedObservations={2}
    emptyMessage="At least two valued observations are needed for performance analytics."
  />
</section>

<style>
  .performance-panel {
    display: grid;
    gap: 1rem;
  }

  .performance-heading,
  .performance-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.8rem;
  }

  .performance-heading h2,
  .performance-heading p,
  .method-note {
    margin: 0;
  }

  .metric-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.7rem;
    margin: 0;
  }

  .metric-grid div {
    padding: 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-panel-strong);
  }

  dt {
    color: var(--color-muted);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  dd {
    margin: 0.2rem 0 0;
    font-size: 1.15rem;
    font-weight: 700;
  }
</style>
