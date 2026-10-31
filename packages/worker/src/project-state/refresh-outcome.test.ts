import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { refreshProjectState, refreshProjectStateOutcome } from './refresh.js';

const mocks = vi.hoisted(() => ({
  missing: vi.fn(),
  operation: vi.fn(),
  recover: vi.fn(),
  sync: vi.fn(),
  write: vi.fn(),
}));
vi.mock('../repo/checkout-head.js', () => ({ checkoutMissing: mocks.missing }));
vi.mock('../repo/git-operation.js', () => ({ gitOperationInProgress: mocks.operation }));
vi.mock('./sync.js', () => ({ syncProjectStateFromCheckout: mocks.sync }));
vi.mock('./write.js', async (original) => ({
  ...(await original<object>()),
  recoverProjectStateWrite: mocks.recover,
  writeProjectStateColumn: mocks.write,
}));
const context = {
  projectInfo: {},
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
  rtkChoiceRecorded: false,
  cliTargets: [],
};
const db = () => {
  const rows = [
    { storagePath: '/fixture', localPath: null, renderContext: context, onboardingResetAt: null },
  ];
  const query = { from: () => query, where: () => query, limit: async () => rows };
  return {
    select: () => query,
    update: () => ({ set: () => ({ where: async () => [] }) }),
  } as unknown as Database;
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.missing.mockResolvedValue(false);
  mocks.operation.mockResolvedValue(false);
  mocks.sync.mockResolvedValue({ outcome: 'synced' });
});
describe('refreshProjectStateOutcome', () => {
  it('distinguishes a missing checkout from a Git operation, without starting recovery', async () => {
    mocks.missing.mockResolvedValue(true);
    expect(await refreshProjectStateOutcome(db(), 'repo')).toEqual({ outcome: 'missing' });
    mocks.missing.mockResolvedValue(false);
    mocks.operation.mockResolvedValue(true);
    expect(await refreshProjectStateOutcome(db(), 'repo')).toEqual({
      outcome: 'held',
      reason: 'git_operation',
    });
    expect(mocks.recover).not.toHaveBeenCalled();
  });
  it.each(['held', 'refused', 'deferred', 'superseded'] as const)(
    'reports sync %s without writing',
    async (outcome) => {
      mocks.sync.mockResolvedValue({ outcome, reason: 'diagnostic only' });
      const result = await refreshProjectStateOutcome(db(), 'repo');
      expect(result).toEqual(
        outcome === 'held'
          ? { outcome: 'held', reason: 'sync' }
          : outcome === 'deferred'
            ? { outcome: 'held', reason: 'checkout' }
            : outcome === 'refused'
              ? { outcome: 'refused', reason: 'record' }
              : { outcome: 'superseded' },
      );
      expect(mocks.write).not.toHaveBeenCalled();
      expect(await refreshProjectState(db(), 'repo')).toBe(false);
    },
  );
  it('keeps the boolean caller contract and reports a completed write', async () => {
    expect(await refreshProjectStateOutcome(db(), 'repo')).toEqual({ outcome: 'written' });
    expect(await refreshProjectState(db(), 'repo')).toBe(true);
    expect(mocks.write).toHaveBeenCalledTimes(2);
  });
});
