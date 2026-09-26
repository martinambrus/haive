import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  abortMerge,
  abortOtherMerge,
  buildMergeFixPrompt,
  captureFixBaseline,
  completeMergeHostSide,
  fixerLeftoversWarning,
  mergeCommitted,
  openMerge,
  relocateFixerChanges,
  squashMergeCommit,
  unmergedPaths,
} from './git-merge.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
// Strict (no undefined values) so it satisfies completeMergeHostSide's signature.
const COMMIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}
async function gitCode(dir: string, args: string[]): Promise<number> {
  try {
    await exec('git', args, { cwd: dir, env: GIT_ENV });
    return 0;
  } catch (e) {
    return (e as { code?: number }).code ?? 1;
  }
}

/** A repo on `main` whose `feature/x` diverges `base.txt` so a merge conflicts. */
async function setupConflict(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gm-'));
  await git(dir, ['init', '-b', 'main']);
  await writeFile(path.join(dir, 'base.txt'), 'base\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'init']);
  await git(dir, ['checkout', '-b', 'feature/x']);
  await writeFile(path.join(dir, 'base.txt'), 'feature\n', 'utf8');
  await git(dir, ['commit', '-am', 'feature edit']);
  await git(dir, ['checkout', 'main']);
  await writeFile(path.join(dir, 'base.txt'), 'main\n', 'utf8');
  await git(dir, ['commit', '-am', 'main edit']);
  return dir;
}

describe('buildMergeFixPrompt', () => {
  it('includes the branch + title and the marker instructions', () => {
    const p = buildMergeFixPrompt('feature/x', 'My feature');
    expect(p).toContain('Conflicting branch: feature/x (My feature).');
    expect(p).toContain('<<<<<<< / ======= / >>>>>>>');
    expect(p).toContain('Do NOT run git');
  });
  it('omits the parenthetical when no title', () => {
    expect(buildMergeFixPrompt('feature/x')).toContain('Conflicting branch: feature/x.');
  });
  it('appends user guidance when provided', () => {
    expect(buildMergeFixPrompt('b', undefined, 'prefer mine')).toContain(
      'User guidance for resolving this conflict: prefer mine',
    );
  });
});

describe('mergeCommitted / completeMergeHostSide (real git)', () => {
  it('commits a resolved mid-merge host-side', async () => {
    const dir = await setupConflict();
    try {
      // Start the conflicting merge: non-zero exit, MERGE_HEAD live, markers in file.
      expect(await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x'])).not.toBe(0);
      expect(await mergeCommitted(dir, 'feature/x')).toBe(false);
      // Simulate the fix agent: write resolved content (no markers).
      await writeFile(path.join(dir, 'base.txt'), 'resolved\n', 'utf8');
      expect(await completeMergeHostSide(dir, COMMIT_ENV, 'feature/x')).toBe(true);
      expect(await mergeCommitted(dir, 'feature/x')).toBe(true);
      expect(await readFile(path.join(dir, 'base.txt'), 'utf8')).toBe('resolved\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to commit while conflict markers remain', async () => {
    const dir = await setupConflict();
    try {
      await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
      // Leave the markers in place → completion must refuse.
      expect(await completeMergeHostSide(dir, COMMIT_ENV, 'feature/x')).toBe(false);
      expect(await mergeCommitted(dir, 'feature/x')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an aborted merge does not read as committed', async () => {
    const dir = await setupConflict();
    try {
      await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
      await gitCode(dir, ['merge', '--abort']);
      // No MERGE_HEAD and nothing unmerged — indistinguishable from a real commit
      // without the ancestry check, since `feature/x` was never merged into HEAD.
      expect(await mergeCommitted(dir, 'feature/x')).toBe(false);
      expect(await completeMergeHostSide(dir, COMMIT_ENV, 'feature/x')).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A conflict on `name` beside `clean.txt`, which only `feature/x` changes, so the merge stages it. */
async function setupNamedConflict(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gm-named-'));
  await git(dir, ['init', '-b', 'main']);
  await writeFile(path.join(dir, name), 'base\n', 'utf8');
  await writeFile(path.join(dir, 'clean.txt'), 'one\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'init']);
  await git(dir, ['checkout', '-b', 'feature/x']);
  await writeFile(path.join(dir, name), 'feature\n', 'utf8');
  await writeFile(path.join(dir, 'clean.txt'), 'two\n', 'utf8');
  await git(dir, ['commit', '-am', 'feature edit']);
  await git(dir, ['checkout', 'main']);
  await writeFile(path.join(dir, name), 'main\n', 'utf8');
  await git(dir, ['commit', '-am', 'main edit']);
  return dir;
}

const mergeHead = (dir: string) => gitCode(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);

/** setupNamedConflict('base.txt') plus two files only `main` has, one of them left edited by the
 *  person, and an untracked file of theirs; the merge is left open on the conflict. */
async function setupMergeWithOwnWork(): Promise<string> {
  const dir = await setupNamedConflict('base.txt');
  await writeFile(path.join(dir, 'untouched.txt'), 'untouched\n', 'utf8');
  await writeFile(path.join(dir, 'dirt.txt'), 'dirt\n', 'utf8');
  await mkdir(path.join(dir, 'lib', 'deep'), { recursive: true });
  await writeFile(path.join(dir, 'lib', 'deep', 'keep.txt'), 'keep\n', 'utf8');
  await mkdir(path.join(dir, 'lib', 'other'), { recursive: true });
  await writeFile(path.join(dir, 'lib', 'other', 'gone.txt'), 'gone\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'main only']);
  await writeFile(path.join(dir, 'dirt.txt'), 'person dirt\n', 'utf8');
  await writeFile(path.join(dir, 'mine.txt'), 'mine\n', 'utf8');
  await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
  return dir;
}

/** A merge left open on `.gitignore`, which ignores `cache/`, with a file in it and an untracked
 *  log nothing ignores. */
async function setupIgnoreConflict(): Promise<{ dir: string; kept: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gm-ignore-'));
  await git(dir, ['init', '-b', 'main']);
  await writeFile(path.join(dir, '.gitignore'), 'cache/\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'init']);
  await git(dir, ['checkout', '-b', 'feature/x']);
  await writeFile(path.join(dir, '.gitignore'), 'cache/\ntheirs/\n', 'utf8');
  await git(dir, ['commit', '-am', 'feature rule']);
  await git(dir, ['checkout', 'main']);
  await writeFile(path.join(dir, '.gitignore'), 'cache/\nours/\n', 'utf8');
  await git(dir, ['commit', '-am', 'main rule']);
  await mkdir(path.join(dir, 'cache'));
  const kept = `kept ${randomUUID()}\n`;
  await writeFile(path.join(dir, 'cache', 'keep'), kept, 'utf8');
  await writeFile(path.join(dir, 'app.log'), 'line1\n', 'utf8');
  await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
  return { dir, kept };
}

describe('fixer leftovers (real git)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('commits only the paths the merge left unmerged', async () => {
    const dir = await setupMergeWithOwnWork();
    try {
      await writeFile(path.join(dir, 'base.txt'), 'resolved\n', 'utf8');
      await writeFile(path.join(dir, 'stray.txt'), 'fixer scratch\n', 'utf8');
      expect(await completeMergeHostSide(dir, COMMIT_ENV, 'feature/x')).toBe(true);
      expect(await git(dir, ['show', 'HEAD:base.txt'])).toBe('resolved\n');
      expect(await git(dir, ['show', 'HEAD:clean.txt'])).toBe('two\n');
      expect(await git(dir, ['show', 'HEAD:dirt.txt'])).toBe('dirt\n');
      expect(await gitCode(dir, ['cat-file', '-e', 'HEAD:stray.txt'])).not.toBe(0);
      expect(await gitCode(dir, ['cat-file', '-e', 'HEAD:mine.txt'])).not.toBe(0);
      expect(await readFile(path.join(dir, 'dirt.txt'), 'utf8')).toBe('person dirt\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("moves a fixer's changes out and puts the tree back as it was sent in", async () => {
    const dir = await setupMergeWithOwnWork();
    try {
      const baseline = await captureFixBaseline(dir);
      expect(baseline).toMatchObject({ unmerged: ['base.txt'] });
      await writeFile(path.join(dir, 'base.txt'), 'resolved\n', 'utf8');
      await writeFile(path.join(dir, 'clean.txt'), 'fixer on staged\n', 'utf8');
      await writeFile(path.join(dir, 'untouched.txt'), 'fixer on untouched\n', 'utf8');
      await rm(path.join(dir, 'dirt.txt'));
      await writeFile(path.join(dir, 'stray.txt'), 'fixer scratch\n', 'utf8');
      await mkdir(path.join(dir, 'deep'));
      await writeFile(path.join(dir, 'deep', 'stray2.txt'), 'deeper\n', 'utf8');
      await mkdir(path.join(dir, '.haive-data'));
      await writeFile(path.join(dir, '.haive-data', 'note.md'), 'haive own\n', 'utf8');
      await symlink('base.txt', path.join(dir, 'link-stray'));

      const out = await relocateFixerChanges(dir, baseline, { taskId: 't1', runId: 'inv1' });
      const folder = '.haive/merge-leftovers/t1/inv1';
      expect(out?.folder).toBe(folder);
      expect(out?.moved.sort()).toEqual([
        'clean.txt',
        'deep/stray2.txt',
        'stray.txt',
        'untouched.txt',
      ]);
      expect(out?.left).toEqual([
        expect.objectContaining({ path: 'link-stray', target: 'base.txt' }),
      ]);
      expect(out?.unstaged).toEqual([]);
      const read = (rel: string) => readFile(path.join(dir, rel), 'utf8');
      expect(await read('base.txt')).toBe('resolved\n');
      expect(await read('clean.txt')).toBe('two\n');
      expect(await read('untouched.txt')).toBe('untouched\n');
      expect(await read('dirt.txt')).toBe('person dirt\n');
      expect(await read('mine.txt')).toBe('mine\n');
      expect(await read('.haive-data/note.md')).toBe('haive own\n');
      await expect(read('stray.txt')).rejects.toThrow();
      expect(await read(`${folder}/files/clean.txt`)).toBe('fixer on staged\n');
      expect(await read(`${folder}/files/deep/stray2.txt`)).toBe('deeper\n');
      const manifest = JSON.parse(await read(`${folder}/manifest.json`)) as { moved: string[] };
      expect(manifest.moved.sort()).toEqual(out?.moved.sort());
      // The index was refreshed after the restore, so git lets the merge go.
      expect(await abortMerge(dir)).toEqual({ ok: true });
      expect(await read('dirt.txt')).toBe('person dirt\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('puts a file back over the directory a fixer made in its place', async () => {
    const dir = await setupMergeWithOwnWork();
    try {
      const baseline = await captureFixBaseline(dir);
      await rm(path.join(dir, 'untouched.txt'));
      await mkdir(path.join(dir, 'untouched.txt'));
      await writeFile(path.join(dir, 'untouched.txt', 'cache'), 'cached\n', 'utf8');
      const out = await relocateFixerChanges(dir, baseline, { taskId: 't1', runId: 'inv1' });
      expect(out?.moved).toEqual(['untouched.txt/cache']);
      expect(await readFile(path.join(dir, 'untouched.txt'), 'utf8')).toBe('untouched\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // git replaces a directory standing where it puts a file back, and takes what is in it along.
  it('keeps a directory standing where a file was while it holds what could not be moved', async () => {
    const dir = await setupMergeWithOwnWork();
    try {
      const baseline = await captureFixBaseline(dir);
      await rm(path.join(dir, 'untouched.txt'));
      await mkdir(path.join(dir, 'untouched.txt'));
      await writeFile(path.join(dir, 'untouched.txt', 'cache'), 'cached\n', 'utf8');
      await symlink('../base.txt', path.join(dir, 'untouched.txt', 'link'));
      const out = await relocateFixerChanges(dir, baseline, { taskId: 't1', runId: 'inv1' });
      expect(out?.moved).toEqual(['untouched.txt/cache']);
      expect(out?.left.map((l) => l.path).sort()).toEqual(['untouched.txt', 'untouched.txt/link']);
      expect(out?.left.find((l) => l.path === 'untouched.txt/link')?.target).toBe('../base.txt');
      expect((await lstat(path.join(dir, 'untouched.txt', 'link'))).isSymbolicLink()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A fixer that ran git staged what it changed, and the person's own work with it.
  it('takes what a fixer staged outside the conflict out of the index before the commit', async () => {
    const dir = await setupMergeWithOwnWork();
    try {
      const baseline = await captureFixBaseline(dir);
      await writeFile(path.join(dir, 'base.txt'), 'resolved\n', 'utf8');
      await writeFile(path.join(dir, 'untouched.txt'), 'fixer on untouched\n', 'utf8');
      await writeFile(path.join(dir, 'stray.txt'), 'fixer scratch\n', 'utf8');
      await git(dir, ['add', '-A']);
      const out = await relocateFixerChanges(dir, baseline, { taskId: 't1', runId: 'inv1' });
      expect(out?.moved.sort()).toEqual(['stray.txt', 'untouched.txt']);
      expect(out?.unstaged.map((u) => u.path).sort()).toEqual([
        'dirt.txt',
        'mine.txt',
        'stray.txt',
        'untouched.txt',
      ]);
      expect(fixerLeftoversWarning('t1', out!)).toContain('taken back out of the index');
      expect(await completeMergeHostSide(dir, COMMIT_ENV, 'feature/x')).toBe(true);
      expect(await git(dir, ['show', 'HEAD:base.txt'])).toBe('resolved\n');
      expect(await git(dir, ['show', 'HEAD:clean.txt'])).toBe('two\n');
      expect(await git(dir, ['show', 'HEAD:untouched.txt'])).toBe('untouched\n');
      expect(await git(dir, ['show', 'HEAD:dirt.txt'])).toBe('dirt\n');
      expect(await gitCode(dir, ['cat-file', '-e', 'HEAD:stray.txt'])).not.toBe(0);
      expect(await gitCode(dir, ['cat-file', '-e', 'HEAD:mine.txt'])).not.toBe(0);
      expect(await readFile(path.join(dir, 'dirt.txt'), 'utf8')).toBe('person dirt\n');
      expect(await readFile(path.join(dir, 'mine.txt'), 'utf8')).toBe('mine\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A fixer resolving `.gitignore` can drop a rule, and what the rule ignored is still not its own.
  it('leaves what git ignored when the fixer was sent in, whatever rules it leaves', async () => {
    const { dir, kept } = await setupIgnoreConflict();
    try {
      const baseline = await captureFixBaseline(dir);
      await writeFile(path.join(dir, '.gitignore'), 'ours/\ntheirs/\n', 'utf8');
      await writeFile(path.join(dir, 'cache', 'new'), 'new under cache\n', 'utf8');
      const out = await relocateFixerChanges(dir, baseline, { taskId: 't1', runId: 'inv1' });
      expect(out).toBeNull();
      expect(await readFile(path.join(dir, 'cache', 'keep'), 'utf8')).toBe(kept);
      expect(await readFile(path.join(dir, 'cache', 'new'), 'utf8')).toBe('new under cache\n');
      // Nor was it hashed: nothing under the directory reached the object store.
      const blob = (await git(dir, ['hash-object', path.join(dir, 'cache', 'keep')])).trim();
      expect(await gitCode(dir, ['cat-file', '-e', blob])).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Or add one, which hides a file the baseline recorded: it is compared, not restored over.
  it('compares a recorded file that a rule the fixer added now hides', async () => {
    const { dir } = await setupIgnoreConflict();
    try {
      const baseline = await captureFixBaseline(dir);
      await writeFile(path.join(dir, '.gitignore'), 'cache/\nours/\ntheirs/\n*.log\n', 'utf8');
      await writeFile(path.join(dir, 'app.log'), 'line1\nline2\n', 'utf8');
      const out = await relocateFixerChanges(dir, baseline, { taskId: 't1', runId: 'inv1' });
      expect(out?.moved).toEqual(['app.log']);
      const read = (rel: string) => readFile(path.join(dir, rel), 'utf8');
      expect(await read('.haive/merge-leftovers/t1/inv1/files/app.log')).toBe('line1\nline2\n');
      expect(await read('app.log')).toBe('line1\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a new file whose name is not UTF-8 and leaves it where it is', async () => {
    const dir = await setupMergeWithOwnWork();
    const odd = Buffer.concat([
      Buffer.from(`${dir}/odd-`),
      Buffer.from([0xff]),
      Buffer.from('.txt'),
    ]);
    try {
      const baseline = await captureFixBaseline(dir);
      await writeFile(odd, 'odd\n');
      const out = await relocateFixerChanges(dir, baseline, { taskId: 't1', runId: 'inv1' });
      expect(out?.unchecked).toBeUndefined();
      expect(out?.left).toEqual([expect.objectContaining({ reason: 'its name is not UTF-8' })]);
      expect(await readFile(odd, 'utf8')).toBe('odd\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a baseline git could not record rather than checking nothing', async () => {
    const dir = await setupMergeWithOwnWork();
    try {
      await git(dir, ['merge', '--abort']);
      const baseline = await captureFixBaseline(dir);
      expect(baseline).toEqual({ unavailable: 'git could not read the merge' });
      const out = await relocateFixerChanges(dir, baseline, { taskId: 't1', runId: 'inv1' });
      expect(out?.unchecked).toContain('nothing was recorded before it ran');
      expect(fixerLeftoversWarning('t1', out!)).toContain('Could not check');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // git writes what it puts back as this process, where the sandbox user owned what stood there.
  it.runIf(process.getuid?.() === 0)(
    'hands what it puts back, and the directories git recreated, to the owner of the tree',
    async () => {
      const dir = await setupMergeWithOwnWork();
      try {
        await exec('chown', ['-R', '1000:1000', dir]);
        await exec('chown', ['0:0', path.join(dir, 'lib', 'deep')]);
        const baseline = await captureFixBaseline(dir);
        await writeFile(path.join(dir, 'untouched.txt'), 'fixer on untouched\n', 'utf8');
        await writeFile(path.join(dir, 'lib', 'deep', 'keep.txt'), 'fixer on keep\n', 'utf8');
        await rm(path.join(dir, 'lib', 'other'), { recursive: true });
        await relocateFixerChanges(dir, baseline, { taskId: 't1', runId: 'inv1' });
        expect(await readFile(path.join(dir, 'lib', 'deep', 'keep.txt'), 'utf8')).toBe('keep\n');
        expect(await readFile(path.join(dir, 'lib', 'other', 'gone.txt'), 'utf8')).toBe('gone\n');
        const owners = [
          'untouched.txt',
          'lib/deep/keep.txt',
          'lib/other',
          'lib/other/gone.txt',
          'lib/deep',
        ];
        const uids = await Promise.all(
          owners.map(async (rel) => (await lstat(path.join(dir, rel))).uid),
        );
        expect(Object.fromEntries(owners.map((rel, i) => [rel, uids[i]]))).toEqual({
          'untouched.txt': 1000,
          'lib/deep/keep.txt': 1000,
          'lib/other': 1000,
          'lib/other/gone.txt': 1000,
          'lib/deep': 0,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('moves nothing once the merge it was sent into was finished by hand', async () => {
    const dir = await setupMergeWithOwnWork();
    try {
      const baseline = await captureFixBaseline(dir);
      await writeFile(path.join(dir, 'base.txt'), 'resolved\n', 'utf8');
      await writeFile(path.join(dir, 'stray.txt'), 'fixer scratch\n', 'utf8');
      await git(dir, ['add', 'base.txt']);
      await git(dir, ['commit', '--no-edit']);
      const out = await relocateFixerChanges(dir, baseline, { taskId: 't1', runId: 'inv1' });
      expect(out?.unchecked).toBeTruthy();
      expect(out?.moved).toEqual([]);
      expect(await readFile(path.join(dir, 'stray.txt'), 'utf8')).toBe('fixer scratch\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records nothing in a person's own checkout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gm-host-'));
    vi.stubEnv('HOST_REPO_ROOT', root);
    vi.resetModules();
    const hosted = await import('./git-merge.js');
    const dir = await setupMergeWithOwnWork();
    const inHost = path.join(root, 'repo');
    try {
      await rename(dir, inHost);
      expect(await hosted.captureFixBaseline(inHost)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('merge helpers (real git)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('checks the markers of a conflicted file whose name git quotes', async () => {
    const dir = await setupNamedConflict('café "notes".txt');
    try {
      await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
      expect(await unmergedPaths(dir)).toEqual(['café "notes".txt']);
      // The markers are still in the file, so nothing may be committed.
      expect(await completeMergeHostSide(dir, COMMIT_ENV, 'feature/x')).toBe(false);
      expect(await mergeHead(dir)).toBe(0);
      expect(await git(dir, ['show', 'HEAD:café "notes".txt'])).toBe('main\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tells a conflict from a merge git refused', async () => {
    const dir = await setupNamedConflict('base.txt');
    try {
      await writeFile(path.join(dir, 'clean.txt'), 'uncommitted\n', 'utf8');
      const refused = await openMerge(dir, 'feature/x', ['--no-edit'], COMMIT_ENV);
      expect(refused.kind).toBe('refused');
      if (refused.kind === 'refused') expect(refused.detail).toContain('clean.txt');
      expect(await mergeHead(dir)).not.toBe(0);
      await git(dir, ['checkout', '--', 'clean.txt']);
      expect((await openMerge(dir, 'feature/x', ['--no-edit'], COMMIT_ENV)).kind).toBe('conflict');
      expect((await openMerge(dir, 'nosuch', ['--no-edit'], COMMIT_ENV)).kind).toBe('refused');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('aborts a merge after a fixer edited a file the merge staged', async () => {
    const dir = await setupNamedConflict('base.txt');
    try {
      await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
      await writeFile(path.join(dir, 'clean.txt'), 'fixer edit\n', 'utf8');
      await writeFile(path.join(dir, 'base.txt'), 'half-resolved\n', 'utf8');
      // git alone refuses this abort and keeps the merge open.
      expect(await gitCode(dir, ['merge', '--abort'])).not.toBe(0);
      expect(await abortMerge(dir)).toEqual({ ok: true });
      expect(await mergeHead(dir)).not.toBe(0);
      expect(await readFile(path.join(dir, 'clean.txt'), 'utf8')).toBe('one\n');
      expect((await git(dir, ['status', '--porcelain'])).trim()).toBe('');
      expect(await abortMerge(dir)).toEqual({ ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('puts nothing back in a host checkout and reports what blocks the abort', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gm-host-'));
    vi.stubEnv('HOST_REPO_ROOT', root);
    vi.resetModules();
    const hosted = await import('./git-merge.js');
    const dir = await setupNamedConflict('base.txt');
    const inHost = path.join(root, 'repo');
    try {
      await rename(dir, inHost);
      await gitCode(inHost, ['merge', '--no-ff', '--no-edit', 'feature/x']);
      await writeFile(path.join(inHost, 'clean.txt'), 'their own edit\n', 'utf8');
      const abort = await hosted.abortMerge(inHost);
      expect(abort.ok).toBe(false);
      if (!abort.ok) expect(abort.blocking).toEqual(['clean.txt']);
      expect(await readFile(path.join(inHost, 'clean.txt'), 'utf8')).toBe('their own edit\n');
      expect(await mergeHead(inHost)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('aborts a stale merge of another ref and keeps one of the ref about to be merged', async () => {
    const dir = await setupNamedConflict('base.txt');
    try {
      await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
      expect(await abortOtherMerge(dir, 'feature/x')).toEqual({ ok: true });
      expect(await mergeHead(dir)).toBe(0);
      await git(dir, ['branch', 'other', 'main']);
      expect(await abortOtherMerge(dir, 'other')).toEqual({ ok: true });
      expect(await mergeHead(dir)).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A repo on `main` with a `feature/x` that adds two commits and does NOT conflict. */
async function setupCleanFeature(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gs-'));
  await git(dir, ['init', '-b', 'main']);
  await writeFile(path.join(dir, 'base.txt'), 'base\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'init']);
  await git(dir, ['checkout', '-b', 'feature/x']);
  await writeFile(path.join(dir, 'one.txt'), 'one\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'ISS-1: one']);
  await writeFile(path.join(dir, 'two.txt'), 'two\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'ISS-2: two']);
  await git(dir, ['checkout', 'main']);
  return dir;
}

const count = async (dir: string, ref: string): Promise<number> =>
  Number((await git(dir, ['rev-list', '--count', ref])).trim());

describe('squashMergeCommit (real git)', () => {
  it('collapses a landed merge into one commit with an identical tree', async () => {
    const dir = await setupCleanFeature();
    try {
      const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      expect(await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x'])).toBe(0);
      // The un-squashed shape: 2 feature commits + the merge commit on top of main's 1.
      expect(await count(dir, 'main')).toBe(4);
      const mergedTree = (await git(dir, ['rev-parse', 'HEAD^{tree}'])).trim();

      const sha = await squashMergeCommit(dir, before, 'feat: squashed', COMMIT_ENV);
      expect(sha).toBeTruthy();
      expect(await count(dir, 'main')).toBe(2); // init + the single squash commit
      expect((await git(dir, ['rev-parse', 'HEAD^{tree}'])).trim()).toBe(mergedTree);
      expect((await git(dir, ['rev-parse', 'HEAD^'])).trim()).toBe(before);
      expect((await git(dir, ['log', '-1', '--format=%s'])).trim()).toBe('feat: squashed');
      // Nothing left staged or dirty.
      expect((await git(dir, ['status', '--porcelain'])).trim()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the merge changed nothing (already up to date)', async () => {
    const dir = await setupCleanFeature();
    try {
      await git(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
      const after = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      // A second merge of the same branch is "Already up to date" — nothing to collapse.
      expect(await squashMergeCommit(dir, after, 'feat: nothing', COMMIT_ENV)).toBeNull();
      expect((await git(dir, ['rev-parse', 'HEAD'])).trim()).toBe(after);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to touch a LIVE merge (MERGE_HEAD present)', async () => {
    const dir = await setupConflict();
    try {
      const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      expect(await gitCode(dir, ['merge', '--no-ff', '--no-edit', 'feature/x'])).not.toBe(0);
      expect(await squashMergeCommit(dir, before, 'feat: nope', COMMIT_ENV)).toBeNull();
      // The conflict loop still owns it: MERGE_HEAD and the markers survive.
      expect(await gitCode(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBe(0);
      expect(await readFile(path.join(dir, 'base.txt'), 'utf8')).toContain('<<<<<<<');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('finishes a crash-interrupted squash (HEAD reset, changes still staged)', async () => {
    const dir = await setupCleanFeature();
    try {
      const before = (await git(dir, ['rev-parse', 'HEAD'])).trim();
      await git(dir, ['merge', '--no-ff', '--no-edit', 'feature/x']);
      // Simulate a crash between the reset and the commit.
      await git(dir, ['reset', '--soft', before]);
      const sha = await squashMergeCommit(dir, before, 'feat: resumed', COMMIT_ENV);
      expect(sha).toBeTruthy();
      expect(await count(dir, 'main')).toBe(2);
      expect((await git(dir, ['log', '-1', '--format=%s'])).trim()).toBe('feat: resumed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
