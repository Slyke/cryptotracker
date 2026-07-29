<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import type { ECharts, EChartsOption } from 'echarts';
  import strings from '$lib/i18n/en-CA.json';
  import {
    formatDisplayNumber,
    formatPercent,
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
    contributingValues?: Record<string, string>;
    [key: string]: unknown;
  }

  interface ChartSeries {
    id: string;
    label: string;
    points: ChartPoint[];
  }

  interface ChartDenominationOption {
    id: string;
    symbol: string;
    label: string;
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
  export let initialRange = '30d';
  export let initialScale: 'linear' | 'log' = 'linear';
  export let initialYAxisUnit = currency;
  export let initialNormalized = false;
  export let initialShowEvents = true;
  export let initialShowVolume = false;

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
    timestampMs: Date.now() - 30 * 24 * 60 * 60_000,
    timezone
  });
  let customTo = formatZonedDateTimeInput({ timestampMs: Date.now(), timezone });
  let customRangeMode: 'dates' | 'ago' = 'dates';
  let customAgoValue = 30;
  let customAgoUnit: RelativeRangeUnit = 'days';
  let selectedGranularity = String(granularity);
  let scale: 'linear' | 'log' = initialScale;
  let yAxisUnit = initialYAxisUnit;
  let minimumMode: 'auto' | 'absolute' | 'relative' = 'auto';
  let maximumMode: 'auto' | 'absolute' | 'relative' = 'auto';
  let minimumValue = '';
  let maximumValue = '';
  let normalized = initialNormalized;
  let showWicks = true;
  let showVolume = initialShowVolume;
  let showEvents = initialShowEvents;
  let eventCategories = new Set([
    'trade',
    'purchase',
    'sale',
    'stake',
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
  let tooltipPinned = false;
  let tooltipSide: 'left' | 'right' = 'right';
  let showAllTooltipAssets = false;
  let saveGraphName = title;
  let validationMessage = '';
  let eventQuery = '';
  let eventPage = 1;
  const eventPageSize = 25;
  const controlId = (suffix: string) => (
    `${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-|-$/g, '')}-${suffix}`
  );

  const allPoints = () => series.flatMap((item) => item.points);
  const rawPointValue = (point: ChartPoint) => point.value ?? point.close ?? null;
  const plottedPointValue = (point: ChartPoint) => (
    chartMode === 'line' && yAxisUnit !== currency
      ? point.denominations?.[yAxisUnit] ?? null
      : rawPointValue(point)
  );
  const yAxisUnitLabel = () => yAxisUnit === currency
    ? currency
    : denominationOptions.find((option) => option.id === yAxisUnit)?.symbol ?? yAxisUnit;
  const assetQuantityLabel = (assetId: string) => (
    denominationOptions.find((option) => option.id === assetId)?.symbol
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
    : formatDisplayNumber({ value });
  const validNumericValues = () => allPoints()
    .map(plottedPointValue)
    .filter((value): value is string => value !== null && value !== undefined)
    .map(Number)
    .filter(Number.isFinite);
  const displayedNumericValues = () => normalized && chartMode === 'line'
    ? series.flatMap((item) => normalizedSeries(item))
      .map((point) => point.normalizedPercent)
      .filter((value): value is string => value !== null)
      .map(Number)
      .filter(Number.isFinite)
    : validNumericValues();
  const logAvailable = () => displayedNumericValues().some((value) => value > 0);
  const scaledValue = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return scale === 'log' && numeric <= 0 ? null : numeric;
  };
  const meaningfulVolume = () => source !== 'combined' && allPoints().some((point) => point.volume !== null && point.volume !== undefined);
  const rangeDurationsMs: Record<string, number | null> = {
    '24h': 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
    '30d': 30 * 24 * 60 * 60_000,
    '90d': 90 * 24 * 60 * 60_000,
    '1y': 365 * 24 * 60 * 60_000,
    '4y': 4 * 365 * 24 * 60 * 60_000,
    all: null
  };
  const selectedRangeDurationMs = () => {
    if (range === 'custom') {
      const customWindow = customRangeWindow();
      return customWindow.from === null || customWindow.to === null
        ? null
        : Math.max(0, customWindow.to - customWindow.from);
    }
    if (range === 'all') {
      const timestamps = allPoints().map((point) => point.timestampMs);
      return timestamps.length < 2 ? null : Math.max(...timestamps) - Math.min(...timestamps);
    }
    return rangeDurationsMs[range] ?? null;
  };
  const granularityAvailable = (seconds: number) => {
    const durationMs = selectedRangeDurationMs();
    return durationMs === null || durationMs / (seconds * 1_000) <= 5_000;
  };

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

  const markerValue = ({ timestampMs, points }: { timestampMs: number; points: ChartPoint[] }) => {
    const nearest = points.reduce<ChartPoint | null>((current, point) => (
      current === null
        || Math.abs(point.timestampMs - timestampMs) < Math.abs(current.timestampMs - timestampMs)
        ? point
        : current
    ), null);
    const value = nearest ? plottedPointValue(nearest) : null;
    return value === null || !Number.isFinite(Number(value)) ? 0 : Number(value);
  };

  const renderChart = () => {
    if (!chart) return;
    const axisBounds = resolveAxisBounds();
    if (scale === 'log' && !logAvailable()) {
      validationMessage = 'Logarithmic mode is selected, but the plotted data has no positive values yet.';
    }
    const chartSeries: NonNullable<EChartsOption['series']> = [];
    const sourceSeries = normalized && chartMode === 'line'
      ? series.map((item) => ({ ...item, points: normalizedSeries(item) }))
      : series;
    const timestamps = [...new Set(sourceSeries.flatMap((item) => (
      item.points.map((point) => point.timestampMs)
    )))].sort((left, right) => left - right);
    for (const [index, item] of sourceSeries.entries()) {
      if (chartMode === 'candlestick' && index === 0) {
        const pointsByTimestamp = new Map(item.points.map((point) => [point.timestampMs, point]));
        chartSeries.push({
          id: item.id,
          name: item.label,
          type: 'candlestick',
          data: timestamps.map((timestampMs) => {
            const point = pointsByTimestamp.get(timestampMs);
            if (!point) {
              return {
                value: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
                meta: null
              };
            }
            const open = Number(point.open ?? point.close ?? 0);
            const close = Number(point.close ?? point.open ?? 0);
            const low = showWicks ? Number(point.low ?? Math.min(open, close)) : Math.min(open, close);
            const high = showWicks ? Number(point.high ?? Math.max(open, close)) : Math.max(open, close);
            return {
              value: [open, close, low, high],
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
          showSymbol: false,
          connectNulls: false,
          sampling: 'lttb',
          lineStyle: {
            type: index % 3 === 1 ? 'dashed' : index % 3 === 2 ? 'dotted' : 'solid',
            width: index === 0 ? 2.5 : 1.8
          },
          data: timestamps.map((timestampMs) => {
            const point = pointsByTimestamp.get(timestampMs);
            return {
              value: point
                ? normalized && chartMode === 'line'
                  ? scaledValue(point.normalizedPercent)
                  : scaledValue(plottedPointValue(point))
                : null,
              meta: point ?? null
            };
          })
        });
      }
    }
    const primaryPoints = sourceSeries[0]?.points ?? [];
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
        yAxisIndex: 1,
        data: timestamps.map((timestampMs) => {
          const point = primaryPointsByTimestamp.get(timestampMs);
          return point?.volume === null || point?.volume === undefined
            ? null
            : Number(point.volume);
        }),
        itemStyle: {
          color: 'rgba(0, 182, 255, 0.45)'
        }
      });
    }
    const markerData = visibleEvents().map((event) => ({
      name: event.category,
      coord: [event.timestampMs, markerValue({ timestampMs: event.timestampMs, points: primaryPoints })],
      value: event.category,
      itemStyle: {
        color: event.reconciliationState === 'likely' ? '#ffbc3a' : '#b86cff'
      }
    }));
    if (markerData.length > 0 && chartSeries.length > 0) {
      (chartSeries[0] as { markPoint?: unknown }).markPoint = {
        symbol: 'pin',
        symbolSize: 34,
        data: markerData
      };
    }
    const option: EChartsOption = {
      animation: false,
      backgroundColor: 'transparent',
      title: {
        text: title,
        subtext: minimalChrome ? undefined : `${source} · ${granularity}s resolved`,
        top: 14,
        left: 18,
        textStyle: {
          color: getComputedStyle(document.documentElement).getPropertyValue('--color-text'),
          fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono'),
          fontSize: 18
        },
        subtextStyle: {
          color: getComputedStyle(document.documentElement).getPropertyValue('--color-muted'),
          fontSize: 12
        }
      },
      legend: {
        top: 72,
        left: 18,
        textStyle: {
          color: getComputedStyle(document.documentElement).getPropertyValue('--color-text')
        }
      },
      grid: showVolume && meaningfulVolume()
        ? [
            { left: 70, right: 28, top: 118, height: '50%' },
            { left: 70, right: 28, top: '74%', height: '15%' }
          ]
        : { left: 70, right: 28, top: 118, bottom: minimalChrome ? 42 : 78 },
      xAxis: showVolume && meaningfulVolume()
        ? [
            {
              type: 'category',
              data: timestamps,
              axisLabel: { formatter: (value: string) => formatInTimezone({ timestampMs: Number(value), timezone }) },
              axisPointer: { show: true },
              boundaryGap: chartMode === 'candlestick',
              gridIndex: 0
            },
            {
              type: 'category',
              data: timestamps,
              axisLabel: { show: false },
              gridIndex: 1
            }
          ]
        : {
            type: 'category',
            data: timestamps,
            boundaryGap: chartMode === 'candlestick',
            axisLabel: {
              color: getComputedStyle(document.documentElement).getPropertyValue('--color-muted'),
              formatter: (value: string) => formatInTimezone({ timestampMs: Number(value), timezone })
            },
            axisPointer: { show: true }
          },
      yAxis: showVolume && meaningfulVolume()
        ? [
            {
              type: scale === 'log' ? 'log' : 'value',
              name: normalized ? '% change' : yAxisUnitLabel(),
              min: axisBounds.min,
              max: axisBounds.max,
              scale: true,
              gridIndex: 0
            },
            {
              type: 'value',
              name: 'Volume',
              scale: true,
              gridIndex: 1
            }
          ]
        : {
            type: scale === 'log' ? 'log' : 'value',
            name: normalized ? '% change' : yAxisUnitLabel(),
            min: axisBounds.min,
            max: axisBounds.max,
            scale: true,
            axisLabel: {
              color: getComputedStyle(document.documentElement).getPropertyValue('--color-muted'),
              formatter: (value: number) => formatChartValue(value)
            }
          },
      axisPointer: {
        link: [{ xAxisIndex: 'all' }],
        lineStyle: {
          color: '#ffbc3a',
          width: 2
        }
      },
      tooltip: {
        trigger: 'axis',
        enterable: true,
        alwaysShowContent: tooltipPinned,
        hideDelay: 300,
        extraCssText: 'user-select:text;pointer-events:auto;',
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
          const timestamp = (
            parameters.find((parameter) => (
              (parameter.data as { meta?: ChartPoint | null } | undefined)?.meta
            ))?.data as { meta?: ChartPoint | null } | undefined
          )?.meta?.timestampMs
            ?? timestamps[Number(parameters[0]?.dataIndex ?? 0)];
          const tooltipPoints = sourceSeries.map((item) => {
            const parameter = parameters.find((candidate) => String(candidate.seriesId) === item.id);
            const parameterPoint = (
              parameter?.data as { meta?: ChartPoint | null } | undefined
            )?.meta;
            const point = parameterPoint
              ?? item.points.find((candidate) => candidate.timestampMs === timestamp);
            return { item, point };
          }).filter((entry): entry is { item: ChartSeries; point: ChartPoint } => Boolean(entry.point));
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
            .map(({ item, point }) => {
              if (quantitiesBelongInline(item.id)) return '';
              const quantities = visibleTooltipQuantities(point.quantities);
              if (quantities.length === 0) return '';
              const quantityRows = quantities.map(([assetId, quantity]) => (
                `<span>${escapeHtml(assetQuantityLabel(assetId))}</span> <strong>${escapeHtml(formatChartValue(quantity))}</strong>`
              )).join('<br />');
              return `<div style="margin-top:.35rem"><strong>${escapeHtml(item.label)}</strong><br />${quantityRows}</div>`;
            })
            .filter(Boolean)
            .join('');
          const exactAmountsSection = exactAmounts
            ? `<div style="margin-top:.55rem;padding-bottom:.55rem;border-bottom:1px solid rgba(127,127,127,.35)"><strong>Exact asset amounts</strong>${exactAmounts}</div>`
            : '';
          const configuredTooltipCurrencies = [...new Set([
            currency.toUpperCase(),
            ...tooltipCurrencies
              .map((quote) => quote.toUpperCase())
              .filter((quote) => /^[A-Z]{3}$/.test(quote))
          ])];
          const rows = [
            ...combinedTooltipPoints,
            ...individualTooltipPoints
          ].map(({ item, point }) => {
            const orderedTooltipCurrencies = configuredTooltipCurrencies;
            const combinedQuantityRows = quantitiesBelongInline(item.id)
              ? visibleTooltipQuantities(point.quantities)
                .map(([assetId, quantity]) => (
                  `<span>${escapeHtml(assetQuantityLabel(assetId))}</span> <strong>${escapeHtml(formatChartValue(quantity))}</strong>`
                )).join('<br />')
              : '';
            const quoteRows = orderedTooltipCurrencies.map((quote) => {
              const value = point.quotes?.[quote] ?? (quote === currency ? rawPointValue(point) : null);
              return `<span>${escapeHtml(quote)}</span> <strong>${escapeHtml(formatChartValue(value))}</strong>`;
            }).join('<br />');
            const denominationRow = yAxisUnit === currency
              ? ''
              : `<br /><span>${escapeHtml(yAxisUnitLabel())} value</span> <strong>${escapeHtml(formatChartValue(point.denominations?.[yAxisUnit] ?? null))}</strong>`;
            const status = point.disputed ? 'disputed' : point.status;
            const statusRow = status && !['native', 'fallback'].includes(status)
              ? `<span>${escapeHtml(status)}</span><br />`
              : '';
            const quantityRows = combinedQuantityRows
              ? `${combinedQuantityRows}<br />`
              : '';
            return `<div style="margin-top:.55rem"><strong>${escapeHtml(item.label)}</strong><br />${quantityRows}${statusRow}${quoteRows}${denominationRow}</div>`;
          }).join('');
          return `<div><strong>${formatInTimezone({ timestampMs: timestamp ?? 0, timezone })}</strong>${exactAmountsSection}${rows}</div>`;
        }
      },
      dataZoom: [
        {
          id: 'inside-time-zoom',
          type: 'inside',
          xAxisIndex: showVolume && meaningfulVolume() ? [0, 1] : [0],
          disabled: !chartInteractionActive,
          zoomOnMouseWheel: chartInteractionActive,
          moveOnMouseMove: chartInteractionActive,
          moveOnMouseWheel: chartInteractionActive
        },
        ...minimalChrome ? [] : [{
          id: 'horizontal-time-selector',
          type: 'slider',
          xAxisIndex: showVolume && meaningfulVolume() ? [0, 1] : [0],
          bottom: 18,
          borderColor: '#202835',
          fillerColor: 'rgba(0, 182, 255, 0.18)'
        }]
      ],
      series: chartSeries
    };
    chart.setOption(option, true);
  };

  const resetZoom = () => {
    chart?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
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
      tooltipCurrencies,
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
    const values = series.map((item) => {
      const point = item.points[inspectionIndex];
      return `${item.label}: ${point ? formatChartValue(plottedPointValue(point)) : 'unavailable'} ${yAxisUnitLabel()}`;
    });
    const timestamp = series[0]?.points[inspectionIndex]?.timestampMs;
    activePointDescription = `${formatInTimezone({ timestampMs: timestamp ?? 0, timezone })}. ${values.join('. ')}`;
  };

  const showInspectionPoint = () => {
    chart?.dispatchAction({
      type: 'showTip',
      seriesIndex: 0,
      dataIndex: inspectionIndex
    });
    describeInspectionPoint();
  };

  const stopKeyboardInspection = () => {
    inspectorActive = false;
    activePointDescription = '';
    chart?.dispatchAction({ type: 'hideTip' });
  };

  const toggleKeyboardInspection = () => {
    if (inspectorActive) {
      stopKeyboardInspection();
      return;
    }
    const pointCount = series[0]?.points.length ?? 0;
    inspectorActive = true;
    inspectionIndex = pointCount > 0 ? Math.min(inspectionIndex, pointCount - 1) : 0;
    if (pointCount > 0) showInspectionPoint();
    else activePointDescription = 'There are no chart points available to inspect.';
  };

  const inspectByKeyboard = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && tooltipPinned) {
      event.preventDefault();
      tooltipPinned = false;
      chart?.setOption({ tooltip: { alwaysShowContent: false } });
      chart?.dispatchAction({ type: 'hideTip' });
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
    const pointCount = series[0]?.points.length ?? 0;
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
    if (
      selectedGranularity !== 'auto'
      && !granularityAvailable(Number(selectedGranularity))
    ) {
      selectedGranularity = 'auto';
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
    renderChart();
    dispatch('viewChange', {
      scale,
      normalized,
      showEvents,
      showVolume,
      yAxisUnit
    });
  };

  const saveGraph = () => {
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
      customFromMs,
      customToMs,
      customRangeMode,
      customAgoValue: Math.floor(Number(customAgoValue)),
      customAgoUnit
    });
  };

  onMount(async () => {
    destroyed = false;
    echartsModule = await import('echarts');
    await tick();
    if (destroyed || !container?.isConnected) return;
    chart = echartsModule.init(container, undefined, { renderer: 'canvas' });
    chart.on('click', (parameters) => {
      const dataIndex = typeof parameters.dataIndex === 'number'
        ? parameters.dataIndex
        : null;
      if (dataIndex === null) return;
      tooltipPinned = true;
      chart?.setOption({ tooltip: { alwaysShowContent: true } });
      chart?.dispatchAction({
        type: 'showTip',
        seriesIndex: typeof parameters.seriesIndex === 'number' ? parameters.seriesIndex : 0,
        dataIndex
      });
    });
    chart.getZr().on('click', (event) => {
      if (event.target) return;
      tooltipPinned = false;
      chart?.setOption({ tooltip: { alwaysShowContent: false } });
      chart?.dispatchAction({ type: 'hideTip' });
    });
    resizeObserver = new ResizeObserver(() => chart?.resize());
    resizeObserver.observe(container);
    renderChart();
  });

  onDestroy(() => {
    destroyed = true;
    resizeObserver?.disconnect();
    chart?.dispose();
  });

  $: if (chart && series) renderChart();
  $: range = initialRange;
  $: selectedGranularity = selectedGranularitySetting ?? String(granularity);
  $: if (
    denominationOptions.length > 0
    &&
    yAxisUnit !== currency
    && !denominationOptions.some((option) => option.id === yAxisUnit)
  ) yAxisUnit = currency;
