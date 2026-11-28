import { discardNoChangeCleanupDirectories } from '../src/step-engine/no-change-cleanup.js';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { schema, type Database } from '@haive/database';
import { TASK_JOB_NAMES, logger } from '@haive/shared';
import {
  markTaskCompleted,
  processTaskJob,
  reapTaskTerminals,
  setContainerCleanupRunner,
  TASK_TERMINAL_REAP_ATTEMPTS,
  TASK_TERMINAL_REAP_RETRY_MS,
} from '../src/queues/task-queue.js';

const h = vi.hoisted(() => ({
  retainAuth: false,
  authReadThrows: false,
  calls: [] as string[],
  reapError: null as Error | null,
  reapFailures: Infinity,
  completing: false,
  type: 'run_app',
  runList: ['01-worktree-setup'],
  uncommitted: 0,
  events: [] as { eventType: string; payload: unknown }[],
  seen: (name: string, _taskId?: string) => {
    h.calls.push(name);
  },
  db: {} as Database,
  sandboxes: [] as unknown[] | null,
  journal: [] as { payload: unknown }[],
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ del: async () => 0 }) }));
vi.mock('../src/repo/worktree-changes.js', () => ({
  readUncommittedChanges: async () => ({ count: h.uncommitted }),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<object>()),
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  },
}));
vi.mock('@haive/shared/rag', async (original) => ({
  ...(await original<object>()),
  resolveTaskEmbedTarget: async () => {
    h.seen('embedUnload');
    return null;
  },
}));
vi.mock('../src/sandbox/cli-sandbox-fence.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  supersedeTaskRuns: async (_db: unknown, taskId: string) => h.seen('supersedeTaskRuns', taskId),
}));
vi.mock('../src/sandbox/sandbox-kill.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  killCliSandboxesForTask: async (taskId: string) => {
    h.seen('killCliSandboxesForTask', taskId);
    return 0;
  },
  listCliSandboxesForTask: async (taskId: string) => {
    h.seen('listCliSandboxesForTask', taskId);
    // No sandbox of the task is left, so the teardown goes on to release its claims and finish.
    return h.sandboxes;
  },
}));
vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  syncRefreshedAuthToUserVolumes: async (_db: unknown, taskId: string) => {
    h.seen('syncRefreshedAuthToUserVolumes', taskId);
    if (h.authReadThrows) throw Object.assign(new Error('fixture'), { code: 'EAGAIN' });
    return { retainTaskCopy: h.retainAuth };
  },
  clearTaskAuthPreparationState: () => h.seen('clearTaskAuthPreparationState'),
  findTaskAuthVolumes: async () => [],
  cleanupTaskAuthVolumes: async (taskId: string) => {
    h.seen('cleanupTaskAuthVolumes', taskId);
    return { removed: [], failed: [] };
  },
}));
vi.mock('../src/sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  killTaskDdevRunners: async (taskId: string) => {
    h.seen('killTaskDdevRunners', taskId);
    return 0;
  },
}));
vi.mock('../src/sandbox/app-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  killTaskAppRunners: async (taskId: string) => {
    h.seen('killTaskAppRunners', taskId);
    return 0;
  },
}));
vi.mock('../src/sandbox/ide-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  killTaskIdeContainers: async (taskId: string) => {
    h.seen('killTaskIdeContainers', taskId);
    return 0;
  },
}));
vi.mock('../src/sandbox/terminal-session-reaper.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reapAllSessionsForTask: async (_redis: unknown, _docker: unknown, taskId: string) => {
    h.seen('reapAllSessionsForTask', taskId);
    if (h.reapError && h.reapFailures-- > 0) throw h.reapError;
    return 0;
  },
}));
vi.mock('../src/sandbox/ollama-provision.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  unloadTaskOllamaCliModels: async (_db: unknown, taskId: string) =>
    h.seen('unloadTaskOllamaCliModels', taskId),
}));
vi.mock('../src/repo/worktree-remove.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  removeTaskWorktree: async (_db: unknown, taskId: string) => {
    h.seen('removeTaskWorktree', taskId);
    return { removed: false, worktreePath: null, method: null, branch: null, branchDeleted: false };
  },
}));
vi.mock('../src/repo/scratch-workspace.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cleanupTaskScratchWorkspace: async (_db: unknown, taskId: string) => {
    h.seen('cleanupTaskScratchWorkspace', taskId);
    return false;
  },
}));
vi.mock('../src/project-state/set-aside.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resyncAfterTaskEnd: async (_db: unknown, taskId: string) => h.seen('resyncAfterTaskEnd', taskId),
}));
vi.mock('../src/step-engine/left-open-merge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/step-engine/left-open-merge.js')>();
  return {
    ...actual,
    recordLeftOpenMerges: async (_db: Database, taskId: string) => {
      h.seen('recordLeftOpenMerges', taskId);
    },
  };
});
vi.mock('../src/step-engine/merge-dir-claim.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/step-engine/merge-dir-claim.js')>();
  return {
    ...actual,
    releaseTaskMergeClaims: async (_db: Database, taskId: string) => {
      h.seen('releaseTaskMergeClaims', taskId);
    },
  };
});
vi.mock('../src/step-engine/steps/plan/01-plan-merge.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  discardPlanMerge: async (_db: unknown, taskId: string) => h.seen('discardPlanMerge', taskId),
}));
vi.mock('../src/step-engine/steps/_global-kb-promote.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reconcileKbAuthorEntryOnTaskEnd: async (_db: unknown, taskId: string) =>
    h.seen('reconcileKbAuthorEntryOnTaskEnd', taskId),
}));

