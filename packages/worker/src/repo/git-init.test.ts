import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_LOCAL_SETTINGS_EXCLUDE,
  ensureGitExcludeEntry,
  initGitWorkspace,
} from './git-init.js';

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

  it('adds only the entries an older exclude file lacks', async () => {
    const repo = await tmp('gi-upgrade-');
    await initGitWorkspace(repo, 'main');
    const p = path.join(repo, '.git', 'info', 'exclude');
    await writeFile(p, 'custom-thing\n.haive/', 'utf8');
    await ensureGitExcludeEntry(repo);
    await ensureGitExcludeEntry(repo);
    expect(await excludeFile(repo)).toBe(
      `custom-thing\n.haive/\n${CLAUDE_LOCAL_SETTINGS_EXCLUDE}\n`,
    );
  });

  // Claude Code's "don't ask again" writes the approved command, secrets included, into this file.
  // A task worktree reads the main repository's exclude file, so the entry reaches gate 3's add.
  // Claude Code also writes the pattern into the host's global ignore file, which the worker
  // container does not have, so the test turns that file off.
  it('keeps a Claude Code local settings file out of a worktree add, at any depth', async () => {
    const repo = await tmp('gi-claude-');
    const git = (cwd: string, ...args: string[]) =>
      exec(
        'git',
        [
          '-c',
          'core.excludesFile=',
          '-c',
          'user.name=T',
          '-c',
          'user.email=t@haive.local',
          ...args,
        ],
        { cwd },
      );
    await initGitWorkspace(repo, 'main');
    await mkdir(path.join(repo, 'kept', '.claude'), { recursive: true });
    await writeFile(path.join(repo, 'kept', '.claude', 'settings.local.json'), '{}\n', 'utf8');
    await git(repo, 'add', '-f', 'kept/.claude/settings.local.json');
    await git(repo, 'commit', '-m', 'initial');
    const wt = path.join(repo, '.haive', 'worktrees', 't');
    await git(repo, 'worktree', 'add', '-b', 'task', wt);

    const secret = '{"permissions":{"allow":["Bash(PGPASSWORD=hunter2 psql)"]}}\n';
    for (const dir of ['.claude', 'sub/.claude']) {
      await mkdir(path.join(wt, dir), { recursive: true });
      await writeFile(path.join(wt, dir, 'settings.local.json'), secret, 'utf8');
    }
    await writeFile(path.join(wt, '.claude', 'settings.json'), '{}\n', 'utf8');
    await writeFile(path.join(wt, 'kept', '.claude', 'settings.local.json'), secret, 'utf8');
    await git(wt, 'add', '-A');

    const { stdout } = await git(wt, 'diff', '--cached', '--name-only');
    // A copy the repository already tracks is the repository's choice and still commits.
    expect(stdout.trim().split('\n').sort()).toEqual([
      '.claude/settings.json',
      'kept/.claude/settings.local.json',
    ]);
  });

  // The exclude file sits inside `.git`, which is not repository CONTENT — but the walk still
  // refuses a link at any component, and that is the point: the write it replaced followed the
  // link and appended the marker to whatever sat on the other end.
  it('refuses to write through an exclude file that is a link', async () => {
    const repo = await tmp('gi-link-');
    const outside = await tmp('gi-link-out-');
    await initGitWorkspace(repo, 'main');

    const target = path.join(outside, 'their-exclude');
    await writeFile(target, 'theirs\n', 'utf8');
    const p = path.join(repo, '.git', 'info', 'exclude');
    await rm(p, { force: true });
    await symlink(target, p);

    await expect(ensureGitExcludeEntry(repo)).rejects.toMatchObject({ reason: 'link' });
    // The file the link named is untouched.
    expect(await readFile(target, 'utf8')).toBe('theirs\n');
  });
});