</script>

<svelte:window on:keydown={inspectByKeyboard} />

<section class="chart-panel" aria-label={title}>
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
        <option value="300" disabled={!granularityAvailable(300)}>5 minutes</option>
        <option value="900" disabled={!granularityAvailable(900)}>15 minutes</option>
        <option value="1800" disabled={!granularityAvailable(1800)}>30 minutes</option>
        <option value="3600" disabled={!granularityAvailable(3600)}>1 hour</option>
        <option value="14400" disabled={!granularityAvailable(14400)}>4 hours</option>
        <option value="86400" disabled={!granularityAvailable(86400)}>1 day</option>
        <option value="604800" disabled={!granularityAvailable(604800)}>1 week</option>
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
  </div>
  {/if}

  {#if !compact}
  <details class="chart-options">
    <summary>Scale bounds, display, events, and exports</summary>
    <div class="details-body">
      <div class="toolbar">
        <div class="field">
          <label for={controlId('y-axis-unit')}>Y-axis unit</label>
          <select
            id={controlId('y-axis-unit')}
            bind:value={yAxisUnit}
            disabled={chartMode === 'candlestick'}
            on:change={viewChanged}
          >
            <option value={currency}>{currency} · Primary currency</option>
            {#each denominationOptions as option (option.id)}
              <option value={option.id}>{option.label}</option>
            {/each}
          </select>
        </div>
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
  {#if partial}
    <div class="alert warning" role="status">{partialMessage}</div>
  {/if}
  {#if stale}
    <div class="alert warning" role="status">{strings['cryptotracker-data_stale-label']}</div>
  {/if}
  {#if source === 'combined' && showVolume}
    <div class="alert start" role="status">Combined volume is intentionally unavailable because exchange volumes cannot be summed without duplication.</div>
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
    {#if inspectorActive}
      <div class="inspector-status" role="status">
        <strong>Keyboard inspection active.</strong>
        Use ←/→ to move one point, Home/End to jump, Escape to close, or press the button again.
        <span>{activePointDescription}</span>
      </div>
    {/if}
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
      tabindex="0"
      aria-label={`${title}. Click or focus to enable horizontal time navigation. Click a plotted point to pin its details.`}
      on:pointerdown={() => {
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
      }}
      on:focus={() => {
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
    {#if !busy && allPoints().length === 0}
      <div class="chart-empty">{emptyMessage}</div>
    {/if}
  </div>
  <p class="sr-only" aria-live="polite">{activePointDescription}</p>

  <div class="chart-meta">
    {#if !minimalChrome}
      <span class="badge start">{source}</span>
      <span class="badge mid">{granularity}s resolved</span>
    {/if}
    {#if allPoints().length > 0}
      <span class="badge">through {formatInTimezone({ timestampMs: Math.max(...allPoints().map((point) => point.timestampMs)), timezone })}</span>
    {/if}
    {#if allPoints().some((point) => point.disputed)}
      <span class="badge warning">disputed points</span>
    {/if}
    {#if allPoints().some((point) => point.status === 'derived')}
      <span class="badge warning">derived data</span>
    {/if}
  </div>

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
    <details class="event-details">
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
                    <details class="event-evidence">
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
  }

  .chart:focus-visible {
    outline: 2px solid var(--color-warning);
    outline-offset: 2px;
  }

  .chart-options {
    margin-top: 0.8rem;
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
