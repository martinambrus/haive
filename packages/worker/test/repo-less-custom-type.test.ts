import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { TASK_JOB_NAMES, taskTypeAllowsNoRepository } from '@haive/shared';
import { knownTaskTypes } from '@haive/shared/stats';
import { stepRegistry } from '../src/step-engine/registry.js';
import { registerStepsOnce } from '../src/step-engine/boot.js';
import { builtinTaskTypeRows } from '../src/step-engine/task-type-seed.js';

const h = vi.hoisted(() => {
  const state = {
    task: {} as Record<string, unknown>,
    ensured: [] as string[][],
  };
  const db = {
    query: {
      tasks: { findFirst: async () => state.task },
      repositories: { findFirst: async () => undefined },
      taskTypeDefinitions: { findFirst: async () => undefined },
    },
    update: () => {
      throw new Error('stop after the context resolved');
    },
    insert: () => {
      throw new Error('stop after the context resolved');
    },
  };
  return { state, db };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/repo/scratch-workspace.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/repo/scratch-workspace.js')>()),
  ensureTaskScratchWorkspace: async (userId: string, taskId: string) => {
    h.state.ensured.push([userId, taskId]);
    return `/scratch/${userId}/${taskId}`;
  },
}));

import { processTaskJob } from '../src/queues/task-queue.js';
import { resolveMcpSurface } from '../src/sandbox/mcp-surface.js';

registerStepsOnce();

describe('seeded built-in requiresRepository', () => {
  it('lists every workflow_type member in the shared task class table', () => {
    expect(knownTaskTypes().slice().sort()).toEqual(
      schema.workflowTypeEnum.enumValues.slice().sort(),
    );
  });

  it('matches the shared repo-optional rule for every built-in', () => {
    for (const row of builtinTaskTypeRows(stepRegistry)) {
      expect(row.requiresRepository, row.slug).toBe(!taskTypeAllowsNoRepository(row.slug));
    }
  });
});

describe('the type_draft built-in', () => {
  it('is seeded hidden, with its one step, and needs no repository', () => {
    const row = builtinTaskTypeRows(stepRegistry).find((r) => r.slug === 'type_draft');
    expect(row).toMatchObject({
      source: 'builtin',
      runListStrategy: 'static',
      stepIds: ['01-type-draft'],
      selectable: false,
      requiresRepository: false,
    });
    expect(taskTypeAllowsNoRepository('type_draft')).toBe(true);
  });
});

function startJob(): Job {
  return {
    id: 'job-1',
    name: TASK_JOB_NAMES.START,
    data: { taskId: 'task-1', userId: 'user-1' },
    timestamp: Date.now(),
  } as unknown as Job;
}

function task(over: Record<string, unknown>) {
  return {
    id: 'task-1',
    userId: 'user-1',
    type: 'my-custom-type',
    repositoryId: null,
    status: 'created',
    orchestrationEpoch: 0,
    metadata: null,
    cliProviderId: null,
    ignoreSavedStepClis: false,
    executionPath: null,
    currentStepId: null,
    currentRound: 0,
    runListSnapshot: ['x'],
    ...over,
  };
}

describe('resolveTaskContext for a task with no repository', () => {
  beforeEach(() => {
    h.state.ensured = [];
  });

  it('hands a custom task created without a repository a scratch workspace', async () => {
    h.state.task = task({ metadata: { anchorRepositoryId: null } });
    await processTaskJob(startJob()).catch(() => undefined);
    expect(h.state.ensured).toEqual([['user-1', 'task-1']]);
  });

  it('hands a type_draft task created without a repository a scratch workspace', async () => {
    h.state.task = task({ type: 'type_draft', metadata: { anchorRepositoryId: null } });
    await processTaskJob(startJob()).catch(() => undefined);
    expect(h.state.ensured).toEqual([['user-1', 'task-1']]);
  });

  it('refuses a type_draft task with no recorded anchor and no repository', async () => {
    h.state.task = task({ type: 'type_draft', metadata: null });
    await expect(processTaskJob(startJob())).rejects.toThrow(
      /anchored to a repository that no longer exists/,
    );
    expect(h.state.ensured).toEqual([]);
  });

  it('refuses a custom task with no recorded anchor and no repository', async () => {
    h.state.task = task({ metadata: null });
    await expect(processTaskJob(startJob())).rejects.toThrow(
      /anchored to a repository that no longer exists/,
    );
    expect(h.state.ensured).toEqual([]);
  });

  it('still refuses a workflow task created repo-less', async () => {
    h.state.task = task({ type: 'workflow', metadata: { anchorRepositoryId: null } });
    await expect(processTaskJob(startJob())).rejects.toThrow(/no resolvable repo path/);
    expect(h.state.ensured).toEqual([]);
  });
});

describe('the retrieval surface of a task with no repository', () => {
  it('wires no rag server, which is what keeps ragWired false at dispatcher.ts', async () => {
    process.env.CONFIG_ENCRYPTION_KEY = 'test-secret';
    const noRepoDb = {
      query: {
        tasks: { findFirst: async () => ({ envTemplateId: null, repositoryId: null }) },
        taskSteps: { findFirst: async () => undefined },
        repositories: { findFirst: async () => undefined },
      },
    } as unknown as Database;
    try {
      const surface = await resolveMcpSurface(noRepoDb, 'task-1', false);
      expect(surface.rag.enabled).toBe(false);
    } finally {
      delete process.env.CONFIG_ENCRYPTION_KEY;
    }
  });
});
