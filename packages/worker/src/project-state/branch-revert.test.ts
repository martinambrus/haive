import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { emptyProjectState, renderProjectState } from '@haive/shared/project-state';
import { gate4PushStep } from '../step-engine/steps/workflow/11a-gate-4-push.js';
import { runAppReadyStep } from '../step-engine/steps/run-app/99-run-app-ready.js';
import type { StepContext } from '../step-engine/step-definition.js';

const handBack = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../step-engine/git-merge.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../step-engine/git-merge.js')>();
  return {
    ...real,
    handBackAfterMove: async (...args: Parameters<typeof real.handBackAfterMove>) => {
      handBack.calls.push(args);
      return real.handBackAfterMove(...args);
    },
  };
});

const load = () => import('./branch-revert.js');

const exec = promisify(execFile);
const IDENTITY = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const STATE = '.haive-data/state';
const GLOBS = `${STATE}/settings/scope-exclude-globs.json`;
const PUT_BACK_EVENT = 'branch.projections_put_back';

const dirs: string[] = [];
afterEach(async () => {
  handBack.calls.length = 0;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: { ...process.env, ...IDENTITY } });
  return stdout.toString();
}
async function at(dir: string, rev: string, file: string): Promise<string | null> {
  try {
    return await git(dir, ['show', `${rev}:${file}`]);
  } catch {
    return null;
  }
}
const revOf = async (dir: string, rev = 'HEAD') => (await git(dir, ['rev-parse', rev])).trim();

async function write(dir: string, files: Record<string, string>): Promise<void> {
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), body, 'utf8');
  }
}
async function commit(dir: string, files: Record<string, string>, message: string): Promise<void> {
  await write(dir, files);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', message]);
}

/** The files of a project state record that holds only these settings. */
function stateFiles(settings: Record<string, unknown>): Record<string, string> {
  const record = {
    ...emptyProjectState(),
    render: {
      projectInfo: {},
      framework: null,
      acceptedAgentIds: [],
      customAgentSpecs: [],
      lspLanguages: [],
    },
    settings,
  };
  return Object.fromEntries(
    [...renderProjectState(record)].map(([rel, text]) => [`${STATE}/${rel}`, text]),
  );
}
const AT_FORK = { 'scope-exclude-globs': ['vendor/**'] };
const BY_AGENT = { 'scope-exclude-globs': ['vendor/**', 'dist/**'] };

/** A repository on `main` with a state record, an `origin` that has it, and a `feature/x` worktree. */
async function fixture(
  extra: Record<string, string> = {},
): Promise<{ parent: string; wt: string; bare: string; forked: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'branch-revert-'));
  const bare = await mkdtemp(path.join(tmpdir(), 'branch-revert-origin-'));
  dirs.push(parent, bare);
  await git(bare, ['init', '-q', '--bare', '-b', 'main']);
  await git(bare, ['config', 'gc.auto', '0']);
  await git(bare, ['config', 'receive.autogc', 'false']);
  await git(parent, ['init', '-q', '-b', 'main']);
  await git(parent, ['config', 'gc.auto', '0']);
  await commit(parent, { 'base.txt': 'base\n', ...stateFiles(AT_FORK), ...extra }, 'initial');
  await git(parent, ['remote', 'add', 'origin', bare]);
  await git(parent, ['push', '-q', '-u', 'origin', 'main']);
  const wt = path.join(parent, '.haive', 'worktrees', 'feature-x');
  await mkdir(path.dirname(wt), { recursive: true });
  await git(parent, ['worktree', 'add', '-q', '-b', 'feature/x', wt, 'main']);
  return { parent, wt, bare, forked: await revOf(parent) };
}

