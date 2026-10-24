import { describe, expect, it } from 'vitest';
import { computeTaskTiming, type TaskTimingStep } from '@haive/shared/timing';
import {
  noStepsMessage,
  notStartedBanner,
  pausedByLabel,
  pausedResumeHint,
  taskBadgeKind,
  taskClockEndMs,
  taskCanStop,
  taskMenuKeys,
  taskNotStarted,
  taskStatusWord,
  taskStoppedAt,
  stopResultNotice,
} from './task-state';

const DEAD_AT = '2026-10-14T10:00:00.000Z';
const PAUSED_AT = '2026-10-14T09:00:00.000Z';
const SLOT = { kind: 'runtime' };
const LIVE_STATUSES = ['created', 'queued', 'running', 'waiting_user', 'waiting_pr', 'failed'];
const COPY_ONLY = {
  status: 'running',
  deadAt: null,
  deadReason: 'the run list names a step this install does not register: module.x.y',
};

describe('taskBadgeKind', () => {
  it('shows the status itself for a plain task', () => {
    expect(taskBadgeKind({ status: 'running' })).toBe('status');
    expect(taskBadgeKind({ status: 'waiting_user' })).toBe('status');
  });

  it('shows a slot wait ahead of the status', () => {
    expect(taskBadgeKind({ status: 'running', slotWait: SLOT })).toBe('slotWait');
  });

  it('shows paused ahead of a slot wait', () => {
    expect(taskBadgeKind({ status: 'running', pausedAt: PAUSED_AT, slotWait: SLOT })).toBe(
      'paused',
    );
  });

  it('shows dead ahead of paused, a slot wait and the status, whatever status it died in', () => {
    for (const status of LIVE_STATUSES) {
      expect(taskBadgeKind({ status, deadAt: DEAD_AT })).toBe('dead');
      expect(taskBadgeKind({ status, deadAt: DEAD_AT, pausedAt: PAUSED_AT, slotWait: SLOT })).toBe(
        'dead',
      );
    }
  });

  it('shows finished ahead of everything, a dead_at left on the row included', () => {
    for (const status of ['cancelled', 'completed']) {
      expect(taskBadgeKind({ status })).toBe('finished');
      expect(taskBadgeKind({ status, deadAt: DEAD_AT, pausedAt: PAUSED_AT, slotWait: SLOT })).toBe(
        'finished',
      );
    }
  });

  it('keys on dead_at and never on a dead_reason that outlived it', () => {
    // NEGATIVE CONTROL: a version keyed on dead_reason badges this running task dead.
    expect(taskBadgeKind(COPY_ONLY)).toBe('status');
  });
});

describe('taskMenuKeys', () => {
  const idle = { stepRunning: false };

  it('offers Cancel and nothing else for a dead task', () => {
    for (const status of LIVE_STATUSES) {
      expect(taskMenuKeys({ status, deadAt: DEAD_AT }, idle)).toEqual(['cancel']);
    }
  });

  it('offers no Start, Retry, Resume, Pause or Stop on a dead task', () => {
    expect(taskMenuKeys({ status: 'created', deadAt: DEAD_AT }, idle)).toEqual(['cancel']);
    expect(taskMenuKeys({ status: 'failed', deadAt: DEAD_AT }, idle)).toEqual(['cancel']);
    expect(taskMenuKeys({ status: 'running', deadAt: DEAD_AT, pausedAt: PAUSED_AT }, idle)).toEqual(
      ['cancel'],
    );
    expect(taskMenuKeys({ status: 'running', deadAt: DEAD_AT }, { stepRunning: true })).toEqual([
      'cancel',
    ]);
  });

  it('keeps every action for a task whose dead_reason outlived its dead_at', () => {
    // NEGATIVE CONTROL: a version keyed on dead_reason strips the menu of a live task.
    expect(taskMenuKeys(COPY_ONLY, idle)).toEqual(['pause', 'cancel']);
  });

  it("offers neither Pause nor Resume while an administrator's pause is locked for the viewer", () => {
    // NEGATIVE CONTROL: red on a menu that keys only on pausedAt.
    const locked = { status: 'running', pausedAt: PAUSED_AT, pauseLocked: true };
    expect(taskMenuKeys(locked, idle)).toEqual(['cancel']);
    expect(taskMenuKeys(locked, { stepRunning: true })).toEqual(['stop', 'cancel']);
    expect(taskMenuKeys({ ...locked, status: 'failed' }, idle)).toEqual(['retry', 'cancel']);
  });

  it('keeps Resume for an administrator viewer, an older api and an unlocked pause', () => {
    const paused = { status: 'running', pausedAt: PAUSED_AT };
    expect(taskMenuKeys({ ...paused, pauseLocked: false }, idle)).toEqual(['resume', 'cancel']);
    expect(taskMenuKeys(paused, idle)).toEqual(['resume', 'cancel']);
  });

  it('ignores pauseLocked on a task that is not paused', () => {
    expect(taskMenuKeys({ status: 'running', pauseLocked: true }, idle)).toEqual([
      'pause',
      'cancel',
    ]);
  });

  it('offers Start only to a task that was created and never started', () => {
    expect(taskMenuKeys({ status: 'created' }, idle)).toEqual(['start', 'pause', 'cancel']);
  });

  it('offers Retry to a failed task', () => {
    expect(taskMenuKeys({ status: 'failed' }, idle)).toEqual(['retry', 'pause', 'cancel']);
  });

  it('offers Pause, or Resume while paused, and Cancel to a running task', () => {
    expect(taskMenuKeys({ status: 'running' }, idle)).toEqual(['pause', 'cancel']);
    expect(taskMenuKeys({ status: 'running', pausedAt: PAUSED_AT }, idle)).toEqual([
      'resume',
      'cancel',
    ]);
  });

  it('offers Stop between Pause and Cancel while a CLI step runs', () => {
    expect(taskMenuKeys({ status: 'running' }, { stepRunning: true })).toEqual([
      'pause',
      'stop',
      'cancel',
    ]);
  });

  it('offers nothing to a finished task, a dead_at left on the row included', () => {
    for (const status of ['cancelled', 'completed']) {
      expect(taskMenuKeys({ status }, idle)).toEqual([]);
      expect(taskMenuKeys({ status, deadAt: DEAD_AT }, idle)).toEqual([]);
    }
  });
});

