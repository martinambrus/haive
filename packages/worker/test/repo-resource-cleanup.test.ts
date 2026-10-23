import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Job } from 'bullmq';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { TASK_JOB_NAMES, type RepoResourceCleanupPayload } from '@haive/shared';

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  removed: [] as string[],
  killRepoIde: vi.fn(),
  del: vi.fn(),
}));

vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  process.env.REPO_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-cleanup-'));
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/sandbox/ide-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/ide-runner.js')>()),
  killRepoIdeRunner: h.killRepoIde,
}));
vi.mock('../src/redis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/redis.js')>()),
  getRedis: () => ({ del: h.del }),
}));

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

afterAll(() => {
  rmSync(process.env.REPO_STORAGE_ROOT!, { recursive: true, force: true });
});

beforeEach(() => {
  h.removed.length = 0;
  h.killRepoIde.mockReset().mockResolvedValue(undefined);
  h.del.mockReset().mockResolvedValue(1);
});

describe('repository resource cleanup', () => {
  it('removes the repository editor and its session even when the repo had no tasks', async () => {
    h.db = createFakeDb({ tasks: schema.tasks, envTemplates: schema.envTemplates }).db;
    await cleanup({ taskIds: [], envTemplateIds: [] });
    expect(h.killRepoIde).toHaveBeenCalledWith('00000000-0000-4000-8000-0000000000b1');
    expect(h.del).toHaveBeenCalledWith('ide:session:repo-00000000-0000-4000-8000-0000000000b1');
  });

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

  describe('its repo_cleanups row', () => {
    const ROW = '00000000-0000-4000-8000-0000000000e1';
    const OTHER = '00000000-0000-4000-8000-0000000000e2';

    function withRows() {
      const fake = createFakeDb({
        tasks: schema.tasks,
        envTemplates: schema.envTemplates,
        repoCleanups: schema.repoCleanups,
      });
      for (const id of [ROW, OTHER]) {
        fake.insert(schema.repoCleanups, {
          id,
          userId: '00000000-0000-4000-8000-0000000000a1',
          repositoryId: '00000000-0000-4000-8000-0000000000b1',
          kind: 'resources',
          payload: {},
        });
      }
      h.db = fake.db;
      return fake;
    }

    it('is deleted once the cleanup has run, and only that row', async () => {
      const fake = withRows();
      await cleanup({ taskIds: [], envTemplateIds: [], cleanupId: ROW });
      expect(fake.rows(schema.repoCleanups).map((r) => r.id)).toEqual([OTHER]);
    });

    it('is kept when the cleanup throws', async () => {
      const fake = withRows();
      h.killRepoIde.mockRejectedValue(new Error('x'));
      h.del.mockImplementation(() => {
        throw new Error('redis gone');
      });
      await expect(cleanup({ taskIds: [], envTemplateIds: [], cleanupId: ROW })).rejects.toThrow();
      expect(fake.rows(schema.repoCleanups)).toHaveLength(2);
    });

    it('is not needed by a payload queued before the table existed', async () => {
      const fake = withRows();
      await cleanup({ taskIds: [], envTemplateIds: [] });
      expect(fake.rows(schema.repoCleanups)).toHaveLength(2);
    });
  });

  describe('its finished upload archive', () => {
    const USER = '00000000-0000-4000-8000-0000000000a1';
    const REPO = '00000000-0000-4000-8000-0000000000b1';
    const OTHER = '00000000-0000-4000-8000-0000000000b2';
    const dir = () => path.join(process.env.REPO_STORAGE_ROOT!, '_uploads', USER);
    const put = (name: string) => {
      mkdirSync(dir(), { recursive: true });
      const file = path.join(dir(), name);
      writeFileSync(file, 'bytes');
      return file;
    };

    beforeEach(() => {
      rmSync(dir(), { recursive: true, force: true });
      h.db = createFakeDb({ tasks: schema.tasks, envTemplates: schema.envTemplates }).db;
    });

    it.each(['zip', 'tar', 'tar.gz'])('is removed for .%s', async (ext) => {
      const file = put(`${REPO}.${ext}`);
      await cleanup({ taskIds: [], envTemplateIds: [] });
      expect(existsSync(file)).toBe(false);
    });

    it('leaves every other name in the directory', async () => {
      const kept = [
        put(`${OTHER}.zip`),
        put('db-00000000-0000-4000-8000-0000000000f1.sql'),
        put(`${REPO}.zip.partial`),
        put('notification-sound.mp3'),
      ];
      put(`${REPO}.zip`);
      await cleanup({ taskIds: [], envTemplateIds: [] });
      for (const file of kept) expect(existsSync(file)).toBe(true);
    });

    it('is fine when no archive is there', async () => {
      await expect(cleanup({ taskIds: [], envTemplateIds: [] })).resolves.toBeUndefined();
    });

    it('does not fail the job or keep its row when a removal fails', async () => {
      const fake = createFakeDb({
        tasks: schema.tasks,
        envTemplates: schema.envTemplates,
        repoCleanups: schema.repoCleanups,
      });
      const ROW = '00000000-0000-4000-8000-0000000000e9';
      fake.insert(schema.repoCleanups, {
        id: ROW,
        userId: USER,
        repositoryId: REPO,
        kind: 'resources',
        payload: {},
      });
      h.db = fake.db;
      const stuck = path.join(dir(), `${REPO}.zip`);
      mkdirSync(stuck, { recursive: true });
      writeFileSync(path.join(stuck, 'x'), 'x');
      await cleanup({ taskIds: [], envTemplateIds: [], cleanupId: ROW });
      expect(fake.rows(schema.repoCleanups)).toHaveLength(0);
    });
  });
});
