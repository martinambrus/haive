import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureGitExcludeEntry, initGitWorkspace } from './git-init.js';

const exec = promisify(execFile);

const dirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function excludeFile(repo: string): Promise<string> {
  return readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
}

describe('initGitWorkspace', () => {
  // symbolic-ref, not `rev-parse --abbrev-ref HEAD`: HEAD is still unborn here (no
  // commit yet) and rev-parse fails on it.
  it('creates a repo on the requested branch', async () => {
    const repo = await tmp('gi-init-');
    await initGitWorkspace(repo, 'trunk');
    const { stdout } = await exec('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo });
    expect(stdout.trim()).toBe('trunk');
  });

  // The regression this exists for: onboarding's commit step ran `git add` against an
  // uploaded repo with no history and died with "fatal: not a git repository".
  it('makes a subsequent add + commit of the whole tree succeed', async () => {
    const repo = await tmp('gi-commit-');
    await writeFile(path.join(repo, 'app.php'), '<?php\n', 'utf8');
    await initGitWorkspace(repo, 'main');
    await exec('git', ['add', '-A'], { cwd: repo });
    await exec('git', ['commit', '-m', 'initial'], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@haive.local',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@haive.local',
      },
    });
    const { stdout } = await exec('git', ['ls-files'], { cwd: repo });
    expect(stdout.trim().split('\n')).toContain('app.php');
  });

  // Excluding BEFORE the first `git add -A` is the point: after it, the internal
  // marker becomes tracked and reappears in every linked worktree.
  it('excludes .haive/ before anything can be staged', async () => {
    const repo = await tmp('gi-exclude-');
    await initGitWorkspace(repo, 'main');
    expect(await excludeFile(repo)).toContain('.haive/');
  });
});

describe('ensureGitExcludeEntry', () => {
  it('is idempotent', async () => {
    const repo = await tmp('gi-idem-');
    await initGitWorkspace(repo, 'main');
    await ensureGitExcludeEntry(repo);
    await ensureGitExcludeEntry(repo);
    const lines = (await excludeFile(repo)).split('\n').filter((l) => l.trim() === '.haive/');
    expect(lines).toHaveLength(1);
  });

  it('keeps pre-existing entries', async () => {
    const repo = await tmp('gi-keep-');
    await initGitWorkspace(repo, 'main');
    const p = path.join(repo, '.git', 'info', 'exclude');
    await writeFile(p, 'custom-thing\n', 'utf8');
    await ensureGitExcludeEntry(repo);
    const content = await excludeFile(repo);
    expect(content).toContain('custom-thing');
    expect(content).toContain('.haive/');
  });
});
