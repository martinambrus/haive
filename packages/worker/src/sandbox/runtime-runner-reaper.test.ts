import { describe, it, expect, vi } from 'vitest';
import type { Database } from '@haive/database';
import {
  reapDecision,
  pickPreemptibleRunner,
  RuntimeRunnerReaper,
  type ReaperTask,
  type RunnerContainer,
} from './runtime-runner-reaper.js';

vi.mock('./runner-activity.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runnerExecLive: async () => false,
}));

const GRACE = 180 * 60_000; // RUNTIME_IDLE_REAP_MINUTES default: 180 min
const NOW = Date.parse('2026-07-22T18:30:00Z');
const ago = (ms: number) => new Date(NOW - ms);

/** A running runner container whose own start time is recent. */
const freshRunner = { running: true, taskId: 't1', startedAtMs: NOW - 20 * 60_000 };

describe('reapDecision', () => {
  it('reaps a long-failed task even when its runner was just rebooted (the slot-squat bug)', () => {
    // The real incident: task failed 14:56, a stray runtime-ensure cold-booted a fresh
    // runner at 18:07. Anchoring the grace to the CONTAINER start re-armed a full 3h hold
    // on one of only two runtime slots. It must anchor to the task's failure time.
    const task = { status: 'failed', completedAt: ago(3.5 * 60 * 60_000) };
    expect(reapDecision(freshRunner, task, GRACE, NOW)).toBe('failed-grace');
  });

  it('keeps a recently-failed task’s runner even when the container is old', () => {
    const task = { status: 'failed', completedAt: ago(10 * 60_000) };
    const oldRunner = { running: true, taskId: 't1', startedAtMs: NOW - 5 * 60 * 60_000 };
    expect(reapDecision(oldRunner, task, GRACE, NOW)).toBe(null);
  });

  it('falls back to the container start when the failure time is unknown', () => {
    const task = { status: 'failed', completedAt: null };
    const old = { running: true, taskId: 't1', startedAtMs: NOW - 4 * 60 * 60_000 };
    expect(reapDecision(old, task, GRACE, NOW)).toBe('failed-grace');
    expect(reapDecision(freshRunner, task, GRACE, NOW)).toBe(null);
  });

  it('keeps a failed task’s runner when the grace is disabled (0)', () => {
    const task = { status: 'failed', completedAt: ago(99 * 60 * 60_000) };
    expect(reapDecision(freshRunner, task, 0, NOW)).toBe(null);
  });

  it.each(['completed', 'cancelled'])('reaps a %s task immediately', (status) => {
    expect(reapDecision(freshRunner, { status, completedAt: ago(1000) }, GRACE, NOW)).toBe(
      'terminal',
    );
  });

  it.each(['running', 'paused', 'waiting_user', 'queued'])('never touches a %s task', (status) => {
    expect(reapDecision(freshRunner, { status, completedAt: null }, GRACE, NOW)).toBe(null);
  });

  it('reaps a non-running container regardless of task status', () => {
    const stopped = { running: false, taskId: 't1', startedAtMs: NOW };
    expect(reapDecision(stopped, { status: 'running', completedAt: null }, GRACE, NOW)).toBe(
      'exited',
    );
  });

  it('reaps an unlabelled runner and one whose task row is gone', () => {
    expect(
      reapDecision({ running: true, taskId: null, startedAtMs: NOW }, undefined, GRACE, NOW),
    ).toBe('orphan');
    expect(reapDecision(freshRunner, undefined, GRACE, NOW)).toBe('orphan');
  });

  it('reaps a long-paused settled task on the same grace, anchored to paused_at', () => {
    // Anchored to the TASK's pause time, never the container start — the same anchoring bug
    // the failed path already had, where a stray reboot re-armed a full grace.
    const long = pausedTask({ pausedAt: ago(3.5 * 60 * 60_000) });
    expect(reapDecision(freshRunner, long, GRACE, NOW)).toBe('paused-grace');
    const oldContainer = { running: true, taskId: 't1', startedAtMs: NOW - 5 * 60 * 60_000 };
    expect(reapDecision(oldContainer, pausedTask({ pausedAt: ago(10 * 60_000) }), GRACE, NOW)).toBe(
      null,
    );
  });

  it('never reaps a paused task whose final CLI run is still going', () => {
    // That run may be driving this very DDEV container; pause promised to let it finish.
    const busy = pausedTask({ pausedAt: ago(99 * 60 * 60_000), settled: false });
    expect(reapDecision(freshRunner, busy, GRACE, NOW)).toBe(null);
  });

  it('keeps a paused task’s runner when the grace is disabled (0)', () => {
    expect(reapDecision(freshRunner, pausedTask({ pausedAt: ago(99 * 60 * 60_000) }), 0, NOW)).toBe(
      null,
    );
  });
});

