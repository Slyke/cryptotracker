<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import type { ECharts, EChartsOption } from 'echarts';
  import strings from '$lib/i18n/en-CA.json';
  import { persistAccordionState } from '$lib/accordion-state';
  import {
    buildChartAxisOptions,
    type ChartAxisOption,
    type ChartDenominationOption
  } from '$lib/chart-axis-options';
  import { activeChartAxisCatalog } from '$lib/chart-axis-catalog';
  import {
    closestCandidateWithinRadius,
    hasMinimumValuedObservations
  } from '$lib/chart-data';
  import SearchableSelect from './SearchableSelect.svelte';
  import SearchableMultiSelect from './SearchableMultiSelect.svelte';
  import {
    formatDisplayNumber,
    formatPercent,
    normalizeTooltipUnits,
    relativeRangeWindow,
    type RelativeRangeUnit
  } from '$lib/preferences';
  import {
    formatInTimezone,
    formatZonedDateTimeInput,
    zonedDateTimeInputToUtc
  } from '$lib/timezone';

  interface ChartPoint {
    timestampMs: number;
    value?: string | null;
    rawValue?: string | null;
    normalizedPercent?: string | null;
    open?: string | null;
    high?: string | null;
    low?: string | null;
    close?: string | null;
    volume?: string | null;
    status?: string | null;
    disputed?: boolean;
    providers?: string[];
    coveragePercent?: string;
    quotes?: Record<string, string | null>;
    quantities?: Record<string, string>;
    denominations?: Record<string, string | null>;
    denominationFallbacks?: Record<string, string>;
    contributingValues?: Record<string, string>;
    [key: string]: unknown;
  }

  interface ChartSeries {
    id: string;
    label: string;
    points: ChartPoint[];
  }

  interface ChartEvent {
    id: string;
    category: string;
    timestampMs: number;
    asset?: string;
    quantity?: string;
    source?: string;
    reconciliationState?: string;
    details?: Record<string, unknown>;
  }

  type ChartHighlightTarget = {
    seriesIndex: number;
    dataIndex: number;
  } | null;

  export let title = 'Portfolio history';
  export let series: ChartSeries[] = [];
  export let chartMode: 'line' | 'candlestick' = 'line';
  export let allowCandlesticks = false;
  export let showFourYearRange = false;
  export let currency = 'CAD';
  export let tooltipCurrencies: string[] = ['CAD'];
  export let denominationOptions: ChartDenominationOption[] = [];
  export let source = 'combined';
  export let timezone = 'America/Vancouver';
  export let granularity = 86_400;
  export let selectedGranularitySetting: string | null = null;
  export let partial = false;
  export let stale = false;
  export let events: ChartEvent[] = [];
  export let exportQuery = '';
  export let busy = false;
  export let compact = false;
  export let minimalChrome = false;
  export let saveable = false;
  export let tooltipEnabledAssetIds: string[] | null = null;
  export let showAllTooltipAssetsControl = false;
  export let partialMessage = strings['cryptotracker-data_partial-label'];
  export let emptyMessage = strings['cryptotracker-chart-empty-label'];
  export let minimumValuedObservations = 1;
  export let initialRange = '30d';
  export let initialCustomFromMs: number | null = null;
  export let initialCustomToMs: number | null = null;
  export let initialCustomRangeMode: 'dates' | 'ago' = 'dates';
  export let initialCustomAgoValue = 30;
  export let initialCustomAgoUnit: RelativeRangeUnit = 'days';
  export let initialScale: 'linear' | 'log' = 'linear';
  export let initialYAxisUnit = currency;
  export let initialTooltipUnits: string[] | null = null;
  export let initialMinimumMode: 'auto' | 'absolute' | 'relative' = 'auto';
  export let initialMaximumMode: 'auto' | 'absolute' | 'relative' = 'auto';
  export let initialMinimumValue = '';
  export let initialMaximumValue = '';
  export let initialNormalized = false;
  export let initialShowWicks = true;
  export let initialShowEvents = true;
  export let initialShowVolume = false;
  export let initialVisibleSeriesIds: string[] | null = null;
  export let initialRightYAxisUnit = '';
  export let initialSaveGraphName = title;
  export let preferenceKey = '';

  const dispatch = createEventDispatcher<{
    stateChange: {
      range: string;
      granularity: string;
      chartMode: 'line' | 'candlestick';
      customFromMs: number | null;
      customToMs: number | null;
      customRangeMode: 'dates' | 'ago';
      customAgoValue: number;
      customAgoUnit: RelativeRangeUnit;
    };
    viewChange: {
      scale: 'linear' | 'log';
      normalized: boolean;
      showEvents: boolean;
      showVolume: boolean;
      yAxisUnit: string;
      tooltipUnits: string[];
      visibleSeriesIds: string[];
      rightYAxisUnit: string;
    };
    zoomRange: {
      fromMs: number;
      toMs: number;
    };
    saveGraph: {
      name: string;
      range: string;
      granularity: string;
      chartMode: 'line' | 'candlestick';
      scale: 'linear' | 'log';
      normalized: boolean;
      showEvents: boolean;
      showVolume: boolean;
      yAxisUnit: string;
      tooltipUnits: string[];
      visibleSeriesIds: string[];
      rightYAxisUnit: string;
      minimumMode: 'auto' | 'absolute' | 'relative';
      maximumMode: 'auto' | 'absolute' | 'relative';
      minimumValue: string;
      maximumValue: string;
      showWicks: boolean;
      customFromMs: number | null;
      customToMs: number | null;
      customRangeMode: 'dates' | 'ago';
      customAgoValue: number;
      customAgoUnit: RelativeRangeUnit;
    };
  }>();
  let container: HTMLDivElement;
  let chart: ECharts | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let echartsModule: typeof import('echarts') | null = null;
  let destroyed = false;
  let range = initialRange;
  let customFrom = formatZonedDateTimeInput({
    timestampMs: initialCustomFromMs ?? Date.now() - 30 * 24 * 60 * 60_000,
    timezone
  });
  let customTo = formatZonedDateTimeInput({
    timestampMs: initialCustomToMs ?? Date.now(),
    timezone
  });
  let customRangeMode: 'dates' | 'ago' = initialCustomRangeMode;
  let customAgoValue = initialCustomAgoValue;
  let customAgoUnit: RelativeRangeUnit = initialCustomAgoUnit;
  let selectedGranularity = String(granularity);
  let scale: 'linear' | 'log' = initialScale;
  let yAxisUnit = initialYAxisUnit;
  let selectedTooltipUnits = normalizeTooltipUnits({
    value: initialTooltipUnits,
    fallback: [currency, ...tooltipCurrencies]
  });
  let minimumMode: 'auto' | 'absolute' | 'relative' = initialMinimumMode;
  let maximumMode: 'auto' | 'absolute' | 'relative' = initialMaximumMode;
  let minimumValue = initialMinimumValue;
  let maximumValue = initialMaximumValue;
  let normalized = initialNormalized;
  let showWicks = initialShowWicks;
  let showVolume = initialShowVolume;
  let showEvents = initialShowEvents;
  let useAllSeriesByDefault = initialVisibleSeriesIds === null;
  let selectedSeriesIds = initialVisibleSeriesIds === null
    ? []
    : [...new Set(initialVisibleSeriesIds)];
  let rightYAxisUnit = initialRightYAxisUnit;
  let eventCategories = new Set([
    'trade',
    'purchase',
    'sale',
    'stake',
    'unstake',
    'deposit',
    'withdrawal',
    'transfer',
    'reward',
    'address',
    'kraken',
    'lifecycle',
    'disputed'
  ]);
  let tableVisible = false;
  let inspectionIndex = 0;
  let activePointDescription = '';
  let inspectorActive = false;
  let chartInteractionActive = false;
  let previousBusy = busy;
  let restoreInteractionAfterBusy = false;
  let activeAxisCurrencies: string[] = [];
  let activeAxisDenominationOptions: ChartDenominationOption[] = [];
  let tooltipPinned = false;
  let hoveredTooltipTarget: {
    seriesIndex: number;
    dataIndex: number;
  } | null = null;
  let hoveredTooltipIsEvent = false;
  let tooltipPointerPosition: [number, number] | null = null;
  let chartHighlightTarget: ChartHighlightTarget = null;
  let pendingChartHighlight: ChartHighlightTarget = null;
  let chartHighlightScheduled = false;
  let suppressZrClickRelease = false;
  let tooltipSide: 'left' | 'right' = 'right';
  let showAllTooltipAssets = false;
  let saveGraphName = initialSaveGraphName;
  let validationMessage = '';
  let eventQuery = '';
  let eventPage = 1;
  let chartPoints: ChartPoint[] = [];
  let hasPlottedData = false;
  let renderedTimestamps: number[] = [];
  let renderedRangeFromMs: number | null = null;
  let renderedRangeToMs: number | null = null;
  let renderedCandlestickSeriesCount = 0;
  let visibleSeriesCount = 0;
  let zoomWindow: { fromMs: number; toMs: number } | null = null;
  let lastDispatchedZoomKey = '';
  let zoomDispatchTimer: ReturnType<typeof setTimeout> | null = null;
  const eventPageSize = 25;
  const chartColors = [
    '#5070dd',
    '#b6d634',
    '#505372',
    '#ff994d',
    '#0bb4ff',
    '#ffcc00',
    '#ea5f94',
    '#8d48e3',
    '#be04a0'
  ];
  const eventLegendPrefix = 'Event · ';
  const tooltipProximityRadius = 36;
  const eventLegendPinIcon = (
    'path://M12 0C5.4 0 0 5.4 0 12'
    + 'C0 20.8 12 28 12 28'
    + 'S24 20.8 24 12C24 5.4 18.6 0 12 0Z'
  );
  const controlId = (suffix: string) => (
    `${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '')}-${suffix}`
  );
  const granularityLabel = (seconds: number) => new Map([
    [300, '5 minutes'],
    [900, '15 minutes'],
    [1_800, '30 minutes'],
    [3_600, '1 hour'],
    [14_400, '4 hours'],
    [86_400, '1 day'],
    [604_800, '1 week']
  ]).get(seconds) ?? `${seconds.toLocaleString()} seconds`;
  const selectedDisplayWindow = () => {
    if (range === 'all') return null;
    if (range === 'custom') {
      const customWindow = customRangeWindow();
      return customWindow.from !== null
        && customWindow.to !== null
        && customWindow.from < customWindow.to
        ? { fromMs: customWindow.from, toMs: customWindow.to }
        : null;
    }
    const durationMs = new Map([
      ['24h', 24 * 60 * 60_000],
      ['7d', 7 * 24 * 60 * 60_000],
      ['30d', 30 * 24 * 60 * 60_000],
      ['90d', 90 * 24 * 60 * 60_000],
      ['1y', 365 * 24 * 60 * 60_000],
      ['4y', 4 * 365 * 24 * 60 * 60_000]
    ]).get(range);
    if (durationMs === undefined) return null;
    const toMs = Date.now();
    return { fromMs: toMs - durationMs, toMs };
  };
  const requestedGranularitySeconds = () => {
    const numeric = Number(selectedGranularity);
    return selectedGranularity === 'auto' || !Number.isFinite(numeric)
      ? null
      : numeric;
  };
  const resolutionLimited = () => (
    requestedGranularitySeconds() !== null
    && granularity > requestedGranularitySeconds()!
  );
  const denominationFallbackCurrencies = (unit: string) => [...new Set(
    allPoints()
      .map((point) => point.denominationFallbacks?.[unit])
      .filter((fallback): fallback is string => Boolean(fallback))
  )];
  const approximateDenomination = () => (
    denominationFallbackCurrencies(yAxisUnit).length > 0
    || (
      rightYAxisUnit !== ''
      && denominationFallbackCurrencies(rightYAxisUnit).length > 0
    )
  );
  const qualityMessage = () => {
    const resolutionMessage = resolutionLimited()
      && !partialMessage.includes('zoomed-out overview resolves')
      ? `${granularityLabel(requestedGranularitySeconds()!)} detail is selected, while the zoomed-out chart currently resolves to ${granularityLabel(granularity)}. Zoomed periods use finer observations where the local history contains them.`
      : '';
    const denominationMessages = [
      {
        side: 'Left',
        unit: yAxisUnit,
        label: yAxisUnitLabel()
      },
      ...rightYAxisUnit
        ? [{
            side: 'Right',
            unit: rightYAxisUnit,
            label: unitLabel(rightYAxisUnit)
          }]
        : []
    ].flatMap(({ side, unit, label }) => {
      const fallbacks = denominationFallbackCurrencies(unit);
      return fallbacks.length > 0
        ? [`${side} ${label} Y-axis values are approximate where a direct ${currency.toUpperCase()} pair was unavailable; those points were normalized through ${fallbacks.join(' or ')} reserve prices.`]
        : [];
    });
    const rightAxisMessage = rightYAxisUnit
      ? normalized
        ? 'The Right Y-axis is hidden while Normalize to 0% is enabled.'
        : rightYAxisConversionRatio() === null
        ? `The Right ${unitLabel(rightYAxisUnit)} Y-axis is selected, but no overlapping conversion is available yet.`
        : `The Right ${unitLabel(rightYAxisUnit)} Y-axis is a reference scale based on the latest overlapping conversion. Popup units remain point-in-time values.`
      : '';
    return [
      resolutionMessage,
      ...denominationMessages,
      rightAxisMessage,
      partial ? partialMessage : ''
    ].filter(Boolean).join(' ');
  };

  const seriesIsVisible = (id: string) => (
    useAllSeriesByDefault || selectedSeriesIds.includes(id)
  );
  const visibleChartSeries = () => series.filter((item) => seriesIsVisible(item.id));
  const allPoints = () => series.flatMap((item) => item.points);
  const rawPointValue = (point: ChartPoint) => point.value ?? point.close ?? null;
  let effectiveDenominationOptionList: ChartDenominationOption[] = [];
  let configuredFiatCurrencyList: string[] = [];
  let yAxisOptionList: ChartAxisOption[] = [];
  let tooltipUnitOptionList: ChartAxisOption[] = [];
  let displayedSeriesOptionList: ChartAxisOption[] = [];
  let rightYAxisUnitOptionList: ChartAxisOption[] = [];
  $: effectiveDenominationOptionList = [
    ...new Map<string, ChartDenominationOption>([
      ...denominationOptions,
      ...activeAxisDenominationOptions
    ].map((option) => [option.id, option])).values()
  ];
  $: configuredFiatCurrencyList = [...new Set([
    currency.toUpperCase(),
    ...activeAxisCurrencies,
    ...tooltipCurrencies
      .map((quote) => quote.toUpperCase())
      .filter((quote) => /^[A-Z]{3}$/.test(quote))
  ])];
  $: yAxisOptionList = buildChartAxisOptions({
    primaryCurrency: currency,
    listedCurrencies: [...tooltipCurrencies, ...activeAxisCurrencies],
    denominationOptions: effectiveDenominationOptionList
  });
  $: tooltipUnitOptionList = currency.trim() === '%'
    ? [{
        value: '%',
        label: '% · Percentage',
        group: 'Display units' as const,
        searchText: 'percent percentage return rate'
      }]
    : yAxisOptionList;
  $: displayedSeriesOptionList = series.map((item) => ({
    value: item.id,
    label: item.label,
    group: 'Display units' as const,
    searchText: `${item.id} ${item.label} chart line series`
  }));
  $: rightYAxisUnitOptionList = [
    {
      value: '',
      label: 'Off · use left Y-axis',
      group: 'Display units' as const,
      searchText: 'off disabled left axis'
    },
    ...yAxisOptionList
  ];
  const isFiatUnit = (unit: string) => configuredFiatCurrencyList.includes(unit.toUpperCase());
  const pointValueForUnit = (point: ChartPoint, unit: string) => (
    unit !== currency
      ? isFiatUnit(unit)
        ? point.quotes?.[unit.toUpperCase()] ?? null
        : point.denominations?.[unit] ?? null
      : rawPointValue(point)
  );
  const plottedPointValue = (point: ChartPoint) => pointValueForUnit(point, yAxisUnit);
  const unitLabel = (unit: string) => isFiatUnit(unit)
    ? unit.toUpperCase()
    : effectiveDenominationOptionList.find((option) => option.id === unit)?.symbol ?? unit;
  const yAxisUnitLabel = () => unitLabel(yAxisUnit);
  const rightYAxisConversionRatio = () => {
    if (!rightYAxisUnit) return null;
    if (rightYAxisUnit === yAxisUnit) return 1;
    const points = visibleChartSeries()
      .flatMap((item) => item.points)
      .sort((left, right) => right.timestampMs - left.timestampMs);
    for (const point of points) {
      const rawLeftValue = pointValueForUnit(point, yAxisUnit);
      const rawRightValue = pointValueForUnit(point, rightYAxisUnit);
      if (rawLeftValue === null || rawRightValue === null) continue;
      const leftValue = Number(rawLeftValue);
      const rightValue = Number(rawRightValue);
      if (
        Number.isFinite(leftValue)
        && leftValue !== 0
        && Number.isFinite(rightValue)
        && rightValue !== 0
      ) return rightValue / leftValue;
    }
    return null;
  };
  const candlestickValueForUnit = ({
    point,
    value
  }: {
    point: ChartPoint;
    value: number;
  }) => {
    if (yAxisUnit === currency) return value;
    const rawReference = Number(rawPointValue(point));
    const convertedReference = Number(pointValueForUnit(point, yAxisUnit));
    if (
      !Number.isFinite(rawReference)
      || rawReference === 0
      || !Number.isFinite(convertedReference)
    ) return Number.NaN;
    return value * (convertedReference / rawReference);
  };
  const tooltipUnitLabel = (unit: string) => {
    if (unit === '%') return '%';
    if (isFiatUnit(unit)) return unit.toUpperCase();
    return effectiveDenominationOptionList.find((option) => option.id === unit)?.symbol ?? unit;
  };
  const tooltipUnitValue = (point: ChartPoint, unit: string) => {
    if (unit === '%') return rawPointValue(point);
    if (isFiatUnit(unit)) {
      return point.quotes?.[unit.toUpperCase()]
        ?? (unit.toUpperCase() === currency.toUpperCase() ? rawPointValue(point) : null);
    }
    return point.denominations?.[unit] ?? null;
  };
  const assetQuantityLabel = (assetId: string) => (
    effectiveDenominationOptionList.find((option) => option.id === assetId)?.symbol
    ?? assetId.toUpperCase()
  );
  const visibleTooltipQuantities = (quantities: Record<string, string> | undefined) => {
    const enabledAssetIds = tooltipEnabledAssetIds === null
      ? null
      : new Set(tooltipEnabledAssetIds);
    return Object.entries(quantities ?? {}).filter(([assetId, quantity]) => (
      Number(quantity) !== 0
      && (
        showAllTooltipAssets
        || enabledAssetIds === null
        || enabledAssetIds.has(assetId)
      )
    ));
  };
  const formatChartValue = (value: unknown) => value === null || value === undefined
    ? 'unavailable'
    : currency.trim() === '%'
      ? formatPercent(value)
      : formatDisplayNumber({ value });
  const validNumericValues = () => visibleChartSeries()
    .flatMap((item) => item.points)
    .map(plottedPointValue)
    .filter((value): value is string => value !== null && value !== undefined)
    .map(Number)
    .filter(Number.isFinite);
  const visibleNumericValues = () => visibleChartSeries()
    .flatMap((item) => item.points)
    .map(plottedPointValue)
    .filter((value): value is string => value !== null && value !== undefined)
    .map(Number)
    .filter(Number.isFinite);
  const displayedNumericValues = () => normalized && chartMode === 'line'
    ? visibleChartSeries().flatMap((item) => normalizedSeries(item))
      .map((point) => point.normalizedPercent)
      .filter((value): value is string => value !== null)
      .map(Number)
      .filter(Number.isFinite)
    : visibleNumericValues();
  const logAvailable = () => displayedNumericValues().some((value) => value > 0);
  const scaledValue = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return scale === 'log' && numeric <= 0 ? null : numeric;
  };
  const meaningfulVolume = () => source !== 'combined' && allPoints().some((point) => point.volume !== null && point.volume !== undefined);
  const normalizedSeries = (item: ChartSeries) => {
    const base = item.points.find((point) => {
      const value = plottedPointValue(point);
      return value !== null && Number(value) !== 0;
    });
    const baseValue = base ? Number(plottedPointValue(base)) : null;
    return item.points.map((point) => {
      const raw = plottedPointValue(point);
      return {
        ...point,
        rawValue: raw,
        normalizedPercent: raw === null || baseValue === null
          ? null
          : String(((Number(raw) - baseValue) / baseValue) * 100),
        normalizationBaseTimestampMs: base?.timestampMs ?? null
      };
    });
  };

  const escapeHtml = (value: unknown) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
  const tooltipHeading = ({
    label,
    color
  }: {
    label: string;
    color: string;
  }) => (
    `<span style="display:inline-flex;align-items:center;gap:.45rem">`
    + `<span aria-hidden="true" style="display:inline-block;width:.7rem;height:.7rem;`
    + `flex:0 0 .7rem;border-radius:999px;background:${escapeHtml(color)};`
    + `box-shadow:0 0 0 2px rgba(255,255,255,.16)"></span>`
    + `<strong>${escapeHtml(label)}</strong>`
    + '</span>'
  );
  const tooltipSeriesHeading = ({
    item,
    color
  }: {
    item: ChartSeries;
    color: string;
  }) => tooltipHeading({ label: item.label, color });
  const tooltipSeriesRowStyle = ({
    color,
    highlighted
  }: {
    color: string;
    highlighted: boolean;
  }) => (
    `padding:.22rem .35rem;margin-left:-.35rem;margin-right:-.35rem;`
    + `border:1px solid ${highlighted ? escapeHtml(color) : 'transparent'};`
    + `border-radius:.45rem;background:${highlighted ? 'rgba(255,188,58,.13)' : 'transparent'};`
  );
  const sameChartHighlight = (
    left: ChartHighlightTarget,
    right: ChartHighlightTarget
  ) => (
    left === right
    || (
      left !== null
      && right !== null
      && left.seriesIndex === right.seriesIndex
      && left.dataIndex === right.dataIndex
    )
  );
  const scheduleChartHighlight = (target: ChartHighlightTarget) => {
    pendingChartHighlight = target;
    if (chartHighlightScheduled) return;
    chartHighlightScheduled = true;
    queueMicrotask(() => {
      chartHighlightScheduled = false;
      const next = pendingChartHighlight;
      pendingChartHighlight = null;
      if (!chart) {
        chartHighlightTarget = null;
        return;
      }
      if (sameChartHighlight(chartHighlightTarget, next)) return;
      if (chartHighlightTarget) {
        chart.dispatchAction({
          type: 'downplay',
          seriesIndex: chartHighlightTarget.seriesIndex,
          dataIndex: chartHighlightTarget.dataIndex
        });
      }
      if (next) {
        chart.dispatchAction({
          type: 'highlight',
          seriesIndex: next.seriesIndex,
          dataIndex: next.dataIndex
        });
      }
      chartHighlightTarget = next;
    });
  };

  const eventMarkerColor = (event: ChartEvent) => {
    if (event.reconciliationState === 'likely') return '#ffbc3a';
    if (event.category === 'reward') return '#39ff79';
    if (['sale', 'withdrawal', 'unstake'].includes(event.category)) return '#ff6fce';
    if (['purchase', 'deposit', 'stake'].includes(event.category)) return '#00b6ff';
    if (event.category === 'disputed') return '#ff1f5a';
    return '#b86cff';
  };

  const eventTooltip = ({
    event,
    pinnedTimestampMs
  }: {
    event: ChartEvent;
    pinnedTimestampMs: number;
  }) => {
    const color = eventMarkerColor(event);
    const omittedDetailKeys = new Set(['transactionId', 'krakenId', 'assetRaw']);
    const detailRows = Object.entries(event.details ?? {})
      .filter(([key]) => !omittedDetailKeys.has(key))
      .map(([key, value]) => {
        const displayed = key === 'subtype' && (value === null || value === '')
          ? 'none'
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
        return `<span>${escapeHtml(key)}</span> <strong>${escapeHtml(displayed)}</strong>`;
      })
      .join('<br />');
    const snappedTime = pinnedTimestampMs !== event.timestampMs
      ? `<div style="margin-top:.35rem;opacity:.72">Marker shown at ${escapeHtml(formatInTimezone({
          timestampMs: pinnedTimestampMs,
          timezone
        }))} to align this event with the chart.</div>`
      : '';
    return (
      `<div style="max-width:26rem;white-space:normal;overflow-wrap:anywhere">`
      + tooltipHeading({ label: `Event · ${event.category}`, color })
      + `<div style="margin-top:.45rem"><strong>${escapeHtml(formatInTimezone({
          timestampMs: event.timestampMs,
          timezone
        }))}</strong></div>`
      + (event.asset
        ? `<div><span>Asset</span> <strong>${escapeHtml(assetQuantityLabel(event.asset))}</strong></div>`
        : '')
      + (event.quantity !== undefined
        ? `<div><span>Quantity</span> <strong>${escapeHtml(formatDisplayNumber({ value: event.quantity }))}</strong></div>`
        : '')
      + (event.source
        ? `<div><span>Source</span> <strong>${escapeHtml(event.source)}</strong></div>`
        : '')
      + (event.reconciliationState
        ? `<div><span>Reconciliation</span> <strong>${escapeHtml(event.reconciliationState)}</strong></div>`
        : '')
      + (detailRows
        ? `<div style="margin-top:.45rem;padding-top:.45rem;border-top:1px solid rgba(127,127,127,.35)">${detailRows}</div>`
        : '')
      + snappedTime
      + '</div>'
    );
  };

  const resolveAxisBounds = () => {
    const values = validNumericValues();
    if (values.length === 0) return {};
    const dataMinimum = Math.min(...values);
    const dataMaximum = Math.max(...values);
    const rangeValue = dataMaximum - dataMinimum || Math.max(Math.abs(dataMaximum), 1);
    const resolveBound = ({
      mode,
      input,
      minimum
    }: {
      mode: 'auto' | 'absolute' | 'relative';
      input: string;
      minimum: boolean;
    }) => {
      if (mode === 'auto') return undefined;
      const parsed = Number(input);
      if (!Number.isFinite(parsed)) return Number.NaN;
      if (mode === 'absolute') return parsed;
      const padding = rangeValue * (parsed / 100);
      return minimum ? dataMinimum - padding : dataMaximum + padding;
    };
    const min = resolveBound({ mode: minimumMode, input: minimumValue, minimum: true });
    const max = resolveBound({ mode: maximumMode, input: maximumValue, minimum: false });
    validationMessage = '';
    if (Number.isNaN(min) || Number.isNaN(max)) {
      validationMessage = 'Bounds must contain valid decimal values.';
      return {};
    }
    if (min !== undefined && max !== undefined && min >= max) {
      validationMessage = 'Absolute minimum must be less than maximum.';
      return {};
    }
    if (scale === 'log' && ((min !== undefined && min <= 0) || (max !== undefined && max <= 0))) {
      validationMessage = 'Logarithmic bounds must be positive.';
      return {};
    }
    return { min, max };
  };

  const visibleEvents = () => showEvents
    ? events.filter((event) => eventCategories.has(event.category))
    : [];
  const filteredEvents = () => {
    const normalized = eventQuery.trim().toLowerCase();
    if (!normalized) return visibleEvents();
    return visibleEvents().filter((event) => [
      event.category,
      event.asset,
      event.quantity,
      event.source,
      event.reconciliationState,
      JSON.stringify(event.details ?? {})
    ].some((value) => String(value ?? '').toLowerCase().includes(normalized)));
  };
  const eventPageCount = () => Math.max(1, Math.ceil(filteredEvents().length / eventPageSize));
  const pagedEvents = () => {
    const page = Math.min(eventPage, eventPageCount());
    const start = (page - 1) * eventPageSize;
    return filteredEvents().slice(start, start + eventPageSize);
  };

  const renderChart = () => {
    if (!chart) return;
    const rootStyles = getComputedStyle(document.documentElement);
    const themeValue = (name: string, fallback: string) => (
      rootStyles.getPropertyValue(name).trim() || fallback
    );
    const textColor = themeValue('--color-text', '#eef6ff');
    const mutedColor = themeValue('--color-muted', '#a4b0c2');
    const panelColor = themeValue('--color-panel-strong', '#10161c');
    const borderColor = themeValue('--color-border-strong', '#364255');
    const fontFamily = themeValue('--font-mono', 'monospace');
    const axisBounds = resolveAxisBounds();
    if (scale === 'log' && !logAvailable()) {
      validationMessage = 'Logarithmic mode is selected, but the plotted data has no positive values yet.';
    }
    const chartSeries: NonNullable<EChartsOption['series']> = [];
    const sourceSeries = normalized && chartMode === 'line'
      ? series.map((item) => ({ ...item, points: normalizedSeries(item) }))
      : series;
    const rightAxisRatio = normalized ? null : rightYAxisConversionRatio();
    const hasRightYAxis = rightYAxisUnit !== '' && rightAxisRatio !== null;
    renderedCandlestickSeriesCount = chartMode === 'candlestick'
      ? sourceSeries.filter((item) => seriesIsVisible(item.id)).length
      : 0;
    const volumeYAxisIndex = hasRightYAxis ? 2 : 1;
    const dataTimestamps = sourceSeries.flatMap((item) => (
      item.points.map((point) => point.timestampMs)
    ));
    const displayWindow = selectedDisplayWindow();
    const timestamps = [...new Set([
      ...dataTimestamps,
      ...(displayWindow ? [displayWindow.fromMs, displayWindow.toMs] : [])
    ])].sort((left, right) => left - right);
    renderedTimestamps = timestamps;
    renderedRangeFromMs = displayWindow?.fromMs ?? timestamps[0] ?? null;
    renderedRangeToMs = displayWindow?.toMs ?? timestamps.at(-1) ?? null;
    const retainedZoom = zoomWindow && timestamps.length > 1
      ? {
          startValue: timestamps.find((timestampMs) => timestampMs >= zoomWindow!.fromMs)
            ?? timestamps[0],
          endValue: timestamps.findLast((timestampMs) => timestampMs <= zoomWindow!.toMs)
            ?? timestamps.at(-1)
        }
      : {};
    for (const [index, item] of sourceSeries.entries()) {
      if (chartMode === 'candlestick') {
        const pointsByTimestamp = new Map(item.points.map((point) => [point.timestampMs, point]));
        chartSeries.push({
          id: item.id,
          name: item.label,
          type: 'candlestick',
          yAxisIndex: 0,
          encode: {
            x: 0,
            y: [1, 2, 3, 4]
          },
          data: timestamps.map((timestampMs) => {
            const point = pointsByTimestamp.get(timestampMs);
            if (!point) {
              return {
                value: [
                  timestampMs,
                  Number.NaN,
                  Number.NaN,
                  Number.NaN,
                  Number.NaN
                ],
                meta: null
              };
            }
            const rawOpen = Number(point.open ?? point.close ?? 0);
            const rawClose = Number(point.close ?? point.open ?? 0);
            const rawLow = showWicks
              ? Number(point.low ?? Math.min(rawOpen, rawClose))
              : Math.min(rawOpen, rawClose);
            const rawHigh = showWicks
              ? Number(point.high ?? Math.max(rawOpen, rawClose))
              : Math.max(rawOpen, rawClose);
            const open = candlestickValueForUnit({ point, value: rawOpen });
            const close = candlestickValueForUnit({ point, value: rawClose });
            const low = candlestickValueForUnit({ point, value: rawLow });
            const high = candlestickValueForUnit({ point, value: rawHigh });
            return {
              value: [timestampMs, open, close, low, high],
              meta: point
            };
          }),
          itemStyle: {
            color: '#39ff79',
            color0: '#ff1f5a',
            borderColor: '#39ff79',
            borderColor0: '#ff1f5a'
          }
        });
      } else {
        const pointsByTimestamp = new Map(item.points.map((point) => [point.timestampMs, point]));
        chartSeries.push({
          id: item.id,
          name: item.label,
          type: 'line',
          yAxisIndex: 0,
          showSymbol: false,
          symbolSize: 8,
          connectNulls: false,
          sampling: 'lttb',
          lineStyle: {
            type: index % 3 === 1 ? 'dashed' : index % 3 === 2 ? 'dotted' : 'solid',
            width: index === 0 ? 2.5 : 1.8
          },
          emphasis: {
            focus: 'series',
            scale: 1.8,
            lineStyle: {
              width: 4
            }
          },
          blur: {
            lineStyle: {
              opacity: 0.22
            }
          },
          data: timestamps.map((timestampMs) => {
            const point = pointsByTimestamp.get(timestampMs);
            return {
              value: [
                timestampMs,
                point
                  ? normalized && chartMode === 'line'
                    ? scaledValue(point.normalizedPercent)
                    : scaledValue(plottedPointValue(point))
                  : null
              ],
              meta: point ?? null
            };
          })
        });
      }
    }
    if (hasRightYAxis) {
      chartSeries.push({
        id: 'right-axis-reference-scale',
        name: 'Right axis reference scale',
        type: 'line',
        yAxisIndex: 1,
        showSymbol: false,
        symbol: 'none',
        silent: true,
        lineStyle: {
          opacity: 0
        },
        itemStyle: {
          opacity: 0
        },
        tooltip: {
          show: false
        },
        data: sourceSeries
          .filter((item) => seriesIsVisible(item.id))
          .flatMap((item) => item.points.map((point) => [
            point.timestampMs,
            normalized && chartMode === 'line'
              ? scaledValue(point.normalizedPercent)
              : scaledValue(plottedPointValue(point))
          ]))
      });
    }
    const primarySeriesIndex = sourceSeries.findIndex((item) => seriesIsVisible(item.id));
    const primaryPoints = primarySeriesIndex >= 0
      ? sourceSeries[primarySeriesIndex]?.points ?? []
      : [];
    const primaryPointsByTimestamp = new Map(primaryPoints.map((point) => [
      point.timestampMs,
      point
    ]));
    if (showVolume && meaningfulVolume()) {
      chartSeries.push({
        id: 'volume',
        name: 'Volume',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: volumeYAxisIndex,
        data: timestamps.map((timestampMs) => {
          const point = primaryPointsByTimestamp.get(timestampMs);
          return [
            timestampMs,
            point?.volume === null || point?.volume === undefined
              ? null
              : Number(point.volume)
          ];
        }),
        itemStyle: {
          color: 'rgba(0, 182, 255, 0.45)'
        }
      });
    }
    const valuedPrimaryPoints = primaryPoints.flatMap((point) => {
      const value = normalized && chartMode === 'line'
        ? point.normalizedPercent
        : plottedPointValue(point);
      const scaled = scaledValue(value);
      return scaled === null ? [] : [{ point, value: scaled }];
    });
    const markerData = visibleEvents().flatMap((event) => {
      const nearest = valuedPrimaryPoints.reduce<{
        point: ChartPoint;
        value: number;
      } | null>((current, candidate) => (
        current === null
          || Math.abs(candidate.point.timestampMs - event.timestampMs)
            < Math.abs(current.point.timestampMs - event.timestampMs)
          ? candidate
          : current
      ), null);
      if (!nearest) return [];
      return [{
        name: event.category,
        coord: [nearest.point.timestampMs, nearest.value],
        value: event.category,
        event,
        pinnedTimestampMs: nearest.point.timestampMs,
        itemStyle: {
          color: eventMarkerColor(event),
          borderColor: panelColor,
          borderWidth: 1.5
        }
      }];
    });
    if (markerData.length > 0 && primarySeriesIndex >= 0 && chartSeries[primarySeriesIndex]) {
      (chartSeries[primarySeriesIndex] as { markPoint?: unknown }).markPoint = {
        symbol: 'pin',
        symbolSize: 44,
        z: 20,
        label: {
          show: false
        },
        data: markerData,
        tooltip: {
          trigger: 'item',
          formatter: (parameters: unknown) => {
            const data = (
              parameters as {
                data?: {
                  event?: ChartEvent;
                  pinnedTimestampMs?: number;
                };
              }
            ).data;
            return data?.event && data.pinnedTimestampMs !== undefined
              ? eventTooltip({
                  event: data.event,
                  pinnedTimestampMs: data.pinnedTimestampMs
                })
              : '';
          }
        }
      };
    }
    const enabledEventTypes = [...new Set(
      visibleEvents().map((event) => event.category)
    )];
    for (const category of enabledEventTypes) {
      const representative = visibleEvents().find((event) => event.category === category);
      if (!representative) continue;
      chartSeries.push({
        id: `event-legend:${category}`,
        name: `${eventLegendPrefix}${category}`,
        type: 'scatter',
        data: [],
        symbol: 'pin',
        symbolSize: 16,
        silent: true,
        itemStyle: {
          color: eventMarkerColor(representative)
        },
        tooltip: {
          show: false
        }
      });
    }
    const option: EChartsOption = {
      animation: false,
      backgroundColor: 'transparent',
      color: chartColors,
      title: {
        text: title,
        subtext: minimalChrome ? undefined : `${source} · ${granularity}s resolved`,
        top: minimalChrome ? 8 : 14,
        left: 18,
        textStyle: {
          color: textColor,
          fontFamily,
          fontSize: 18
        },
        subtextStyle: {
          color: mutedColor,
          fontSize: 12
        }
      },
      legend: {
        type: 'scroll',
        top: minimalChrome ? 46 : 72,
        left: 18,
        right: 18,
        itemWidth: 22,
        itemHeight: 18,
        data: [
          ...sourceSeries.map((item) => item.label),
          ...(showVolume && meaningfulVolume() ? ['Volume'] : []),
          ...enabledEventTypes.map((category) => ({
            name: `${eventLegendPrefix}${category}`,
            icon: eventLegendPinIcon,
            symbolKeepAspect: true
          }))
        ],
        selected: Object.fromEntries(sourceSeries.map((item) => [
          item.label,
          seriesIsVisible(item.id)
        ])),
        textStyle: {
          color: textColor
        }
      },
      grid: showVolume && meaningfulVolume()
        ? [
            { left: 70, right: hasRightYAxis ? 82 : 28, top: minimalChrome ? 96 : 118, height: '50%' },
            { left: 70, right: hasRightYAxis ? 82 : 28, top: '74%', height: '15%' }
          ]
        : {
            left: 70,
            right: hasRightYAxis ? 82 : 28,
            top: minimalChrome ? 96 : 118,
            bottom: minimalChrome ? 42 : 78
          },
      xAxis: showVolume && meaningfulVolume()
        ? [
            {
              type: 'time',
              axisLabel: {
                hideOverlap: true,
                formatter: (value: number) => formatInTimezone({ timestampMs: value, timezone })
              },
              axisPointer: { show: true },
              boundaryGap: [0, 0],
              gridIndex: 0
            },
            {
              type: 'time',
              axisLabel: { show: false },
              gridIndex: 1
            }
          ]
        : {
            type: 'time',
            boundaryGap: [0, 0],
            axisLabel: {
              color: mutedColor,
              hideOverlap: true,
              formatter: (value: number) => formatInTimezone({ timestampMs: value, timezone })
            },
            axisPointer: { show: true }
          },
      yAxis: [
        {
          type: scale === 'log' ? 'log' : 'value',
          name: normalized ? '% change' : yAxisUnitLabel(),
          min: axisBounds.min,
          max: axisBounds.max,
          scale: true,
          gridIndex: 0,
          position: 'left',
          axisLabel: {
            color: mutedColor,
            formatter: (value: number) => normalized
              ? formatPercent(value)
              : formatChartValue(value)
          }
        },
        ...(hasRightYAxis
          ? [{
            type: (scale === 'log' ? 'log' : 'value') as 'log' | 'value',
            name: unitLabel(rightYAxisUnit),
            min: axisBounds.min,
            max: axisBounds.max,
            scale: true,
            gridIndex: 0,
            position: 'right' as const,
            axisLabel: {
              color: mutedColor,
              formatter: (value: number) => formatChartValue(value * rightAxisRatio)
            }
          }]
          : []),
        ...(showVolume && meaningfulVolume()
          ? [{
              type: 'value' as const,
              name: 'Volume',
              scale: true,
              gridIndex: 1
            }]
          : [])
      ],
      axisPointer: {
        triggerOn: busy || tooltipPinned ? 'none' : 'mousemove|click',
        link: [{ xAxisIndex: 'all' }],
        lineStyle: {
          color: '#ffbc3a',
          width: 2
        }
      },
      tooltip: {
        show: !busy,
        trigger: 'axis',
        triggerOn: busy || tooltipPinned ? 'none' : 'mousemove|click|mousewheel',
        renderMode: 'html',
        enterable: true,
        alwaysShowContent: !busy && tooltipPinned,
        hideDelay: 300,
        backgroundColor: panelColor,
        borderColor,
        borderWidth: 1,
        padding: 12,
        textStyle: {
          color: textColor,
          fontFamily,
          fontSize: 13
        },
        extraCssText: 'user-select:text;-webkit-user-select:text;pointer-events:auto;cursor:text;box-shadow:0 14px 36px rgba(0,0,0,.45);border-radius:.7rem;',
        axisPointer: {
          type: 'line'
        },
        confine: true,
        position: (
          point: number[],
          _parameters: unknown,
          _element: unknown,
          _rect: unknown,
          size: { contentSize: number[]; viewSize: number[] }
        ) => {
          const margin = 28;
          const leftScaleGutter = 86;
          const proximity = 36;
          const rightLeft = Math.max(
            leftScaleGutter,
            size.viewSize[0] - size.contentSize[0] - margin
          );
          if (
            tooltipSide === 'right'
            && point[0] >= rightLeft - proximity
          ) {
            tooltipSide = 'left';
          } else if (
            tooltipSide === 'left'
            && point[0] <= leftScaleGutter + size.contentSize[0] + proximity
          ) {
            tooltipSide = 'right';
          }
          const left = tooltipSide === 'right'
            ? rightLeft
            : Math.min(
                leftScaleGutter,
                Math.max(margin, size.viewSize[0] - size.contentSize[0] - margin)
              );
          return [
            left,
            Math.min(margin, Math.max(0, size.viewSize[1] - size.contentSize[1]))
          ];
        },
        formatter: (rawParameters) => {
          const parameters = Array.isArray(rawParameters) ? rawParameters : [rawParameters];
          const eventParameter = parameters.find((parameter) => (
            (parameter.data as { event?: ChartEvent } | undefined)?.event
          ));
          const eventData = eventParameter?.data as {
            event?: ChartEvent;
            pinnedTimestampMs?: number;
          } | undefined;
          if (eventData?.event && eventData.pinnedTimestampMs !== undefined) {
            hoveredTooltipTarget = null;
            hoveredTooltipIsEvent = true;
            scheduleChartHighlight(null);
            return eventTooltip({
              event: eventData.event,
              pinnedTimestampMs: eventData.pinnedTimestampMs
            });
          }
          const hoveredSeriesParameter = parameters.find((parameter) => (
            sourceSeries.some((item) => item.id === String(parameter.seriesId))
            && typeof parameter.seriesIndex === 'number'
            && typeof parameter.dataIndex === 'number'
          ));
          hoveredTooltipTarget = hoveredSeriesParameter
            ? {
                seriesIndex: Number(hoveredSeriesParameter.seriesIndex),
                dataIndex: Number(hoveredSeriesParameter.dataIndex)
              }
            : null;
          hoveredTooltipIsEvent = false;
          const timestamp = (
            parameters.find((parameter) => (
              (parameter.data as { meta?: ChartPoint | null } | undefined)?.meta
            ))?.data as { meta?: ChartPoint | null } | undefined
          )?.meta?.timestampMs
            ?? timestamps[Number(parameters[0]?.dataIndex ?? 0)];
          const tooltipPoints = sourceSeries.flatMap((item, seriesIndex) => {
            const parameter = parameters.find((candidate) => String(candidate.seriesId) === item.id);
            const parameterPoint = (
              parameter?.data as { meta?: ChartPoint | null } | undefined
            )?.meta;
            const point = parameterPoint
              ?? item.points.find((candidate) => candidate.timestampMs === timestamp);
            if (!point) return [];
            const dataIndex = typeof parameter?.dataIndex === 'number'
              ? parameter.dataIndex
              : timestamps.indexOf(point.timestampMs);
            const displayedValue = normalized && chartMode === 'line'
              ? point.normalizedPercent
              : plottedPointValue(point);
            const plottedValue = scaledValue(displayedValue);
            const pixel = dataIndex >= 0 && plottedValue !== null
              ? chart?.convertToPixel(
                  { seriesIndex },
                  [point.timestampMs, plottedValue]
                )
              : null;
            const distance = (
              tooltipPointerPosition
              && Array.isArray(pixel)
              && Number.isFinite(Number(pixel[0]))
              && Number.isFinite(Number(pixel[1]))
            )
              ? Math.hypot(
                  Number(pixel[0]) - tooltipPointerPosition[0],
                  Number(pixel[1]) - tooltipPointerPosition[1]
                )
              : null;
            return [{
              item,
              point,
              color: chartColors[seriesIndex % chartColors.length]!,
              seriesIndex,
              dataIndex,
              distance
            }];
          });
          if (tooltipPoints.length === 0) return '';
          const closestTooltipPoint = closestCandidateWithinRadius({
            candidates: tooltipPoints,
            radius: tooltipProximityRadius
          });
          const highlightedSeriesId = closestTooltipPoint?.item.id ?? null;
          scheduleChartHighlight(closestTooltipPoint
            ? {
                seriesIndex: closestTooltipPoint.seriesIndex,
                dataIndex: closestTooltipPoint.dataIndex
              }
            : null);
          const isCombinedSeries = (id: string) => (
            id === 'combined'
            || id === 'kraken-total'
            || id === 'kraken-earn-total'
          );
          const combinedTooltipPoints = tooltipPoints
            .filter(({ item }) => isCombinedSeries(item.id))
            .slice(0, 1);
          const individualTooltipPoints = tooltipPoints.filter(({ item }) => !isCombinedSeries(item.id));
          const exactAmountPoints = combinedTooltipPoints.length > 0
            ? combinedTooltipPoints
            : individualTooltipPoints;
          const inlineCombinedIds = new Set([
            'combined',
            'kraken-total',
            'kraken-earn-total'
          ]);
          const quantitiesBelongInline = (id: string) => (
            inlineCombinedIds.has(id)
            || source.toLowerCase().startsWith('kraken')
          );
          const exactAmounts = exactAmountPoints
            .map(({ item, point, color }) => {
              if (quantitiesBelongInline(item.id)) return '';
              const quantities = visibleTooltipQuantities(point.quantities);
              if (quantities.length === 0) return '';
              const highlighted = item.id === highlightedSeriesId;
              const quantityRows = quantities.map(([assetId, quantity]) => (
                `<span>${escapeHtml(assetQuantityLabel(assetId))}</span> <strong>${escapeHtml(formatChartValue(quantity))}</strong>`
              )).join('<br />');
              return `<div style="margin-top:.35rem;${tooltipSeriesRowStyle({ color, highlighted })}">${tooltipSeriesHeading({ item, color })}<br />${quantityRows}</div>`;
            })
            .filter(Boolean)
            .join('');
          const exactAmountsSection = exactAmounts
            ? `<div style="margin-top:.55rem;padding-bottom:.55rem;border-bottom:1px solid rgba(127,127,127,.35)"><strong>Exact asset amounts</strong>${exactAmounts}</div>`
            : '';
          const rows = [
            ...combinedTooltipPoints,
            ...individualTooltipPoints
          ].map(({ item, point, color }) => {
            const highlighted = item.id === highlightedSeriesId;
            const combinedQuantityRows = quantitiesBelongInline(item.id)
              ? visibleTooltipQuantities(point.quantities)
                .map(([assetId, quantity]) => (
                  `<span>${escapeHtml(assetQuantityLabel(assetId))}</span> <strong>${escapeHtml(formatChartValue(quantity))}</strong>`
                )).join('<br />')
              : '';
            const valueRows = selectedTooltipUnits.map((unit) => (
              `<span>${escapeHtml(tooltipUnitLabel(unit))}</span> <strong>${escapeHtml(formatChartValue(tooltipUnitValue(point, unit)))}</strong>`
            )).join('<br />');
            const status = point.disputed ? 'disputed' : point.status;
            const statusRow = status
              && !(source === 'derived analytics' && status === 'derived')
              && !['native', 'fallback'].includes(status)
              ? `<span>${escapeHtml(status)}</span><br />`
              : '';
            const quantityRows = combinedQuantityRows
              ? `${combinedQuantityRows}<br />`
              : '';
            return `<div style="margin-top:.55rem;${tooltipSeriesRowStyle({ color, highlighted })}">${tooltipSeriesHeading({ item, color })}<br />${quantityRows}${statusRow}${valueRows}</div>`;
          }).join('');
          return `<div><strong>${formatInTimezone({ timestampMs: timestamp ?? 0, timezone })}</strong>${exactAmountsSection}${rows}</div>`;
        }
      },
      dataZoom: [
        {
          id: 'inside-time-zoom',
          type: 'inside',
          xAxisIndex: showVolume && meaningfulVolume() ? [0, 1] : [0],
          disabled: busy || !chartInteractionActive,
          zoomOnMouseWheel: !busy && chartInteractionActive,
          moveOnMouseMove: !busy && chartInteractionActive,
          moveOnMouseWheel: !busy && chartInteractionActive,
          ...retainedZoom
        },
        ...minimalChrome ? [] : [{
          id: 'horizontal-time-selector',
          type: 'slider',
          xAxisIndex: showVolume && meaningfulVolume() ? [0, 1] : [0],
          disabled: busy,
          bottom: 18,
          borderColor: '#202835',
          fillerColor: 'rgba(0, 182, 255, 0.18)',
          ...retainedZoom
        }]
      ],
      series: chartSeries
    };
    chartHighlightTarget = null;
    pendingChartHighlight = null;
    chart.setOption(option, true);
  };

  const resetZoom = () => {
    zoomWindow = null;
    lastDispatchedZoomKey = '';
    if (zoomDispatchTimer) clearTimeout(zoomDispatchTimer);
    zoomDispatchTimer = null;
    chart?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
  };

  const scheduleZoomRange = () => {
    if (busy || !chart || renderedTimestamps.length < 2) return;
    const options = chart.getOption() as {
      dataZoom?: Array<{
        id?: string;
        start?: number;
        end?: number;
      }>;
    };
    const dataZoom = options.dataZoom?.find((item) => item.id === 'horizontal-time-selector')
      ?? options.dataZoom?.[0];
    const start = Math.max(0, Math.min(100, Number(dataZoom?.start ?? 0)));
    const end = Math.max(start, Math.min(100, Number(dataZoom?.end ?? 100)));
    if (end - start >= 99.5) {
      zoomWindow = null;
      lastDispatchedZoomKey = '';
      if (zoomDispatchTimer) clearTimeout(zoomDispatchTimer);
      zoomDispatchTimer = null;
      return;
    }
    const earliestTimestampMs = renderedTimestamps[0]!;
    const latestTimestampMs = renderedTimestamps.at(-1)!;
    const durationMs = Math.max(0, latestTimestampMs - earliestTimestampMs);
    const fromMs = Math.round(earliestTimestampMs + (start / 100) * durationMs);
    const toMs = Math.round(earliestTimestampMs + (end / 100) * durationMs);
    zoomWindow = { fromMs, toMs };
    if (zoomDispatchTimer) clearTimeout(zoomDispatchTimer);
    zoomDispatchTimer = setTimeout(() => {
      zoomDispatchTimer = null;
      const zoomKey = `${fromMs}:${toMs}`;
      if (busy || zoomKey === lastDispatchedZoomKey) return;
      lastDispatchedZoomKey = zoomKey;
      dispatch('zoomRange', { fromMs, toMs });
    }, 600);
  };

  const resetBounds = () => {
    minimumMode = 'auto';
    maximumMode = 'auto';
    minimumValue = '';
    maximumValue = '';
    renderChart();
  };

  const downloadDataUrl = ({ dataUrl, fileName }: { dataUrl: string; fileName: string }) => {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = fileName;
    link.click();
  };

  const exportPng = () => {
    if (!chart) return;
    downloadDataUrl({
      dataUrl: chart.getDataURL({
        type: 'png',
        pixelRatio: 2,
        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-bg')
      }),
      fileName: `cryptotracker-${title.toLowerCase().replaceAll(/\W+/g, '-')}.png`
    });
  };

  const exportSvg = async () => {
    if (!echartsModule) return;
    const temporary = document.createElement('div');
    temporary.style.cssText = 'position:fixed;left:-10000px;top:0;width:1200px;height:700px';
    document.body.append(temporary);
    const svgChart = echartsModule.init(temporary, undefined, {
      renderer: 'svg',
      width: 1200,
      height: 700
    });
    svgChart.setOption(chart?.getOption() ?? {});
    const dataUrl = svgChart.getDataURL({
      type: 'svg',
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--color-bg')
    });
    downloadDataUrl({
      dataUrl,
      fileName: `cryptotracker-${title.toLowerCase().replaceAll(/\W+/g, '-')}.svg`
    });
    svgChart.dispose();
    temporary.remove();
  };

  const downloadText = ({
    contents,
    contentType,
    fileName
  }: {
    contents: string;
    contentType: string;
    fileName: string;
  }) => {
    const url = URL.createObjectURL(new Blob([contents], { type: contentType }));
    downloadDataUrl({ dataUrl: url, fileName });
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const csvCell = (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    return `"${text.replaceAll('"', '""')}"`;
  };

  const openDataExport = ({ format }: { format: 'csv' | 'json' }) => {
    if (exportQuery) {
      window.location.href = `/api/exports/series.${format}?${exportQuery}`;
      return;
    }
    const metadata = {
      exportedAt: new Date().toISOString(),
      title,
      source,
      currency,
      tooltipUnits: selectedTooltipUnits,
      timezone,
      chartMode,
      resolvedGranularitySeconds: granularity,
      partial,
      stale
    };
    const slug = title.toLowerCase().replaceAll(/\W+/g, '-');
    if (format === 'json') {
      downloadText({
        contents: JSON.stringify({ metadata, series, events }, null, 2),
        contentType: 'application/json;charset=utf-8',
        fileName: `cryptotracker-${slug}.json`
      });
      return;
    }
    const rows = [
      ['timestamp_utc', 'timestamp_display', 'series_id', 'series_label', 'value', 'open', 'high', 'low', 'close', 'volume', 'status', 'providers', 'coverage_percent', 'evidence'],
      ...series.flatMap((item) => item.points.map((point) => [
        new Date(point.timestampMs).toISOString(),
        formatInTimezone({ timestampMs: point.timestampMs, timezone }),
        item.id,
        item.label,
        point.value ?? '',
        point.open ?? '',
        point.high ?? '',
        point.low ?? '',
        point.close ?? '',
        point.volume ?? '',
        point.disputed ? 'disputed' : point.status ?? 'native',
        point.providers ?? [],
        point.coveragePercent ?? '',
        point.provenance ?? point.contributingValues ?? {}
      ]))
    ];
    const metadataRows = Object.entries(metadata).map(([key, value]) => `# ${key}: ${JSON.stringify(value)}`);
    downloadText({
      contents: `${metadataRows.join('\n')}\n${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`,
      contentType: 'text/csv;charset=utf-8',
      fileName: `cryptotracker-${slug}.csv`
    });
  };

  const describeInspectionPoint = () => {
    const inspectionSeries = visibleChartSeries();
    const values = inspectionSeries.map((item) => {
      const point = item.points[inspectionIndex];
      return `${item.label}: ${point ? formatChartValue(plottedPointValue(point)) : 'unavailable'} ${yAxisUnitLabel()}`;
    });
    const timestamp = inspectionSeries[0]?.points[inspectionIndex]?.timestampMs;
    activePointDescription = `${formatInTimezone({ timestampMs: timestamp ?? 0, timezone })}. ${values.join('. ')}`;
  };

  const showInspectionPoint = () => {
    if (busy) return;
    const inspectionSeries = visibleChartSeries()[0];
    const timestampMs = inspectionSeries?.points[inspectionIndex]?.timestampMs;
    const renderedDataIndex = timestampMs === undefined
      ? -1
      : renderedTimestamps.indexOf(timestampMs);
    if (renderedDataIndex < 0) return;
    tooltipPointerPosition = null;
    scheduleChartHighlight(null);
    chart?.dispatchAction({
      type: 'showTip',
      seriesIndex: Math.max(0, series.findIndex((item) => item.id === inspectionSeries?.id)),
      dataIndex: renderedDataIndex
    });
    describeInspectionPoint();
  };

  const clearChartPopups = () => {
    tooltipPinned = false;
    hoveredTooltipTarget = null;
    hoveredTooltipIsEvent = false;
    tooltipPointerPosition = null;
    chartInteractionActive = false;
    inspectorActive = false;
    activePointDescription = '';
    scheduleChartHighlight(null);
    chart?.dispatchAction({ type: 'hideTip' });
  };

  const enableChartInteraction = () => {
    if (busy) return;
    chartInteractionActive = true;
    chart?.setOption({
      dataZoom: [{
        id: 'inside-time-zoom',
        disabled: false,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        moveOnMouseWheel: true
      }]
    });
  };

  const restoreChartInteraction = async () => {
    await tick();
    requestAnimationFrame(() => {
      if (
        destroyed
        || busy
        || !container?.isConnected
        || !restoreInteractionAfterBusy
      ) return;
      const focused = document.activeElement;
      restoreInteractionAfterBusy = false;
      if (focused && focused !== document.body && focused !== container) return;
      container.focus({ preventScroll: true });
      enableChartInteraction();
    });
  };

  const releasePinnedTooltip = () => {
    if (!tooltipPinned) return;
    tooltipPinned = false;
    chart?.setOption({
      tooltip: {
        alwaysShowContent: false,
        triggerOn: 'mousemove|click|mousewheel'
      },
      axisPointer: {
        triggerOn: 'mousemove|click'
      }
    });
    chart?.dispatchAction({ type: 'hideTip' });
    hoveredTooltipTarget = null;
    hoveredTooltipIsEvent = false;
    scheduleChartHighlight(null);
  };

  const freezeHoveredTooltip = () => {
    if (
      !chart
      || busy
      || tooltipPinned
      || (!hoveredTooltipTarget && !hoveredTooltipIsEvent)
    ) return;
    const target = hoveredTooltipTarget;
    tooltipPinned = true;
    chart.setOption({
      tooltip: {
        alwaysShowContent: true,
        triggerOn: 'none'
      },
      axisPointer: {
        triggerOn: 'none'
      }
    });
    if (target) {
      chart.dispatchAction({
        type: 'showTip',
        seriesIndex: target.seriesIndex,
        dataIndex: target.dataIndex
      });
    }
  };

  const trackTooltipPointer = (event: PointerEvent) => {
    if (busy || tooltipPinned || !container) return;
    const bounds = container.getBoundingClientRect();
    tooltipPointerPosition = [
      event.clientX - bounds.left,
      event.clientY - bounds.top
    ];
  };

  const clearTooltipPointer = () => {
    if (tooltipPinned) return;
    tooltipPointerPosition = null;
    scheduleChartHighlight(null);
  };

  const stopKeyboardInspection = () => {
    inspectorActive = false;
    activePointDescription = '';
    chart?.dispatchAction({ type: 'hideTip' });
  };

  const toggleKeyboardInspection = () => {
    if (busy) return;
    if (inspectorActive) {
      stopKeyboardInspection();
      return;
    }
    const pointCount = visibleChartSeries()[0]?.points.length ?? 0;
    inspectorActive = true;
    inspectionIndex = pointCount > 0 ? Math.min(inspectionIndex, pointCount - 1) : 0;
    if (pointCount > 0) showInspectionPoint();
    else activePointDescription = 'There are no chart points available to inspect.';
  };

  const inspectByKeyboard = (event: KeyboardEvent) => {
    if (busy) return;
    if (event.key === 'Escape' && tooltipPinned) {
      event.preventDefault();
      releasePinnedTooltip();
      if (!inspectorActive) return;
    }
    if (!inspectorActive) return;
    const target = event.target;
    if (
      target instanceof HTMLInputElement
      || target instanceof HTMLSelectElement
      || target instanceof HTMLTextAreaElement
    ) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      stopKeyboardInspection();
      return;
    }
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const pointCount = visibleChartSeries()[0]?.points.length ?? 0;
    if (pointCount === 0) {
      activePointDescription = 'There are no chart points available to inspect.';
      return;
    }
    if (event.key === 'ArrowRight') {
      inspectionIndex = Math.min(pointCount - 1, inspectionIndex + 1);
    } else if (event.key === 'ArrowLeft') {
      inspectionIndex = Math.max(0, inspectionIndex - 1);
    } else if (event.key === 'Home') {
      inspectionIndex = 0;
    } else if (event.key === 'End') {
      inspectionIndex = pointCount - 1;
    }
    showInspectionPoint();
  };

  const toggleEventCategory = ({ category }: { category: string }) => {
    if (busy) return;
    const next = new Set(eventCategories);
    if (next.has(category)) next.delete(category);
    else next.add(category);
    eventCategories = next;
    eventPage = 1;
    renderChart();
  };

  const customRangeWindow = () => {
    if (customRangeMode === 'dates') {
      return {
        from: zonedDateTimeInputToUtc({ value: customFrom, timezone }),
        to: zonedDateTimeInputToUtc({ value: customTo, timezone })
      };
    }
    return relativeRangeWindow({
      value: customAgoValue,
      unit: customAgoUnit
    }) ?? { from: null, to: null };
  };

  const stateChanged = () => {
    zoomWindow = null;
    lastDispatchedZoomKey = '';
    if (zoomDispatchTimer) clearTimeout(zoomDispatchTimer);
    zoomDispatchTimer = null;
    const customWindow = range === 'custom' ? customRangeWindow() : { from: null, to: null };
    const customFromMs = customWindow.from;
    const customToMs = customWindow.to;
    if (range === 'custom' && (
      customFromMs === null
      || customToMs === null
      || customFromMs >= customToMs
    )) {
      validationMessage = customRangeMode === 'dates'
        ? 'Custom range must contain valid local times with the start before the end.'
        : 'Time ago must be a whole number greater than zero.';
      return;
    }
    validationMessage = '';
    dispatch('stateChange', {
      range,
      granularity: selectedGranularity,
      chartMode,
      customFromMs,
      customToMs,
      customRangeMode,
      customAgoValue: Math.floor(Number(customAgoValue)),
      customAgoUnit
    });
  };

  const viewChanged = () => {
    if (busy) return;
    renderChart();
    dispatch('viewChange', {
      scale,
      normalized,
      showEvents,
      showVolume,
      yAxisUnit,
      tooltipUnits: selectedTooltipUnits,
      visibleSeriesIds: series.filter((item) => seriesIsVisible(item.id)).map((item) => item.id),
      rightYAxisUnit
    });
  };

  const displayedSeriesChanged = () => {
    useAllSeriesByDefault = false;
    viewChanged();
  };

  const saveGraph = () => {
    if (busy) return;
    const name = saveGraphName.trim();
    if (!name) {
      validationMessage = 'Enter a name before saving this graph.';
      return;
    }
    const customWindow = range === 'custom' ? customRangeWindow() : { from: null, to: null };
    const customFromMs = customWindow.from;
    const customToMs = customWindow.to;
    if (range === 'custom' && (
      customFromMs === null
      || customToMs === null
      || customFromMs >= customToMs
    )) {
      validationMessage = customRangeMode === 'dates'
        ? 'Custom range must contain valid local times with the start before the end.'
        : 'Time ago must be a whole number greater than zero.';
      return;
    }
    dispatch('saveGraph', {
      name,
      range,
      granularity: selectedGranularity,
      chartMode,
      scale,
      normalized,
      showEvents,
      showVolume,
      yAxisUnit,
      tooltipUnits: selectedTooltipUnits,
      visibleSeriesIds: series.filter((item) => seriesIsVisible(item.id)).map((item) => item.id),
      rightYAxisUnit,
      minimumMode,
      maximumMode,
      minimumValue,
      maximumValue,
      showWicks,
      customFromMs,
      customToMs,
      customRangeMode,
      customAgoValue: Math.floor(Number(customAgoValue)),
      customAgoUnit
    });
  };

  onMount(async () => {
    destroyed = false;
    const [loadedEcharts, axisCatalog] = await Promise.all([
      import('echarts'),
      currency.trim() === '%' || minimalChrome
        ? Promise.resolve(null)
        : activeChartAxisCatalog().catch(() => null)
    ]);
    echartsModule = loadedEcharts;
    if (axisCatalog) {
      activeAxisCurrencies = axisCatalog.currencies;
      activeAxisDenominationOptions = axisCatalog.denominationOptions;
    }
    await tick();
    if (destroyed || !container?.isConnected) return;
    chart = echartsModule.init(container, undefined, { renderer: 'canvas' });
    chart.on('click', (parameters) => {
      if (busy) return;
      if (parameters.componentType === 'markPoint') {
        if (tooltipPinned) {
          releasePinnedTooltip();
          return;
        }
        suppressZrClickRelease = true;
        queueMicrotask(() => {
          suppressZrClickRelease = false;
        });
        hoveredTooltipTarget = null;
        hoveredTooltipIsEvent = true;
        scheduleChartHighlight(null);
        freezeHoveredTooltip();
        return;
      }
      releasePinnedTooltip();
    });
    chart.on('legendselectchanged', (parameters) => {
      if (busy) return;
      const legendParameters = parameters as {
        name?: unknown;
        selected?: Record<string, boolean>;
      };
      const name = String(legendParameters.name ?? '');
      if (!name.startsWith(eventLegendPrefix)) {
        const item = series.find((candidate) => candidate.label === name);
        if (!item) return;
        useAllSeriesByDefault = false;
        const selected = legendParameters.selected?.[name] !== false;
        selectedSeriesIds = selected
          ? [...new Set([...selectedSeriesIds, item.id])]
          : selectedSeriesIds.filter((id) => id !== item.id);
        if (!compact) viewChanged();
        return;
      }
      const category = name.slice(eventLegendPrefix.length);
      const selected = legendParameters.selected?.[name] !== false;
      const next = new Set(eventCategories);
      if (selected) next.add(category);
      else next.delete(category);
      eventCategories = next;
      renderChart();
    });
    chart.on('datazoom', scheduleZoomRange);
    chart.getZr().on('click', () => {
      if (busy) return;
      if (suppressZrClickRelease) return;
      releasePinnedTooltip();
    });
    chart.getZr().on('dblclick', (event) => {
      if (busy) return;
      if (!chart?.containPixel(
        { gridIndex: 0 },
        [event.offsetX, event.offsetY]
      )) return;
      freezeHoveredTooltip();
    });
    resizeObserver = new ResizeObserver(() => chart?.resize());
    resizeObserver.observe(container);
    renderChart();
  });

  onDestroy(() => {
    destroyed = true;
    if (zoomDispatchTimer) clearTimeout(zoomDispatchTimer);
    zoomDispatchTimer = null;
    resizeObserver?.disconnect();
    chart?.dispose();
    chart = null;
  });

  $: {
    minimalChrome;
    busy;
    if (busy !== previousBusy) {
      if (busy) {
        restoreInteractionAfterBusy = (
          chartInteractionActive
          || document.activeElement === container
        );
      } else if (restoreInteractionAfterBusy) {
        void restoreChartInteraction();
      }
      previousBusy = busy;
    }
    if (chart && series) {
      if (busy) clearChartPopups();
      renderChart();
    }
  }
  $: chartPoints = series.flatMap((item) => item.points);
  $: visibleSeriesCount = useAllSeriesByDefault
    ? series.length
    : series.filter((item) => selectedSeriesIds.includes(item.id)).length;
  $: if (useAllSeriesByDefault) {
    const allSeriesIds = series.map((item) => item.id);
    if (selectedSeriesIds.join('\u0000') !== allSeriesIds.join('\u0000')) {
      selectedSeriesIds = allSeriesIds;
    }
  }
  $: hasPlottedData = hasMinimumValuedObservations({
    series,
    minimum: minimumValuedObservations
  });
  $: range = initialRange;
  $: if (
    selectedGranularitySetting !== null
    && selectedGranularity !== selectedGranularitySetting
  ) selectedGranularity = selectedGranularitySetting;
  $: if (compact) {
    customRangeMode = initialCustomRangeMode;
    customAgoValue = initialCustomAgoValue;
    customAgoUnit = initialCustomAgoUnit;
    customFrom = formatZonedDateTimeInput({
      timestampMs: initialCustomFromMs ?? Date.now() - 30 * 24 * 60 * 60_000,
      timezone
    });
    customTo = formatZonedDateTimeInput({
      timestampMs: initialCustomToMs ?? Date.now(),
      timezone
    });
  }
  $: if (
    !busy
    &&
    yAxisUnit !== currency
    && !isFiatUnit(yAxisUnit)
    && !effectiveDenominationOptionList.some((option) => option.id === yAxisUnit)
  ) yAxisUnit = currency;
  $: if (
    !busy
    && rightYAxisUnit
    && !isFiatUnit(rightYAxisUnit)
    && !effectiveDenominationOptionList.some((option) => option.id === rightYAxisUnit)
  ) rightYAxisUnit = '';
