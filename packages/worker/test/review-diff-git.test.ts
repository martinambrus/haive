import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared/logger';
import type { Database } from '@haive/database';
import type { StepContext } from '@haive/shared/step';
import { readReviewDiff } from '../src/step-engine/review-diff.js';

vi.mock('../src/step-engine/steps/onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: vi.fn(async (_db, _task, id) => ({
    output: id === '01-worktree-setup' ? { baseBranch: 'base' } : { filesTouched: ['a.txt'] },
  })),
}));
vi.mock('../src/step-engine/review-dimension-context.js', () => ({
  resolveTaskReviewDimensions: vi.fn(async () => ({ enabled: [{ id: 'security' }] })),
}));
vi.mock('../src/queues/cli-exec/secret-mask.js', async () => {
  const { secretMaskPolicy } = await import('../src/queues/cli-exec/secret-mask-policy.js');
  return { taskSecretMaskPolicy: vi.fn(async () => secretMaskPolicy({})) };
});
let root: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sp3-review-'));
  git('init', '-b', 'base');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  writeFileSync(join(root, 'a.txt'), 'before\n');
  writeFileSync(join(root, 'deleted.txt'), 'removed\n');
  writeFileSync(join(root, 'mode.txt'), 'mode\n');
  writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 1]));
  git('add', '.');
  git('commit', '-m', 'baseline');
  git('checkout', '-b', 'feature');
  writeFileSync(join(root, 'a.txt'), 'committed\n');
  unlinkSync(join(root, 'deleted.txt'));
  chmodSync(join(root, 'mode.txt'), 0o755);
  writeFileSync(join(root, 'binary.dat'), Buffer.from([0, 2]));
  git('add', '.');
  git('commit', '-m', 'implementation');
  writeFileSync(join(root, 'a.txt'), 'dirty\n');
  writeFileSync(join(root, 'new.txt'), 'untracked\n');
  writeFileSync(join(root, 'new.dat'), Buffer.from([0, 3]));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
it('reads committed and dirty changes, untracked text, deletion, mode and binary from real git', async () => {
  const ctx: StepContext = {
    taskId: 'task',
    taskStepId: 'step',
    userId: 'user',
    round: 1,
    repoPath: root,
    workspacePath: root,
    sandboxWorkdir: '/workspace',
    cliProviderId: null,
    db: {} as Database,
    logger: logger.child({ test: 'review-git' }),
    signal: new AbortController().signal,
    throwIfCancelled() {},
    async emitProgress() {},
  };
  const options = { worktreePath: root, maxBytes: 20000, includeFileContents: true };
  const first = await readReviewDiff(ctx, root, options);
  expect(first.status, JSON.stringify(first)).toBe('ready');
  if (first.status !== 'ready') throw Error(JSON.stringify(first));
  const p = JSON.parse(first.content);
  expect(p.diff).toContain('+dirty');
  expect(p.diff).toContain('deleted file mode');
  expect(p.diff).toContain('old mode 100644');
  expect(p.diff).toContain('new mode 100755');
  expect(p.diff).toContain('Binary files');
  expect(p.files).toContainEqual(
    expect.objectContaining({ path: 'new.dat', kind: 'binary', untracked: true }),
  );
  expect(p.untrackedContents).toEqual([{ path: 'new.txt', content: 'untracked\n' }]);
  expect(p.fileContents).toContainEqual({ path: 'a.txt', content: 'dirty\n' });
  expect(p.files).toContainEqual({ path: 'deleted.txt', kind: 'deleted' });
  expect(await readReviewDiff(ctx, root, options)).toEqual(first);
  writeFileSync(join(root, 'new.txt'), 'different\n');
  const changed = await readReviewDiff(ctx, root, options);
  expect(changed.status === 'ready' && changed.diffHash).not.toBe(first.diffHash);
  expect((await readReviewDiff(ctx, root, { ...options, maxBytes: 100 })).status).toBe('too-large');
  git('branch', '-D', 'base');
  expect((await readReviewDiff(ctx, root, options)).status).toBe('unavailable');
  git('branch', 'base', git('rev-parse', 'HEAD~1').trim());
  unlinkSync(join(root, 'new.txt'));
  symlinkSync('/etc/hostname', join(root, 'new.txt'));
  const linked = await readReviewDiff(ctx, root, options);
  expect(linked.status, JSON.stringify(linked)).toBe('ready');
  if (linked.status === 'ready') {
    expect(JSON.parse(linked.content).coverage.partial).toBe(true);
    expect(JSON.parse(linked.content).files).toContainEqual(
      expect.objectContaining({ path: 'new.txt', kind: 'link' }),
    );
  }
});
