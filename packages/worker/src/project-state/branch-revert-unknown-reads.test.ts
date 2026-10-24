import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { failGit, type FakeGit } from '../../test/support/fake-git.js';
import { listBranchProjectionEdits, revertHaiveProjectionsOnBranch } from './branch-revert.js';

const exec = promisify(execFile);
const IDENTITY = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const PUT_BACK_EVENT = 'branch.projections_put_back';
const FILE = '.haive-data/state/settings/x.json';
const FAILED = /^git rev-parse .+ failed in .+: fatal: simulated failure/;

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: { ...process.env, ...IDENTITY } });
  return stdout.toString();
}
const revOf = async (dir: string, rev = 'HEAD') => (await git(dir, ['rev-parse', rev])).trim();
const verify = (spec: string) => ['rev-parse', '-q', '--verify', spec];

const dirs: string[] = [];
let shim: FakeGit | null = null;
afterEach(async () => {
  await shim?.restore();
  shim = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5 });
});

async function commit(dir: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), body, 'utf8');
  }
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', message]);
}

/** A repository on `main` holding the record `"fork"`, and a `feature/x` worktree. */
async function fixture(): Promise<{ parent: string; wt: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'br-unknown-'));
  dirs.push(parent);
  await git(parent, ['init', '-q', '-b', 'main']);
  await git(parent, ['config', 'gc.auto', '0']);
  await commit(parent, { 'base.txt': 'base\n', [FILE]: '"fork"\n' }, 'initial');
  const wt = path.join(parent, '.haive', 'worktrees', 'feature-x');
  await mkdir(path.dirname(wt), { recursive: true });
  await git(parent, ['worktree', 'add', '-q', '-b', 'feature/x', wt, 'main']);
  return { parent, wt };
}

/** The slice of the database a put-back reaches: its record is a task event. */
function stubDb() {
  const events: { eventType: string; payload: { synced?: boolean; commit?: string } }[] = [];
  const db = {
    query: {
      users: { findFirst: async () => undefined },
      tasks: { findFirst: async () => ({ repositoryId: 'r1' }) },
      repositories: { findFirst: async () => ({ credentialsSecretId: null }) },
      taskSteps: { findFirst: async () => ({ id: 'ts-1', warningMessage: null }) },
    },
    insert: (table: unknown) => ({
      values: async (v: (typeof events)[number]) => {
        if (table === schema.taskEvents) events.push(v);
      },
    }),
    delete: (table: unknown) => ({
      where: async () => {
        if (table === schema.taskEvents) events.splice(0, events.length);
      },
    }),
    update: (table: unknown) => ({
      set: () => ({
        where: () => {
          if (table === schema.taskEvents) {
            for (const e of events) {
              if (e.eventType === PUT_BACK_EVENT) e.payload = { ...e.payload, synced: true };
            }
            return Promise.resolve();
          }
          return { returning: async () => [{ id: 'ts-1', warningMessage: null }] };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () =>
            events
              .filter((e) => e.eventType === PUT_BACK_EVENT)
              .map((e) => ({ payload: e.payload })),
        }),
      }),
    }),
  };
  return { db, events };
}

const noop = () => undefined;
const revert = (parent: string, wt: string, db: unknown, target: string | string[] = 'main') =>
  revertHaiveProjectionsOnBranch({
    ctx: {
      taskId: 'task-1',
      taskStepId: 'ts-1',
      userId: 'user-1',
      repoPath: parent,
      db,
      logger: { info: noop, warn: noop, error: noop, debug: noop },
    } as never,
    worktree: wt,
    branch: 'feature/x',
    target,
  });