</script>

<svelte:window on:keydown={inspectByKeyboard} />

<section
  class:minimal-chrome={minimalChrome}
  class="chart-panel"
  aria-label={title}
  data-denomination-option-count={denominationOptions.length}
  data-active-axis-option-count={activeAxisDenominationOptions.length}
  data-effective-axis-option-count={effectiveDenominationOptionList.length}
  data-chart-axis="time"
  data-chart-mode={chartMode}
  data-visible-series-count={visibleSeriesCount}
  data-left-y-axis-unit={yAxisUnit}
  data-right-y-axis-unit={rightYAxisUnit}
  data-rendered-candlestick-series-count={renderedCandlestickSeriesCount}
  data-rendered-range-from-ms={renderedRangeFromMs ?? ''}
  data-rendered-range-to-ms={renderedRangeToMs ?? ''}
>
  {#if !compact}
  <div class="toolbar chart-toolbar">
    <div class="field">
      <label for={controlId('range')}>Range</label>
      <select id={controlId('range')} bind:value={range} on:change={stateChanged}>
        <option value="24h">24 hours</option>
        <option value="7d">7 days</option>
        <option value="30d">30 days</option>
        <option value="90d">90 days</option>
        <option value="1y">1 year</option>
        {#if showFourYearRange}<option value="4y">4 years</option>{/if}
        <option value="all">All available</option>
        <option value="custom">Custom</option>
      </select>
    </div>
    {#if range === 'custom'}
      <div class="field custom-range-mode">
        <span class="field-label">Custom range mode</span>
        <div class="range-mode-toggle" role="group" aria-label="Custom range mode">
          <button
            class="ghost compact"
            type="button"
            aria-pressed={customRangeMode === 'dates'}
            on:click={() => {
              customRangeMode = 'dates';
              stateChanged();
            }}
          >Dates</button>
          <button
            class="ghost compact"
            type="button"
            aria-pressed={customRangeMode === 'ago'}
            on:click={() => {
              customRangeMode = 'ago';
              stateChanged();
            }}
          >Time ago</button>
        </div>
      </div>
      {#if customRangeMode === 'dates'}
        <div class="field">
          <label for={controlId('custom-from')}>Start ({timezone})</label>
          <input id={controlId('custom-from')} type="datetime-local" bind:value={customFrom} on:change={stateChanged} />
        </div>
        <div class="field">
          <label for={controlId('custom-to')}>End ({timezone})</label>
          <input id={controlId('custom-to')} type="datetime-local" bind:value={customTo} on:change={stateChanged} />
        </div>
      {:else}
        <div class="field">
          <label for={controlId('custom-ago-value')}>Look back</label>
          <input
            id={controlId('custom-ago-value')}
            type="number"
            min="1"
            max="10000"
            step="1"
            bind:value={customAgoValue}
            on:change={stateChanged}
          />
        </div>
        <div class="field">
          <label for={controlId('custom-ago-unit')}>Unit</label>
          <select id={controlId('custom-ago-unit')} bind:value={customAgoUnit} on:change={stateChanged}>
            <option value="hours">Hours ago</option>
            <option value="days">Days ago</option>
            <option value="weeks">Weeks ago</option>
            <option value="months">Months ago</option>
            <option value="years">Years ago</option>
          </select>
        </div>
      {/if}
    {/if}
    <div class="field">
      <label for={controlId('granularity')}>Granularity</label>
      <select id={controlId('granularity')} bind:value={selectedGranularity} on:change={stateChanged}>
        <option value="auto">Auto</option>
        <option value="300">5 minutes</option>
        <option value="900">15 minutes</option>
        <option value="1800">30 minutes</option>
        <option value="3600">1 hour</option>
        <option value="14400">4 hours</option>
        <option value="86400">1 day</option>
        <option value="604800">1 week</option>
      </select>
    </div>
    {#if allowCandlesticks}
      <div class="field">
        <label for={controlId('chart-mode')}>Mode</label>
        <select id={controlId('chart-mode')} bind:value={chartMode} on:change={stateChanged}>
          <option value="line">Line</option>
          <option value="candlestick">Candlesticks</option>
        </select>
      </div>
    {/if}
    <div class="field">
      <label for={controlId('scale')}>Y scale</label>
      <select id={controlId('scale')} bind:value={scale} on:change={viewChanged}>
        <option value="linear">Linear</option>
        <option value="log">Logarithmic</option>
      </select>
    </div>
    <button class="ghost" type="button" on:click={resetZoom}>Reset zoom</button>
    <button class="ghost" type="button" on:click={() => (tableVisible = !tableVisible)} aria-pressed={tableVisible}>Table</button>
    {#if (partial || resolutionLimited() || approximateDenomination() || rightYAxisUnit) && !busy}
      <button
        type="button"
        class="partial-data-tip chart-toolbar-warning"
        aria-label="Partial data notice"
        aria-describedby={controlId('partial-data-tooltip')}
      >
        <span class="partial-data-icon" aria-hidden="true">!</span>
        <span
          class="partial-data-popup"
          id={controlId('partial-data-tooltip')}
          role="tooltip"
        >{qualityMessage()}</span>
      </button>
    {/if}
  </div>
  {/if}

  {#if !compact}
  <details
    class="chart-options"
    use:persistAccordionState={{
      key: `${preferenceKey || controlId('chart')}:options`
    }}
  >
    <summary>Scale bounds, display, events, and exports</summary>
    <div class="details-body">
      <div class="toolbar">
        <div class="field grow">
          <label for={controlId('displayed-series')}>Displayed lines</label>
          <SearchableMultiSelect
            id={controlId('displayed-series')}
            bind:value={selectedSeriesIds}
            options={displayedSeriesOptionList}
            label="chart lines"
            maximum={Math.max(displayedSeriesOptionList.length, 1)}
            disabled={displayedSeriesOptionList.length === 0}
            on:change={displayedSeriesChanged}
          />
        </div>
      </div>
      <div class="toolbar axis-unit-controls">
        <div class="field grow">
          <label for={controlId('left-y-axis-unit')}>Left Y-Axis</label>
          <SearchableSelect
            id={controlId('left-y-axis-unit')}
            bind:value={yAxisUnit}
            options={yAxisOptionList}
            label="Left Y-Axis currencies or crypto assets"
            on:change={viewChanged}
          />
        </div>
        <div class="field grow">
          <label for={controlId('right-y-axis-unit')}>Right Y-Axis</label>
          <SearchableSelect
            id={controlId('right-y-axis-unit')}
            bind:value={rightYAxisUnit}
            options={rightYAxisUnitOptionList}
            label="Right Y-Axis currencies or crypto assets"
            on:change={viewChanged}
          />
        </div>
        <div class="field grow">
          <label for={controlId('tooltip-units')}>Popup units</label>
          <SearchableMultiSelect
            id={controlId('tooltip-units')}
            bind:value={selectedTooltipUnits}
            options={tooltipUnitOptionList}
            label="popup currencies or crypto assets"
            maximum={5}
            on:change={viewChanged}
          />
        </div>
      </div>
      <div class="toolbar">
        <div class="field">
          <label for={controlId('minimum-mode')}>Minimum</label>
          <select id={controlId('minimum-mode')} bind:value={minimumMode} on:change={renderChart}>
            <option value="auto">Auto</option>
            <option value="absolute">Absolute</option>
            <option value="relative">Relative %</option>
          </select>
        </div>
        {#if minimumMode !== 'auto'}
          <div class="field">
            <label for={controlId('minimum-value')}>Minimum value</label>
            <input id={controlId('minimum-value')} inputmode="decimal" bind:value={minimumValue} on:input={renderChart} />
          </div>
        {/if}
        <div class="field">
          <label for={controlId('maximum-mode')}>Maximum</label>
          <select id={controlId('maximum-mode')} bind:value={maximumMode} on:change={renderChart}>
            <option value="auto">Auto</option>
            <option value="absolute">Absolute</option>
            <option value="relative">Relative %</option>
          </select>
        </div>
        {#if maximumMode !== 'auto'}
          <div class="field">
            <label for={controlId('maximum-value')}>Maximum value</label>
            <input id={controlId('maximum-value')} inputmode="decimal" bind:value={maximumValue} on:input={renderChart} />
          </div>
        {/if}
        <button class="ghost" type="button" on:click={resetBounds}>Reset bounds</button>
      </div>
      <div class="toolbar option-toggles">
        <label class="check"><input type="checkbox" bind:checked={normalized} disabled={chartMode === 'candlestick'} on:change={viewChanged} /> Normalize to 0%</label>
        <label class="check"><input type="checkbox" bind:checked={showWicks} disabled={chartMode !== 'candlestick'} on:change={renderChart} /> Candlestick wicks</label>
        <label class="check"><input type="checkbox" bind:checked={showVolume} disabled={!meaningfulVolume()} on:change={viewChanged} /> Volume subplot</label>
        <label class="check"><input type="checkbox" bind:checked={showEvents} on:change={viewChanged} /> Event markers</label>
      </div>
      <p class="option-help muted">
        Event markers pin imported activity—trades, purchases, rewards, stakes, transfers, and lifecycle
        changes—to its timestamp on the graph.
      </p>
      {#if scale === 'log' && !logAvailable()}
        <p class="option-help muted">Logarithmic scale can only draw positive plotted values.</p>
      {/if}
      {#if events.length > 0}
        <div class="toolbar event-filters" aria-label="Event marker categories">
          {#each [...new Set(events.map((event) => event.category))] as category}
            <button
              class="ghost compact"
              type="button"
              aria-pressed={eventCategories.has(category)}
              on:click={() => toggleEventCategory({ category })}
            >{category}</button>
          {/each}
        </div>
      {/if}
      <div class="toolbar export-actions">
        <button type="button" on:click={exportPng}>PNG snapshot</button>
        <button type="button" on:click={exportSvg}>SVG snapshot</button>
        <button class="secondary" type="button" disabled={series.length === 0} on:click={() => openDataExport({ format: 'csv' })}>CSV data</button>
        <button class="secondary" type="button" disabled={series.length === 0} on:click={() => openDataExport({ format: 'json' })}>JSON data</button>
      </div>
      {#if saveable}
        <div class="save-graph">
          <div class="field grow">
            <label for={controlId('saved-graph-name')}>Dashboard graph name</label>
            <input id={controlId('saved-graph-name')} maxlength="120" bind:value={saveGraphName} />
          </div>
          <button class="secondary" type="button" on:click={saveGraph}>Save to dashboard</button>
        </div>
      {/if}
    </div>
  </details>
  {/if}

  {#if validationMessage}
    <div class="alert warning" role="status">{validationMessage}</div>
  {/if}
  {#if stale}
    <div class="alert warning" role="status">{strings['cryptotracker-data_stale-label']}</div>
  {/if}
  {#if source === 'combined' && showVolume}
    <div class="alert start" role="status">Combined volume is intentionally unavailable because exchange volumes cannot be summed without duplication.</div>
  {/if}

  {#if partial || resolutionLimited() || approximateDenomination()}
    <span class="sr-only" role="status">{qualityMessage()}</span>
  {/if}
  <div class="chart-frame">
    <!-- Focus activates chart-only navigation without presenting the plotting surface as a button. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class:busy
      class:interaction-active={chartInteractionActive}
      class="chart"
      bind:this={container}
      role="img"
      tabindex={busy ? -1 : 0}
      inert={busy}
      aria-busy={busy}
      aria-label={`${title}. Click or focus to enable horizontal time navigation. Double-click the graph to freeze its details; click again or press Escape to release. Event pins freeze with one click.`}
      on:pointermove|capture={trackTooltipPointer}
      on:pointerleave={clearTooltipPointer}
      on:pointerdown={() => {
        enableChartInteraction();
      }}
      on:focus={() => {
        enableChartInteraction();
      }}
      on:blur={() => {
        chartInteractionActive = false;
        chart?.setOption({
          dataZoom: [{
            id: 'inside-time-zoom',
            disabled: true,
            zoomOnMouseWheel: false,
            moveOnMouseMove: false,
            moveOnMouseWheel: false
          }]
        });
      }}
    ></div>
    {#if !busy && !hasPlottedData}
      <div class="chart-empty">{emptyMessage}</div>
    {/if}
  </div>
  <p class="sr-only" aria-live="polite">{activePointDescription}</p>

  {#if !minimalChrome}
    <div class="chart-meta">
      <span class="badge start">{source}</span>
      <span class="badge mid">{granularity}s resolved</span>
      {#if chartPoints.length > 0}
        <span class="badge">through {formatInTimezone({ timestampMs: Math.max(...chartPoints.map((point) => point.timestampMs)), timezone })}</span>
      {/if}
      {#if chartPoints.some((point) => point.disputed)}
        <span class="badge warning">disputed points</span>
      {/if}
      {#if chartPoints.some((point) => point.status === 'derived')}
        <span class="badge warning">derived data</span>
      {/if}
    </div>
  {/if}

  {#if !compact}
    <div class="chart-inspection-actions">
      <button
        type="button"
        class="btn secondary compact keyboard-inspector-button"
        aria-label={`${title} ${inspectorActive ? 'stop keyboard chart inspector' : 'keyboard chart inspector'}`}
        aria-expanded={inspectorActive}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End Escape"
        on:click={toggleKeyboardInspection}
      >{inspectorActive ? 'Stop keyboard inspection' : 'Inspect chart with keyboard'}</button>
      {#if showAllTooltipAssetsControl}
        <label class="check popup-assets-toggle">
          <input
            type="checkbox"
            bind:checked={showAllTooltipAssets}
            on:change={renderChart}
          />
          Show all, including disabled/inactive, in popup
        </label>
      {/if}
    </div>
    {#if inspectorActive && !busy}
      <div class="inspector-status" role="status">
        <strong>Keyboard inspection active.</strong>
        Use ←/→ to move one point, Home/End to jump, Escape to close, or press the button again.
        <span>{activePointDescription}</span>
      </div>
    {/if}
  {:else if (partial || resolutionLimited() || approximateDenomination()) && !busy}
    <div class="chart-inspection-actions">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <span
        class="partial-data-tip"
        role="group"
        tabindex="0"
        aria-label="Partial data notice"
        aria-describedby={controlId('compact-partial-data-tooltip')}
      >
        <span class="partial-data-icon" aria-hidden="true">!</span>
        <span
          class="partial-data-popup"
          id={controlId('compact-partial-data-tooltip')}
          role="tooltip"
        >{qualityMessage()}</span>
      </span>
    </div>
  {/if}

  {#if tableVisible}
    <div class="table-wrap plotted-table">
      <table>
        <caption>Currently plotted data</caption>
        <thead>
          <tr>
            <th>Timestamp</th>
            <th>Series</th>
            <th>Value</th>
            <th>Status</th>
            <th>Providers</th>
            <th>Coverage</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {#each series as item}
            {#each item.points as point}
              <tr>
                <td>{formatInTimezone({ timestampMs: point.timestampMs, timezone })}</td>
                <td>{item.label}</td>
                <td>{formatChartValue(plottedPointValue(point))} {yAxisUnitLabel()}</td>
                <td>{point.disputed ? 'disputed' : point.status ?? 'native'}</td>
                <td>{point.providers?.join(', ') ?? '—'}</td>
                <td>{point.coveragePercent === null || point.coveragePercent === undefined ? '—' : `${formatPercent(point.coveragePercent)}%`}</td>
                <td><code>{JSON.stringify(point.provenance ?? point.contributingValues ?? {}, null, 2)}</code></td>
              </tr>
            {/each}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if visibleEvents().length > 0}
    <details
      class="event-details"
      use:persistAccordionState={{
        key: `${preferenceKey || controlId('chart')}:events`
      }}
    >
      <summary>Accessible event details ({filteredEvents().length} of {visibleEvents().length})</summary>
      <div class="details-body">
        <div class="event-detail-toolbar">
          <div class="field grow">
            <label for={controlId('event-detail-search')}>Filter events</label>
            <input
              id={controlId('event-detail-search')}
              type="search"
              placeholder="Category, asset, source, quantity, or detail"
              bind:value={eventQuery}
              on:input={() => (eventPage = 1)}
            />
          </div>
          <span class="muted">25 rows per page</span>
        </div>
        <div class="table-wrap event-table">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Category</th>
                <th>Asset</th>
                <th>Quantity</th>
                <th>Source</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {#each pagedEvents() as event (event.id)}
                <tr>
                  <td>{formatInTimezone({ timestampMs: event.timestampMs, timezone })}</td>
                  <td><span class="badge start">{event.category}</span></td>
                  <td>{event.asset ?? 'Unknown'}</td>
                  <td>{formatChartValue(event.quantity)}</td>
                  <td>{event.source ?? 'Unknown'}</td>
                  <td>
                    <details
                      class="event-evidence"
                      use:persistAccordionState={{
                        key: `${preferenceKey || controlId('chart')}:event:${event.id}`
                      }}
                    >
                      <summary>Inspect</summary>
                      <code>{JSON.stringify(event.details ?? {}, null, 2)}</code>
                    </details>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="event-pagination">
          <button class="ghost compact" type="button" disabled={eventPage <= 1} on:click={() => (eventPage -= 1)}>Previous</button>
          <span>Page {Math.min(eventPage, eventPageCount())} of {eventPageCount()}</span>
          <button class="ghost compact" type="button" disabled={eventPage >= eventPageCount()} on:click={() => (eventPage += 1)}>Next</button>
        </div>
      </div>
    </details>
  {/if}
</section>

<style>
  .chart-panel {
    position: relative;
    min-width: 0;
  }

  .chart-toolbar {
    margin-bottom: 0.8rem;
  }

  .range-mode-toggle {
    display: flex;
    gap: 0.35rem;
  }

  .field-label {
    color: var(--color-muted);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .chart-frame {
    position: relative;
    margin-top: 0.8rem;
  }

  .chart-panel.minimal-chrome .chart-frame {
    margin-top: 0;
  }

  .chart {
    width: 100%;
    min-height: 34rem;
    margin-top: 0;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-panel-strong);
  }

  .chart.busy {
    opacity: 0.55;
    pointer-events: none;
    user-select: none;
  }

  .chart:focus-visible {
    outline: 2px solid var(--color-warning);
    outline-offset: 2px;
  }

  .chart-options {
    margin-top: 0.8rem;
  }

  .axis-unit-controls,
  .axis-unit-controls + .toolbar {
    margin-top: 0.7rem;
  }

  .option-toggles {
    margin: 1rem 0;
  }

  .option-help {
    max-width: 58rem;
    margin: -0.4rem 0 0.8rem;
  }

  .check {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 2.4rem;
    padding: 0.4rem 0.65rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    color: var(--color-text);
    font-size: 0.85rem;
    letter-spacing: 0;
    text-transform: none;
  }

  .check input {
    width: 1.15rem;
    min-height: 1.15rem;
    accent-color: var(--color-mid);
  }

  .compact {
    min-height: 2rem;
    padding: 0.3rem 0.55rem;
  }

  .save-graph {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.7rem;
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--color-border);
  }

  .keyboard-inspector-button {
    margin-top: 0;
  }

  .chart-inspection-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .popup-assets-toggle {
    margin-left: auto;
  }

  .partial-data-tip {
    position: relative;
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 1.65rem;
    min-width: 1.65rem;
    height: 1.5rem;
    min-height: 1.5rem;
    margin-left: auto;
    padding: 0;
    outline: none;
    user-select: text;
  }

  button.partial-data-tip {
    overflow: visible;
    border: 0;
    background: transparent;
    box-shadow: none;
  }

  button.partial-data-tip::before,
  button.partial-data-tip::after {
    display: none;
  }

  .chart-toolbar-warning {
    align-self: flex-end;
    margin-left: auto;
  }

  .partial-data-icon {
    display: grid;
    width: 1.65rem;
    height: 1.5rem;
    place-items: center;
    padding-top: 0.32rem;
    background: var(--color-warning);
    clip-path: polygon(50% 0, 100% 100%, 0 100%);
    color: #17120a;
    font-size: 0.72rem;
    font-weight: 800;
    line-height: 1;
    cursor: help;
  }

  .partial-data-tip:hover .partial-data-icon,
  .partial-data-tip:focus-visible .partial-data-icon {
    filter: brightness(1.08) drop-shadow(0 0 0.16rem var(--color-warning-border));
  }

  .partial-data-popup {
    position: absolute;
    z-index: 20;
    right: 0;
    bottom: calc(100% + 0.45rem);
    display: block;
    visibility: hidden;
    width: min(24rem, calc(100vw - 2rem));
    padding: 0.55rem 0.65rem;
    opacity: 0;
    border: 1px solid var(--color-warning-border);
    border-radius: var(--radius-sm);
    background: var(--color-panel-strong);
    color: var(--color-text);
    box-shadow: 0 0.7rem 1.8rem rgba(0, 0, 0, 0.28);
    font-size: 0.76rem;
    font-weight: 400;
    letter-spacing: 0;
    line-height: 1.4;
    text-align: left;
    text-transform: none;
    transition:
      opacity 0.12s ease 0.35s,
      visibility 0s linear 0.47s;
    user-select: text;
    white-space: normal;
    cursor: text;
  }

  .partial-data-popup::after {
    position: absolute;
    top: 100%;
    right: 0;
    width: 2.5rem;
    height: 0.55rem;
    content: '';
  }

  .partial-data-tip:hover .partial-data-popup,
  .partial-data-tip:focus .partial-data-popup,
  .partial-data-tip:focus-within .partial-data-popup {
    visibility: visible;
    opacity: 1;
    transition-delay: 0s;
  }

  .inspector-status {
    display: grid;
    gap: 0.25rem;
    margin-top: 0.7rem;
    padding: 0.7rem;
    border: 1px solid var(--color-mid);
    border-radius: var(--radius-md);
    background: var(--color-mid-fill);
    color: var(--color-text);
    font-size: 0.82rem;
  }

  .inspector-status span {
    color: var(--color-muted);
  }

  button[aria-pressed="true"] {
    border-color: var(--color-mid);
    background: var(--color-mid-fill);
    color: var(--color-mid-ink);
    box-shadow: inset 0 2px rgba(0, 0, 0, 0.24);
  }

  .chart-empty {
    position: absolute;
    top: 50%;
    right: clamp(0.75rem, 5vw, 2rem);
    left: clamp(0.75rem, 5vw, 2rem);
    z-index: 1;
    padding: 1rem;
    transform: translateY(-50%);
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-panel);
    color: var(--color-muted);
    text-align: center;
  }

  .chart-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0.7rem 0;
  }

  .plotted-table {
    max-height: 30rem;
    margin: 1rem 0;
  }

  caption {
    padding: 0.6rem;
    color: var(--color-muted);
    text-align: left;
  }

  .export-actions {
    gap: 0.7rem;
    margin-top: 1rem;
    padding: 0.35rem 0;
  }

  .event-details {
    margin-top: 1rem;
  }

  .event-detail-toolbar,
  .event-pagination {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 0.7rem;
  }

  .event-table {
    max-height: 32rem;
    margin: 0.8rem 0;
  }

  .event-evidence {
    min-width: 7rem;
  }

  .event-evidence code {
    display: block;
    max-width: 32rem;
    max-height: 12rem;
    padding: 0.6rem;
    overflow: auto;
    white-space: pre-wrap;
  }

  .event-pagination {
    justify-content: flex-end;
  }

  @media (max-width: 45rem) {
    .chart {
      min-height: 27rem;
    }
  }
</style>
