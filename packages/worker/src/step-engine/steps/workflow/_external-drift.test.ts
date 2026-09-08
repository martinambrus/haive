import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect, afterEach } from 'vitest';
import {
  externalCommitBlock,
  parseCommitLog,
  resolveBranchPoint,
  type ExternalCommit,
} from './_external-drift.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: GIT_ENV });
  return stdout.toString();
}

async function commit(dir: string, file: string, body: string, message: string): Promise<string> {
  await writeFile(path.join(dir, file), body, 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', message]);
  return (await git(dir, ['rev-parse', 'HEAD'])).trim();
}

async function repo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ext-drift-'));
  made.push(root);
  await git(root, ['init', '-b', 'main']);
  await commit(root, 'base.txt', 'base\n', 'base');
  return root;
}

/** The exact argv `resolveExternalDrift` runs, so the parser is exercised against real
 *  git output rather than a fixture someone hand-wrote to match the parser. */
async function logRange(dir: string, range: string): Promise<string> {
  return git(dir, ['log', '--format=%x00%H%x1f%s', '--name-only', '--no-merges', range]);
}

describe('parseCommitLog', () => {
  it('reads real git output back as commits with their own paths', async () => {
    const dir = await repo();
    const from = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    const one = await commit(dir, 'a.txt', 'a\n', 'add a');
    const two = await commit(dir, 'b.txt', 'b\n', 'add b');

    const parsed = parseCommitLog(await logRange(dir, `${from}..${two}`));
    expect(parsed.map((p) => p.commit.sha)).toEqual([two, one]);
    expect(parsed.map((p) => p.commit.subject)).toEqual(['add b', 'add a']);
    // Each commit keeps its OWN files — the whole reason this is one `log` call and not a
    // range-wide `diff`, which would attribute every file to every commit.
    expect(parsed.map((p) => p.paths)).toEqual([['b.txt'], ['a.txt']]);
  });

  it('keeps a commit that touched no files', async () => {
    const dir = await repo();
    const from = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    await git(dir, ['commit', '--allow-empty', '-m', 'chore: empty']);
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();

    const parsed = parseCommitLog(await logRange(dir, `${from}..${head}`));
    // Dropping it would under-report the range, and "no files" is a fact about the commit,
    // not a reason to hide that it happened.
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.commit.subject).toBe('chore: empty');
    expect(parsed[0]?.paths).toEqual([]);
  });

  it('survives a subject containing the record separators it is parsed with', async () => {
    const dir = await repo();
    const from = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    // A colon-and-dash subject is ordinary; the point is that nothing in normal prose can
    // forge the NUL/US framing, so the sha and the subject stay whole.
    const sha = await commit(dir, 'c.txt', 'c\n', 'fix(auth): token expiry uses <= not <');

    const parsed = parseCommitLog(await logRange(dir, `${from}..${sha}`));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.commit.sha).toBe(sha);
    expect(parsed[0]?.commit.subject).toBe('fix(auth): token expiry uses <= not <');
  });

  it('returns nothing for an empty range', async () => {
    const dir = await repo();
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    expect(parseCommitLog(await logRange(dir, `${head}..${head}`))).toEqual([]);
  });
});

describe('resolveBranchPoint', () => {
  it('is the fork point, not HEAD, so this task own commits stay out of the range', async () => {
    const dir = await repo();
    const fork = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    await git(dir, ['checkout', '-q', '-b', 'feature']);
    const mine = await commit(dir, 'mine.txt', 'mine\n', 'my own work');

    const point = await resolveBranchPoint(dir, 'main');
    expect(point).toBe(fork);
    expect(point).not.toBe(mine);
  });

  it('falls back to HEAD when the base branch is gone', async () => {
    const dir = await repo();
    const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    expect(await resolveBranchPoint(dir, 'no-such-branch')).toBe(head);
    expect(await resolveBranchPoint(dir, null)).toBe(head);
  });

  it('is null where there is no history to fork from', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ext-drift-empty-'));
    made.push(dir);
    await git(dir, ['init', '-b', 'main']);
    expect(await resolveBranchPoint(dir, 'main')).toBeNull();
  });
});

describe('externalCommitBlock', () => {
  const drift = (over: { commits?: ExternalCommit[]; commitsOmitted?: number }) => ({
    commits: [],
    commitsOmitted: 0,
    ...over,
  });

  it('states the cap instead of silently truncating', () => {
    const block = externalCommitBlock(
      drift({ commits: [{ sha: 'abcdef1234', subject: 'add thing' }], commitsOmitted: 7 }),
    );
    expect(block).toContain('abcdef12 add thing');
    expect(block).toContain('+7 further commit(s) not listed');
  });

  it('says nothing about a cap that did not apply', () => {
    const block = externalCommitBlock(
      drift({ commits: [{ sha: 'abcdef1234', subject: 'add thing' }] }),
    );
    expect(block).toBe('- abcdef12 add thing');
  });
});
