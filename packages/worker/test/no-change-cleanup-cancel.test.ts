import { discardNoChangeCleanupDirectories } from '../src/step-engine/no-change-cleanup.js';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { schema, type Database } from '@haive/database';
import { TASK_JOB_NAMES, logger } from '@haive/shared';
import { processTaskJob, setContainerCleanupRunner } from '../src/queues/task-queue.js';

const h = vi.hoisted(() => ({
  calls: [] as string[],
  seen: (name: string, _taskId?: string) => {
    h.calls.push(name);
  },
  db: {} as Database,
  sandboxes: [] as unknown[] | null,
  journal: [] as { payload: unknown }[],
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({ del: async () => 0 }) }));
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
  syncRefreshedAuthToUserVolumes: async (_db: unknown, taskId: string) =>
    h.seen('syncRefreshedAuthToUserVolumes', taskId),
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
    for: async () => (builder.table === schema.tasks ? [{ status: 'cancelled' }] : []),
    returning: async () => [],
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
  };
  const db = {
    query: {
      tasks: {
        findFirst: async () => ({ status: 'cancelled', runListSnapshot: ['12-no-change-cleanup'] }),
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
    insert: () => ({ values: async (event: { eventType: string }) => h.seen(event.eventType) }),
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  h.db = db as unknown as Database;
  setContainerCleanupRunner(async () => 0);
  vi.spyOn(logger, 'warn').mockImplementation(() => {});
  vi.spyOn(logger, 'error').mockImplementation(() => {});
});
afterEach(() => {
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
