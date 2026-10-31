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

it.each(['recovery', 'checkout', 'moved', 'unknown'] as const)(
  'reports recovery %s',
  async (site) => {
    const { ProjectStateRecoveryHeldError, ProjectStateCheckoutHeldError, ProjectStateMovedError } =
      await import('./write.js');
    const err =
      site === 'recovery'
        ? new ProjectStateRecoveryHeldError('held')
        : site === 'checkout'
          ? new ProjectStateCheckoutHeldError()
          : site === 'moved'
            ? new ProjectStateMovedError()
            : new Error('failure');
    mocks.recover.mockRejectedValue(err);
    const result = refreshProjectStateOutcome(db(), 'repo');
    if (site === 'unknown') await expect(result).rejects.toBe(err);
    else
      expect(await result).toEqual(
        site === 'moved' ? { outcome: 'superseded' } : { outcome: 'held', reason: site },
      );
    expect(mocks.sync).not.toHaveBeenCalled();
  },
);
it.each(['checkout', 'moved', 'unknown'] as const)('reports write %s', async (site) => {
  const { ProjectStateCheckoutHeldError, ProjectStateMovedError } = await import('./write.js');
  const err =
    site === 'checkout'
      ? new ProjectStateCheckoutHeldError()
      : site === 'moved'
        ? new ProjectStateMovedError()
        : new Error('failure');
  mocks.write.mockRejectedValue(err);
  const result = refreshProjectStateOutcome(db(), 'repo');
  if (site === 'unknown') await expect(result).rejects.toBe(err);
  else
    expect(await result).toEqual(
      site === 'moved' ? { outcome: 'superseded' } : { outcome: 'held', reason: site },
    );
});
it('surfaces the stable writer blockage', async () => {
  mocks.write.mockResolvedValue({
    written: [],
    removed: [],
    blocked: { code: 'unowned_malformed_rtk', file: '.haive-data/state/settings/rtk-enabled.json' },
  });
  expect(await refreshProjectStateOutcome(db(), 'repo')).toEqual({
    outcome: 'blocked',
    code: 'unowned_malformed_rtk',
    file: '.haive-data/state/settings/rtk-enabled.json',
  });
  expect(await refreshProjectState(db(), 'repo')).toBe(false);
});
it.each(['write_pending', 'git_operation'] as const)(
  'carries the sync hold code %s',
  async (code) => {
    mocks.sync.mockResolvedValue({ outcome: 'held', code });
    expect(await refreshProjectStateOutcome(db(), 'repo')).toEqual({
      outcome: 'held',
      reason: 'sync',
      code,
    });
  },
);
it.each([
  undefined,
  { storagePath: null },
  { storagePath: '/fixture', renderContext: null },
  { storagePath: '/fixture', renderContext: { invalid: true } },
])('reports missing path/context %j', async (row) => {
  const rows = row ? [row] : [];
  const query = { from: () => query, where: () => query, limit: async () => rows };
  const fixture = { ...db(), select: () => query } as unknown as Database;
  expect(await refreshProjectStateOutcome(fixture, 'repo')).toEqual(
    row?.renderContext ? { outcome: 'refused', reason: 'context' } : { outcome: 'absent' },
  );
  expect(mocks.write).not.toHaveBeenCalled();
});
