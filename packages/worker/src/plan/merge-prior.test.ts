import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PRIOR_HISTORY_MAX_CHARS,
  PRIOR_MAX_PATHS,
  PRIOR_TOTAL_MAX_CHARS,
  priorResolutionLines,
  readPriorResolution,
  type PriorRef,
} from './merge-prior.js';

const exec = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const git = async (dir: string, args: string[]): Promise<string> =>
  (await exec('git', args, { cwd: dir, env: ENV })).stdout.toString().trim();

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A worktree standing on the first commit, with a second that holds the answer to read. */
async function standingOnFirst(
  second: (dir: string) => Promise<void>,
): Promise<{ dir: string; ref: PriorRef }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'planmerge-prior-'));
  dirs.push(dir);
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'gc.auto', '0']);
  await writeFile(path.join(dir, 'README.md'), 'first\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'first']);
  const head = await git(dir, ['rev-parse', 'HEAD']);
  await second(dir);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--allow-empty', '-m', 'second']);
  const sha = await git(dir, ['rev-parse', 'HEAD']);
  await git(dir, ['checkout', '-q', head]);
  return { dir, ref: { sha, head } };
}

describe('the previous answer, read from the commit', () => {
  it('describes a mode, a link, a binary, a file under a file and a name that looks like a pattern', async () => {
    const { dir, ref } = await standingOnFirst(async (d) => {
      await writeFile(path.join(d, 'run.sh'), '#!/bin/sh\n', 'utf8');
      await chmod(path.join(d, 'run.sh'), 0o755);
      await symlink('target.txt', path.join(d, 'link'));
      await writeFile(path.join(d, 'blob.bin'), Buffer.from([1, 0, 2]));
      await writeFile(path.join(d, 'docs'), 'a file\n', 'utf8');
      await writeFile(path.join(d, 'a*b'), 'star\n', 'utf8');
      await writeFile(path.join(d, 'axb'), 'not this\n', 'utf8');
    });
    const found = await readPriorResolution(dir, ref, [
      'run.sh',
      'link',
      'blob.bin',
      'docs/guide.md',
      'a*b',
      'gone.txt',
    ]);
    expect(found?.entries).toEqual([
      { path: 'run.sh', kind: 'text', mode: '100755', link: false, text: '#!/bin/sh\n', cut: 0 },
      { path: 'link', kind: 'text', mode: '120000', link: true, text: 'target.txt', cut: 0 },
      { path: 'blob.bin', kind: 'hidden', why: 'binary' },
      { path: 'docs/guide.md', kind: 'absent', under: 'docs' },
      { path: 'a*b', kind: 'text', mode: '100644', link: false, text: 'star\n', cut: 0 },
      { path: 'gone.txt', kind: 'absent' },
    ]);
    const lines = priorResolutionLines([{ role: 'user', body: 'again' }], found!);
    expect(lines).toContain('- run.sh: your previous content (mode 100755):');
    expect(lines).toContain(
      '- docs/guide.md: absent from your previous resolution, where `docs` was a file.',
    );
  });

  it('reads nothing while the worktree is not where the reopen put it', async () => {
    const { dir, ref } = await standingOnFirst(async (d) => {
      await writeFile(path.join(d, 'more.txt'), 'x\n', 'utf8');
    });
    expect(await readPriorResolution(dir, { ...ref, head: ref.sha }, ['more.txt'])).toBeNull();
  });

  it('stops reading at the size budget and counts the rest', async () => {
    const { dir, ref } = await standingOnFirst(async (d) => {
      for (let i = 0; i < 8; i += 1) {
        await writeFile(path.join(d, `f${i}.txt`), 'y'.repeat(9_000), 'utf8');
      }
    });
    const names = Array.from({ length: 8 }, (_, i) => `f${i}.txt`);
    const found = await readPriorResolution(dir, ref, names);
    const spent = found!.entries.reduce((n, e) => n + (e.kind === 'text' ? e.text.length : 0), 0);
    expect(spent).toBe(PRIOR_TOTAL_MAX_CHARS);
    expect(found!.entries.length + found!.more).toBe(8);
    expect(found!.more).toBeGreaterThan(0);
  });

  it('counts a conflicted name no prompt line can hold among the files not shown', async () => {
    const { dir, ref } = await standingOnFirst(async () => {});
    const found = await readPriorResolution(dir, ref, ['two\nlines.txt', 'a\u0007b.txt']);
    expect(found!.entries).toHaveLength(0);
    expect(found!.more).toBe(2);
    expect(priorResolutionLines([], found!).join('\n')).toContain('and 2 more files');
  });

  it('does not repeat an oversized latest request the prompt already states', () => {
    const big = `ask:${'q'.repeat(PRIOR_HISTORY_MAX_CHARS + 1)}`;
    const text = priorResolutionLines([{ role: 'user', body: big }], {
      sha: 'x',
      entries: [],
      more: 0,
    }).join('\n');
    expect(text).not.toContain('ask:');
    expect(text).toContain('(1 earlier turns of this conversation are not shown)');
  });

  it('keeps only the newest whole turns of a long conversation', () => {
    const turn = 'z'.repeat(PRIOR_HISTORY_MAX_CHARS / 4);
    const transcript = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      body: `${i}:${turn}`,
    }));
    const text = priorResolutionLines(transcript, { sha: 'x', entries: [], more: 0 }).join('\n');
    expect(text).toContain('9:');
    expect(text).not.toContain('0:');
    expect(text).toMatch(/\(\d+ earlier turns of this conversation are not shown\)/);
    expect(text.length).toBeLessThan(PRIOR_HISTORY_MAX_CHARS + 4_000);
  });

  it('reads no more paths than the path cap', async () => {
    const { dir, ref } = await standingOnFirst(async () => {});
    const names = Array.from({ length: PRIOR_MAX_PATHS + 5 }, (_, i) => `missing${i}.txt`);
    const found = await readPriorResolution(dir, ref, names);
    expect(found!.entries).toHaveLength(PRIOR_MAX_PATHS);
    expect(found!.more).toBe(5);
  });
});
