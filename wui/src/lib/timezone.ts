const partsInTimezone = ({
  timestampMs,
  timezone
}: {
  timestampMs: number;
  timezone: string;
}) => Object.fromEntries(
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestampMs))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value])
);

export const formatInTimezone = ({
  timestampMs,
  timezone,
  locale = 'en-CA'
}: {
  timestampMs: number;
  timezone: string;
  locale?: string;
}) => {
  void locale;
  const parts = partsInTimezone({ timestampMs, timezone });
  return `${parts.year}-${parts.month}-${parts.day}, ${parts.hour}:${parts.minute}`;
};

export const formatZonedDateTimeInput = ({
  timestampMs,
  timezone
}: {
  timestampMs: number;
  timezone: string;
}) => {
  const parts = partsInTimezone({ timestampMs, timezone });
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

export const zonedDateTimeInputToUtc = ({
  value,
  timezone
}: {
  value: string;
  timezone: string;
}) => {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})$/.exec(value);
  if (!match?.groups) return null;
  const desired = {
    year: Number(match.groups.year),
    month: Number(match.groups.month),
    day: Number(match.groups.day),
    hour: Number(match.groups.hour),
    minute: Number(match.groups.minute)
  };
  if (
    desired.month < 1 || desired.month > 12
    || desired.day < 1 || desired.day > 31
    || desired.hour > 23 || desired.minute > 59
  ) {
    return null;
  }
  const nominal = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute
  );
  let candidate = nominal;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const actual = partsInTimezone({ timestampMs: candidate, timezone });
    const represented = Date.UTC(
      Number(actual.year),
      Number(actual.month) - 1,
      Number(actual.day),
      Number(actual.hour),
      Number(actual.minute)
    );
    candidate += nominal - represented;
  }
  const confirmed = partsInTimezone({ timestampMs: candidate, timezone });
  return (
    Number(confirmed.year) === desired.year
    && Number(confirmed.month) === desired.month
    && Number(confirmed.day) === desired.day
    && Number(confirmed.hour) === desired.hour
    && Number(confirmed.minute) === desired.minute
  ) ? candidate : null;
};