describe('a failed ref read in branch-revert is unknown, not absent', () => {
  it('B2 a failed branch-tip read rejects in the revert and in the edit listing, and records nothing', async () => {
    const { parent, wt } = await fixture();
    await commit(wt, { [FILE]: '"agent"\n' }, 'agent edits a setting');
    const h = stubDb();
    shim = await failGit(verify('refs/heads/feature/x^{commit}'));
    await expect(revert(parent, wt, h.db)).rejects.toThrow(FAILED);
    await expect(
      listBranchProjectionEdits({ repoPath: parent, branch: 'feature/x', target: ['main'] }),
    ).rejects.toThrow(FAILED);
    expect(h.events).toEqual([]);
  });

  it('B1 a failed local-base read does not fall through to origin/<base>', async () => {
    const { parent, wt } = await fixture();
    await git(parent, ['update-ref', 'refs/remotes/origin/main', 'main']);
    await commit(parent, { [FILE]: '"local-record"\n' }, 'local base ahead of origin');
    await git(wt, ['merge', '-q', '--ff-only', 'main']);
    await commit(wt, { [FILE]: '"agent"\n' }, 'agent edits a setting');
    const h = stubDb();
    shim = await failGit(verify('refs/heads/main^{commit}'));
    await expect(revert(parent, wt, h.db, ['main', 'origin/main'])).rejects.toThrow(FAILED);
    await shim.restore();
    shim = null;
    expect((await git(parent, ['show', `feature/x:${FILE}`])).trim()).toBe('"agent"');
  });

  it('B3 a failed `<commit>^{commit}` read keeps the put-back record', async () => {
    const { parent, wt } = await fixture();
    await commit(wt, { [FILE]: '"agent"\n' }, 'agent edits a setting');
    const h = stubDb();
    const first = await revert(parent, wt, h.db);
    await commit(wt, { 'late.txt': 'late\n' }, 'work after the put-back');
    shim = await failGit(verify(`${first!.commit}^{commit}`));
    await expect(revert(parent, wt, h.db)).rejects.toThrow(FAILED);
    expect(h.events).toHaveLength(1);
  });

  it('B4 a failed tip read in the resume rejects, and the Retry finishes the worktree sync', async () => {
    const { parent, wt } = await fixture();
    await commit(wt, { [FILE]: '"agent"\n' }, 'agent edits a setting');
    const h = stubDb();
    shim = await failGit(['restore']);
    await expect(revert(parent, wt, h.db)).rejects.toThrow(/could not be brought to the new tip/);
    await shim.restore();
    shim = await failGit(verify('refs/heads/feature/x^{commit}'), { from: 1, until: 1 });
    await expect(revert(parent, wt, h.db)).rejects.toThrow(FAILED);
    await shim.restore();
    shim = null;
    expect(h.events[0]?.payload.synced).not.toBe(true);
    await revert(parent, wt, h.db);
    expect((await git(wt, ['status', '--porcelain'])).trim()).toBe('');
    expect(h.events[0]?.payload.synced).toBe(true);
  });

  it('B5 a failed `<commit>^` read keeps the record and makes no second put-back commit', async () => {
    const { parent, wt } = await fixture();
    await commit(wt, { [FILE]: '"agent"\n' }, 'agent edits a setting');
    const pre = await revOf(wt);
    const h = stubDb();
    const first = await revert(parent, wt, h.db);
    await git(parent, ['update-ref', 'refs/heads/feature/x', pre]);
    await git(wt, ['reset', '-q', '--hard', pre]);
    h.events.forEach((e) => (e.payload = { ...e.payload, synced: undefined }));
    shim = await failGit(verify(`${first!.commit}^`));
    await expect(revert(parent, wt, h.db)).rejects.toThrow(FAILED);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]!.payload.commit).toBe(first!.commit);
    expect(await revOf(parent, 'feature/x')).toBe(pre);
  });

  it('B0 GUARD a healthy put-back still reverts the file and records once', async () => {
    const { parent, wt } = await fixture();
    await commit(wt, { [FILE]: '"agent"\n' }, 'agent edits a setting');
    const h = stubDb();
    const out = await revert(parent, wt, h.db);
    expect(out?.paths).toEqual([FILE]);
    expect(h.events).toHaveLength(1);
    expect((await git(parent, ['show', `feature/x:${FILE}`])).trim()).toBe('"fork"');
  });
});
