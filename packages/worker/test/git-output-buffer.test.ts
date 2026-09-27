import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { openMerge } from '../src/step-engine/git-merge.js';
import { gitRun as kbGitRun } from '../src/step-engine/steps/workflow/_kb-commit.js';

const exec = promisify(execFile);
const IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const GIT_OPTS = { env: { ...process.env, ...IDENTITY }, maxBuffer: 64 * 1024 * 1024 };

/** Fifteen directories of 240-character names: a few hundred paths under it print past 1 MiB. */
const DEEP = Array.from({ length: 15 }, (_, i) => String(i).padEnd(240, 'd')).join('/');

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

async function git(dir: string, args: string[]): Promise<void> {
  await exec('git', args, { cwd: dir, ...GIT_OPTS });
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'haive-git-buffer-'));
  dirs.push(dir);
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'gc.auto', '0']);
  await git(dir, ['config', 'maintenance.auto', 'false']);
  return dir;
}

async function writeMany(dir: string, count: number, body: (i: number) => string): Promise<void> {
  await mkdir(path.join(dir, DEEP), { recursive: true });
  for (let i = 0; i < count; i++) {
    await writeFile(path.join(dir, DEEP, `f${i}.txt`), body(i), 'utf8');
  }
}

describe("git output past execFile's default 1 MiB buffer", () => {
  it('leaves a wide conflicted merge open, not killed half-way', async () => {
    const dir = await repo();
    await writeMany(dir, 300, () => 'base\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', 'init']);
    await git(dir, ['checkout', '-q', '-b', 'feature/x']);
    await writeMany(dir, 300, (i) => `feature ${i}\n`);
    await git(dir, ['commit', '-q', '-am', 'feature']);
    await git(dir, ['checkout', '-q', 'main']);
    await writeMany(dir, 300, (i) => `main ${i}\n`);
    await git(dir, ['commit', '-q', '-am', 'main']);

    expect(await openMerge(dir, 'feature/x', ['--no-edit'], IDENTITY)).toEqual({
      kind: 'conflict',
    });
  });

  it('reports a wide commit as the success it is', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, 'README.md'), 'readme\n', 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-q', '-m', 'init']);
    await writeMany(dir, 400, (i) => `new ${i}\n`);
    await git(dir, ['add', '-A']);

    const res = await kbGitRun(dir, ['commit', '-m', 'wide'], IDENTITY);
    expect(res.code).toBe(0);
  });
});
