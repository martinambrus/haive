import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyProjectState, renderProjectState } from '@haive/shared/project-state';

const spawned = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('../repo/git-exec.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../repo/git-exec.js')>();
  return {
    ...real,
    gitRun: async (...call: Parameters<typeof real.gitRun>) => {
      spawned.calls.push(call[1]);
      return real.gitRun(...call);
    },
  };
});

const { readHeadRecord, rebaseProjectStateOnHeadLocked } = await import('./sync.js');

const exec = promisify(execFile);
const STATE = '.haive-data/state';
const dirs: string[] = [];

afterEach(async () => {
  spawned.calls = [];
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function git(dir: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@h.local' };
  const { stdout } = await exec('git', args, {
    cwd: dir,
    env: { ...env, GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@h.local' },
  });
  return stdout;
}

async function commitRecord(dir: string, globs: string[], extra = 25): Promise<void> {
  const record = {
    ...emptyProjectState(),
    render: {
      projectInfo: {},
      framework: null,
      acceptedAgentIds: [],
      customAgentSpecs: [],
      lspLanguages: [],
    },
    settings: { 'scope-exclude-globs': globs },
  };
  const files = new Map(renderProjectState(record));
  for (let i = 0; i < extra; i += 1) files.set(`extra/f${i}.txt`, `${i}\n`);
  for (const [rel, text] of files) {
    await mkdir(path.dirname(path.join(dir, STATE, rel)), { recursive: true });
    await writeFile(path.join(dir, STATE, rel), text);
  }
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'record']);
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'head-record-'));
  dirs.push(dir);
  await git(dir, ['init', '-q', '-b', 'main']);
  await git(dir, ['config', 'gc.auto', '0']);
  await commitRecord(dir, ['a/**']);
  return dir;
}

/** The sync row a rebase writes, captured from the one upsert it makes. */
function txProbe() {
  const written: { baseSnapshot?: unknown; lastError?: string | null }[] = [];
  const row = { baseSnapshot: { stale: true }, lastError: null as string | null };
  const tx = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: async ({ set }: { set: (typeof written)[number] }) => {
          written.push(set);
        },
      }),
    }),
    update: () => ({
      set: (patch: { lastError: string }) => ({
        where: async () => {
          written.push(patch);
        },
      }),
    }),
  };
  return { tx: tx as never, written };
}

const gitVerbs = () => spawned.calls.map((c) => c[0]);

describe('rebaseProjectStateOnHeadLocked with a record read before the transaction', () => {
  it('spawns one git process for an unmoved HEAD and writes what an in-transaction read writes', async () => {
    const dir = await repo();
    const inside = txProbe();
    await rebaseProjectStateOnHeadLocked(inside.tx, { repositoryId: 'r', repoPath: dir });
    expect(gitVerbs().filter((v) => v === 'cat-file').length).toBeGreaterThanOrEqual(20);

    spawned.calls = [];
    const head = await readHeadRecord(dir);
    expect(gitVerbs()).toContain('ls-tree');
    expect(gitVerbs().filter((v) => v === 'cat-file').length).toBeGreaterThanOrEqual(20);

    spawned.calls = [];
    const pre = txProbe();
    await rebaseProjectStateOnHeadLocked(pre.tx, { repositoryId: 'r', repoPath: dir, head });
    expect(gitVerbs()).toEqual(['rev-parse']);
    expect(pre.written).toHaveLength(1);
    expect(JSON.stringify(pre.written[0]!.baseSnapshot)).toBe(
      JSON.stringify(inside.written[0]!.baseSnapshot),
    );
  });

  it('reads again when HEAD moved after the pre-read, never writing the stale record', async () => {
    const dir = await repo();
    const head = await readHeadRecord(dir);
    await commitRecord(dir, ['b/**'], 0);
    const fresh = txProbe();
    await rebaseProjectStateOnHeadLocked(fresh.tx, { repositoryId: 'r', repoPath: dir });
    const stale = txProbe();
    await rebaseProjectStateOnHeadLocked(stale.tx, { repositoryId: 'r', repoPath: dir, head });
    const globs = (p: ReturnType<typeof txProbe>) => JSON.stringify(p.written[0]!.baseSnapshot);
    expect(globs(stale)).toBe(globs(fresh));
    expect(globs(stale)).toContain('b/**');
    expect(globs(stale)).not.toContain('a/**');
  });

  it('answers a pre-read that threw as the in-transaction read does: base kept, last_error set', async () => {
    const dir = await repo();
    await writeFile(path.join(dir, STATE, 'format.json'), '{ not json');
    await git(dir, ['commit', '-q', '-am', 'broken']);
    const head = await readHeadRecord(dir);
    const inside = txProbe();
    await rebaseProjectStateOnHeadLocked(inside.tx, { repositoryId: 'r', repoPath: dir });
    const pre = txProbe();
    await rebaseProjectStateOnHeadLocked(pre.tx, { repositoryId: 'r', repoPath: dir, head });
    expect(pre.written[0]!.lastError).toBe(inside.written[0]!.lastError);
    expect(pre.written[0]!.lastError).toMatch(/was not read/);
    expect(pre.written[0]!.baseSnapshot).toBeUndefined();
  });

  it('never reuses a record read with no HEAD', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'head-record-'));
    dirs.push(dir);
    await git(dir, ['init', '-q', '-b', 'main']);
    const head = await readHeadRecord(dir);
    expect(head.sha).toBeNull();
    spawned.calls = [];
    await rebaseProjectStateOnHeadLocked(txProbe().tx, {
      repositoryId: 'r',
      repoPath: dir,
      head,
    });
    expect(gitVerbs()).toContain('ls-tree');
  });
});
