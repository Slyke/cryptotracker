import type { ChartSeries } from './components/chart-types';

const numericPointValue = (point: ChartSeries['points'][number]) => {
  const value = point.value ?? point.close;
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

export const hasMinimumValuedObservations = ({
  series,
  minimum
}: {
  series: ChartSeries[];
  minimum: number;
}) => {
  const required = Math.max(1, Math.floor(minimum));
  return series.some((item) => {
    let observations = 0;
    for (const point of item.points) {
      if (numericPointValue(point) === null) continue;
      observations += 1;
      if (observations >= required) return true;
    }
    return false;
  });
};

export const closestCandidateWithinRadius = <
  Candidate extends { distance: number | null }
>({
  candidates,
  radius
}: {
  candidates: Candidate[];
  radius: number;
}) => candidates.reduce<Candidate | null>((closest, candidate) => (
  candidate.distance !== null
  && candidate.distance <= radius
  && (
    closest === null
    || closest.distance === null
    || candidate.distance < closest.distance
  )
    ? candidate
    : closest
), null);
