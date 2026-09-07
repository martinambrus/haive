import { describe, expect, it } from 'vitest';
import { computeBusySpan } from './busy-span.js';
import { buildTaskTimeBreakdown, TASK_TIME_ROW_LIMIT } from './task-time.js';

const UTC = { timeZone: 'UTC' };
const H = 3_600_000;

const iv = (taskId: string, start: string, end: string) => ({ taskId, start, end });

describe('buildTaskTimeBreakdown', () => {
  it('returns nothing for no intervals', () => {
    expect(buildTaskTimeBreakdown([], UTC)).toEqual({ rows: [], taskCount: 0, truncated: false });
  });

  it('splits agent-hours so the parts add up to the window total exactly', () => {
    // The property the whole feature rests on: the table under the tiles must reconcile with
    // them. Agent-hours is a plain sum, so partitioning it cannot change the total.
    const intervals = [
      iv('a', '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z'),
      iv('b', '2026-09-01T11:00:00Z', '2026-09-01T11:30:00Z'),
      iv('a', '2026-09-02T09:00:00Z', '2026-09-02T09:15:00Z'),
      iv('c', '2026-09-03T00:00:00Z', '2026-09-03T01:00:00Z'),
    ];
    const { rows } = buildTaskTimeBreakdown(intervals, UTC);
    const whole = computeBusySpan(intervals, UTC);
    expect(rows.reduce((n, r) => n + r.agentMs, 0)).toBe(whole.agentMs);
  });

  it('does NOT let busy spans add up when two tasks overlap', () => {
    // Two tasks running the same hour each own that hour; the window owns it once. A caller
    // that adds these columns is asking a question with no answer, which is why the UI says so.
    const intervals = [
      iv('a', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
      iv('b', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
    ];
    const { rows } = buildTaskTimeBreakdown(intervals, UTC);
    expect(rows.map((r) => r.busyMs)).toEqual([H, H]);
    expect(computeBusySpan(intervals, UTC).busyMs).toBe(H);
  });

  it('reports each task its own concurrency, not the window average', () => {
    const { rows } = buildTaskTimeBreakdown(
      [
        // Three agents on one task, all in the same hour.
        iv('fanout', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        iv('fanout', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        iv('fanout', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        // One agent on another, elsewhere in the day.
        iv('serial', '2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z'),
      ],
      UTC,
    );
    const byId = new Map(rows.map((r) => [r.taskId, r]));
    expect(byId.get('fanout')).toMatchObject({ agentMs: 3 * H, busyMs: H, concurrency: 3 });
    expect(byId.get('serial')).toMatchObject({ agentMs: H, busyMs: H, concurrency: 1 });
  });

  it('measures the calendar span per task, gaps included', () => {
    const { rows } = buildTaskTimeBreakdown(
      [
        iv('a', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        iv('a', '2026-09-01T20:00:00Z', '2026-09-01T21:00:00Z'),
      ],
      UTC,
    );
    expect(rows[0]).toMatchObject({
      agentMs: 2 * H,
      busyMs: 2 * H,
      calendarMs: 11 * H,
      islands: 2,
    });
    expect(rows[0]!.dutyCycle).toBeCloseTo(2 / 11, 10);
  });

  it('ranks by agent-hours and breaks ties deterministically', () => {
    const { rows } = buildTaskTimeBreakdown(
      [
        iv('small', '2026-09-01T10:00:00Z', '2026-09-01T10:30:00Z'),
        // zzz and aaa consume the same agent-hours; the id decides, so a cap cuts the same
        // rows on every request for the same window.
        iv('zzz', '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z'),
        iv('aaa', '2026-09-02T10:00:00Z', '2026-09-02T12:00:00Z'),
      ],
      UTC,
    );
    expect(rows.map((r) => r.taskId)).toEqual(['aaa', 'zzz', 'small']);
  });

  it('caps after ranking, keeping the biggest consumers and reporting the cut', () => {
    const intervals = Array.from({ length: 5 }, (_, i) =>
      // Later index -> longer run, so the cap must keep t4/t3 and drop t0.
      iv(`t${i}`, '2026-09-01T00:00:00Z', `2026-09-01T0${i + 1}:00:00Z`),
    );
    const r = buildTaskTimeBreakdown(intervals, { ...UTC, limit: 2 });
    expect(r.rows.map((x) => x.taskId)).toEqual(['t4', 't3']);
    expect(r.taskCount).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it('does not report truncation when the set fits', () => {
    const r = buildTaskTimeBreakdown([iv('a', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')], {
      ...UTC,
      limit: 1,
    });
    expect(r.truncated).toBe(false);
    expect(r.taskCount).toBe(1);
  });

  it('falls back to the module cap for an absent or nonsensical limit', () => {
    expect(buildTaskTimeBreakdown([], UTC)).toMatchObject({ truncated: false });
    const many = Array.from({ length: TASK_TIME_ROW_LIMIT + 1 }, (_, i) =>
      iv(`t${String(i).padStart(4, '0')}`, '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
    );
    expect(buildTaskTimeBreakdown(many, { ...UTC, limit: 0 }).rows).toHaveLength(
      TASK_TIME_ROW_LIMIT,
    );
    expect(buildTaskTimeBreakdown(many, UTC).truncated).toBe(true);
  });

  it('keeps a task whose intervals are all unusable, with zeroed timings', () => {
    // An inverted row is dropped by computeBusySpan. The task still ran something, so hiding it
    // from a table that exists to account for the window would be a worse answer than a zero.
    const r = buildTaskTimeBreakdown(
      [
        iv('broken', '2026-09-01T11:00:00Z', '2026-09-01T10:00:00Z'),
        { taskId: 'broken', start: null, end: null },
      ],
      UTC,
    );
    expect(r.rows).toEqual([
      {
        taskId: 'broken',
        invocations: 2,
        agentMs: 0,
        busyMs: 0,
        calendarMs: 0,
        islands: 0,
        concurrency: null,
        dutyCycle: null,
      },
    ]);
  });
});