const runner = (over: Partial<RunnerContainer> = {}): RunnerContainer => ({
  id: 'c1',
  taskId: 't1',
  running: true,
  startedAtMs: NOW,
  ...over,
});
const tasks = (entries: Array<[string, ReaperTask]>) => new Map(entries);

/** A task the user paused. Its STATUS stays `running` — that is the whole point of storing the
 *  hold in its own column — so these cases are precisely the ones a status-only rule misses. */
const pausedTask = (over: Partial<ReaperTask> = {}): ReaperTask => ({
  status: 'running',
  completedAt: null,
  pausedAt: ago(60 * 60_000),
  settled: true,
  ...over,
});

/** A dead task keeps its real status, like a paused one, and carries `dead_at` instead. */
const deadTask = (over: Partial<ReaperTask> = {}): ReaperTask => ({
  status: 'running',
  completedAt: null,
  pausedAt: null,
  deadAt: ago(60 * 60_000),
  settled: true,
  ...over,
});

describe('reapDecision: a dead task', () => {
  it('reaps a long-dead settled task on the paused grace, anchored to dead_at', () => {
    expect(
      reapDecision(freshRunner, deadTask({ deadAt: ago(3.5 * 60 * 60_000) }), GRACE, NOW),
    ).toBe('dead-grace');
    const oldContainer = { running: true, taskId: 't1', startedAtMs: NOW - 5 * 60 * 60_000 };
    expect(reapDecision(oldContainer, deadTask({ deadAt: ago(10 * 60_000) }), GRACE, NOW)).toBe(
      null,
    );
  });

  it.each(['running', 'queued', 'waiting_user', 'waiting_pr', 'created'])(
    'reaps the runner of a dead %s task after the grace and not before',
    (status) => {
      expect(
        reapDecision(freshRunner, deadTask({ status, deadAt: ago(GRACE - 1) }), GRACE, NOW),
      ).toBe(null);
      expect(reapDecision(freshRunner, deadTask({ status, deadAt: ago(GRACE) }), GRACE, NOW)).toBe(
        'dead-grace',
      );
    },
  );

  it('never reaps a dead task whose final CLI run is still going', () => {
    const busy = deadTask({ deadAt: ago(99 * 60 * 60_000), settled: false });
    expect(reapDecision(freshRunner, busy, GRACE, NOW)).toBe(null);
  });

  it('keeps a dead task’s runner when the grace is disabled (0)', () => {
    expect(reapDecision(freshRunner, deadTask({ deadAt: ago(99 * 60 * 60_000) }), 0, NOW)).toBe(
      null,
    );
  });

  it('keeps the runner of a task that is not dead', () => {
    expect(reapDecision(freshRunner, deadTask({ deadAt: null }), GRACE, NOW)).toBe(null);
  });

  it('leaves a dead failed task to the failed grace, anchored to its failure', () => {
    const failed = deadTask({
      status: 'failed',
      completedAt: ago(10 * 60_000),
      deadAt: ago(99 * 60 * 60_000),
    });
    expect(reapDecision(freshRunner, failed, GRACE, NOW)).toBe(null);
  });
});

