import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  error: null as Error | null,
  leaf: '',
  hits: 0,
  chowns: [] as string[],
}));
vi.mock('@haive/shared/fs-safe', async (original) => {
  const real = await original<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    chownNoFollow: (...args: Parameters<typeof real.chownNoFollow>) => {
      h.chowns.push(args[1]);
      return real.chownNoFollow(...args);
    },
  };
});
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: (...args: Parameters<typeof real.lstat>) => {
      if (h.error && String(args[0]).endsWith('/' + h.leaf)) {
        h.hits += 1;
        throw h.error;
      }
      return real.lstat(...args);
    },
  };
});
import { captureFixBaseline, relocateFixerChanges } from '../src/step-engine/git-merge.js';
const exec = promisify(execFile);
let template: string;
let root: string;
const git = (cwd: string, args: string[]) =>
  exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_COMMITTER_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.test',
      GIT_COMMITTER_EMAIL: 't@example.test',
    },
  });
beforeAll(async () => {
  template = await mkdtemp(path.join(tmpdir(), 'merge-resource-template-'));
  await git(template, ['init', '-q', '-b', 'main']);
  await writeFile(path.join(template, 'conflict.txt'), 'base');
  await writeFile(path.join(template, 'keep.txt'), 'private baseline');
  await writeFile(path.join(template, 'a-private.txt'), 'private baseline');
  await mkdir(path.join(template, 'private'));
  await writeFile(path.join(template, 'private/keep.txt'), 'private baseline');
  await writeFile(path.join(template, '.gitignore'), '*.cache\n');
  await git(template, ['add', '-A']);
  await git(template, ['commit', '-qm', 'base']);
  await git(template, ['checkout', '-qb', 'feature']);
  await writeFile(path.join(template, 'conflict.txt'), 'feature');
  await git(template, ['commit', '-qam', 'feature']);
  await git(template, ['checkout', '-q', 'main']);
  await writeFile(path.join(template, 'conflict.txt'), 'main');
  await git(template, ['commit', '-qam', 'main']);
  await git(template, ['merge', '--no-edit', 'feature']).catch(() => undefined);
});
afterAll(async () => rm(template, { recursive: true, force: true }));
beforeEach(async () => {
  h.hits = 0;
  h.chowns = [];
  root = await mkdtemp(path.join(tmpdir(), 'merge-resource-'));
  await cp(template, root, { recursive: true });
});
afterEach(async () => {
  h.error = null;
  await rm(root, { recursive: true, force: true });
});

/** On the vulnerable implementation a Retry forgets the moved file's private mode. Let the
 *  permission assertions observe that consequence before checking the original outcome. */
async function relocateWithRetryOnFailure(
  baseline: Awaited<ReturnType<typeof captureFixBaseline>>,
  runId: string,
) {
  let failure: unknown;
  const out = await relocateFixerChanges(
    root,
    baseline,
    { taskId: 'task', runId },
    async () => null,
  ).catch((err: unknown) => {
    failure = err;
    return null;
  });
  if (failure) {
    h.error = null;
    await relocateFixerChanges(
      root,
      baseline,
      { taskId: 'task', runId: `${runId}-retry` },
      async () => null,
    );
  }
  return { out, failure };
}

it('does not take an unread manifest for absence before moving anything', async () => {
  for (const code of ['EMFILE', 'ENFILE']) {
    h.error = null;
    await writeFile(path.join(root, 'keep.txt'), 'private baseline');
    await chmod(path.join(root, 'keep.txt'), 0o644);
    const baseline = await captureFixBaseline(root, async () => null);
    expect(baseline).not.toHaveProperty('unavailable');
    await writeFile(path.join(root, 'keep.txt'), 'private fixer edit');
    await chmod(path.join(root, 'keep.txt'), 0o600);
    const folder = path.join(root, '.haive/merge-leftovers/task', code);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'manifest.json'), 'earlier recovery record');
    h.leaf = 'manifest.json';
    const err = Object.assign(new Error('injected'), { code });
    h.error = err;
    await expect(
      relocateFixerChanges(root, baseline, { taskId: 'task', runId: code }, async () => null),
    ).rejects.toBe(err);
    expect(await readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('private fixer edit');
    expect((await stat(path.join(root, 'keep.txt'))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(folder, 'manifest.json'), 'utf8')).toBe(
      'earlier recovery record',
    );
  }
});

