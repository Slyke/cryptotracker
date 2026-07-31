export type ChartLineType = 'solid' | 'dashed' | 'dotted';

export interface ChartSeriesLineStyle {
  type: ChartLineType;
  color: string;
  width: number;
}

export type ChartSeriesLineStyles = Record<string, ChartSeriesLineStyle>;

export const chartLineColors = [
  '#5070dd',
  '#b6d634',
  '#505372',
  '#ff994d',
  '#0bb4ff',
  '#ffcc00',
  '#ea5f94',
  '#8d48e3',
  '#be04a0'
] as const;

const lineTypes = new Set<ChartLineType>(['solid', 'dashed', 'dotted']);
const validColor = (value: unknown): value is string => (
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
);

export const normalizeChartLineWidth = (value: unknown, fallback = 1.8) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.round(Math.min(8, Math.max(1, numeric)) * 10) / 10;
};

export const defaultChartSeriesLineStyle = (index: number): ChartSeriesLineStyle => ({
  type: index % 3 === 1 ? 'dashed' : index % 3 === 2 ? 'dotted' : 'solid',
  color: chartLineColors[index % chartLineColors.length]!,
  width: index === 0 ? 2.5 : 1.8
});

export const normalizeChartSeriesLineStyles = (
  value: unknown,
  fallback: ChartSeriesLineStyles = {}
): ChartSeriesLineStyles => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...fallback };
  const normalized: ChartSeriesLineStyles = {};
  for (const [rawId, rawStyle] of Object.entries(value)) {
    const id = rawId.trim();
    if (
      !id
      || !rawStyle
      || typeof rawStyle !== 'object'
      || Array.isArray(rawStyle)
    ) continue;
    const candidate = rawStyle as Record<string, unknown>;
    if (!lineTypes.has(candidate.type as ChartLineType) || !validColor(candidate.color)) continue;
    normalized[id] = {
      type: candidate.type as ChartLineType,
      color: candidate.color.toLowerCase(),
      width: normalizeChartLineWidth(candidate.width)
    };
  }
  return normalized;
};

export const resolvedChartSeriesLineStyle = ({
  styles,
  seriesId,
  index
}: {
  styles: ChartSeriesLineStyles;
  seriesId: string;
  index: number;
}): ChartSeriesLineStyle => (
  styles[seriesId] ?? defaultChartSeriesLineStyle(index)
);

export const resolvedChartSeriesLineStyles = ({
  styles,
  series
}: {
  styles: ChartSeriesLineStyles;
  series: Array<{ id: string }>;
}): ChartSeriesLineStyles => Object.fromEntries(series.map((item, index) => [
  item.id,
  resolvedChartSeriesLineStyle({
    styles,
    seriesId: item.id,
    index
  })
]));
