import { describe, it, expect } from 'vitest';
import { deriveSlotWait, STALE_PARK_MS, type SlotWaitStep } from './slot-wait.js';

const NOW = Date.parse('2026-07-24T12:00:00Z');
const agoMs = (ms: number) => new Date(NOW - ms).toISOString();

const step = (over: Partial<SlotWaitStep> = {}): SlotWaitStep => ({
  id: 'row-1',
  stepId: '01c-ddev-env',
  round: 0,
  status: 'pending',
  waitingStartedAt: agoMs(5 * 60_000),
  statusMessage: 'Waiting for a free runtime slot (limit 2; 1 ahead in the queue)',
  updatedAt: agoMs(10_000),
  ...over,
});

const derive = (
  over: Partial<Parameters<typeof deriveSlotWait>[0]> = {},
  steps: SlotWaitStep[] = [step()],
) =>
  deriveSlotWait({
    taskStatus: 'running',
    currentStepId: '01c-ddev-env',
    currentRound: 0,
    steps,
    queuedInvocationStepRowIds: new Set<string>(),
    nowMs: NOW,
    ...over,
  });

describe('deriveSlotWait', () => {
  it('reports a runtime park (pending + marker) on the current step', () => {
    expect(derive()).toEqual({
      kind: 'runtime',
      since: agoMs(5 * 60_000),
      stepId: '01c-ddev-env',
      message: 'Waiting for a free runtime slot (limit 2; 1 ahead in the queue)',
      stale: false,
    });
  });

  it('is null while the step is genuinely running', () => {
    expect(derive({}, [step({ status: 'running', waitingStartedAt: null })])).toBeNull();
  });

  it('is null for a pending step with no marker (plain not-yet-run row)', () => {
    expect(derive({}, [step({ waitingStartedAt: null })])).toBeNull();
  });

  it('ignores a park marker on a step that is NOT the current one', () => {
    // An earlier round parked, then the fix loop moved on: the stale marker/message survive
    // on that row while the task works elsewhere.
    const steps = [
      step({ id: 'row-old', stepId: '07b-phase-4-validate', round: 2 }),
      step({ id: 'row-cur', status: 'running', waitingStartedAt: null }),
    ];
    expect(derive({}, steps)).toBeNull();
  });

  it('matches on round, not just step id', () => {
    expect(derive({ currentRound: 1 }, [step({ round: 0 })])).toBeNull();
    expect(derive({ currentRound: 1 }, [step({ round: 1 })])?.kind).toBe('runtime');
  });

  it.each(['failed', 'cancelled', 'completed', 'waiting_user', 'queued'])(
    'is null for a %s task even with a parked row',
    (taskStatus) => {
      expect(derive({ taskStatus })).toBeNull();
    },
  );

  it('flags a cold park as stale (dead poll loop = wedged, not queued)', () => {
    const fresh = derive({}, [step({ updatedAt: agoMs(STALE_PARK_MS) })]);
    expect(fresh?.stale).toBe(false);
    const cold = derive({}, [step({ updatedAt: agoMs(STALE_PARK_MS + 1) })]);
    expect(cold?.stale).toBe(true);
  });

  it('reports an agent-slot wait for waiting_cli with an unstarted invocation', () => {
    const row = step({ id: 'row-cli', status: 'waiting_cli', statusMessage: null });
    const got = derive({ queuedInvocationStepRowIds: new Set(['row-cli']) }, [row]);
    expect(got).toEqual({
      kind: 'agent',
      since: agoMs(5 * 60_000),
      stepId: '01c-ddev-env',
      message: null,
      stale: false,
    });
  });

  it('is null for waiting_cli whose invocation is already running', () => {
    const row = step({ id: 'row-cli', status: 'waiting_cli', waitingStartedAt: null });
    expect(derive({ queuedInvocationStepRowIds: new Set(['row-other']) }, [row])).toBeNull();
  });

  it('is null when the task has no current step', () => {
    expect(derive({ currentStepId: null })).toBeNull();
  });
});