describe('pickPreemptibleRunner', () => {
  it.each(['failed', 'completed', 'cancelled'])(
    'preempts a running %s task’s runner (demand outranks the retry-cache)',
    (status) => {
      const pick = pickPreemptibleRunner(
        [runner()],
        tasks([['t1', { status, completedAt: ago(60_000) }]]),
      );
      expect(pick?.id).toBe('c1');
    },
  );

  it.each(['running', 'paused', 'waiting_user', 'waiting_cli', 'queued', 'pending', 'weird'])(
    'never preempts a running %s task’s runner (in use / fail-safe)',
    (status) => {
      expect(
        pickPreemptibleRunner([runner()], tasks([['t1', { status, completedAt: null }]])),
      ).toBeNull();
    },
  );

  it('preempts an orphan runner (no task label) and one whose task row is gone', () => {
    expect(pickPreemptibleRunner([runner({ id: 'orphan', taskId: null })], new Map())?.id).toBe(
      'orphan',
    );
    expect(pickPreemptibleRunner([runner({ id: 'gone', taskId: 'missing' })], new Map())?.id).toBe(
      'gone',
    );
  });

  it('never preempts a non-running (exited/created) container — it holds no gate slot', () => {
    // Boot-race guard: a runner another waiter is mid-cold-boot into shows as `created`.
    expect(
      pickPreemptibleRunner(
        [runner({ id: 'x', running: false })],
        tasks([['t1', { status: 'failed', completedAt: ago(60_000) }]]),
      ),
    ).toBeNull();
  });

  it('prefers the longest-dead candidate (oldest completedAt)', () => {
    const pick = pickPreemptibleRunner(
      [runner({ id: 'recent', taskId: 'tr' }), runner({ id: 'old', taskId: 'to' })],
      tasks([
        ['tr', { status: 'failed', completedAt: ago(10 * 60_000) }],
        ['to', { status: 'failed', completedAt: ago(3 * 60 * 60_000) }],
      ]),
    );
    expect(pick?.id).toBe('old');
  });

  it('sorts an orphan (unknown death time) as oldest', () => {
    const pick = pickPreemptibleRunner(
      [runner({ id: 'failed', taskId: 'tr' }), runner({ id: 'orphan', taskId: null })],
      tasks([['tr', { status: 'failed', completedAt: ago(10 * 60_000) }]]),
    );
    expect(pick?.id).toBe('orphan');
  });

  it('returns null when nothing is preemptible', () => {
    expect(
      pickPreemptibleRunner([runner()], tasks([['t1', { status: 'running', completedAt: null }]])),
    ).toBeNull();
    expect(pickPreemptibleRunner([], new Map())).toBeNull();
  });

  it('preempts a settled paused task’s runner when nothing dead is available', () => {
    // The deadlock this exists for: every slot held by tasks the user paused, so a live task
    // can never boot. Its status is `running`, so only the pausedAt rule can free it.
    expect(pickPreemptibleRunner([runner()], tasks([['t1', pausedTask()]]))?.id).toBe('c1');
  });

  it('prefers a DEAD runner over a paused one (reclaiming a dead one costs nothing)', () => {
    const pick = pickPreemptibleRunner(
      [runner({ id: 'held', taskId: 'tp' }), runner({ id: 'dead', taskId: 'td' })],
      tasks([
        // Paused far longer than the dead task has been dead — tier still wins over age.
        ['tp', pausedTask({ pausedAt: ago(10 * 60 * 60_000) })],
        ['td', { status: 'failed', completedAt: ago(60_000) }],
      ]),
    );
    expect(pick?.id).toBe('dead');
  });

  it('never preempts a paused task that still has a CLI run finishing', () => {
    expect(
      pickPreemptibleRunner([runner()], tasks([['t1', pausedTask({ settled: false })]])),
    ).toBeNull();
  });

  it('prefers the longest-paused runner among held tasks', () => {
    const pick = pickPreemptibleRunner(
      [runner({ id: 'recent', taskId: 'tr' }), runner({ id: 'old', taskId: 'to' })],
      tasks([
        ['tr', pausedTask({ pausedAt: ago(10 * 60_000) })],
        ['to', pausedTask({ pausedAt: ago(5 * 60 * 60_000) })],
      ]),
    );
    expect(pick?.id).toBe('old');
  });

  it('preempts a settled dead task’s runner on demand, with no grace', () => {
    expect(
      pickPreemptibleRunner([runner()], tasks([['t1', deadTask({ deadAt: ago(60_000) })]]))?.id,
    ).toBe('c1');
  });

  it('never preempts a dead task that still has a CLI run finishing', () => {
    expect(
      pickPreemptibleRunner([runner()], tasks([['t1', deadTask({ settled: false })]])),
    ).toBeNull();
  });

  it('never preempts a settled task that is not dead', () => {
    expect(
      pickPreemptibleRunner([runner()], tasks([['t1', deadTask({ deadAt: null })]])),
    ).toBeNull();
  });

  it('prefers a failed runner over a dead one', () => {
    const pick = pickPreemptibleRunner(
      [runner({ id: 'dead', taskId: 'td' }), runner({ id: 'failed', taskId: 'tf' })],
      tasks([
        ['td', deadTask({ deadAt: ago(10 * 60 * 60_000) })],
        ['tf', { status: 'failed', completedAt: ago(60_000) }],
      ]),
    );
    expect(pick?.id).toBe('failed');
  });

  it('prefers the longest-held runner among paused and dead tasks', () => {
    const tasksHeld = (deadFor: number, pausedFor: number) =>
      tasks([
        ['td', deadTask({ deadAt: ago(deadFor) })],
        ['tp', pausedTask({ pausedAt: ago(pausedFor) })],
      ]);
    const both = [runner({ id: 'dead', taskId: 'td' }), runner({ id: 'paused', taskId: 'tp' })];

    expect(pickPreemptibleRunner(both, tasksHeld(5 * 60 * 60_000, 10 * 60_000))?.id).toBe('dead');
    expect(pickPreemptibleRunner(both, tasksHeld(10 * 60_000, 5 * 60 * 60_000))?.id).toBe('paused');
  });
});

