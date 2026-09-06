import { describe, expect, it } from 'vitest';
import { computeBusySpan, dayKey, dayKeysBetween } from './busy-span.js';

const UTC = { timeZone: 'UTC' };
const BA = { timeZone: 'Europe/Bratislava' };
const H = 3_600_000;

const iv = (start: string, end: string) => ({ start, end });

describe('computeBusySpan', () => {
  it('reports nothing rather than zero when there is no data', () => {
    // concurrency/dutyCycle are null, not 0: "nothing ran" and "we have no idea" must not
    // render as the same number on a KPI tile.
    const r = computeBusySpan([], UTC);
    expect(r).toMatchObject({
      busyMs: 0,
      agentMs: 0,
      islands: 0,
      concurrency: null,
      dutyCycle: null,
    });
    expect(r.buckets).toEqual([]);
  });

  it('counts overlap once for the span and every time for agent-hours', () => {
    // The whole point of the module: three agents running the same hour is one hour of
    // busy span and three agent-hours.
    const r = computeBusySpan(
      [
        iv('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        iv('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        iv('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
      ],
      UTC,
    );
    expect(r.busyMs).toBe(H);
    expect(r.agentMs).toBe(3 * H);
    expect(r.islands).toBe(1);
    expect(r.concurrency).toBe(3);
  });

  it('merges partially overlapping and exactly touching intervals into one island', () => {
    // Touching intervals: the union of [10,11] and [11,12] IS [10,12]. Reporting two islands
    // would overstate how fragmented the work was.
    const r = computeBusySpan(
      [
        iv('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        iv('2026-09-01T10:30:00Z', '2026-09-01T11:30:00Z'),
        iv('2026-09-01T11:30:00Z', '2026-09-01T12:00:00Z'),
      ],
      UTC,
    );
    expect(r.islands).toBe(1);
    expect(r.busyMs).toBe(2 * H);
  });

  it('keeps a gap as a separate island and counts it in the calendar span', () => {
    const r = computeBusySpan(
      [
        iv('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        iv('2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z'),
      ],
      UTC,
    );
    expect(r.islands).toBe(2);
    expect(r.busyMs).toBe(2 * H);
    expect(r.calendarMs).toBe(5 * H);
    expect(r.dutyCycle).toBeCloseTo(2 / 5, 10);
  });

  it('does not depend on input order', () => {
    const forward = computeBusySpan(
      [
        iv('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        iv('2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z'),
      ],
      UTC,
    );
    const reversed = computeBusySpan(
      [
        iv('2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z'),
        iv('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
      ],
      UTC,
    );
    expect(reversed).toEqual(forward);
  });

  it('drops an unusable interval instead of clamping it', () => {
    // A row whose clocks disagree cannot be placed in time. Clamping it to zero length would
    // still add an island and overstate fragmentation.
    const r = computeBusySpan(
      [
        iv('2026-09-01T11:00:00Z', '2026-09-01T10:00:00Z'), // inverted
        iv('2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z'), // zero length
        { start: null, end: '2026-09-01T13:00:00Z' },
        { start: '2026-09-01T13:00:00Z', end: null },
        { start: 'not a date', end: '2026-09-01T14:00:00Z' },
        iv('2026-09-01T15:00:00Z', '2026-09-01T16:00:00Z'), // the only usable one
      ],
      UTC,
    );
    expect(r.islands).toBe(1);
    expect(r.busyMs).toBe(H);
    expect(r.agentMs).toBe(H);
  });

  it('accepts Date objects and epoch ms as well as ISO strings', () => {
    // Drizzle hands the api Date objects; web JSON hands it strings. Same latitude as
    // TaskTimingStep, for the same reason.
    const start = new Date('2026-09-01T10:00:00Z');
    const end = new Date('2026-09-01T11:00:00Z');
    expect(computeBusySpan([{ start, end }], UTC).busyMs).toBe(H);
    expect(computeBusySpan([{ start: start.getTime(), end: end.getTime() }], UTC).busyMs).toBe(H);
  });

  it('splits an interval that crosses local midnight across two buckets', () => {
    const r = computeBusySpan([iv('2026-09-01T23:00:00Z', '2026-09-02T01:00:00Z')], UTC);
    expect(r.busyMs).toBe(2 * H);
    expect(r.islands).toBe(1);
    expect(r.buckets).toEqual([
      { bucket: '2026-09-01', busyMs: H, islands: 1 },
      { bucket: '2026-09-02', busyMs: H, islands: 1 },
    ]);
  });

  it('buckets by the requested zone, not UTC', () => {
    // The measured case on the live install: 48 invocations that UTC calls Sep 5 belong to
    // local Sep 6. Getting this wrong shifts ~5-10% of rows into the wrong day.
    const late = [iv('2026-09-05T22:30:00Z', '2026-09-05T23:30:00Z')];
    expect(computeBusySpan(late, UTC).buckets.map((b) => b.bucket)).toEqual(['2026-09-05']);
    // Bratislava is UTC+2 in September, so 22:30Z is 00:30 on the 6th.
    expect(computeBusySpan(late, BA).buckets.map((b) => b.bucket)).toEqual(['2026-09-06']);
  });

  it('keeps bucket totals equal to the union total', () => {
    // Splitting must partition the union, never duplicate or drop any of it.
    const r = computeBusySpan(
      [
        iv('2026-09-01T22:00:00Z', '2026-09-02T03:00:00Z'),
        iv('2026-09-02T02:00:00Z', '2026-09-04T06:00:00Z'),
        iv('2026-09-05T10:00:00Z', '2026-09-05T11:00:00Z'),
      ],
      BA,
    );
    const summed = r.buckets.reduce((n, b) => n + b.busyMs, 0);
    expect(summed).toBe(r.busyMs);
  });

  it('survives a DST spring-forward, where the local day is 23 hours', () => {
    // Europe/Bratislava 2026-03-29: 02:00 -> 03:00 local, so that local day is 23 real hours.
    // A naive "midnight + 24h" boundary lands an hour into the next day and mis-buckets
    // everything after it. Verified independently: 2026-03-28T22:00Z is 23:00 local on the
    // 28th (CET, +1) and 2026-03-30T00:00Z is 02:00 local on the 30th (CEST, +2), so the
    // 26-hour interval is 1h + 23h + 2h.
    const r = computeBusySpan([iv('2026-03-28T22:00:00Z', '2026-03-30T00:00:00Z')], BA);
    const summed = r.buckets.reduce((n, b) => n + b.busyMs, 0);
    expect(summed).toBe(r.busyMs);
    expect(r.busyMs).toBe(26 * H);
    expect(r.buckets).toEqual([
      { bucket: '2026-03-28', busyMs: 1 * H, islands: 1 },
      { bucket: '2026-03-29', busyMs: 23 * H, islands: 1 },
      { bucket: '2026-03-30', busyMs: 2 * H, islands: 1 },
    ]);
  });

  it('survives a DST fall-back, where the local day is 25 hours', () => {
    // Europe/Bratislava 2026-10-25: 03:00 -> 02:00 local, so that local day is 25 real hours.
    // Verified independently: 2026-10-24T22:00Z is exactly 00:00 local on the 25th and
    // 2026-10-25T23:00Z is exactly 00:00 local on the 26th — the interval IS that one local
    // day, so it must produce exactly one bucket of 25 h and spill nothing into the 26th.
    const r = computeBusySpan([iv('2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z')], BA);
    const summed = r.buckets.reduce((n, b) => n + b.busyMs, 0);
    expect(summed).toBe(r.busyMs);
    expect(r.buckets).toEqual([{ bucket: '2026-10-25', busyMs: 25 * H, islands: 1 }]);
  });

  it('reproduces the measured live figures', () => {
    // Sanity anchor: the shape the dashboard reports. 3 agents for an hour inside a 4-hour
    // window is 3 agent-hours, 1 busy hour, 3x concurrency, 25% duty cycle.
    const r = computeBusySpan(
      [
        iv('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        iv('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        iv('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        iv('2026-09-01T13:00:00Z', '2026-09-01T14:00:00Z'),
      ],
      UTC,
    );
    expect(r.agentMs / H).toBe(4);
    expect(r.busyMs / H).toBe(2);
    expect(r.concurrency).toBe(2);
    expect(r.dutyCycle).toBeCloseTo(0.5, 10);
  });
});

describe('dayKey', () => {
  it('zero-pads so keys sort lexically as dates', () => {
    expect(dayKey(Date.parse('2026-01-02T00:00:00Z'), 'UTC')).toBe('2026-01-02');
    expect(dayKey(Date.parse('2026-11-30T00:00:00Z'), 'UTC')).toBe('2026-11-30');
  });
});

describe('dayKeysBetween', () => {
  it('lists every local day inclusive so a chart can render explicit zeros', () => {
    const keys = dayKeysBetween(
      Date.parse('2026-09-01T06:00:00Z'),
      Date.parse('2026-09-04T06:00:00Z'),
      'UTC',
    );
    expect(keys).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']);
  });

  it('returns an empty list for an inverted or unusable range', () => {
    expect(
      dayKeysBetween(Date.parse('2026-09-04T00:00:00Z'), Date.parse('2026-09-01T00:00:00Z'), 'UTC'),
    ).toEqual([]);
    expect(dayKeysBetween(Number.NaN, 0, 'UTC')).toEqual([]);
  });

  it('crosses a DST boundary without duplicating or skipping a day', () => {
    const keys = dayKeysBetween(
      Date.parse('2026-03-28T12:00:00Z'),
      Date.parse('2026-03-30T12:00:00Z'),
      'Europe/Bratislava',
    );
    expect(keys).toEqual(['2026-03-28', '2026-03-29', '2026-03-30']);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
