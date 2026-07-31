import type { ChartSeries } from '$lib/components/chart-types';

export type PerformanceMode = 'return' | 'drawdown';

export const numericPerformancePoints = (item: ChartSeries) => item.points
  .flatMap((point) => {
    const rawValue = point.value ?? point.close;
    if (rawValue === null || rawValue === undefined) return [];
    const numericValue = Number(rawValue);
    return Number.isFinite(numericValue)
      ? [{ ...point, numericValue }]
      : [];
  })
  .sort((left, right) => left.timestampMs - right.timestampMs);

export const transformPerformanceSeries = ({
  series,
  mode
}: {
  series: ChartSeries[];
  mode: PerformanceMode;
}): ChartSeries[] => series.map((item) => {
  const points = numericPerformancePoints(item);
  const first = points.find((point) => point.numericValue !== 0);
  let peak: number | null = null;
  return {
    // Keep the source ID stable so saved visibility, axis, and line-style
    // preferences still address the transformed performance line.
    id: item.id,
    label: `${item.label} · ${mode === 'return' ? 'return' : 'drawdown'}`,
    points: points.map((point) => {
      peak = peak === null ? point.numericValue : Math.max(peak, point.numericValue);
      const value = mode === 'return'
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
          calculation: mode === 'return'
            ? 'cumulative change from first non-zero observation'
            : 'change from preceding peak'
        }
      };
    })
  };
});