describe('RuntimeRunnerReaper.reclaimOnePreemptible: a dead task', () => {
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    status: 'running',
    completedAt: null,
    pausedAt: null,
    deadAt: ago(60_000),
    voteScore: 0,
    ...over,
  });

  /** Answers only the columns asked for, so a column the code forgets to select reads as absent. */
  function reaperOf(task: Record<string, unknown>, liveRuns = 0) {
    const db = {
      query: {
        tasks: {
          findFirst: async ({ columns }: { columns: Record<string, boolean> }) =>
            Object.fromEntries(
              Object.entries(columns)
                .filter(([, selected]) => selected)
                .map(([name]) => [name, task[name]]),
            ),
        },
      },
      select: () => ({ from: () => ({ where: async () => [{ n: liveRuns }] }) }),
    } as unknown as Database;
    const reaper = new RuntimeRunnerReaper({ db });
    const inner = reaper as unknown as {
      listRunnerContainers: () => Promise<RunnerContainer[]>;
      reap: (id: string) => Promise<void>;
      inspect: (id: string) => Promise<RunnerContainer | null>;
    };
    vi.spyOn(inner, 'listRunnerContainers').mockResolvedValue([runner()]);
    vi.spyOn(inner, 'inspect').mockResolvedValue(null);
    return { reaper, reap: vi.spyOn(inner, 'reap').mockResolvedValue(undefined) };
  }

  it('reclaims the runner of a settled dead task for a waiting task', async () => {
    const { reaper, reap } = reaperOf(row());

    await expect(reaper.reclaimOnePreemptible()).resolves.toBe(true);

    expect(reap).toHaveBeenCalledExactlyOnceWith('c1');
  });

  it('leaves the runner of a dead task that still has a CLI run live', async () => {
    const { reaper, reap } = reaperOf(row(), 1);

    await expect(reaper.reclaimOnePreemptible()).resolves.toBe(false);

    expect(reap).not.toHaveBeenCalled();
  });

  it('leaves the runner of a task that is not dead', async () => {
    const { reaper, reap } = reaperOf(row({ deadAt: null }));

    await expect(reaper.reclaimOnePreemptible()).resolves.toBe(false);

    expect(reap).not.toHaveBeenCalled();
  });
});

