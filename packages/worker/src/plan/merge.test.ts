import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect, afterEach } from 'vitest';
import { planMirrorPayloadSchema } from '@haive/shared/schemas';
import { renderPlanMarkdownFromMirror, serializePlanMirror } from '@haive/shared/plan';
import { mergePlanMirror } from '@haive/shared/plan-mirror-merge';
import type { PlanMirror } from '@haive/shared';
import {
  PROJECT_STATE_DIR,
  claimFileName,
  emptyProjectState,
  mergeProjectState,
  parseProjectState,
  renderProjectState,
  type ProjectRender,
  type ProjectStateClaim,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import {
  abortMerge,
  commitMerge,
  conflictedPaths,
  divergence,
  ensurePlanMergeWorktree,
  landPlanMerge,
  mergeOriginInto,
  planMergeWorktreePath,
  removePlanMergeWorktree,
} from './merge.js';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
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

const dirs: string[] = [];

/**
 * Stop git writing into a fixture repo after the test that made it has returned.
 *
 * A commit can trigger `git gc --auto`, which DETACHES by default, so it keeps writing
 * `.git/objects/pack` past the awaited `execFile`. The teardown below then walks a tree
 * something is still filling and `rmdir` fails `ENOTEMPTY` — MEASURED on CI run
 * 35607941673, `ENOTEMPTY ... rmdir '/tmp/planmerge-local-7TkHPI/.git/objects/pack'`,
 * one failure of 4,854 tests on a commit whose whole content was two markdown files,
 * and the same job passed on the IDENTICAL sha when rerun.
 *
 * Set repo-locally rather than through the environment: every git process touching this
 * tree then inherits it, including the ones `merge.ts` spawns through `gitRun` for
 * `worktree prune` and `worktree remove --force`, and nothing changes for any other
 * suite. Called after `clone` too, which creates its own `.git` and inherits no config
 * from the remote.
 */
async function quietGit(dir: string): Promise<void> {
  await git(dir, ['config', 'gc.auto', '0']);
}

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    // Retried on ENOTEMPTY rather than trusted, the same reading `removeDirContents`
    // (`@haive/shared/fs-safe`) takes for the same errno: a writer can add an entry
    // between the listing and the `rmdir`, and a few passes cover that while still
    // terminating on a directory something is actively filling. `quietGit` removes the
    // writer this was measured against; this covers any other.
    for (let pass = 0; ; pass += 1) {
      try {
        await rm(d, { recursive: true, force: true });
        break;
      } catch (err) {
        if (pass >= 2 || (err as { code?: string }).code !== 'ENOTEMPTY') throw err;
      }
    }
  }
});

async function write(dir: string, file: string, body: string | Buffer): Promise<void> {
  const full = path.join(dir, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body);
}

/**
 * The exact shape that prompted this feature: a Haive blank repo (its own README plus
 * a plan snapshot) and a remote created independently (its own README), sharing NO
 * commit.
 */
async function unrelatedPair(): Promise<{ local: string; remote: string }> {
  const remote = await mkdtemp(path.join(tmpdir(), 'planmerge-remote-'));
  const local = await mkdtemp(path.join(tmpdir(), 'planmerge-local-'));
  dirs.push(remote, local);

  await git(remote, ['init', '-b', 'main']);
  await quietGit(remote);
  await write(remote, 'README.md', '# vareska\n\nfrom the forge\n');
  await git(remote, ['add', '-A']);
  await git(remote, ['commit', '-m', 'Initial commit']);

  await git(local, ['init', '-b', 'main']);
  await quietGit(local);
  await write(local, 'README.md', '# vareska-claude\n\nCreated by Haive as a blank project.\n');
  await write(local, '.haive-data/plan.json', '{"nodes":["local"]}\n');
  await write(local, '.haive-data/plan.md', '# Plan\n\nlocal\n');
  await git(local, ['add', '-A']);
  await git(local, ['commit', '-m', 'chore: initialise blank repository']);
  await git(local, ['remote', 'add', 'origin', remote]);
  await git(local, ['fetch', 'origin', 'main']);
  return { local, remote };
}

describe('divergence', () => {
  it('reports unrelated histories rather than a merge base', async () => {
    const { local } = await unrelatedPair();
    const d = await divergence(local, 'main');
    expect(d.unrelated).toBe(true);
    // Both sides count in full: with no common ancestor there is nothing shared.
    expect(d.behind).toBeGreaterThan(0);
    expect(d.ahead).toBeGreaterThan(0);
  });

  it('counts a plain fast-forward as behind, not unrelated', async () => {
    const { remote } = await unrelatedPair();
    const clone = await mkdtemp(path.join(tmpdir(), 'planmerge-clone-'));
    dirs.push(clone);
    await git(clone, ['clone', remote, '.']);
    await quietGit(clone);
    // The remote moves on. Committed in place rather than pushed: a non-bare repo
    // refuses a push to its checked-out branch, which is a property of the fixture,
    // not of anything under test.
    await write(remote, 'later.txt', 'x\n');
    await git(remote, ['add', '-A']);
    await git(remote, ['commit', '-m', 'later']);
    await git(clone, ['fetch', 'origin', 'main']);

    const d = await divergence(clone, 'main');
    expect(d.unrelated).toBe(false);
    expect(d.behind).toBe(1);
    expect(d.ahead).toBe(0);
  });
});