it.each(['EMFILE', 'ENFILE'])(
  'leaves an unread mode in place after an earlier move (%s)',
  async (code) => {
    const baseline = await captureFixBaseline(root, async () => null);
    expect(baseline).not.toHaveProperty('unavailable');
    for (const name of ['a-private.txt', 'keep.txt']) {
      await writeFile(path.join(root, name), 'private fixer edit');
      await chmod(path.join(root, name), 0o600);
    }
    h.leaf = 'keep.txt';
    h.error = Object.assign(new Error('injected'), { code });
    const { out, failure } = await relocateWithRetryOnFailure(baseline, 'mode');
    for (const name of ['a-private.txt', 'keep.txt'])
      expect((await stat(path.join(root, name))).mode & 0o777).toBe(0o600);
    expect(failure).toBeUndefined();
    expect(h.hits).toBeGreaterThan(0);
    expect(out?.moved).toEqual(['a-private.txt']);
    expect(out?.left).toEqual([
      { path: 'keep.txt', reason: expect.stringMatching(/mode.*could not be read.*left in place/) },
    ]);
    expect(await readFile(path.join(root, 'keep.txt'), 'utf8')).toBe('private fixer edit');
    expect(await readFile(path.join(root, 'a-private.txt'), 'utf8')).toBe('private baseline');
  },
);

it.each(['EMFILE', 'ENFILE'])(
  'does not restore over an unread occupied path after a private move (%s)',
  async (code) => {
    const baseline = await captureFixBaseline(root, async () => null);
    expect(baseline).not.toHaveProperty('unavailable');
    await writeFile(path.join(root, 'a-private.txt'), 'private fixer edit');
    await chmod(path.join(root, 'a-private.txt'), 0o600);
    await rm(path.join(root, 'keep.txt'));
    await mkdir(path.join(root, 'keep.txt'));
    await writeFile(path.join(root, 'keep.txt/personal.cache'), 'personal data');
    h.leaf = 'keep.txt';
    h.error = Object.assign(new Error('injected'), { code });
    const { out, failure } = await relocateWithRetryOnFailure(baseline, 'directory');
    expect((await stat(path.join(root, 'a-private.txt'))).mode & 0o777).toBe(0o600);
    expect(failure).toBeUndefined();
    expect(h.hits).toBeGreaterThan(0);
    expect(out?.moved).toEqual(['a-private.txt']);
    expect(out?.left).toEqual([
      { path: 'keep.txt', reason: 'not put back: its path could not be read' },
    ]);
    expect(await readFile(path.join(root, 'keep.txt/personal.cache'), 'utf8')).toBe(
      'personal data',
    );
    expect(await readFile(path.join(root, 'a-private.txt'), 'utf8')).toBe('private baseline');
  },
);

it.each(['EMFILE', 'ENFILE'])(
  'finishes restoring a private file when its parent cannot be read (%s)',
  async (code) => {
    const baseline = await captureFixBaseline(root, async () => null);
    expect(baseline).not.toHaveProperty('unavailable');
    await writeFile(path.join(root, 'private/keep.txt'), 'private fixer edit');
    await chmod(path.join(root, 'private/keep.txt'), 0o600);
    h.leaf = 'private';
    h.error = Object.assign(new Error('injected'), { code });
    const { out, failure } = await relocateWithRetryOnFailure(baseline, 'parent');
    expect((await stat(path.join(root, 'private/keep.txt'))).mode & 0o777).toBe(0o600);
    expect(failure).toBeUndefined();
    expect(h.hits).toBeGreaterThan(0);
    expect(out?.moved).toEqual(['private/keep.txt']);
    expect(out?.left).toEqual([]);
    expect(h.chowns).toContain('private/keep.txt');
    expect(h.chowns).not.toContain('private');
    expect(await readFile(path.join(root, 'private/keep.txt'), 'utf8')).toBe('private baseline');
  },
);
