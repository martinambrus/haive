import { describe, it, expect } from 'vitest';
import { restoreSteers } from '../src/lib/steer-history';
import type { TaskEvent } from '../src/lib/api-client';

function ev(id: string, taskStepId: string, payload: Record<string, unknown>): TaskEvent {
  return {
    id,
    taskId: 't',
    taskStepId,
    eventType: 'steering.nudge',
    payload,
    createdAt: '2026-09-12T00:00:00Z',
  } as TaskEvent;
}

describe('restoreSteers', () => {
  // A step can hold several invocations — a retry, or a multi-agent fan-out — and
  // step-level scoping made every panel replay every panel's steers, misattributing what
  // each agent was actually told.
  it('shows only the steers sent to THIS invocation', () => {
    const events = [
      ev('1', 'step-a', { text: 'to A', invocationId: 'inv-a' }),
      ev('2', 'step-a', { text: 'to B', invocationId: 'inv-b' }),
    ];
    expect(restoreSteers(events, 'step-a', 'inv-a').map((s) => s.text)).toEqual(['to A']);
    expect(restoreSteers(events, 'step-a', 'inv-b').map((s) => s.text)).toEqual(['to B']);
  });

  it('never crosses a step boundary', () => {
    const events = [ev('1', 'step-b', { text: 'other step', invocationId: 'inv-a' })];
    expect(restoreSteers(events, 'step-a', 'inv-a')).toEqual([]);
  });

  // Written before the id was recorded. Dropping them would erase the history this
  // restore exists to show; step-level matching is what they already had.
  it('falls back to step scope for an event with no invocationId', () => {
    const events = [ev('1', 'step-a', { text: 'legacy' })];
    expect(restoreSteers(events, 'step-a', 'inv-a').map((s) => s.text)).toEqual(['legacy']);
    expect(restoreSteers(events, 'step-a', 'inv-zzz').map((s) => s.text)).toEqual(['legacy']);
  });

  it('marks every restored row historical and prefixes the id', () => {
    const [row] = restoreSteers(
      [ev('9', 'step-a', { text: 'x', invocationId: 'i' })],
      'step-a',
      'i',
    );
    expect(row).toEqual({ id: 'history:9', text: 'x', status: 'historical' });
  });

  it('reports a missing text rather than rendering undefined', () => {
    const rows = restoreSteers([ev('1', 'step-a', { invocationId: 'i' })], 'step-a', 'i');
    expect(rows[0]!.text).toBe('(no text recorded)');
  });

  it('is empty with no step row, and tolerates undefined events', () => {
    expect(restoreSteers([ev('1', 'step-a', { text: 'x' })], undefined, 'i')).toEqual([]);
    expect(restoreSteers(undefined, 'step-a', 'i')).toEqual([]);
  });
});
