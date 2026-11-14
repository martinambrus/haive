import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { StepContext } from '@haive/shared/step';
import { logger } from '@haive/shared/logger';
import { openFileNoFollow } from '@haive/shared/fs-safe';
import { readReviewDiff } from '../src/step-engine/review-diff.js';
import { taskSecretMaskPolicy } from '../src/queues/cli-exec/secret-mask.js';
import { secretMaskPolicy } from '../src/queues/cli-exec/secret-mask-policy.js';
vi.mock('../src/queues/cli-exec/secret-mask.js', () => ({ taskSecretMaskPolicy: vi.fn() }));
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: vi.fn(async () => ({ output: { baseBranch: 'base' } })),
}));
vi.mock('../src/step-engine/steps/workflow/_dependency-policy.js', () => ({
  loadDependencyPolicy: vi.fn(async () => ({})),
}));
vi.mock('../src/step-engine/review-dimension-context.js', () => ({
  resolveTaskReviewDimensions: vi.fn(async () => ({ enabled: [] })),
}));
vi.mock('../src/step-engine/steps/workflow/_impl-changes.js', () => ({
  collectImplementationFiles: vi.fn(async () => ({
    files: paths,
    total: paths.length,
    truncated: false,
    scanError: null,
  })),
}));
vi.mock('@haive/shared/fs-safe', async (original) => {
  const actual = await original<typeof import('@haive/shared/fs-safe')>();
  return { ...actual, openFileNoFollow: vi.fn(actual.openFileNoFollow) };
});
const tracked = ['.auth/user.json', 'storage-state.json'];
const untracked = ['.auth/new.json', 'storage-state-new.json'];
const before = randomBytes(24).toString('hex');
const after = randomBytes(24).toString('hex');
let paths: string[], template: string, root: string, ctx: StepContext;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), 'sp3-secret-template-'));
  mkdirSync(join(template, '.auth'));
  for (const p of tracked) writeFileSync(join(template, p), before);
  git(template, 'init', '-b', 'base');
  git(template, 'config', 'user.name', 'Fixture');
  git(template, 'config', 'user.email', 'fixture@example.test');
  git(template, 'add', '.');
  git(template, 'commit', '-m', 'baseline');
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(taskSecretMaskPolicy).mockResolvedValue(secretMaskPolicy({}));
  root = mkdtempSync(join(tmpdir(), 'sp3-secret-'));
  cpSync(template, root, { recursive: true });
  paths = [...tracked, ...untracked];
  for (const p of paths) writeFileSync(join(root, p), after);
  ctx = {
    taskId: 'task',
    taskStepId: 'step',
    userId: 'user',
    round: 0,
    repoPath: root,
    workspacePath: root,
    sandboxWorkdir: '/workspace',
    cliProviderId: null,
    db: {} as Database,
    logger: logger.child({ test: 'secrets' }),
    signal: new AbortController().signal,
    throwIfCancelled() {},
    async emitProgress() {},
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
afterAll(() => rmSync(template, { recursive: true, force: true }));
it.each([false, true])(
  'withholds tracked and untracked default secret paths (contents %s)',
  async (includeFileContents) => {
    const result = await readReviewDiff(ctx, root, {
      worktreePath: root,
      maxBytes: 20000,
      includeFileContents,
    });
    expect(result.status, JSON.stringify(result)).toBe('ready');
    expect(JSON.stringify(result)).not.toContain(before);
    expect(JSON.stringify(result)).not.toContain(after);
    expect(JSON.stringify(result)).not.toContain(createHash('sha256').update(after).digest('hex'));
    if (result.status !== 'ready') return;
    const payload = JSON.parse(result.content);
    for (const path of paths)
      expect(payload.files).toContainEqual(
        expect.objectContaining({ path, kind: 'withheld', size: after.length, mode: 0o644 }),
      );
    expect(payload.diff).toBe('');
    expect(openFileNoFollow).not.toHaveBeenCalled();
    expect(taskSecretMaskPolicy).toHaveBeenCalledExactlyOnceWith(ctx.db, ctx.taskId);
  },
);
it.each([false, true])(
  'withholds both delete/add endpoints of a secret rename (contents %s)',
  async (includeFileContents) => {
    renameSync(join(root, tracked[0]!), join(root, 'moved.json'));
    paths.push('moved.json');
    const result = await readReviewDiff(ctx, root, {
      worktreePath: root,
      maxBytes: 20000,
      includeFileContents,
    });
    expect(result.status, JSON.stringify(result)).toBe('ready');
    expect(JSON.stringify(result)).not.toContain(before);
    expect(JSON.stringify(result)).not.toContain(after);
    if (result.status === 'ready')
      expect(JSON.parse(result.content).files).toContainEqual(
        expect.objectContaining({ path: 'moved.json', kind: 'withheld' }),
      );
    expect(openFileNoFollow).not.toHaveBeenCalled();
  },
);
it.each(['missing', 'error'])('refuses a %s policy before any file read', async (mode) => {
  if (mode === 'missing') vi.mocked(taskSecretMaskPolicy).mockResolvedValue(null);
  else vi.mocked(taskSecretMaskPolicy).mockRejectedValue(new Error('Policy unavailable'));
  expect((await readReviewDiff(ctx, root, { worktreePath: root, maxBytes: 20000 })).status).toBe(
    'unavailable',
  );
  expect(openFileNoFollow).not.toHaveBeenCalled();
});
