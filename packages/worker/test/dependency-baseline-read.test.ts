import { beforeEach, expect, it, vi } from 'vitest';
import { gitRun } from '../src/repo/git-exec.js';
import { loadDependencyPolicy } from '../src/step-engine/steps/workflow/_dependency-policy.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

vi.mock('../src/repo/git-exec.js', async (original) => ({
  ...(await original<typeof import('../src/repo/git-exec.js')>()),
  gitRun: vi.fn(),
}));
vi.mock('../src/step-engine/steps/onboarding/_helpers.js', () => ({
  loadPreviousStepOutput: async () => null,
}));
vi.mock('@haive/shared/fs-safe', () => ({
  readTextNoFollow: async () => '{}',
  lstatNoFollow: async () => null,
}));

const base = 'a'.repeat(40);
const ctx = { db: {}, taskId: 'task' } as StepContext;
const ownership = '.haive-data/dependency-ownership.json';
const success = (stdout = '') => ({ code: 0, stdout, stderr: '' });

beforeEach(() => {
  vi.mocked(gitRun).mockImplementation(async (_cwd, args) => {
    if (args[0] === 'rev-parse' && args.at(-1) === 'HEAD') return success(base);
    if (args[0] === 'rev-parse') {
      return args.at(-1)?.endsWith('bootstrap.inc')
        ? { code: 1, stdout: '', stderr: '' }
        : success('b'.repeat(40));
    }
    if (args[0] === 'show') {
      return success(
        args[1] === `${base}:${ownership}`
          ? JSON.stringify({ ownedPaths: ['vendor/company/package'] })
          : JSON.stringify({ require: { 'drupal/core': '^11' } }),
      );
    }
    return { code: 128, stdout: '', stderr: '' };
  });
});

it.each([ownership, 'composer.json'])(
  'fails closed when the baseline %s blob cannot be read',
  async (file) => {
    const normal = vi.mocked(gitRun).getMockImplementation()!;
    vi.mocked(gitRun).mockImplementation(async (...args) =>
      args[1][0] === 'show' && args[1][1] === `${base}:${file}`
        ? { code: 128, stdout: '', stderr: 'arbitrary diagnostic' }
        : normal(...args),
    );
    await expect(loadDependencyPolicy(ctx, '/repo')).rejects.toThrow(/baseline/);
  },
);

it.each([ownership, 'composer.json', 'includes/bootstrap.inc'])(
  'fails closed when the baseline presence probe fails for %s',
  async (file) => {
    const normal = vi.mocked(gitRun).getMockImplementation()!;
    vi.mocked(gitRun).mockImplementation(async (...args) =>
      args[1].at(-1) === `${base}:${file}`
        ? { code: 128, stdout: '', stderr: 'arbitrary diagnostic' }
        : normal(...args),
    );
    await expect(loadDependencyPolicy(ctx, '/repo')).rejects.toThrow(/baseline/);
  },
);

it('retains Drupal protection and owned paths from readable baseline files', async () => {
  expect(await loadDependencyPolicy(ctx, '/repo')).toMatchObject({
    drupal: true,
    ownedPaths: ['vendor/company/package'],
  });
});

it('accepts positively absent optional baseline files', async () => {
  const normal = vi.mocked(gitRun).getMockImplementation()!;
  vi.mocked(gitRun).mockImplementation(async (...args) =>
    args[1][0] === 'show' || args[1][0] === 'cat-file'
      ? { code: 128, stdout: '', stderr: '' }
      : args[1][0] === 'rev-parse' && args[1].at(-1) !== 'HEAD'
        ? { code: 1, stdout: '', stderr: '' }
        : normal(...args),
  );
  expect(await loadDependencyPolicy(ctx, '/repo')).toMatchObject({
    drupal: false,
    ownedPaths: [],
  });
});
