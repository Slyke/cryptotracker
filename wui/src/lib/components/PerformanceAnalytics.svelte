<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import PortfolioChart from './PortfolioChart.svelte';
  import SearchableMultiSelect from './SearchableMultiSelect.svelte';
  import type { ChartAxisOption } from '$lib/chart-axis-options';
  import {
    formatPercent,
    normalizeTooltipUnits,
    relativeRangeWindow,
    type RelativeRangeUnit
  } from '$lib/preferences';
  import {
    numericPerformancePoints,
    transformPerformanceSeries,
    type PerformanceMode
  } from '$lib/performance';
  import type { ChartSeries } from './chart-types';

  export let title = 'Performance analytics';
  export let series: ChartSeries[] = [];
  export let timezone = 'America/Vancouver';
  export let returnMethod: 'price' | 'value' = 'value';
  export let busy = false;
  export let saveable = false;
  export let initialMode: PerformanceMode = 'return';
  export let initialAnalysisId = '';
  export let initialBenchmarkId = '';
  export let initialRange = '30d';
  export let initialCustomAgoValue = 1;
  export let initialCustomAgoUnit: RelativeRangeUnit = 'years';
  export let initialVisibleSeriesIds: string[] | null = null;
  export let initialLeftYAxisSeriesIds: string[] | null = null;
  export let initialRightYAxisSeriesIds: string[] = [];
  export let initialRightYAxisUnit = '';
  export let initialLeftYAxisLineColor = '#364255';
  export let initialRightYAxisLineColor = '#ffbc3a';
  export let initialTooltipUnits: string[] = ['%'];
  export let initialMinimumMode: 'auto' | 'absolute' | 'relative' = 'auto';
  export let initialMaximumMode: 'auto' | 'absolute' | 'relative' = 'auto';
  export let initialMinimumValue = '';
  export let initialMaximumValue = '';
  export let initialSaveGraphName = title;

  const dispatch = createEventDispatcher<{
    rangeChange: {
      range: string;
      fromMs: number;
      toMs: number;
      customAgoValue: number;
      customAgoUnit: RelativeRangeUnit;
    };
    displayChange: {
      visibleSeriesIds: string[];
      leftYAxisSeriesIds: string[];
      rightYAxisSeriesIds: string[];
      rightYAxisUnit: string;
      leftYAxisLineColor: string;
      rightYAxisLineColor: string;
      tooltipUnits: string[];
      minimumMode: 'auto' | 'absolute' | 'relative';
      maximumMode: 'auto' | 'absolute' | 'relative';
      minimumValue: string;
      maximumValue: string;
    };
    saveGraph: {
      name: string;
      performanceMode: PerformanceMode;
      performanceAnalysisId: string;
      performanceBenchmarkId: string;
      range: string;
      customRangeMode: 'ago';
      customAgoValue: number;
      customAgoUnit: RelativeRangeUnit;
      visibleSeriesIds: string[];
      leftYAxisSeriesIds: string[];
      rightYAxisSeriesIds: string[];
      rightYAxisUnit: string;
      leftYAxisLineColor: string;
      rightYAxisLineColor: string;
      tooltipUnits: string[];
      minimumMode: 'auto' | 'absolute' | 'relative';
      maximumMode: 'auto' | 'absolute' | 'relative';
      minimumValue: string;
      maximumValue: string;
    };
  }>();

  type Metric = {
    id: string;
    label: string;
    observations: number;
    totalReturn: number | null;
    annualizedReturn: number | null;
    annualizedVolatility: number | null;
    maxDrawdown: number | null;
  };

  let mode: PerformanceMode = initialMode;
  let analysisId = initialAnalysisId;
  let benchmarkId = initialBenchmarkId;
  let performanceRange = initialRange;
  let customAgoValue = initialCustomAgoValue;
  let customAgoUnit: RelativeRangeUnit = initialCustomAgoUnit;
  let useAllLeftSeriesByDefault = (
    initialLeftYAxisSeriesIds === null
    && initialVisibleSeriesIds === null
  );
  let rightYAxisSeriesIds = [...new Set(initialRightYAxisSeriesIds)];
  let leftYAxisSeriesIds = [
    ...new Set(initialLeftYAxisSeriesIds ?? initialVisibleSeriesIds ?? [])
  ].filter((id) => !rightYAxisSeriesIds.includes(id));
  let rightYAxisUnit = initialRightYAxisUnit === '%' ? '%' : '';
  let leftYAxisLineColor = initialLeftYAxisLineColor;
  let rightYAxisLineColor = initialRightYAxisLineColor;
  let selectedTooltipUnits = normalizeTooltipUnits({
    value: initialTooltipUnits,
    fallback: ['%']
  }).filter((unit) => unit === '%');
  let minimumMode = initialMinimumMode;
  let maximumMode = initialMaximumMode;
  let minimumValue = initialMinimumValue;
  let maximumValue = initialMaximumValue;
  let saveGraphName = initialSaveGraphName;
  let saveValidation = '';
  let metrics: Metric[] = [];
  let filteredSeries: ChartSeries[] = [];
  let transformedSeries: ChartSeries[] = [];
  let displayedSeriesOptions: ChartAxisOption[] = [];
  let effectiveLeftYAxisSeriesIds: string[] = [];
  let effectiveRightYAxisSeriesIds: string[] = [];
  const percentageUnitOptions: ChartAxisOption[] = [{
    value: '%',
    label: '% · Percentage',
    group: 'Display units',
    searchText: 'percent percentage return rate'
  }];
  let selectedMetric: Metric | null = null;
  let benchmarkMetric: Metric | null = null;
  let appliedInitialMode = initialMode;
  let appliedInitialAnalysisId = initialAnalysisId;
  let appliedInitialBenchmarkId = initialBenchmarkId;
  let appliedInitialRange = initialRange;
  let appliedInitialCustomAgoValue = initialCustomAgoValue;
  let appliedInitialCustomAgoUnit = initialCustomAgoUnit;
  let appliedInitialLeftYAxisSeriesKey = (
    initialLeftYAxisSeriesIds ?? initialVisibleSeriesIds
  )?.join('\u0000') ?? '*';
  let appliedInitialRightYAxisSeriesKey = initialRightYAxisSeriesIds.join('\u0000');
  let appliedInitialRightYAxisUnit = initialRightYAxisUnit;
  let appliedInitialLeftYAxisLineColor = initialLeftYAxisLineColor;
  let appliedInitialRightYAxisLineColor = initialRightYAxisLineColor;
  let appliedInitialTooltipUnitsKey = initialTooltipUnits.join('\u0000');
  let appliedInitialBoundsKey = [
    initialMinimumMode,
    initialMaximumMode,
    initialMinimumValue,
    initialMaximumValue
  ].join('\u0000');
  let appliedInitialSaveGraphName = initialSaveGraphName;

  const median = (values: number[]) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1]! + sorted[middle]!) / 2
      : sorted[middle]!;
  };

  const metricFor = (item: ChartSeries): Metric => {
    const points = numericPerformancePoints(item);
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

  const percent = (value: number | null) => value === null || !Number.isFinite(value)
    ? 'unavailable'
    : `${formatPercent(value)}%`;
  const controlId = (suffix: string) => (
    `${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '')}-${suffix}`
  );
  const rangeWindow = () => {
    const toMs = Date.now();
    if (performanceRange === 'all') return { fromMs: 0, toMs };
    if (performanceRange === 'custom') {
      const relative = relativeRangeWindow({
        value: customAgoValue,
        unit: customAgoUnit,
        toMs
      });
      return {
        fromMs: relative?.from ?? toMs,
        toMs: relative?.to ?? toMs
      };
    }
    const durations: Record<string, number> = {
      '24h': 24 * 60 * 60_000,
      '7d': 7 * 24 * 60 * 60_000,
      '30d': 30 * 24 * 60 * 60_000,
      '90d': 90 * 24 * 60 * 60_000,
      '1y': 365 * 24 * 60 * 60_000,
      '4y': 4 * 365 * 24 * 60 * 60_000
    };
    return {
      fromMs: toMs - (durations[performanceRange] ?? durations['30d']),
      toMs
    };
  };
  const rangeChanged = () => {
    const { fromMs, toMs } = rangeWindow();
    dispatch('rangeChange', {
      range: performanceRange,
      fromMs,
      toMs,
      customAgoValue: Math.max(1, Math.floor(Number(customAgoValue))),
      customAgoUnit
    });
  };
  const resolveLeftYAxisSeriesIds = () => series
    .filter((item) => (
      useAllLeftSeriesByDefault
        ? !rightYAxisSeriesIds.includes(item.id)
        : leftYAxisSeriesIds.includes(item.id)
    ))
    .map((item) => item.id);
  const resolveRightYAxisSeriesIds = () => series
    .filter((item) => rightYAxisSeriesIds.includes(item.id))
    .map((item) => item.id);
  const displayChanged = () => {
    const leftIds = resolveLeftYAxisSeriesIds();
    const rightIds = resolveRightYAxisSeriesIds();
    dispatch('displayChange', {
      visibleSeriesIds: [...new Set([...leftIds, ...rightIds])],
      leftYAxisSeriesIds: leftIds,
      rightYAxisSeriesIds: rightIds,
      rightYAxisUnit,
      leftYAxisLineColor,
      rightYAxisLineColor,
      tooltipUnits: selectedTooltipUnits,
      minimumMode,
      maximumMode,
      minimumValue,
      maximumValue
    });
  };
  const leftDisplayedSeriesChanged = () => {
    useAllLeftSeriesByDefault = false;
    rightYAxisSeriesIds = rightYAxisSeriesIds.filter((id) => (
      !leftYAxisSeriesIds.includes(id)
    ));
    displayChanged();
  };
  const rightDisplayedSeriesChanged = () => {
    if (useAllLeftSeriesByDefault) {
      leftYAxisSeriesIds = series
        .map((item) => item.id)
        .filter((id) => !rightYAxisSeriesIds.includes(id));
    } else {
      leftYAxisSeriesIds = leftYAxisSeriesIds.filter((id) => (
        !rightYAxisSeriesIds.includes(id)
      ));
    }
    useAllLeftSeriesByDefault = false;
    displayChanged();
  };
  const saveGraph = () => {
    const name = saveGraphName.trim();
    if (!name) {
      saveValidation = 'Enter a name before saving this chart.';
      return;
    }
    saveValidation = '';
    const leftIds = resolveLeftYAxisSeriesIds();
    const rightIds = resolveRightYAxisSeriesIds();
    dispatch('saveGraph', {
      name,
      performanceMode: mode,
      performanceAnalysisId: analysisId,
      performanceBenchmarkId: benchmarkId,
      range: performanceRange,
      customRangeMode: 'ago',
      customAgoValue: Math.max(1, Math.floor(Number(customAgoValue))),
      customAgoUnit,
      visibleSeriesIds: [...new Set([...leftIds, ...rightIds])],
      leftYAxisSeriesIds: leftIds,
      rightYAxisSeriesIds: rightIds,
      rightYAxisUnit,
      leftYAxisLineColor,
      rightYAxisLineColor,
      tooltipUnits: selectedTooltipUnits,
      minimumMode,
      maximumMode,
      minimumValue,
      maximumValue
    });
  };

  $: {
    const { fromMs, toMs } = rangeWindow();
    filteredSeries = series.map((item) => ({
      ...item,
      points: item.points.filter((point) => (
        point.timestampMs >= fromMs && point.timestampMs <= toMs
      ))
    }));
  }
  $: if (appliedInitialMode !== initialMode) {
    mode = initialMode;
    appliedInitialMode = initialMode;
  }
  $: if (appliedInitialAnalysisId !== initialAnalysisId) {
    analysisId = initialAnalysisId;
    appliedInitialAnalysisId = initialAnalysisId;
  }
  $: if (appliedInitialBenchmarkId !== initialBenchmarkId) {
    benchmarkId = initialBenchmarkId;
    appliedInitialBenchmarkId = initialBenchmarkId;
  }
  $: if (appliedInitialRange !== initialRange) {
    performanceRange = initialRange;
    appliedInitialRange = initialRange;
  }
  $: if (appliedInitialCustomAgoValue !== initialCustomAgoValue) {
    customAgoValue = initialCustomAgoValue;
    appliedInitialCustomAgoValue = initialCustomAgoValue;
  }
  $: if (appliedInitialCustomAgoUnit !== initialCustomAgoUnit) {
    customAgoUnit = initialCustomAgoUnit;
    appliedInitialCustomAgoUnit = initialCustomAgoUnit;
  }
  $: {
    const nextInitialLeftYAxisSeriesKey = (
      initialLeftYAxisSeriesIds ?? initialVisibleSeriesIds
    )?.join('\u0000') ?? '*';
    const nextInitialRightYAxisSeriesKey = initialRightYAxisSeriesIds.join('\u0000');
    if (appliedInitialRightYAxisSeriesKey !== nextInitialRightYAxisSeriesKey) {
      rightYAxisSeriesIds = [...new Set(initialRightYAxisSeriesIds)];
      appliedInitialRightYAxisSeriesKey = nextInitialRightYAxisSeriesKey;
    }
    if (appliedInitialLeftYAxisSeriesKey !== nextInitialLeftYAxisSeriesKey) {
      const initialLeftIds = initialLeftYAxisSeriesIds ?? initialVisibleSeriesIds;
      useAllLeftSeriesByDefault = initialLeftIds === null;
      leftYAxisSeriesIds = [...new Set(initialLeftIds ?? [])]
        .filter((id) => !rightYAxisSeriesIds.includes(id));
      appliedInitialLeftYAxisSeriesKey = nextInitialLeftYAxisSeriesKey;
    }
    if (appliedInitialRightYAxisUnit !== initialRightYAxisUnit) {
      rightYAxisUnit = initialRightYAxisUnit === '%' ? '%' : '';
      appliedInitialRightYAxisUnit = initialRightYAxisUnit;
    }
    if (appliedInitialLeftYAxisLineColor !== initialLeftYAxisLineColor) {
      leftYAxisLineColor = initialLeftYAxisLineColor;
      appliedInitialLeftYAxisLineColor = initialLeftYAxisLineColor;
    }
    if (appliedInitialRightYAxisLineColor !== initialRightYAxisLineColor) {
      rightYAxisLineColor = initialRightYAxisLineColor;
      appliedInitialRightYAxisLineColor = initialRightYAxisLineColor;
    }
    const nextTooltipUnitsKey = initialTooltipUnits.join('\u0000');
    if (appliedInitialTooltipUnitsKey !== nextTooltipUnitsKey) {
      selectedTooltipUnits = normalizeTooltipUnits({
        value: initialTooltipUnits,
        fallback: ['%']
      }).filter((unit) => unit === '%');
      appliedInitialTooltipUnitsKey = nextTooltipUnitsKey;
    }
    const nextBoundsKey = [
      initialMinimumMode,
      initialMaximumMode,
      initialMinimumValue,
      initialMaximumValue
    ].join('\u0000');
    if (appliedInitialBoundsKey !== nextBoundsKey) {
      minimumMode = initialMinimumMode;
      maximumMode = initialMaximumMode;
      minimumValue = initialMinimumValue;
      maximumValue = initialMaximumValue;
      appliedInitialBoundsKey = nextBoundsKey;
    }
  }
  $: if (appliedInitialSaveGraphName !== initialSaveGraphName) {
    saveGraphName = initialSaveGraphName;
    appliedInitialSaveGraphName = initialSaveGraphName;
  }
  $: metrics = filteredSeries.map(metricFor);
  $: if (metrics.length > 0 && !metrics.some((metric) => metric.id === analysisId)) {
    analysisId = metrics[0]?.id ?? '';
  }
  $: if (metrics.length > 0 && benchmarkId && !metrics.some((metric) => metric.id === benchmarkId)) {
    benchmarkId = '';
  }
  $: selectedMetric = metrics.find((metric) => metric.id === analysisId) ?? null;
  $: benchmarkMetric = metrics.find((metric) => metric.id === benchmarkId) ?? null;
  $: transformedSeries = transformPerformanceSeries({
    series: filteredSeries,
    mode
  });
  $: if (useAllLeftSeriesByDefault) {
    const allLeftSeriesIds = series
      .map((item) => item.id)
      .filter((id) => !rightYAxisSeriesIds.includes(id));
    if (leftYAxisSeriesIds.join('\u0000') !== allLeftSeriesIds.join('\u0000')) {
      leftYAxisSeriesIds = allLeftSeriesIds;
    }
  }
  $: {
    useAllLeftSeriesByDefault;
    leftYAxisSeriesIds;
    rightYAxisSeriesIds;
    effectiveLeftYAxisSeriesIds = resolveLeftYAxisSeriesIds();
    effectiveRightYAxisSeriesIds = resolveRightYAxisSeriesIds();
  }
  $: displayedSeriesOptions = series.map((item) => ({
    value: item.id,
    label: item.label,
    group: 'Display units' as const,
    searchText: `${item.id} ${item.label} performance chart line`
  }));
</script>

<section class="panel performance-panel">
  <div class="performance-heading">
    <div>
      <p class="eyebrow">Risk and return</p>
      <h2>{title}</h2>
    </div>
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
      <label for={controlId('range')}>Time range</label>
      <select id={controlId('range')} bind:value={performanceRange} on:change={rangeChanged}>
        <option value="24h">24 hours</option>
        <option value="7d">7 days</option>
        <option value="30d">30 days</option>
        <option value="90d">90 days</option>
        <option value="1y">1 year</option>
        <option value="4y">4 years</option>
        <option value="all">All available</option>
        <option value="custom">Custom time ago</option>
      </select>
    </div>
    {#if performanceRange === 'custom'}
      <div class="field">
        <label for={controlId('ago-value')}>Look back</label>
        <input
          id={controlId('ago-value')}
          type="number"
          min="1"
          max="10000"
          step="1"
          bind:value={customAgoValue}
          on:change={rangeChanged}
        />
      </div>
      <div class="field">
        <label for={controlId('ago-unit')}>Time ago unit</label>
        <select id={controlId('ago-unit')} bind:value={customAgoUnit} on:change={rangeChanged}>
          <option value="hours">Hours ago</option>
          <option value="days">Days ago</option>
          <option value="weeks">Weeks ago</option>
          <option value="months">Months ago</option>
          <option value="years">Years ago</option>
        </select>
      </div>
    {/if}
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

  <div class="performance-axis-row">
    <div class="field">
      <label for={controlId('left-y-axis-unit')}>Left Y-Axis</label>
      <select id={controlId('left-y-axis-unit')} disabled>
        <option value="%">% · Percentage</option>
      </select>
    </div>
    <div class="field">
      <label for={controlId('left-displayed-series')}>Left displayed lines</label>
      <SearchableMultiSelect
        id={controlId('left-displayed-series')}
        bind:value={leftYAxisSeriesIds}
        options={displayedSeriesOptions}
        label="Left Y-Axis performance lines"
        maximum={Math.max(displayedSeriesOptions.length, 1)}
        disabled={displayedSeriesOptions.length === 0}
        on:change={leftDisplayedSeriesChanged}
      />
    </div>
    <div class="field">
      <label for={controlId('left-y-axis-line-color')}>Left horizontal line color</label>
      <div class="color-input">
        <input
          id={controlId('left-y-axis-line-color')}
          type="color"
          bind:value={leftYAxisLineColor}
          on:change={displayChanged}
        />
        <code>{leftYAxisLineColor}</code>
      </div>
    </div>
  </div>

  <div class="performance-axis-row">
    <div class="field">
      <label for={controlId('right-y-axis-unit')}>Right Y-Axis</label>
      <select
        id={controlId('right-y-axis-unit')}
        bind:value={rightYAxisUnit}
        on:change={displayChanged}
      >
        <option value="">Off</option>
        <option value="%">% · Percentage</option>
      </select>
    </div>
    <div class="field">
      <label for={controlId('right-displayed-series')}>Right displayed lines</label>
      <SearchableMultiSelect
        id={controlId('right-displayed-series')}
        bind:value={rightYAxisSeriesIds}
        options={displayedSeriesOptions}
        label="Right Y-Axis performance lines"
        maximum={Math.max(displayedSeriesOptions.length, 1)}
        disabled={displayedSeriesOptions.length === 0 || !rightYAxisUnit}
        on:change={rightDisplayedSeriesChanged}
      />
    </div>
    <div class="field">
      <label for={controlId('right-y-axis-line-color')}>Right horizontal line color</label>
      <div class="color-input">
        <input
          id={controlId('right-y-axis-line-color')}
          type="color"
          bind:value={rightYAxisLineColor}
          disabled={!rightYAxisUnit}
          on:change={displayChanged}
        />
        <code>{rightYAxisLineColor}</code>
      </div>
    </div>
  </div>

  <div class="performance-bounds-row">
    <div class="field">
      <label for={controlId('tooltip-units')}>Popup units</label>
      <SearchableMultiSelect
        id={controlId('tooltip-units')}
        bind:value={selectedTooltipUnits}
        options={percentageUnitOptions}
        label="performance popup units"
        maximum={1}
        on:change={displayChanged}
      />
    </div>
    <div class="field">
      <label for={controlId('minimum-mode')}>Minimum</label>
      <select id={controlId('minimum-mode')} bind:value={minimumMode} on:change={displayChanged}>
        <option value="auto">Auto</option>
        <option value="absolute">Absolute</option>
        <option value="relative">Relative %</option>
      </select>
    </div>
    {#if minimumMode !== 'auto'}
      <div class="field">
        <label for={controlId('minimum-value')}>Minimum value</label>
        <input id={controlId('minimum-value')} inputmode="decimal" bind:value={minimumValue} on:input={displayChanged} />
      </div>
    {/if}
    <div class="field">
      <label for={controlId('maximum-mode')}>Maximum</label>
      <select id={controlId('maximum-mode')} bind:value={maximumMode} on:change={displayChanged}>
        <option value="auto">Auto</option>
        <option value="absolute">Absolute</option>
        <option value="relative">Relative %</option>
      </select>
    </div>
    {#if maximumMode !== 'auto'}
      <div class="field">
        <label for={controlId('maximum-value')}>Maximum value</label>
        <input id={controlId('maximum-value')} inputmode="decimal" bind:value={maximumValue} on:input={displayChanged} />
      </div>
    {/if}
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
      ? 'Each return uses only that asset’s own cached market price; portfolio balances and other tokens are not included.'
      : 'Returns use observed portfolio value. Deposits and withdrawals are not removed, so this is not a cash-flow-adjusted time-weighted return.'}
    Volatility is annualized from the median observation interval.
  </p>

  {#if saveable}
    <div class="save-performance">
      <div class="field">
        <label for={controlId('save-name')}>Dashboard chart name</label>
        <input id={controlId('save-name')} maxlength="120" bind:value={saveGraphName} />
      </div>
      <button class="secondary" type="button" disabled={busy} on:click={saveGraph}>Save chart to dashboard</button>
    </div>
    {#if saveValidation}<div class="alert warning" role="status">{saveValidation}</div>{/if}
  {/if}

  <PortfolioChart
    title={`${title} ${mode}`}
    series={transformedSeries}
    chartMode="line"
    currency="%"
    tooltipCurrencies={['%']}
    source="derived analytics"
    {timezone}
    {busy}
    granularity={86_400}
    compact
    minimalChrome
    initialRange={performanceRange}
    initialCustomRangeMode="ago"
    initialCustomAgoValue={customAgoValue}
    initialCustomAgoUnit={customAgoUnit}
    initialVisibleSeriesIds={[...new Set([
      ...effectiveLeftYAxisSeriesIds,
      ...effectiveRightYAxisSeriesIds
    ])]}
    initialLeftYAxisSeriesIds={effectiveLeftYAxisSeriesIds}
    initialRightYAxisUnit={rightYAxisUnit}
    initialRightYAxisSeriesIds={effectiveRightYAxisSeriesIds}
    initialLeftYAxisLineColor={leftYAxisLineColor}
    initialRightYAxisLineColor={rightYAxisLineColor}
    initialTooltipUnits={selectedTooltipUnits}
    initialMinimumMode={minimumMode}
    initialMaximumMode={maximumMode}
    initialMinimumValue={minimumValue}
    initialMaximumValue={maximumValue}
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
  .save-performance {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.8rem;
  }

  .performance-controls {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
    align-items: end;
    gap: 0.8rem;
  }

  .performance-axis-row,
  .performance-bounds-row {
    display: grid;
    grid-template-columns: minmax(10rem, 0.8fr) minmax(min(100%, 20rem), 1.4fr) minmax(12rem, 0.8fr);
    align-items: end;
    gap: 0.8rem;
  }

  .performance-bounds-row {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
  }

  .performance-controls .field,
  .performance-axis-row .field,
  .performance-bounds-row .field,
  .save-performance .field {
    min-width: 0;
  }

  .performance-controls select,
  .performance-controls input,
  .performance-axis-row select,
  .performance-bounds-row select,
  .performance-bounds-row input {
    width: 100%;
  }

  .color-input {
    display: flex;
    align-items: center;
    min-height: 2.75rem;
    gap: 0.6rem;
  }

  .color-input input[type='color'] {
    width: 4.5rem;
    min-height: 2.75rem;
    padding: 0.25rem;
  }

  .color-input code {
    color: var(--color-muted);
  }

  @media (max-width: 760px) {
    .performance-axis-row {
      grid-template-columns: 1fr;
    }
  }

  .save-performance .field {
    flex: 1 1 18rem;
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