describe('taskNotStarted', () => {
  it('is true for a created task', () => {
    expect(taskNotStarted({ status: 'created' })).toBe(true);
  });

  it('is false for every other status', () => {
    for (const status of [
      'queued',
      'running',
      'waiting_user',
      'waiting_pr',
      'failed',
      'completed',
      'cancelled',
    ]) {
      expect(taskNotStarted({ status })).toBe(false);
    }
  });

  it('is false for a dead task, which can only be cancelled', () => {
    expect(taskNotStarted({ status: 'created', deadAt: DEAD_AT })).toBe(false);
  });

  it('keys on dead_at and never on a dead_reason that outlived it', () => {
    // NEGATIVE CONTROL: a version keyed on dead_reason hides the banner from a live task.
    expect(taskNotStarted({ ...COPY_ONLY, status: 'created' })).toBe(true);
  });

  it('is true exactly when the Actions menu offers Start', () => {
    for (const status of [...LIVE_STATUSES, 'completed', 'cancelled']) {
      for (const deadAt of [null, DEAD_AT]) {
        const task = { status, deadAt };
        expect(taskNotStarted(task)).toBe(
          taskMenuKeys(task, { stepRunning: false }).includes('start'),
        );
      }
    }
  });
});

describe('taskStatusWord', () => {
  it('says dead for a dead task, not the status it died in', () => {
    for (const status of LIVE_STATUSES) {
      expect(taskStatusWord({ status, deadAt: DEAD_AT })).toBe('dead');
    }
  });

  it('says the status for everything else', () => {
    expect(taskStatusWord({ status: 'waiting_user' })).toBe('waiting_user');
    expect(taskStatusWord({ status: 'cancelled', deadAt: DEAD_AT })).toBe('cancelled');
    expect(taskStatusWord({ status: 'completed', deadAt: DEAD_AT })).toBe('completed');
  });

  it('keys on dead_at and never on a dead_reason that outlived it', () => {
    expect(taskStatusWord(COPY_ONLY)).toBe('running');
  });
});

describe('pausedByLabel', () => {
  it('says an administrator paused it when the api says so', () => {
    expect(pausedByLabel({ pausedByAdmin: true })).toBe('Paused by an administrator');
  });

  it("keeps the owner's own pause as Paused by you", () => {
    // NEGATIVE CONTROL: a version that always says an administrator fails these two.
    expect(pausedByLabel({ pausedByAdmin: false })).toBe('Paused by you');
    expect(pausedByLabel({})).toBe('Paused by you');
  });
});

describe('pausedResumeHint', () => {
  it('says only an administrator can resume a locked pause', () => {
    expect(pausedResumeHint({ pauseLocked: true })).toBe('Only an administrator can resume it.');
  });

  it('tells everyone else to press Resume', () => {
    expect(pausedResumeHint({ pauseLocked: false })).toBe(
      'Press Resume to continue where it stopped.',
    );
    expect(pausedResumeHint({})).toBe('Press Resume to continue where it stopped.');
  });
});

