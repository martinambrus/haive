import { beforeEach, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import type { ProjectStateRefreshOutcome } from '../src/project-state/refresh.js';
import { restoreProjectData } from '../src/repo/clone.js';

const mocks = vi.hoisted(() => ({ state: vi.fn(), plan: vi.fn(), remove: vi.fn() }));
vi.mock('../src/project-state/refresh.js', () => ({ refreshProjectStateOutcome: mocks.state }));
vi.mock('../src/plan/mirror.js', async (original) => ({
  ...(await original<object>()),
  writePlanMirror: mocks.plan,
}));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<object>()),
  removeNoFollow: mocks.remove,
}));

const db = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () =>
          table === schema.repositories ? [{ renderContext: {} }] : [{ id: 'root' }],
      }),
    }),
  }),
} as unknown as Database;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.state.mockResolvedValue({ outcome: 'written' });
});

it.each([1, 2])('retries %s superseded private restores before writing the plan', async (count) => {
  for (let i = 0; i < count; i++) mocks.state.mockResolvedValueOnce({ outcome: 'superseded' });
  await restoreProjectData(db, 'repo', '/private-replacement');
  expect(mocks.state).toHaveBeenCalledTimes(count + 1);
  expect(mocks.plan).toHaveBeenCalledOnce();
  expect(mocks.state.mock.invocationCallOrder.at(-1)).toBeLessThan(
    mocks.plan.mock.invocationCallOrder[0]!,
  );
});

it('stops after three superseded restore attempts', async () => {
  mocks.state.mockResolvedValue({ outcome: 'superseded' });
  await expect(restoreProjectData(db, 'repo', '/private-replacement')).rejects.toThrow(
    'superseded',
  );
  expect(mocks.state).toHaveBeenCalledTimes(3);
  expect(mocks.plan).not.toHaveBeenCalled();
});

it('does not retry a plan writer failure', async () => {
  mocks.plan.mockRejectedValue(new Error('plan writer held'));
  await expect(restoreProjectData(db, 'repo', '/private-replacement')).rejects.toThrow(
    'plan writer held',
  );
  expect(mocks.state).toHaveBeenCalledOnce();
  expect(mocks.plan).toHaveBeenCalledOnce();
});

it.each<ProjectStateRefreshOutcome>([
  { outcome: 'held', reason: 'git_operation' },
  { outcome: 'refused', reason: 'record' },
  { outcome: 'missing' },
  { outcome: 'blocked', code: 'unowned_malformed_rtk', file: 'settings/rtk-enabled.json' },
])('fails immediately for a stable restore outcome: $outcome', async (state) => {
  mocks.state.mockResolvedValue(state);
  await expect(restoreProjectData(db, 'repo', '/private-replacement')).rejects.toThrow(
    state.outcome,
  );
  expect(mocks.state).toHaveBeenCalledOnce();
  expect(mocks.plan).not.toHaveBeenCalled();
});