/** The slice of the database a step that puts files back and warns about it reaches. */
function stubDb() {
  const events: { eventType: string; payload: unknown }[] = [];
  let warning: string | null = null;
  const db = {
    query: {
      users: { findFirst: async () => undefined },
      tasks: { findFirst: async () => ({ repositoryId: 'r1' }) },
      repositories: { findFirst: async () => ({ credentialsSecretId: null }) },
      taskSteps: { findFirst: async () => ({ id: 'ts-1', warningMessage: warning }) },
    },
    insert: (table: unknown) => ({
      values: async (v: { eventType: string; payload: unknown }) => {
        if (table === schema.taskEvents) events.push(v);
      },
    }),
    update: () => ({
      set: (patch: { warningMessage?: string | null }) => ({
        where: () => ({
          returning: async () => {
            if ('warningMessage' in patch) warning = patch.warningMessage ?? null;
            return [{ id: 'ts-1', warningMessage: warning }];
          },
        }),
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
  return { db, events, warning: () => warning };
}

function stepCtx(parent: string, db: unknown): StepContext {
  const noop = () => undefined;
  return {
    taskId: 'task-1',
    taskStepId: 'ts-1',
    userId: 'user-1',
    repoPath: parent,
    workspacePath: parent,
    sandboxWorkdir: '/workspace',
    db,
    logger: { info: noop, warn: noop, error: noop, debug: noop },
  } as unknown as StepContext;
}

describe('the pushes Haive makes of a task branch put its Haive files back first', () => {
  it('11a gate 4 pushes the branch with them put back', async () => {
    const { parent, wt, bare, forked } = await fixture();
    await commit(wt, stateFiles(BY_AGENT), 'agent edits a setting');
    const h = stubDb();
    const out = await gate4PushStep.apply(stepCtx(parent, h.db), {
      detected: {
        hasGit: true,
        workspacePath: wt,
        branch: 'feature/x',
        hasOrigin: true,
        originUrl: bare,
        recentCommits: '',
        repositoryId: 'r1',
        boundCredentialId: null,
        credentials: [],
        baseBranch: 'main',
      },
      formValues: { push: true, credentialId: '', setUpstream: true },
      iteration: 0,
      previousIterations: [],
    } as never);
    expect(out).toMatchObject({ pushed: true, branch: 'feature/x' });
    expect(await at(bare, 'feature/x', GLOBS)).toBe(await at(parent, forked, GLOBS));
    expect(await revOf(bare, 'feature/x')).toBe(await revOf(parent, 'feature/x'));
    expect(h.warning()).toContain(GLOBS);
    expect(h.events.filter((e) => e.eventType === PUT_BACK_EVENT)).toHaveLength(1);
  });

  it('11a gate 4 pushes a branch that changed none of them as it is', async () => {
    const { parent, wt, bare } = await fixture();
    await commit(wt, { 'feature.txt': 'feature\n' }, 'feature work');
    const tip = await revOf(wt);
    const h = stubDb();
    await gate4PushStep.apply(stepCtx(parent, h.db), {
      detected: {
        hasGit: true,
        workspacePath: wt,
        branch: 'feature/x',
        hasOrigin: true,
        originUrl: bare,
        recentCommits: '',
        repositoryId: 'r1',
        boundCredentialId: null,
        credentials: [],
        baseBranch: 'main',
      },
      formValues: { push: true, credentialId: '', setUpstream: true },
      iteration: 0,
      previousIterations: [],
    } as never);
    expect(await revOf(bare, 'feature/x')).toBe(tip);
    expect(h.events).toEqual([]);
    expect(h.warning()).toBeNull();
  });

  it('the run-app ready gate pushes the session commit with them put back', async () => {
    const { parent, wt, bare, forked } = await fixture();
    await write(wt, { ...stateFiles(BY_AGENT), 'session.txt': 'session\n' });
    const h = stubDb();
    const out = await runAppReadyStep.apply(stepCtx(parent, h.db), {
      detected: {
        mode: 'none',
        appUrl: null,
        liveBrowser: null,
        directAccess: false,
        dbAccess: false,
        workspacePath: wt,
        hasGit: true,
        branch: 'feature/x',
        hasOrigin: true,
        dirtyFiles: 2,
        diffArtifactPath: null,
        changedFileCount: 2,
        baseBranch: 'main',
      },
      formValues: { commit: true, commitMessage: 'session edits', push: true },
      iteration: 0,
      previousIterations: [],
    } as never);
    expect(out).toMatchObject({ committed: true, pushed: true });
    expect(await at(bare, 'feature/x', 'session.txt')).toBe('session\n');
    expect(await at(bare, 'feature/x', GLOBS)).toBe(await at(parent, forked, GLOBS));
    expect(h.warning()).toContain(GLOBS);
  });

  it('the run-app ready gate on the repository root itself has nothing to put back', async () => {
    const { parent, bare } = await fixture();
    await write(parent, stateFiles(BY_AGENT));
    const h = stubDb();
    const out = await runAppReadyStep.apply(stepCtx(parent, h.db), {
      detected: {
        mode: 'none',
        appUrl: null,
        liveBrowser: null,
        directAccess: false,
        dbAccess: false,
        workspacePath: parent,
        hasGit: true,
        branch: 'main',
        hasOrigin: true,
        dirtyFiles: 1,
        diffArtifactPath: null,
        changedFileCount: 1,
        baseBranch: null,
      },
      formValues: { commit: true, commitMessage: 'session edits', push: true },
      iteration: 0,
      previousIterations: [],
    } as never);
    expect(out).toMatchObject({ committed: true, pushed: true });
    expect(h.events).toEqual([]);
    expect(await at(bare, 'main', GLOBS)).toBe(await readFile(path.join(parent, GLOBS), 'utf8'));
  });
});

const forkedState = (dir: string, rev: string) => revOf(dir, `${rev}:${STATE}`);

describe('revertHaiveProjectionsOnBranch', () => {
  async function revert(
    parent: string,
    wt: string | null,
    over: { branch?: string; target?: string | string[] } = {},
  ) {
    const { revertHaiveProjectionsOnBranch } = await load();
    const h = stubDb();
    const result = await revertHaiveProjectionsOnBranch({
      ctx: stepCtx(parent, h.db),
      worktree: wt,
      branch: over.branch ?? 'feature/x',
      target: over.target ?? 'main',
    });
    return { result, h };
  }

  it('puts back a directory that became a file, a file that became a directory and a new gitlink', async () => {
    const { parent, wt, forked } = await fixture({
      [`${STATE}/dirthing/child`]: 'child\n',
      [`${STATE}/filething`]: 'file\n',
    });
    await rm(path.join(wt, STATE, 'dirthing'), { recursive: true });
    await rm(path.join(wt, STATE, 'filething'));
    await write(wt, { [`${STATE}/dirthing`]: 'now a file\n', [`${STATE}/filething/inner`]: 'x\n' });
    await git(wt, ['add', '-A']);
    await git(wt, ['update-index', '--add', '--cacheinfo', `160000,${forked},${STATE}/sub`]);
    await git(wt, ['commit', '-m', 'agent reshapes the record']);
    const { result } = await revert(parent, wt);
    expect(result?.paths).toEqual(
      expect.arrayContaining([`${STATE}/dirthing`, `${STATE}/dirthing/child`, `${STATE}/sub`]),
    );
    expect(await forkedState(parent, 'feature/x')).toBe(await forkedState(parent, forked));
    expect(await git(wt, ['status', '--porcelain'])).toBe('');
    expect(await readFile(path.join(wt, STATE, 'dirthing', 'child'), 'utf8')).toBe('child\n');
    expect(await readFile(path.join(wt, STATE, 'filething'), 'utf8')).toBe('file\n');
  });

  it('halts, naming it, when .haive-data is a link in the worktree, and writes nothing through it', async () => {
    const { parent, wt } = await fixture();
    await commit(wt, stateFiles(BY_AGENT), 'agent edits a setting');
    const tip = await revOf(wt);
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'branch-revert-elsewhere-'));
    dirs.push(elsewhere);
    await write(elsewhere, { 'state/settings/scope-exclude-globs.json': 'decoy\n' });
    await rm(path.join(wt, '.haive-data'), { recursive: true });
    await symlink(elsewhere, path.join(wt, '.haive-data'));
    await expect(revert(parent, wt)).rejects.toThrow(/\.haive-data is a link in the worktree/);
    expect(await revOf(parent, 'feature/x')).toBe(tip);
    expect(
      await readFile(path.join(elsewhere, 'state/settings/scope-exclude-globs.json'), 'utf8'),
    ).toBe('decoy\n');
  });

  it('leaves a link where the state directory was alone, and writes nothing through it', async () => {
    const { parent, wt, forked } = await fixture();
    await commit(wt, stateFiles(BY_AGENT), 'agent edits a setting');
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'branch-revert-elsewhere-'));
    dirs.push(elsewhere);
    await write(elsewhere, { 'settings/scope-exclude-globs.json': 'decoy\n' });
    await rm(path.join(wt, STATE), { recursive: true });
    await symlink(elsewhere, path.join(wt, STATE));
    const { result } = await revert(parent, wt);
    expect(result?.paths).toContain(GLOBS);
    expect(await at(parent, 'feature/x', GLOBS)).toBe(await at(parent, forked, GLOBS));
    expect((await lstat(path.join(wt, STATE))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(elsewhere, 'settings/scope-exclude-globs.json'), 'utf8')).toBe(
      'decoy\n',
    );
  });

  it('halts, naming it, when .haive-data is a file at the tip', async () => {
    const { parent, wt } = await fixture();
    await rm(path.join(wt, '.haive-data'), { recursive: true });
    await commit(wt, { '.haive-data': 'not a directory\n' }, 'agent replaces the directory');
    const tip = await revOf(wt);
    await expect(revert(parent, null)).rejects.toThrow(
      /\.haive-data is not a directory at the tip of feature\/x/,
    );
    await expect(revert(parent, wt)).rejects.toThrow(/\.haive-data is a file in the worktree/);
    expect(await revOf(parent, 'feature/x')).toBe(tip);
  });

  it('moves the branch alone when its worktree is gone, or holds another branch', async () => {
    const gone = await fixture();
    await commit(gone.wt, stateFiles(BY_AGENT), 'agent edits a setting');
    await git(gone.parent, ['worktree', 'remove', '--force', gone.wt]);
    const first = await revert(gone.parent, gone.wt);
    expect(first.result?.paths).toEqual([GLOBS]);
    expect(await at(gone.parent, 'feature/x', GLOBS)).toBe(
      await at(gone.parent, gone.forked, GLOBS),
    );

    const other = await fixture();
    await commit(other.wt, stateFiles(BY_AGENT), 'agent edits a setting');
    await git(other.wt, ['checkout', '-q', '--detach']);
    const second = await revert(other.parent, other.wt);
    expect(second.result?.paths).toEqual([GLOBS]);
    expect(await at(other.parent, 'feature/x', GLOBS)).toBe(
      await at(other.parent, other.forked, GLOBS),
    );
    expect(await readFile(path.join(other.wt, GLOBS), 'utf8')).toBe(
      await at(other.parent, 'feature/x~1', GLOBS),
    );
  });

  it('does nothing for a branch with no fork point with the target, a missing one or a bad name', async () => {
    const { parent, wt } = await fixture();
    const unrelated = await mkdtemp(path.join(tmpdir(), 'branch-revert-unrelated-'));
    dirs.push(unrelated);
    await git(unrelated, ['init', '-q', '-b', 'main']);
    await git(unrelated, ['config', 'gc.auto', '0']);
    await commit(unrelated, stateFiles(BY_AGENT), 'an unrelated history');
    await git(parent, ['fetch', '-q', unrelated, 'main:refs/heads/unrelated']);
    expect((await revert(parent, wt, { branch: 'unrelated' })).result).toBeNull();
    expect((await revert(parent, wt, { branch: 'no/such' })).result).toBeNull();
    expect((await revert(parent, wt, { branch: '-x' })).result).toBeNull();
    expect((await revert(parent, wt, { target: ['nope'] })).result).toBeNull();
  });

  it('lists what it would put back without writing anything', async () => {
    const { listBranchProjectionEdits } = await load();
    const { parent, wt } = await fixture();
    await commit(wt, stateFiles(BY_AGENT), 'agent edits a setting');
    const tip = await revOf(wt);
    const listed = await listBranchProjectionEdits({
      repoPath: parent,
      branch: 'feature/x',
      target: ['nope', 'main'],
    });
    expect(listed).toEqual([GLOBS]);
    expect(await revOf(parent, 'feature/x')).toBe(tip);
  });

  it('caps the paths in the event and the commit message and counts them all', async () => {
    const { parent, wt } = await fixture();
    const many = Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [
        `${STATE}/claims/c${String(i).padStart(3, '0')}.json`,
        '{}\n',
      ]),
    );
    await commit(wt, many, 'agent adds claims');
    const { result, h } = await revert(parent, wt);
    expect(result?.paths).toHaveLength(120);
    const payload = h.events[0]!.payload as { paths: string[]; pathCount: number };
    expect(payload.paths).toHaveLength(100);
    expect(payload.pathCount).toBe(120);
    const message = await git(parent, ['log', '-1', '--format=%B', 'feature/x']);
    expect(message).toContain('- and 70 more');
    expect(await forkedState(parent, 'feature/x')).toBe(await forkedState(parent, 'main'));
  });

  it('puts back a name that is not UTF-8 as it was', async () => {
    const { parent, wt } = await fixture();
    await writeFile(Buffer.from(`${path.join(wt, STATE)}/caf\xe9.json`, 'latin1'), '{}\n');
    await git(wt, ['add', '-A']);
    await git(wt, ['commit', '-m', 'agent adds a file with a latin1 name']);
    const { result } = await revert(parent, wt);
    expect(result?.paths).toHaveLength(1);
    expect(await forkedState(parent, 'feature/x')).toBe(await forkedState(parent, 'main'));
    expect(await git(wt, ['status', '--porcelain'])).toBe('');
  });

  it('hands the files it restored in the worktree back, and only when it restored any', async () => {
    const { parent, wt } = await fixture();
    await commit(wt, stateFiles(BY_AGENT), 'agent edits a setting');
    const preRevert = await revOf(wt);
    await revert(parent, wt);
    expect(handBack.calls).toEqual([[wt, preRevert]]);

    const edited = await fixture();
    await commit(edited.wt, stateFiles(BY_AGENT), 'agent edits a setting');
    handBack.calls.length = 0;
    await write(edited.wt, { [GLOBS]: '["mine"]\n' });
    await revert(edited.parent, edited.wt);
    expect(handBack.calls).toEqual([]);
    expect(await readFile(path.join(edited.wt, GLOBS), 'utf8')).toBe('["mine"]\n');
    expect(await git(edited.wt, ['status', '--porcelain'])).toBe(` M ${GLOBS}\n`);
  });

  it('does not overwrite a branch that moved while it worked', async () => {
    const { revertHaiveProjectionsOnBranch } = await load();
    const { parent, wt } = await fixture();
    await commit(wt, stateFiles(BY_AGENT), 'agent edits a setting');
    const h = stubDb();
    // The identity is read after the scratch tree is built and before the ref moves.
    h.db.query.users.findFirst = async () => {
      await commit(wt, { 'late.txt': 'late\n' }, 'a commit that raced it');
      return undefined;
    };
    await expect(
      revertHaiveProjectionsOnBranch({
        ctx: stepCtx(parent, h.db),
        worktree: wt,
        branch: 'feature/x',
        target: 'main',
      }),
    ).rejects.toThrow(/feature\/x moved while/);
    expect(await at(parent, 'feature/x', 'late.txt')).toBe('late\n');
    expect(h.events).toEqual([]);
  });
});

