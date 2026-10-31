import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '@haive/database/testing';
import { schema } from '@haive/database';
import { PLAN_MIRROR_JOB_NAMES } from '@haive/shared';
const h = vi.hoisted(() => ({ db: null as unknown, refresh: vi.fn(), commit: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/repo/checkout-head.js', () => ({ checkoutMissing: async () => false }));
vi.mock('../src/repo/git-operation.js', () => ({ gitOperationInProgress: async () => false }));
vi.mock('../src/repo/git-workspace.js', () => ({ requireUsableGit: async () => true }));
vi.mock('../src/project-state/refresh.js', () => ({ refreshProjectStateOutcome: h.refresh }));
import { saveHaiveData } from '../src/project-state/save.js';
const repoId = '00000000-0000-4000-8000-000000000001';
const userId = '00000000-0000-4000-8000-000000000002';
beforeEach(() => {
  vi.resetAllMocks();
});
function fixture(extra = {}) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    projectStateOutbox: schema.projectStateOutbox,
    planMirrorState: schema.planMirrorState,
    projectStateConflicts: schema.projectStateConflicts,
  });
  fake.insert(schema.repositories, {
    id: repoId,
    userId,
    storagePath: '/fixture',
    rootClaimedAt: null,
    ...extra,
  });
  h.db = fake.db;
  return fake;
}
describe('Haive data Save preflight', () => {
  it('has its own queue job name', () => {
    expect(PLAN_MIRROR_JOB_NAMES.SAVE_HAIVE_DATA).toBe('save-haive-data');
  });
  it('refuses a live root claim with a result and starts no flush', async () => {
    fixture({ rootClaimedAt: new Date(), rootClaimKind: 'reset' });
    const result = await saveHaiveData({ repositoryId: repoId, userId, push: false });
    expect(result).toMatchObject({
      outcome: 'refused',
      committed: false,
      pushed: false,
      refusal: { code: 'root_claim' },
    });
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it('reports an interrupted write structurally', async () => {
    const fake = fixture();
    fake.insert(schema.projectStateOutbox, {
      repositoryId: repoId,
      revision: 2,
      writtenRevision: 1,
      writeIntent: {},
    });
    expect(await saveHaiveData({ repositoryId: repoId, userId, push: false })).toMatchObject({
      refusal: { code: 'write_pending' },
      committed: false,
    });
  });
  it('requires repository ownership before reporting holds', async () => {
    fixture({ rootClaimedAt: new Date() });
    await expect(
      saveHaiveData({ repositoryId: repoId, userId: repoId, push: false }),
    ).rejects.toThrow('repository not found');
  });
});
