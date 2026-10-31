import { expect, it, vi } from 'vitest';
import { PLAN_MIRROR_JOB_NAMES } from '@haive/shared';
const h = vi.hoisted(() => ({
  processor: undefined as unknown as (job: unknown) => Promise<unknown>,
  save: vi.fn(),
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Worker: class {
    constructor(_name: string, processor: typeof h.processor) {
      h.processor = processor;
    }
    on() {}
  },
}));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('../src/project-state/save.js', () => ({ saveHaiveData: h.save }));
import { startPlanMirrorWorker } from '../src/queues/plan-mirror-queue.js';
it('routes save-haive-data through the registered plan-mirror processor', async () => {
  const payload = { repositoryId: 'repo', userId: 'user', push: false };
  const result = {
    outcome: 'unchanged',
    committed: false,
    commitSha: null,
    files: [],
    skipped: [],
    pushed: false,
    branch: null,
    refusal: null,
    indexSynced: true,
  };
  h.save.mockResolvedValue(result);
  startPlanMirrorWorker();
  expect(await h.processor({ name: PLAN_MIRROR_JOB_NAMES.SAVE_HAIVE_DATA, data: payload })).toBe(
    result,
  );
  expect(h.save).toHaveBeenCalledExactlyOnceWith(payload);
});