describe('ensurePlanMergeWorktree', () => {
  it('creates a detached worktree at HEAD and is idempotent', async () => {
    const { local } = await unrelatedPair();
    const first = await ensurePlanMergeWorktree(local);
    expect(first).toBe(planMergeWorktreePath(local));
    // Detached: no branch is checked out there, so the main tree keeps `main`.
    expect((await git(first, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('HEAD');
    expect((await git(first, ['rev-parse', 'HEAD'])).trim()).toBe(
      (await git(local, ['rev-parse', 'HEAD'])).trim(),
    );
    await expect(ensurePlanMergeWorktree(local)).resolves.toBe(first);
  });

  it('removes cleanly', async () => {
    const { local } = await unrelatedPair();
    await ensurePlanMergeWorktree(local);
    await removePlanMergeWorktree(local);
    const list = await git(local, ['worktree', 'list', '--porcelain']);
    expect(list).not.toContain(planMergeWorktreePath(local));
  });
});

describe('mergeOriginInto', () => {
  it('needs the unrelated-histories flag, and reports the add/add conflict', async () => {
    const { local } = await unrelatedPair();
    const wt = await ensurePlanMergeWorktree(local);
    const d = await divergence(local, 'main');

    // Without the flag git refuses outright — the reason this feature exists. It
    // must THROW, not report a clean merge: no merge starts, so nothing is
    // conflicted, and a caller reading only the conflict list would land nothing.
    await expect(mergeOriginInto(wt, 'main', false, COMMIT_ENV)).rejects.toThrow(
      /could not start/i,
    );

    const attempt = await mergeOriginInto(wt, 'main', d.unrelated, COMMIT_ENV);
    expect(attempt.unrelated).toBe(true);
    expect(attempt.clean).toBe(false);
    expect(attempt.conflicts).toEqual(['README.md']);
  });

  it('auto-resolves the plan mirror files and keeps them out of the conflict list', async () => {
    const { local, remote } = await unrelatedPair();
    // The other side has a plan snapshot too, so plan.json collides as well.
    await write(remote, '.haive-data/plan.json', '{"nodes":["remote"]}\n');
    await write(remote, '.haive-data/plan.md', '# Plan\n\nremote\n');
    await git(remote, ['add', '-A']);
    await git(remote, ['commit', '-m', 'remote plan']);
    await git(local, ['fetch', 'origin', 'main']);

    const wt = await ensurePlanMergeWorktree(local);
    const attempt = await mergeOriginInto(
      wt,
      'main',
      (await divergence(local, 'main')).unrelated,
      COMMIT_ENV,
    );

    expect(attempt.autoResolved.sort()).toEqual(['.haive-data/plan.json', '.haive-data/plan.md']);
    // Only the real conflict is handed on; the plan files never reach a person.
    expect(attempt.conflicts).toEqual(['README.md']);
    // Incoming side taken, which is what reconcilePlanFromCheckout has to read.
    expect(await readFile(path.join(wt, '.haive-data/plan.json'), 'utf8')).toContain('remote');
  });

  it('reports a conflicted name git would quote as the name itself', async () => {
    const { local, remote } = await unrelatedPair();
    const name = 'café "notes".txt';
    await write(remote, name, 'remote\n');
    await git(remote, ['add', '-A']);
    await git(remote, ['commit', '-m', 'remote notes']);
    await write(local, name, 'local\n');
    await git(local, ['add', '-A']);
    await git(local, ['commit', '-m', 'local notes']);
    await git(local, ['fetch', 'origin', 'main']);

    const wt = await ensurePlanMergeWorktree(local);
    const attempt = await mergeOriginInto(
      wt,
      'main',
      (await divergence(local, 'main')).unrelated,
      COMMIT_ENV,
    );
    expect(attempt.conflicts.sort()).toEqual(['README.md', name]);
    expect((await conflictedPaths(wt)).paths.sort()).toEqual(['README.md', name]);
  });

  it('judges a conflicted name by its bytes: a valid U+FFFD is listed, an undecodable one is counted', async () => {
    const { local, remote } = await unrelatedPair();
    const valid = 'bad\uFFFD.md';
    const raw = Buffer.concat([Buffer.from('b'), Buffer.from([0xff]), Buffer.from('.md')]);
    for (const [dir, body] of [
      [remote, 'remote\n'],
      [local, 'local\n'],
    ] as const) {
      await write(dir, valid, body);
      await writeFile(Buffer.concat([Buffer.from(`${dir}/`), raw]), body);
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', 'names']);
    }
    await git(local, ['fetch', 'origin', 'main']);

    const wt = await ensurePlanMergeWorktree(local);
    const attempt = await mergeOriginInto(
      wt,
      'main',
      (await divergence(local, 'main')).unrelated,
      COMMIT_ENV,
    );
    expect(attempt.conflicts.sort()).toEqual(['README.md', valid]);
    expect(attempt.undecodable).toBe(1);
    expect(attempt.clean).toBe(false);
    const found = await conflictedPaths(wt);
    expect(found.paths.sort()).toEqual(['README.md', valid]);
    expect(found.undecodable).toBe(1);
    expect(found.undecodableShown).toHaveLength(1);
  });

  it('is clean when only the plan files collide', async () => {
    const { local, remote } = await unrelatedPair();
    // Same README on both sides, so it is not a conflict; only the plan differs.
    await write(remote, 'README.md', '# vareska-claude\n\nCreated by Haive as a blank project.\n');
    await write(remote, '.haive-data/plan.json', '{"nodes":["remote"]}\n');
    await write(remote, '.haive-data/plan.md', '# Plan\n\nremote\n');
    await git(remote, ['add', '-A']);
    await git(remote, ['commit', '-m', 'remote plan']);
    await git(local, ['fetch', 'origin', 'main']);

    const wt = await ensurePlanMergeWorktree(local);
    const attempt = await mergeOriginInto(
      wt,
      'main',
      (await divergence(local, 'main')).unrelated,
      COMMIT_ENV,
    );
    expect(attempt.conflicts).toEqual([]);
    expect(attempt.clean).toBe(true);
  });
});

const ROOT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NODE_X = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NODE_Y = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NODE_Z = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NODE_W = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PLAN_JSON = '.haive-data/plan.json';
const PLAN_MD = '.haive-data/plan.md';

function planOf(spec: [string, string][]): PlanMirror {
  return {
    schemaVersion: 2,
    nodes: [
      {
        id: ROOT_ID,
        parentId: null,
        ordinal: 0,
        title: 'Product',
        kind: 'component',
        body: null,
        status: 'todo',
        taskable: false,
      },
      ...spec.map(([id, title], i) => ({
        id,
        parentId: ROOT_ID,
        ordinal: i,
        title,
        kind: 'component',
        body: null,
        status: 'todo',
        taskable: false,
      })),
    ],
    edges: [],
    codeLinks: [],
  };
}

const withKind = (plan: PlanMirror, id: string, kind: string): PlanMirror => ({
  ...plan,
  nodes: plan.nodes.map((n) => (n.id === id ? { ...n, kind } : n)),
});

async function writePlan(dir: string, plan: PlanMirror): Promise<void> {
  await write(dir, PLAN_JSON, serializePlanMirror(plan));
  await write(dir, PLAN_MD, renderPlanMarkdownFromMirror(plan));
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', message]);
}

/** Two checkouts of one history: `base` committed, then each side commits its own plan (null = deleted). */
async function relatedPair(
  base: PlanMirror | null,
  ours: PlanMirror | null,
  theirs: PlanMirror | null,
): Promise<{ local: string; wt: string }> {
  const remote = await mkdtemp(path.join(tmpdir(), 'planmerge-remote-'));
  const local = await mkdtemp(path.join(tmpdir(), 'planmerge-local-'));
  dirs.push(remote, local);
  await git(remote, ['init', '-b', 'main']);
  await quietGit(remote);
  await write(remote, 'README.md', '# repo\n');
  if (base) await writePlan(remote, base);
  await commitAll(remote, 'base');
  await rm(local, { recursive: true, force: true });
  await git(path.dirname(local), ['clone', remote, local]);
  await quietGit(local);
  const change = async (dir: string, plan: PlanMirror | null): Promise<void> => {
    if (plan) await writePlan(dir, plan);
    else await git(dir, ['rm', '-q', '-f', PLAN_JSON, PLAN_MD]);
    await commitAll(dir, 'plan');
  };
  await change(local, ours);
  await change(remote, theirs);
  await git(local, ['fetch', 'origin', 'main']);
  return { local, wt: await ensurePlanMergeWorktree(local) };
}

async function mergeAndCommit(local: string, wt: string) {
  const attempt = await mergeOriginInto(
    wt,
    'main',
    (await divergence(local, 'main')).unrelated,
    COMMIT_ENV,
  );
  if (attempt.clean) await commitMerge(wt, 'merge', COMMIT_ENV);
  const committed = async (file: string): Promise<string> => git(wt, ['show', `HEAD:${file}`]);
  return { attempt, committed };
}

const nodeOf = (plan: PlanMirror, id: string): PlanMirror['nodes'][number] | undefined =>
  plan.nodes.find((n) => n.id === id);
const parsePlan = (json: string): PlanMirror => {
  const parsed = planMirrorPayloadSchema.parse(JSON.parse(json) as unknown);
  if (parsed.schemaVersion !== 2) throw new Error('expected a v2 plan');
  return parsed;
};

describe('mergeOriginInto: plan.json merges three-way', () => {
  const base = planOf([
    [NODE_X, 'X'],
    [NODE_Y, 'Y'],
  ]);

  it('carries both sides changes into the merge commit', async () => {
    // Adjacent lines of one node (title, kind) are what makes git itself report a conflict.
    const { local, wt } = await relatedPair(
      base,
      planOf([
        [NODE_X, 'X ours'],
        [NODE_Y, 'Y'],
      ]),
      withKind(
        planOf([
          [NODE_X, 'X'],
          [NODE_Y, 'Y theirs'],
        ]),
        NODE_X,
        'decision',
      ),
    );
    const { attempt, committed } = await mergeAndCommit(local, wt);

    expect(attempt.autoResolved).toContain(PLAN_JSON);
    expect(attempt.clean).toBe(true);
    const plan = parsePlan(await committed(PLAN_JSON));
    expect(nodeOf(plan, NODE_X)).toMatchObject({ title: 'X ours', kind: 'decision' });
    expect(nodeOf(plan, NODE_Y)?.title).toBe('Y theirs');
    expect(await committed(PLAN_JSON)).toBe(serializePlanMirror(plan));
    expect(await readFile(path.join(wt, PLAN_JSON), 'utf8')).toBe(await committed(PLAN_JSON));
  });

  it('renders plan.md from the merged plan.json', async () => {
    const { local, wt } = await relatedPair(
      base,
      planOf([
        [NODE_X, 'X ours'],
        [NODE_Y, 'Y'],
        [NODE_Z, 'Z'],
      ]),
      withKind(
        planOf([
          [NODE_X, 'X'],
          [NODE_Y, 'Y theirs'],
          [NODE_W, 'W'],
        ]),
        NODE_X,
        'decision',
      ),
    );
    const { committed } = await mergeAndCommit(local, wt);

    const plan = parsePlan(await committed(PLAN_JSON));
    expect(plan.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([NODE_X, NODE_Y, NODE_Z, NODE_W]),
    );
    expect(await committed(PLAN_MD)).toBe(renderPlanMarkdownFromMirror(plan));
  });

  it('keeps theirs for a field both sides changed, and ours elsewhere', async () => {
    const ours = planOf([
      [NODE_X, 'X ours'],
      [NODE_Y, 'Y'],
      [NODE_Z, 'Z'],
    ]);
    const theirs = planOf([
      [NODE_X, 'X theirs'],
      [NODE_Y, 'Y'],
    ]);
    const { local, wt } = await relatedPair(base, ours, theirs);
    const { committed } = await mergeAndCommit(local, wt);

    const plan = parsePlan(await committed(PLAN_JSON));
    expect(nodeOf(plan, NODE_X)?.title).toBe('X theirs');
    expect(nodeOf(plan, NODE_Z)?.title).toBe('Z');
    const merge = mergePlanMirror({ base, local: ours, incoming: theirs });
    expect(merge.conflicts.map((c) => [c.nodeId, c.field])).toEqual([[NODE_X, 'title']]);
  });

  it('re-renders plan.md from the merged plan.json even where git merged plan.md cleanly', async () => {
    const ours = planOf([
      [NODE_X, 'X ours'],
      [NODE_Y, 'Y'],
    ]);
    const theirs = planOf([
      [NODE_X, 'X theirs'],
      [NODE_Y, 'Y'],
    ]);
    const { local, wt } = await relatedPair(base, ours, theirs);
    await write(wt, PLAN_MD, 'same on both sides\n');
    await commitAll(wt, 'md');
    const remoteDir = (await git(local, ['remote', 'get-url', 'origin'])).trim();
    await write(remoteDir, PLAN_MD, 'same on both sides\n');
    await commitAll(remoteDir, 'md');
    await git(local, ['fetch', 'origin', 'main']);
    const { committed, attempt } = await mergeAndCommit(local, wt);
    expect(attempt.autoResolved).toEqual([PLAN_JSON, PLAN_MD]);
    const plan = parsePlan(await committed(PLAN_JSON));
    expect(await committed(PLAN_MD)).toBe(renderPlanMarkdownFromMirror(plan));
  });

  it('merges an add/add with no base instead of taking theirs', async () => {
    const { local, wt } = await relatedPair(
      null,
      planOf([[NODE_X, 'X ours']]),
      planOf([[NODE_Y, 'Y theirs']]),
    );
    const { attempt, committed } = await mergeAndCommit(local, wt);

    expect(attempt.autoResolved).toContain(PLAN_JSON);
    expect(attempt.clean).toBe(true);
    const plan = parsePlan(await committed(PLAN_JSON));
    expect(nodeOf(plan, NODE_X)?.title).toBe('X ours');
    expect(nodeOf(plan, NODE_Y)?.title).toBe('Y theirs');
    expect(await committed(PLAN_MD)).toBe(renderPlanMarkdownFromMirror(plan));
  });

  it('keeps the modified side when the other side deleted plan.json', async () => {
    const modified = planOf([
      [NODE_X, 'X modified'],
      [NODE_Y, 'Y'],
    ]);
    for (const [ours, theirs] of [
      [modified, null],
      [null, modified],
    ] as const) {
      const { local, wt } = await relatedPair(base, ours, theirs);
      const { attempt, committed } = await mergeAndCommit(local, wt);

      expect(attempt.clean).toBe(true);
      expect(attempt.warnings.join('\n')).toContain('one side deleted it');
      const plan = parsePlan(await committed(PLAN_JSON));
      expect(nodeOf(plan, NODE_X)?.title).toBe('X modified');
      expect(await committed(PLAN_MD)).toBe(renderPlanMarkdownFromMirror(plan));
    }
  });

  it('falls back to theirs with a warning when a side does not parse', async () => {
    const theirs = planOf([[NODE_Y, 'Y theirs']]);
    const { local, wt } = await relatedPair(base, planOf([[NODE_X, 'X ours']]), theirs);
    await removePlanMergeWorktree(local);
    await write(local, PLAN_JSON, '{"nodes":["local"]}\n');
    await commitAll(local, 'garbled');
    const fresh = await ensurePlanMergeWorktree(local);
    expect(fresh).toBe(wt);
    const { attempt, committed } = await mergeAndCommit(local, fresh);

    expect(attempt.clean).toBe(true);
    expect(attempt.warnings.some((w) => w.startsWith(PLAN_JSON))).toBe(true);
    expect(await committed(PLAN_JSON)).toBe(serializePlanMirror(theirs));
  });

  it('takes an incoming deletion of plan.md when the plan.json to render it from does not parse', async () => {
    const { local, wt } = await relatedPair(
      base,
      planOf([[NODE_X, 'X ours']]),
      planOf([[NODE_X, 'X ours']]),
    );
    // One shared plan commit is the merge base, so plan.json merges cleanly to the garbled side.
    const remoteDir = (await git(local, ['remote', 'get-url', 'origin'])).trim();
    await git(remoteDir, ['fetch', '-q', local, 'HEAD']);
    await git(remoteDir, ['reset', '-q', '--hard', 'FETCH_HEAD']);
    await removePlanMergeWorktree(local);
    await write(local, PLAN_JSON, '{"nodes":["local"]}\n');
    await write(local, PLAN_MD, '# local edit\n');
    await commitAll(local, 'garbled');
    await git(remoteDir, ['rm', '-q', '-f', PLAN_MD]);
    await commitAll(remoteDir, 'drop md');
    await git(local, ['fetch', 'origin', 'main']);
    const fresh = await ensurePlanMergeWorktree(local);
    expect(fresh).toBe(wt);
    const { attempt } = await mergeAndCommit(local, fresh);

    expect(attempt.clean).toBe(true);
    expect((await git(fresh, ['ls-files', '-u'])).trim()).toBe('');
    expect((await git(fresh, ['ls-files', '--', PLAN_MD])).trim()).toBe('');
  });

  it('falls back to theirs with a warning when the roots differ', async () => {
    const other = planOf([[NODE_Y, 'Y other']]);
    other.nodes[0] = { ...other.nodes[0]!, id: NODE_W };
    other.nodes[1] = { ...other.nodes[1]!, parentId: NODE_W };
    const { local, wt } = await relatedPair(base, planOf([[NODE_X, 'X ours']]), other);
    const { attempt, committed } = await mergeAndCommit(local, wt);

    expect(attempt.warnings.join('\n')).toContain('different roots');
    expect(await committed(PLAN_JSON)).toBe(serializePlanMirror(other));
  });
});

const STATE_PREFIX = `${PROJECT_STATE_DIR}/`;
const RENDER_FILE = `${STATE_PREFIX}project/render.json`;

const baseRender = (over: Partial<ProjectRender> = {}): ProjectRender => ({
  projectInfo: {},
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
  ...over,
});

const claimAt = (diskPath: string, writtenHash: string): ProjectStateClaim => ({
  path: diskPath,
  templateId: 'tpl',
  kind: 'agent',
  schemaVersion: 1,
  templateHash: 'h',
  writtenHash,
  haiveVersion: '1.0.0',
});

const recordOf = (over: Partial<ProjectStateRecord> = {}): ProjectStateRecord => ({
  ...emptyProjectState(),
  render: baseRender(),
  ...over,
});

type Files = Record<string, string | Buffer | null>;

const stateFiles = (record: ProjectStateRecord): Files =>
  Object.fromEntries(
    [...renderProjectState(record)].map(([rel, text]) => [`${STATE_PREFIX}${rel}`, text]),
  );

/** Two checkouts of one history, each side's files given as path -> text (null = removed). */
async function relatedFilesPair(
  base: Files,
  ours: Files,
  theirs: Files,
): Promise<{ local: string; wt: string }> {
  const remote = await mkdtemp(path.join(tmpdir(), 'planmerge-remote-'));
  const local = await mkdtemp(path.join(tmpdir(), 'planmerge-local-'));
  dirs.push(remote, local);
  await git(remote, ['init', '-b', 'main']);
  await quietGit(remote);
  await write(remote, 'README.md', '# repo\n');
  const apply = async (dir: string, files: Files): Promise<void> => {
    for (const [file, body] of Object.entries(files)) {
      if (body === null) await git(dir, ['rm', '-q', '-f', file]);
      else await write(dir, file, body);
    }
    await commitAll(dir, 'state');
  };
  await apply(remote, base);
  await rm(local, { recursive: true, force: true });
  await git(path.dirname(local), ['clone', remote, local]);
  await quietGit(local);
  await apply(local, ours);
  await apply(remote, theirs);
  await git(local, ['fetch', 'origin', 'main']);
  return { local, wt: await ensurePlanMergeWorktree(local) };
}

async function committedRecord(wt: string): Promise<ProjectStateRecord> {
  const listed = await git(wt, ['ls-tree', '-r', '--name-only', 'HEAD', '--', PROJECT_STATE_DIR]);
  const files = new Map<string, string>();
  for (const file of listed.split('\n').filter(Boolean)) {
    files.set(file.slice(STATE_PREFIX.length), await git(wt, ['show', `HEAD:${file}`]));
  }
  const parsed = parseProjectState(files);
  if (!parsed.ok) throw new Error(parsed.problems.join('; '));
  return parsed.record;
}

const unmergedUnderState = async (wt: string): Promise<string> =>
  (await git(wt, ['ls-files', '-u', '--', PROJECT_STATE_DIR])).trim();

describe('mergeOriginInto: the project state record merges three-way', () => {
  const base = recordOf();
  const theirsSpec = [{ id: 'agent-a', description: 'A' }];

  it('carries both sides changes to different keys of one file', async () => {
    // customAgentSpecs and framework are adjacent lines of render.json, so git reports a conflict.
    const { local, wt } = await relatedFilesPair(
      stateFiles(base),
      stateFiles(recordOf({ render: baseRender({ framework: 'drupal' }) })),
      stateFiles(recordOf({ render: baseRender({ customAgentSpecs: theirsSpec }) })),
    );
    const { attempt } = await mergeAndCommit(local, wt);

    expect(attempt.autoResolved).toContain(RENDER_FILE);
    expect(attempt.clean).toBe(true);
    expect(attempt.conflicts).toEqual([]);
    expect(await unmergedUnderState(wt)).toBe('');
    const record = await committedRecord(wt);
    expect(record.render?.framework).toBe('drupal');
    expect(record.render?.customAgentSpecs).toEqual(theirsSpec);
  });

  it('keeps theirs for a key both sides changed', async () => {
    const ours = recordOf({ render: baseRender({ framework: 'drupal' }) });
    const theirs = recordOf({ render: baseRender({ framework: 'laravel' }) });
    const { local, wt } = await relatedFilesPair(
      stateFiles(base),
      stateFiles(ours),
      stateFiles(theirs),
    );
    const { attempt } = await mergeAndCommit(local, wt);

    expect(attempt.clean).toBe(true);
    expect((await committedRecord(wt)).render?.framework).toBe('laravel');
    const merge = mergeProjectState({ base, local: ours, incoming: theirs });
    expect(merge.conflicts.map((c) => c.unit)).toEqual(['project/render.json#framework']);
  });

  it('keeps an added setting file and the other side change in a conflicted file', async () => {
    const { local, wt } = await relatedFilesPair(
      stateFiles(base),
      stateFiles(
        recordOf({
          render: baseRender({ framework: 'drupal' }),
          settings: Object.assign(Object.create(null), { 'rtk-version': '1.0' }) as Record<
            string,
            unknown
          >,
        }),
      ),
      stateFiles(recordOf({ render: baseRender({ customAgentSpecs: theirsSpec }) })),
    );
    const { attempt } = await mergeAndCommit(local, wt);

    expect(attempt.clean).toBe(true);
    const record = await committedRecord(wt);
    expect(record.settings['rtk-version']).toBe('1.0');
    expect(record.render?.framework).toBe('drupal');
    expect(record.render?.customAgentSpecs).toEqual(theirsSpec);
  });

  it('keeps theirs for a whole-file unit both sides changed', async () => {
    const withUnits = (setting: string, hash: string): ProjectStateRecord =>
      recordOf({
        settings: Object.assign(Object.create(null), { 'rtk-version': setting }) as Record<
          string,
          unknown
        >,
        claims: [claimAt('.claude/agents/a.md', hash)],
      });
    const { local, wt } = await relatedFilesPair(
      stateFiles(withUnits('1', 'h0')),
      stateFiles(withUnits('2', 'h-ours')),
      stateFiles(withUnits('3', 'h-theirs')),
    );
    const { attempt } = await mergeAndCommit(local, wt);

    expect(attempt.clean).toBe(true);
    expect(await unmergedUnderState(wt)).toBe('');
    const record = await committedRecord(wt);
    expect(record.settings['rtk-version']).toBe('3');
    expect(record.claims.map((c) => c.writtenHash)).toEqual(['h-theirs']);
  });

  it('removes a file the record no longer holds when theirs deleted a unit ours changed', async () => {
    const claim = claimAt('.claude/agents/a.md', 'h0');
    const file = `${STATE_PREFIX}${claimFileName(claim.path)}`;
    const { local, wt } = await relatedFilesPair(
      stateFiles(recordOf({ claims: [claim] })),
      stateFiles(recordOf({ claims: [{ ...claim, writtenHash: 'h-ours' }] })),
      { [file]: null },
    );
    const { attempt } = await mergeAndCommit(local, wt);

    expect(attempt.clean).toBe(true);
    expect(await unmergedUnderState(wt)).toBe('');
    expect((await committedRecord(wt)).claims).toEqual([]);
    await expect(lstat(path.join(wt, file))).rejects.toThrow();
    expect((await git(wt, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('falls back to theirs with a warning when a state file does not parse', async () => {
    const theirs = stateFiles(recordOf({ render: baseRender({ framework: 'laravel' }) }));
    const { local, wt } = await relatedFilesPair(
      stateFiles(base),
      { ...stateFiles(base), [RENDER_FILE]: '{ not json\n' },
      theirs,
    );
    const { attempt, committed } = await mergeAndCommit(local, wt);

    expect(attempt.clean).toBe(true);
    expect(attempt.warnings.some((w) => w.includes(PROJECT_STATE_DIR))).toBe(true);
    expect(await unmergedUnderState(wt)).toBe('');
    expect(await committed(RENDER_FILE)).toBe(theirs[RENDER_FILE]);
  });

  it('falls back without reading a state tree past the record limits', async () => {
    const theirs = stateFiles(recordOf({ render: baseRender({ framework: 'laravel' }) }));
    const { local, wt } = await relatedFilesPair(
      stateFiles(base),
      stateFiles(recordOf({ render: baseRender({ framework: 'drupal' }) })),
      { ...theirs, [`${STATE_PREFIX}huge.json`]: `"${'x'.repeat(1024 * 1024 + 16)}"\n` },
    );
    const { attempt, committed } = await mergeAndCommit(local, wt);

    expect(attempt.clean).toBe(true);
    expect(attempt.warnings.some((w) => w.includes('larger than the record allows'))).toBe(true);
    expect(await unmergedUnderState(wt)).toBe('');
    expect(await committed(RENDER_FILE)).toBe(theirs[RENDER_FILE]);
  });

  it('falls back rather than decoding a state file that is not UTF-8', async () => {
    const theirs = stateFiles(recordOf({ render: baseRender({ framework: 'laravel' }) }));
    const ours = String(
      stateFiles(recordOf({ render: baseRender({ framework: 'drupal' }) }))[RENDER_FILE],
    );
    const at = ours.indexOf('drupal');
    const { local, wt } = await relatedFilesPair(
      stateFiles(base),
      {
        [RENDER_FILE]: Buffer.concat([
          Buffer.from(ours.slice(0, at)),
          Buffer.from([0xff]),
          Buffer.from(ours.slice(at + 1)),
        ]),
      },
      theirs,
    );
    const { attempt, committed } = await mergeAndCommit(local, wt);

    expect(attempt.clean).toBe(true);
    expect(attempt.warnings.some((w) => w.includes('not valid UTF-8'))).toBe(true);
    expect(await committed(RENDER_FILE)).toBe(theirs[RENDER_FILE]);
  });

  it('takes the incoming deletion of a state file when the record falls back', async () => {
    const claim = claimAt('.claude/agents/a.md', 'h0');
    const file = `${STATE_PREFIX}${claimFileName(claim.path)}`;
    const theirs = stateFiles(recordOf({ render: baseRender({ framework: 'laravel' }) }));
    const { local, wt } = await relatedFilesPair(
      stateFiles(recordOf({ claims: [claim] })),
      {
        ...stateFiles(recordOf({ claims: [{ ...claim, writtenHash: 'h-ours' }] })),
        [RENDER_FILE]: '{ not json\n',
      },
      { [RENDER_FILE]: theirs[RENDER_FILE]!, [file]: null },
    );
    const { attempt } = await mergeAndCommit(local, wt);

    expect(attempt.clean).toBe(true);
    expect(await unmergedUnderState(wt)).toBe('');
    await expect(lstat(path.join(wt, file))).rejects.toThrow();
    expect((await git(wt, ['ls-files', '--', file])).trim()).toBe('');
  });

  it('commits a merge whose only conflicts are in the state directory', async () => {
    const { local, wt } = await relatedFilesPair(
      stateFiles(base),
      stateFiles(recordOf({ render: baseRender({ framework: 'drupal' }) })),
      stateFiles(recordOf({ render: baseRender({ customAgentSpecs: theirsSpec }) })),
    );
    const { attempt } = await mergeAndCommit(local, wt);

    expect(attempt.conflicts).toEqual([]);
    expect(attempt.clean).toBe(true);
    expect(
      (await git(wt, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' '),
    ).toHaveLength(3);
  });
});

describe('landPlanMerge', () => {
  it('fast-forwards the real branch onto the resolved merge', async () => {
    const { local } = await unrelatedPair();
    const before = (await git(local, ['rev-parse', 'HEAD'])).trim();
    const wt = await ensurePlanMergeWorktree(local);
    await mergeOriginInto(wt, 'main', (await divergence(local, 'main')).unrelated, COMMIT_ENV);

    // Resolve the one real conflict the way an agent would: edit, then stage.
    await write(wt, 'README.md', '# vareska\n\nboth sides\n');
    await git(wt, ['add', 'README.md']);
    const sha = await commitMerge(wt, 'Merge origin/main', COMMIT_ENV);
    expect(sha).toBeTruthy();

    await landPlanMerge(local, sha!);
    expect((await git(local, ['rev-parse', 'HEAD'])).trim()).toBe(sha);
    // The merge carries the old HEAD as its first parent, which is what made the
    // fast-forward legal — and is the single-command undo.
    expect((await git(local, ['rev-parse', `${sha}^1`])).trim()).toBe(before);
    expect(await readFile(path.join(local, 'README.md'), 'utf8')).toContain('both sides');
  });

  it('refuses rather than resetting when the checkout moved underneath', async () => {
    const { local } = await unrelatedPair();
    const wt = await ensurePlanMergeWorktree(local);
    await mergeOriginInto(wt, 'main', (await divergence(local, 'main')).unrelated, COMMIT_ENV);
    await write(wt, 'README.md', 'merged\n');
    await git(wt, ['add', 'README.md']);
    const sha = await commitMerge(wt, 'Merge origin/main', COMMIT_ENV);

    // Someone commits to the checkout while the conversation is open.
    await write(local, 'unrelated.txt', 'meanwhile\n');
    await git(local, ['add', '-A']);
    await git(local, ['commit', '-m', 'meanwhile']);

    await expect(landPlanMerge(local, sha!)).rejects.toThrow(/checkout moved/i);
  });

  it('names a change in the checkout that git refused to overwrite, rather than blaming a move', async () => {
    const { local } = await unrelatedPair();
    const wt = await ensurePlanMergeWorktree(local);
    await mergeOriginInto(wt, 'main', (await divergence(local, 'main')).unrelated, COMMIT_ENV);
    await write(wt, 'README.md', 'merged\n');
    await git(wt, ['add', 'README.md']);
    const sha = await commitMerge(wt, 'Merge origin/main', COMMIT_ENV);

    await write(local, 'README.md', 'edited meanwhile\n');

    await expect(landPlanMerge(local, sha!)).rejects.toThrow(/uncommitted changes \(README\.md\)/);
    expect(await readFile(path.join(local, 'README.md'), 'utf8')).toBe('edited meanwhile\n');
  });
});

describe('abortMerge', () => {
  it('leaves the worktree at its pre-merge commit', async () => {
    const { local } = await unrelatedPair();
    const wt = await ensurePlanMergeWorktree(local);
    const before = (await git(wt, ['rev-parse', 'HEAD'])).trim();
    await mergeOriginInto(wt, 'main', (await divergence(local, 'main')).unrelated, COMMIT_ENV);
    expect((await conflictedPaths(wt)).paths.length).toBeGreaterThan(0);

    await abortMerge(wt);
    expect(await conflictedPaths(wt)).toEqual({ paths: [], undecodable: 0, undecodableShown: [] });
    expect((await git(wt, ['rev-parse', 'HEAD'])).trim()).toBe(before);
  });
});

const ownerOf = async (p: string): Promise<number> => (await lstat(p)).uid;

// A merge git runs as root writes as root, where a fixer runs as the tree's owner.
describe.runIf(process.getuid?.() === 0)(
  'a root plan merge in a tree the sandbox user owns',
  () => {
    async function ownedPair(): Promise<{ local: string; wt: string }> {
      const { local, remote } = await unrelatedPair();
      await write(remote, 'docs/guide/a.md', 'a\n');
      await git(remote, ['add', '-A']);
      await git(remote, ['commit', '-m', 'docs']);
      await git(local, ['fetch', 'origin', 'main']);
      const wt = await ensurePlanMergeWorktree(local);
      await exec('chown', ['-R', '1000:1000', local]);
      return { local, wt };
    }

    it('hands what the merge wrote, and the directories it created, to the tree owner', async () => {
      const { local, wt } = await ownedPair();
      const attempt = await mergeOriginInto(
        wt,
        'main',
        (await divergence(local, 'main')).unrelated,
        COMMIT_ENV,
      );
      expect(attempt.conflicts).toEqual(['README.md']);
      for (const rel of ['README.md', 'docs', 'docs/guide', 'docs/guide/a.md']) {
        expect([rel, await ownerOf(path.join(wt, rel))]).toEqual([rel, 1000]);
      }
    });

    it('hands back what an abort rewrote', async () => {
      const { local, wt } = await ownedPair();
      await mergeOriginInto(wt, 'main', (await divergence(local, 'main')).unrelated, COMMIT_ENV);
      await abortMerge(wt);
      expect(await ownerOf(path.join(wt, 'README.md'))).toBe(1000);
    });
  },
);