describe('pickPreemptibleRunner: score tier', () => {
  const runner = (over: Partial<RunnerContainer> = {}): RunnerContainer => ({
    id: 'c1',
    taskId: 't1',
    running: true,
    startedAtMs: 1_000,
    ...over,
  });
  const live = (voteScore: number, settled: boolean): ReaperTask => ({
    status: 'running',
    completedAt: null,
    pausedAt: null,
    settled,
    voteScore,
  });

  it('is inert without a waiter score — the pre-feature behaviour', () => {
    const c = [runner({ id: 'low', taskId: 'low' })];
    const tasks = new Map([['low', live(0, true)]]);
    expect(pickPreemptibleRunner(c, tasks)).toBeNull();
    expect(pickPreemptibleRunner(c, tasks, null)).toBeNull();
  });

  it('takes a settled runner the waiter outscores', () => {
    const c = [runner({ id: 'low', taskId: 'low' })];
    expect(pickPreemptibleRunner(c, new Map([['low', live(0, true)]]), 2)?.id).toBe('low');
  });

  it('NEVER takes an unsettled runner — the guard that stops killing a live agent', () => {
    const c = [runner({ id: 'low', taskId: 'low' })];
    expect(pickPreemptibleRunner(c, new Map([['low', live(0, false)]]), 2)).toBeNull();
  });

  it('never takes an equal or higher score — ties stay first-come', () => {
    const c = [runner({ id: 'peer', taskId: 'peer' })];
    expect(pickPreemptibleRunner(c, new Map([['peer', live(2, true)]]), 2)).toBeNull();
    expect(pickPreemptibleRunner(c, new Map([['peer', live(3, true)]]), 2)).toBeNull();
  });

  it('an absent score reads as neutral 0', () => {
    const c = [runner({ id: 'x', taskId: 'x' })];
    const t: ReaperTask = { status: 'running', completedAt: null, pausedAt: null, settled: true };
    expect(pickPreemptibleRunner(c, new Map([['x', t]]), 1)?.id).toBe('x');
  });

  it('prefers the lowest score, then the LONGEST-running', () => {
    const c = [
      runner({ id: 'mid', taskId: 'mid', startedAtMs: 5_000 }),
      runner({ id: 'oldest-low', taskId: 'oldest-low', startedAtMs: 1_000 }),
      runner({ id: 'newest-low', taskId: 'newest-low', startedAtMs: 9_000 }),
    ];
    const tasks = new Map([
      ['mid', live(1, true)],
      ['oldest-low', live(0, true)],
      ['newest-low', live(0, true)],
    ]);
    expect(pickPreemptibleRunner(c, tasks, 2)?.id).toBe('oldest-low');
  });

  it('tiers 1 and 2 still win over the score tier', () => {
    const c = [
      runner({ id: 'dead', taskId: 'dead' }),
      runner({ id: 'low', taskId: 'low', startedAtMs: 1 }),
    ];
    const withDead = new Map<string, ReaperTask>([
      ['dead', { status: 'failed', completedAt: new Date(0), settled: true, voteScore: 5 }],
      ['low', live(0, true)],
    ]);
    expect(pickPreemptibleRunner(c, withDead, 2)?.id).toBe('dead');

    const withPaused = new Map<string, ReaperTask>([
      [
        'dead',
        {
          status: 'running',
          completedAt: null,
          pausedAt: new Date(0),
          settled: true,
          voteScore: 5,
        },
      ],
      ['low', live(0, true)],
    ]);
    expect(pickPreemptibleRunner(c, withPaused, 2)?.id).toBe('dead');
  });

  it('ignores non-running containers, like every other tier', () => {
    // pickPreemptibleRunner filters to `running` before any tier: an exited container holds no
    // gate slot, so reclaiming it would free nothing. (The periodic sweep still reaps it via
    // reapDecision's 'exited' branch — a different code path with a different job.)
    const c = [runner({ id: 'low', taskId: 'low', running: false })];
    expect(pickPreemptibleRunner(c, new Map([['low', live(0, true)]]), 2)).toBeNull();
  });
});
