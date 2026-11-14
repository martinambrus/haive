import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StepContext } from '@haive/shared/step';
import { loadDependencyPolicy } from '../src/step-engine/steps/workflow/_dependency-policy.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
vi.mock('../src/repo/git-exec.js', () => ({
  gitRun: vi.fn(async (_cwd, args: string[]) => ({
    code: args.includes('HEAD') ? 0 : 1,
    stdout: args.includes('HEAD') ? 'a'.repeat(40) : '',
    stderr: '',
  })),
  gitGaveNoAnswer: () => false,
}));
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: vi.fn(async () => null),
}));

const ctx = { db: {}, taskId: 'task' } as StepContext;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'review-policy-'));
});
afterEach(async () => {
  vi.mocked(open).mockReset();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(open).mockImplementation(actual.open);
  await rm(root, { recursive: true, force: true });
});

it('treats a symlinked composer.json as absent during host review', async () => {
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ require: { 'drupal/core': '*' } }));
  await symlink('manifest.json', join(root, 'composer.json'));
  await expect(
    loadDependencyPolicy(ctx, root, { propagateResourceErrors: true }),
  ).resolves.toMatchObject({
    drupal: false,
    drupal7Roots: [],
    ownedPaths: [],
  });
});

it.each(['symlink', 'file'])(
  'treats a %s Drupal marker parent as absent during host review',
  async (kind) => {
    if (kind === 'symlink') {
      await mkdir(join(root, 'site/includes'), { recursive: true });
      await writeFile(join(root, 'site/includes/bootstrap.inc'), 'Drupal marker\n');
      await symlink('site', join(root, 'web'));
    } else {
      await writeFile(join(root, 'web'), 'not a directory\n');
    }
    await expect(
      loadDependencyPolicy(ctx, root, { propagateResourceErrors: true }),
    ).resolves.toMatchObject({
      drupal: false,
      drupal7Roots: [],
    });
  },
);

it.each(['EMFILE', 'ENFILE'])(
  'propagates %s from both filesystem probes only for host review',
  async (code) => {
    await writeFile(join(root, 'composer.json'), '{}');
    await mkdir(join(root, 'web/includes'), { recursive: true });
    await writeFile(join(root, 'web/includes/bootstrap.inc'), 'Drupal marker\n');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    for (const suffix of ['/composer.json', '/web']) {
      const error = Object.assign(new Error(code), { code });
      vi.mocked(open).mockImplementation((file, flags, mode) =>
        String(file).endsWith(suffix) ? Promise.reject(error) : actual.open(file, flags, mode),
      );
      await expect(loadDependencyPolicy(ctx, root, { propagateResourceErrors: true })).rejects.toBe(
        error,
      );
      await expect(loadDependencyPolicy(ctx, root)).resolves.toBeDefined();
    }
  },
);