describe('the warning notes', () => {
  it('are one per time files were put back, read from the events, and added once each', async () => {
    const { projectionRevertNotes, warnStep } = await load();
    const h = stubDb();
    const payload = (commit: string) => ({
      branch: 'feature/x',
      paths: [GLOBS, `${STATE}/format.json`],
      pathCount: 12,
      commit,
      preRevertSha: 'b'.repeat(40),
      mergeBase: 'c'.repeat(40),
    });
    h.events.push({ eventType: PUT_BACK_EVENT, payload: payload('a'.repeat(40)) });
    h.events.push({ eventType: PUT_BACK_EVENT, payload: payload('d'.repeat(40)) });
    h.events.push({ eventType: PUT_BACK_EVENT, payload: { paths: 'not a list' } });
    const notes = await projectionRevertNotes(h.db as never, 'task-1');
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('12 of its own project files on feature/x');
    expect(notes[0]).toContain(JSON.stringify(GLOBS));
    expect(notes[0]).toContain('and 10 more');
    expect(notes[0]).toContain('commit aaaaaaa');
    expect(notes[0]).toContain('commit bbbbbbb');
    await warnStep(stepCtx('/unused', h.db), notes);
    await warnStep(stepCtx('/unused', h.db), notes);
    const warning = h.warning()!;
    expect(warning.split(notes[0]!)).toHaveLength(2);
    expect(warning.split(notes[1]!)).toHaveLength(2);
  });
});
