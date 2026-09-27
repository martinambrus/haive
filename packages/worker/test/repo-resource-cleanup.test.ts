import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { TASK_JOB_NAMES, type RepoResourceCleanupPayload } from '@haive/shared';

const h = vi.hoisted(() => ({ db: undefined as unknown, removed: [] as string[] }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/sandbox/docker-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/docker-runner.js')>()),
  defaultDockerRunner: {
    remove: async (ref: string) => {
      h.removed.push(ref);
      return { ok: true, stderr: '' };
    },
  },
}));
vi.mock('../src/sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/ddev-runner.js')>()),
  killTaskDdevRunners: async () => 0,
}));
vi.mock('../src/sandbox/app-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/app-runner.js')>()),
  killTaskAppRunners: async () => 0,
}));

import { processTaskJob } from '../src/queues/task-queue.js';

const TEMPLATE = '00000000-0000-4000-8000-0000000000c1';

function cleanup(payload: Partial<RepoResourceCleanupPayload>) {
  const data: RepoResourceCleanupPayload = {
    userId: '00000000-0000-4000-8000-0000000000a1',
    repositoryId: '00000000-0000-4000-8000-0000000000b1',
    taskIds: ['00000000-0000-4000-8000-0000000000d1'],
    envTemplateIds: [TEMPLATE],
    storagePath: null,
    ...payload,
  };
  return processTaskJob({ name: TASK_JOB_NAMES.CLEANUP_REPO_RESOURCES, data } as unknown as Job);
}

beforeEach(() => {
  h.removed.length = 0;
});

describe('repository resource cleanup', () => {
  it('removes the image of a template whose row went with its user', async () => {
    h.db = createFakeDb({ tasks: schema.tasks, envTemplates: schema.envTemplates }).db;
    await cleanup({ envImageTags: { [TEMPLATE]: 'haive-env:abc' } });
    expect(h.removed).toEqual(['haive-env:abc']);
  });

  it("reads the tag from the template's row while the row stands", async () => {
    const fake = createFakeDb({ tasks: schema.tasks, envTemplates: schema.envTemplates });
    fake.insert(schema.envTemplates, { id: TEMPLATE, imageTag: 'haive-env:current' });
    h.db = fake.db;
    await cleanup({ envImageTags: { [TEMPLATE]: 'haive-env:abc' } });
    expect(h.removed).toEqual(['haive-env:current']);
    expect(fake.rows(schema.envTemplates)).toHaveLength(0);
  });
});
