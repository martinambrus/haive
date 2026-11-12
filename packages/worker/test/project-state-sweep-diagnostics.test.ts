import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { projectStateSweepDiagnostic } from './support/project-state-sweep-diagnostics.js';

const mocks = vi.hoisted(() => ({ claim: vi.fn(), holders: vi.fn(), marker: vi.fn() }));
vi.mock('@haive/database', async (original) => ({
  ...(await original<object>()),
  readLiveRootClaim: mocks.claim,
}));
vi.mock('../src/repo/refresh.js', () => ({ checkoutHoldingTasks: mocks.holders }));
vi.mock('../src/repo/git-operation.js', async (original) => {
  const real = await original<typeof import('../src/repo/git-operation.js')>();
  mocks.marker.mockImplementation(real.gitOperationMarker);
  return { ...real, gitOperationMarker: (path: string) => mocks.marker(path) };
});

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
const rows = () => [
  {
    revision: 22,
    written_revision: 21,
    last_error: null,
    synced_hash: 'accepted-checkout-hash',
    repo_path: repo,
  },
];
const fixture = (outbox = rows()) => {
  const tasks = [{ id: 'holder', type: 'onboarding', status: 'running', worktreePath: null }];
  const query = { from: () => query, where: () => query, limit: async () => tasks };
  return { execute: vi.fn().mockResolvedValue(outbox), select: () => query } as unknown as Database;
};
beforeEach(async () => {
  vi.clearAllMocks();
  const real = await vi.importActual<typeof import('../src/repo/git-operation.js')>(
    '../src/repo/git-operation.js',
  );
  mocks.marker.mockImplementation(real.gitOperationMarker);
  repo = await mkdtemp(join(tmpdir(), 'sweep-diagnostic-'));
  git('init', '-q', '-b', 'main');
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '--allow-empty',
    '-qm',
    'seed',
  );
  mocks.claim.mockResolvedValue({ kind: 'reset', claimedAt: new Date('2026-11-11T00:00:00Z') });
  mocks.holders.mockResolvedValue(1);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

it.each([
  'MERGE_HEAD',
  'REBASE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'rebase-merge',
  'rebase-apply',
])(
  'reports the forced %s hold with outbox, lease, checkout holder and porcelain v2 branch status',
  async (marker) => {
    const entry = join(repo, '.git', marker);
    if (marker.startsWith('rebase-')) await mkdir(entry);
    else await writeFile(entry, git('rev-parse', 'HEAD'));
    const refresh = { outcome: 'held', reason: 'git_operation' } as const;
    const snapshot = await projectStateSweepDiagnostic(fixture(), 'repo', refresh);
    expect(snapshot).toMatchObject({
      repositoryId: 'repo',
      refresh,
      outbox: {
        revision: 22,
        written_revision: 21,
        last_error: null,
        synced_hash: 'accepted-checkout-hash',
      },
      rootClaim: { kind: 'reset' },
      rootCheckoutHolders: 1,
      checkoutHolders: [{ id: 'holder', type: 'onboarding', status: 'running' }],
      gitOperationMarker: marker,
      gitStatus: { code: 0, stdout: expect.stringContaining('# branch.head main') },
    });
    await rm(entry, { recursive: true });
    expect(
      (await projectStateSweepDiagnostic(fixture(), 'repo', refresh))?.gitOperationMarker,
    ).toBeNull();
  },
);
it('does not probe a clean/absent outbox and does not call a writer', async () => {
  expect(await projectStateSweepDiagnostic(fixture([]), 'repo', { outcome: 'written' })).toBeNull();
  expect(mocks.claim).not.toHaveBeenCalled();
  expect(mocks.holders).not.toHaveBeenCalled();
});
it('keeps the other probes when a lease cannot be read, and preserves the sync reason', async () => {
  mocks.claim.mockRejectedValue(new Error('lease unavailable'));
  const refresh = {
    outcome: 'held',
    reason: 'sync',
    code: 'write_pending',
    detail: 'an interrupted project state write awaits recovery',
  } as const;
  const snapshot = await projectStateSweepDiagnostic(fixture(), 'repo', refresh);
  expect(snapshot).toMatchObject({
    refresh,
    rootClaim: { error: 'lease unavailable' },
    rootCheckoutHolders: 1,
    gitStatus: { code: 0 },
  });
});
it('reports a database error without its bound values', async () => {
  mocks.claim.mockRejectedValue(
    Object.assign(new Error('insert failed for secret-value'), { parameters: ['secret-value'] }),
  );
  const snapshot = await projectStateSweepDiagnostic(fixture(), 'repo', { outcome: 'written' });
  expect(snapshot?.rootClaim).toEqual({ error: 'Database operation failed' });
  expect(JSON.stringify(snapshot)).not.toContain('secret-value');
});
it('bounds a stalled git operation probe and keeps the others', async () => {
  mocks.marker.mockReturnValue(new Promise(() => {}));
  const snapshot = await projectStateSweepDiagnostic(fixture(), 'repo', { outcome: 'written' }, 50);
  expect(snapshot).toMatchObject({
    gitOperationMarker: { error: 'probe timed out after 50 ms' },
    rootCheckoutHolders: 1,
    gitStatus: { code: 0 },
  });
});
