import { describe, expect, it } from 'vitest';
import {
  formatZonedDateTimeInput,
  zonedDateTimeInputToUtc
} from '../src/lib/timezone.js';

describe('timezone range controls', () => {
  it('round-trips Vancouver wall time across standard and daylight time', () => {
    for (const timestampMs of [
      Date.parse('2026-01-15T20:30:00.000Z'),
      Date.parse('2026-07-15T19:30:00.000Z')
    ]) {
      const input = formatZonedDateTimeInput({
        timestampMs,
        timezone: 'America/Vancouver'
      });
      expect(zonedDateTimeInputToUtc({
        value: input,
        timezone: 'America/Vancouver'
      })).toBe(timestampMs);
    }
  });

  it('rejects a wall time skipped by the daylight-saving transition', () => {
    expect(zonedDateTimeInputToUtc({
      value: '2026-03-08T02:30',
      timezone: 'America/Vancouver'
    })).toBeNull();
  });
});
