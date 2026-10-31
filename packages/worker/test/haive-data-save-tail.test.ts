import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '@haive/database/testing';
import { schema } from '@haive/database';
import { eq } from 'drizzle-orm';
import { cleanup, h, payload, REPO, USER, setup } from './support/plan-mirror-failure.js';
const calls = vi.hoisted(() => ({ commit: vi.fn() }));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<object>()),
  lstatNoFollow: async () => null,
}));
vi.mock('../src/repo/checkout-head.js', () => ({ checkoutMissing: async () => false }));
vi.mock('../src/project-state/refresh.js', () => ({
  refreshProjectStateOutcome: async () => ({ outcome: 'written' }),
}));
vi.mock('../src/project-state/commit.js', () => ({
  commitHaiveProjections: calls.commit,
  HaiveProjectionRefusal: class extends Error {},
}));
import { saveHaiveData } from '../src/project-state/save.js';
let fake: ReturnType<typeof createFakeDb>;
beforeEach(() => {
  setup();
  fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    planMirrorState: schema.planMirrorState,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: schema.projectStateConflicts,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    storagePath: '/repo',
    status: 'ready',
  });
  fake.insert(schema.planMirrorState, { repositoryId: REPO, revision: 1, writtenRevision: 1 });
  h.db = fake.db;
  calls.commit.mockResolvedValue({
    committed: true,
    commitSha: 'local',
    files: ['.haive-data/state/format.json'],
    skipped: ['unknown'],
  });
});
afterEach(cleanup);
describe('the Haive data Save push seam', () => {
  it('returns a structured refusal when the plan keeps changing during its flush', async () => {
    await fake.db
      .update(schema.planMirrorState)
      .set({ writtenRevision: 0 })
      .where(eq(schema.planMirrorState.repositoryId, REPO));
    expect(await saveHaiveData(payload)).toMatchObject({
      outcome: 'refused',
      committed: false,
      pushed: false,
      refusal: { code: 'projections_changing' },
    });
    expect(calls.commit).not.toHaveBeenCalled();
  });
  it('returns a structured integration hold while preserving the local commit', async () => {
    h.aside.mockResolvedValue({ outcome: 'held', holding: 3 });
    expect(await saveHaiveData(payload)).toMatchObject({
      outcome: 'refused',
      committed: true,
      commitSha: 'local',
      pushed: false,
      refusal: { code: 'integration_held', count: 3 },
      skipped: ['unknown'],
    });
  });
  it('maps an integration refusal to a code without parsing its text', async () => {
    h.aside.mockResolvedValue({ outcome: 'refused', reason: 'any diagnostic in any language' });
    expect(await saveHaiveData(payload)).toMatchObject({
      outcome: 'refused',
      committed: true,
      pushed: false,
      refusal: { code: 'integration_refused' },
    });
  });
  it('does not recommit or push when a landed merge raises a project-state question', async () => {
    h.resync.mockImplementation(async () => {
      fake.insert(schema.projectStateConflicts, {
        id: '00000000-0000-4000-8000-000000000003',
        repositoryId: REPO,
        unit: 'project/render.json#framework',
        resolvedAt: null,
      });
      return true;
    });
    const result = await saveHaiveData(payload);
    expect(result).toMatchObject({
      outcome: 'refused',
      committed: true,
      pushed: false,
      refusal: { code: 'project_state_questions', units: ['project/render.json#framework'] },
    });
    expect(calls.commit).toHaveBeenCalledOnce();
    expect(h.metadata).toHaveBeenCalled();
  });
});