const job = { name: TASK_JOB_NAMES.CANCEL, data: { taskId: 'task', userId: 'user' } } as Job;
beforeEach(() => {
  h.calls = [];
  h.retainAuth = false;
  h.authReadThrows = false;
  h.reapError = null;
  h.reapFailures = Infinity;
  h.completing = false;
  h.type = 'run_app';
  h.runList = ['01-worktree-setup'];
  h.uncommitted = 0;
  h.events = [];
  h.sandboxes = [];
  h.journal = [{ payload: { version: 999 } }];
  const builder = {
    from: (table: unknown) => {
      builder.table = table;
      return builder;
    },
    table: undefined as unknown,
    where: () => builder,
    orderBy: () => builder,
    for: async () =>
      builder.table === schema.tasks ? [{ status: h.completing ? 'completed' : 'cancelled' }] : [],
    returning: async () => (h.completing ? [{ id: 'task' }] : []),
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
  };
  const db = {
    query: {
      tasks: {
        findFirst: async () => ({
          status: h.completing ? 'completed' : 'cancelled',
          type: h.type,
          worktreePath: '/wt',
          runListSnapshot: h.completing ? h.runList : ['12-no-change-cleanup'],
        }),
      },
      taskEvents: {
        findMany: async () => {
          h.seen('discardJournalRead');
          return h.journal;
        },
      },
    },
    select: () => builder,
    update: () => ({ set: () => builder }),
    insert: () => ({
      values: async (event: { eventType: string; payload: unknown }) => {
        h.events.push(event);
        h.seen(event.eventType);
      },
    }),
    execute: async () => undefined,
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  h.db = db as unknown as Database;
  setContainerCleanupRunner(async () => 0);
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setContainerCleanupRunner(null);
});

it('runs merge, scratch, model and KB cleanup before rethrowing a refused discard, then redrives', async () => {
  await expect(processTaskJob(job)).rejects.toMatchObject({ name: 'ZodError' });
  expect(h.calls).toEqual(
    expect.arrayContaining([
      'recordLeftOpenMerges',
      'releaseTaskMergeClaims',
      'discardPlanMerge',
      'resyncAfterTaskEnd',
      'cleanupTaskScratchWorkspace',
      'embedUnload',
      'unloadTaskOllamaCliModels',
      'reconcileKbAuthorEntryOnTaskEnd',
    ]),
  );
  expect(h.calls.slice(h.calls.indexOf('listCliSandboxesForTask') + 1)).toEqual([
    'recordLeftOpenMerges',
    'releaseTaskMergeClaims',
    'discardPlanMerge',
    'resyncAfterTaskEnd',
    'cleanupTaskScratchWorkspace',
    'discardJournalRead',
    'embedUnload',
    'unloadTaskOllamaCliModels',
    'reconcileKbAuthorEntryOnTaskEnd',
  ]);
  expect(h.calls).not.toContain('task.cancel_finished');
  h.journal = [];
  await processTaskJob(job);
  expect(h.calls.at(-1)).toBe('task.cancel_finished');
});
it('does not discard or release claims while sandbox absence is unknown', async () => {
  h.sandboxes = null;
  await expect(processTaskJob(job)).rejects.toThrow('docker could not list them');
  expect(h.calls).not.toContain('discardJournalRead');
  expect(h.calls).not.toContain('releaseTaskMergeClaims');
  expect(h.calls).not.toContain('task.cancel_finished');
  expect(h.calls).toContain('reconcileKbAuthorEntryOnTaskEnd');
});

it('does not read a task without a cleanup journal', async () => {
  h.journal = [];
  const read = vi.spyOn(h.db.query.tasks, 'findFirst');
  await discardNoChangeCleanupDirectories(h.db, 'task');
  expect(read).not.toHaveBeenCalled();
});

it.each(['retry outcome', 'lookup throws'] as const)(
  'task-end retains auth after %s while unrelated teardown finishes',
  async (failure) => {
    h.retainAuth = failure === 'retry outcome';
    h.authReadThrows = failure === 'lookup throws';
    h.journal = [];
    await processTaskJob(job);
    expect(h.calls).toContain('syncRefreshedAuthToUserVolumes');
    expect(h.calls).not.toContain('cleanupTaskAuthVolumes');
    expect(h.calls).not.toContain('clearTaskAuthPreparationState');
    expect(h.calls).toContain('cleanupTaskScratchWorkspace');
    expect(h.calls).toContain('task.cancel_finished');
  },
);
it('retries a terminal reap before worktree removal after a transient outage', async () => {
  vi.useFakeTimers();
  h.journal = [];
  h.reapError = Object.assign(new Error('store unavailable'), { code: 'redis_unavailable' });
  h.reapFailures = 1;
  const result = processTaskJob(job).catch((error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(h.calls.filter((call) => call === 'reapAllSessionsForTask')).toHaveLength(2);
  expect(h.calls.indexOf('removeTaskWorktree')).toBeGreaterThan(
    h.calls.lastIndexOf('reapAllSessionsForTask'),
  );
  expect(h.calls.at(-1)).toBe('task.cancel_finished');
});
it('keeps cancel eligible for its production redrive after terminal reap retries are exhausted', async () => {
  vi.useFakeTimers();
  h.journal = [];
  h.reapError = Object.assign(new Error('store unavailable'), { code: 'redis_unavailable' });
  const result = processTaskJob(job).then(
    () => ({ ok: true }),
    (error) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toEqual({ error: h.reapError });
  expect(h.calls.filter((call) => call === 'reapAllSessionsForTask')).toHaveLength(3);
  expect(h.calls).not.toContain('removeTaskWorktree');
  expect(h.calls).not.toContain('task.cancel_finished');
  expect(h.calls).toContain('reconcileKbAuthorEntryOnTaskEnd');
  h.reapError = null;
  h.calls = [];
  await processTaskJob(job);
  expect(h.calls.indexOf('removeTaskWorktree')).toBeGreaterThan(
    h.calls.indexOf('reapAllSessionsForTask'),
  );
  expect(h.calls.at(-1)).toBe('task.cancel_finished');
});
it.each(['run_app', 'review_only'])(
  'durably identifies a retained %s worktree in Activity without failing completion',
  async (type) => {
    vi.useFakeTimers();
    h.journal = [];
    h.completing = true;
    h.type = type;
    h.reapError = Object.assign(new Error('store unavailable'), { code: 'redis_unavailable' });
    const result = markTaskCompleted(h.db, 'task', { epoch: 1 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(h.calls).not.toContain('removeTaskWorktree');
    expect(h.events).toContainEqual(
      expect.objectContaining({
        eventType: 'worktree.cleanup_deferred',
        payload: {
          reason: 'terminal_reap_failed',
          taskEndReason: 'completed',
          worktreePath: '/wt',
        },
      }),
    );
    expect(h.calls).toContain('task.completed');
  },
);

it.each([
  { type: 'workflow', runList: ['01-worktree-setup'], uncommitted: 0 },
  { type: 'workflow', runList: ['01-worktree-setup', '12-worktree-cleanup'], uncommitted: 0 },
  { type: 'review_only', runList: ['01-worktree-setup', '12-worktree-cleanup'], uncommitted: 0 },
  { type: 'review_only', runList: ['01-worktree-setup', '12-no-change-cleanup'], uncommitted: 0 },
  { type: 'review_only', runList: ['01-worktree-setup'], uncommitted: 1 },
  { type: 'review_only', runList: [], uncommitted: 0 },
])('does not report deferred removal when completion owes none: %j', async (control) => {
  vi.useFakeTimers();
  h.journal = [];
  h.completing = true;
  h.type = control.type;
  h.runList = control.runList;
  h.uncommitted = control.uncommitted;
  h.reapError = Object.assign(new Error('store unavailable'), { code: 'redis_unavailable' });
  const result = markTaskCompleted(h.db, 'task', { epoch: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(h.calls).not.toContain('removeTaskWorktree');
  expect(h.events.map((event) => event.eventType)).not.toContain('worktree.cleanup_deferred');
  expect(h.calls).toContain('task.completed');
});

it('pins the production terminal reap retry policy', () => {
  expect(TASK_TERMINAL_REAP_ATTEMPTS).toBe(3);
  expect(TASK_TERMINAL_REAP_RETRY_MS).toBe(250);
});

it('honors injected terminal reap attempt and delay bounds', async () => {
  vi.useFakeTimers();
  h.reapError = Object.assign(new Error('store unavailable'), { code: 'redis_unavailable' });
  let settled = false;
  const result = reapTaskTerminals(h.db, 'task', { attempts: 2, retryMs: 7 }).catch((error) => {
    settled = true;
    return error;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.calls).toEqual(['reapAllSessionsForTask']);
  await vi.advanceTimersByTimeAsync(6);
  expect(h.calls).toEqual(['reapAllSessionsForTask']);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe(h.reapError);
  expect(h.calls).toEqual(['reapAllSessionsForTask', 'reapAllSessionsForTask']);
  expect(vi.getTimerCount()).toBe(0);
});