describe('task clocks', () => {
  const MIN = 60_000;
  const NOW = Date.parse('2026-10-14T12:00:00.000Z');
  const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
  type Clock = { startedAt: string; completedAt: string | null; deadAt: string | null };
  const alive: Clock = { startedAt: ago(20), completedAt: null, deadAt: null };
  const dead: Clock = { ...alive, deadAt: ago(10) };
  // Open for 20 minutes, the last 15 of them waiting at a gate.
  const gate: TaskTimingStep[] = [
    {
      startedAt: ago(20),
      endedAt: null,
      idleMs: 0,
      userActiveMs: 0,
      waitingStartedAt: ago(15),
      status: 'waiting_form',
    },
  ];
  // What the task page shows: the wall clock, and the open step and wait billed up to the same end.
  const reading = (task: Clock, nowMs: number) => {
    const endMs = taskClockEndMs(task, nowMs);
    return { wallMs: endMs - Date.parse(task.startedAt), ...computeTaskTiming(gate, endMs) };
  };

  it('reads an alive task up to now', () => {
    expect(reading(alive, NOW)).toEqual({
      wallMs: 20 * MIN,
      workMs: 5 * MIN,
      idleMs: 15 * MIN,
      userActiveMs: 0,
    });
    expect(reading(alive, NOW + 5 * MIN).wallMs).toBe(25 * MIN);
    expect(taskStoppedAt(alive)).toBeNull();
  });

  it.each([-15, 0, 1, 90, 6000])(
    'stops a dead task at dead_at when now is %i minutes from the reference time',
    (minutesFromNow) => {
      expect(reading(dead, NOW + minutesFromNow * MIN)).toEqual({
        wallMs: 10 * MIN,
        workMs: 5 * MIN,
        idleMs: 5 * MIN,
        userActiveMs: 0,
      });
    },
  );

  it('names dead_at as the instant a dead task stopped', () => {
    expect(taskStoppedAt(dead)).toBe(dead.deadAt);
  });

  it('ticks again once the task is revived', () => {
    const revived = { ...dead, deadAt: null };
    expect(taskStoppedAt(revived)).toBeNull();
    expect(reading(revived, NOW).wallMs).toBe(20 * MIN);
    expect(reading(revived, NOW + 5 * MIN).wallMs).toBe(25 * MIN);
  });

  it('stops a finished task at completed_at, a dead_at left on the row included', () => {
    const finished = { ...alive, completedAt: ago(15), deadAt: ago(10) };
    expect(taskStoppedAt(finished)).toBe(finished.completedAt);
    expect(reading(finished, NOW).wallMs).toBe(5 * MIN);
    expect(reading(finished, NOW + 90 * MIN).wallMs).toBe(5 * MIN);
  });

  it('reads an api that predates dead_at as alive', () => {
    expect(taskStoppedAt({ completedAt: null })).toBeNull();
    expect(taskClockEndMs({}, NOW)).toBe(NOW);
  });
});

describe('task page copy', () => {
  const GENERIC = 'No steps recorded yet. The task worker will populate them once it starts.';

  it('pins the not-started banner', () => {
    expect(notStartedBanner).toEqual({
      lead: 'This task has not started.',
      detail:
        'It was created without being started so its attachments could be uploaded first; nothing runs on it until you press Start.',
    });
  });

  it('pins the empty-steps message for a task that has not started, and the generic one otherwise', () => {
    expect(noStepsMessage({ status: 'created' })).toBe(
      'No steps recorded yet. This task has not started; press Start above and the task worker will populate them.',
    );
    expect(noStepsMessage({ status: 'running' })).toBe(GENERIC);
    expect(noStepsMessage({ status: 'created', deadAt: DEAD_AT })).toBe(GENERIC);
  });
});

describe('Stop eligibility controls (#395)', () => {
  it('offers Stop for a running task with a pending current row', () => {
    const opts = { stepRunning: false, currentStepStatus: 'pending' };
    expect(taskMenuKeys({ status: 'running' }, opts)).toContain('stop');
  });

  it.each(['completed', 'cancelled', 'created', 'failed', 'queued', 'waiting_user'])(
    'does not offer Stop for a pending row on a %s task',
    (status) => {
      const opts = { stepRunning: false, currentStepStatus: 'pending' };
      expect(taskMenuKeys({ status }, opts)).not.toContain('stop');
    },
  );

  it('does not offer Stop for a pause alone, a missing row, or a dead task', () => {
    expect(
      taskMenuKeys({ status: 'running', pausedAt: PAUSED_AT }, { stepRunning: false }),
    ).not.toContain('stop');
    const opts = { stepRunning: false, currentStepStatus: 'pending' };
    expect(taskMenuKeys({ status: 'running', deadAt: DEAD_AT }, opts)).not.toContain('stop');
  });

  it.each(['running', 'waiting_cli'])('keeps Stop for a %s row', (currentStepStatus) => {
    expect(taskCanStop({ status: 'running' }, { stepRunning: false, currentStepStatus })).toBe(
      true,
    );
  });
});

describe('empty Stop result notice', () => {
  it('requires explicit zero counts, including when an older API omits counts', () => {
    expect(stopResultNotice({ stopped: 0, cancelled: 0, killed: 0 })).toBe(
      'Nothing was running to stop.',
    );
    expect(stopResultNotice({})).toBeNull();
    expect(stopResultNotice({ stopped: 0 })).toBeNull();
    expect(stopResultNotice({ stopped: 0, killed: 0 })).toBeNull();
    expect(stopResultNotice({ stopped: 0, cancelled: 0 })).toBeNull();
  });
});
