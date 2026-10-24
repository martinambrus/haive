import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROJECT_STATE_DIR,
  emptyProjectState,
  renderProjectState,
} from '@haive/shared/project-state';
import type { ProjectStateRecord } from '@haive/shared/project-state';
import { killGit, type KilledGit } from '../../test/support/kill-git.js';
import { conflictedPaths, ensurePlanMergeWorktree, mergeOriginInto } from './merge.js';
import { resolveHaiveProjectionConflicts } from './projection-merge.js';

const exec = promisify(execFile);
const IDENT = {
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@haive.local',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@haive.local',
};
const PLAN_JSON = '.haive-data/plan.json';
const STATE_PREFIX = `${PROJECT_STATE_DIR}/`;

const dirs: string[] = [];
let shim: KilledGit | null = null;

afterEach(async () => {
  await shim?.restore();
  shim = null;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function git(dir: string, args: string[], allowFail = false): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd: dir, env: { ...process.env, ...IDENT } });
    return stdout.toString();
  } catch (err) {
    if (allowFail) return '';
    throw err;
  }
}

type Files = Record<string, string>;

async function commitFiles(dir: string, files: Files): Promise<void> {
  for (const [file, body] of Object.entries(files)) {
    const full = path.join(dir, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', 'c']);
}

/** A scratch worktree with `origin/main` not yet merged, the two sides having changed the same files. */
async function divergedPair(base: Files, ours: Files, theirs: Files): Promise<string> {
  const remote = await mkdtemp(path.join(tmpdir(), 'nox-remote-'));
  const local = await mkdtemp(path.join(tmpdir(), 'nox-local-'));
  dirs.push(remote, local);
  await git(remote, ['init', '-q', '-b', 'main']);
  await git(remote, ['config', 'gc.auto', '0']);
  await commitFiles(remote, { 'README.md': '# r\n', ...base });
  await rm(local, { recursive: true, force: true });
  await git(path.dirname(local), ['clone', '-q', remote, local]);
  await git(local, ['config', 'gc.auto', '0']);
  await commitFiles(local, ours);
  await commitFiles(remote, theirs);
  await git(local, ['fetch', '-q', 'origin', 'main']);
  return ensurePlanMergeWorktree(local);
}

const openConflict = async (wt: string): Promise<void> => {
  await git(wt, ['merge', '--no-edit', 'origin/main'], true);
};

const planSides = (): [Files, Files, Files] => [
  { [PLAN_JSON]: '{"v":0}\n' },
  { [PLAN_JSON]: '{"v":1}\n' },
  { [PLAN_JSON]: '{"v":2}\n' },
];

const recordOf = (framework: string | null): ProjectStateRecord => ({
  ...emptyProjectState(),
  render: {
    projectInfo: {},
    framework,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
  },
});

const stateFiles = (framework: string | null): Files =>
  Object.fromEntries(
    [...renderProjectState(recordOf(framework))].map(([rel, text]) => [
      `${STATE_PREFIX}${rel}`,
      text,
    ]),
  );

const stateSides = (): [Files, Files, Files] => [
  stateFiles(null),
  stateFiles('drupal'),
  stateFiles('laravel'),
];

// hardenGitArgs puts --no-ext-diff and --no-textconv right after the subcommand.
const DIFF_U = ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U'];

describe('conflictedPaths on a git that gave no answer', () => {
  it('lists a real unmerged path (guard)', async () => {
    const wt = await divergedPair(...planSides());
    await openConflict(wt);
    expect((await conflictedPaths(wt)).paths).toEqual([PLAN_JSON]);
  });

  it('rejects instead of listing no paths', async () => {
    const wt = await divergedPair(...planSides());
    await openConflict(wt);
    shim = await killGit(DIFF_U);
    await expect(conflictedPaths(wt)).rejects.toThrow(/git diff --diff-filter=U failed/);
  });

  it('mergeOriginInto rejects rather than report a conflicted merge clean', async () => {
    const wt = await divergedPair({ 'a.txt': '0\n' }, { 'a.txt': '1\n' }, { 'a.txt': '2\n' });
    shim = await killGit(DIFF_U);
    await expect(mergeOriginInto(wt, 'main', false, IDENT)).rejects.toThrow(
      /git diff --diff-filter=U failed/,
    );
  });
});

describe('resolveHaiveProjectionConflicts on a blob read that gave no answer', () => {
  it('leaves plan.json unmerged instead of keeping one side', async () => {
    const wt = await divergedPair(...planSides());
    await openConflict(wt);
    const theirsSha = (await git(wt, ['rev-parse', `origin/main:${PLAN_JSON}`])).trim();
    shim = await killGit(['cat-file', 'blob'], { contains: theirsSha });
    const out = await resolveHaiveProjectionConflicts(wt);
    await shim.restore();
    shim = null;
    expect(out.resolved).not.toContain(PLAN_JSON);
    expect(out.warnings.join('\n')).not.toContain('one side deleted it');
    expect((await git(wt, ['ls-files', '-u', '--', PLAN_JSON])).trim()).not.toBe('');
  });
});

describe('resolveHaiveProjectionConflicts on state reads that gave no answer', () => {
  it('does not take a failed merge-base for "no merge base"', async () => {
    const wt = await divergedPair(...stateSides());
    await openConflict(wt);
    shim = await killGit(['merge-base', 'HEAD', 'MERGE_HEAD']);
    const out = await resolveHaiveProjectionConflicts(wt);
    const warning = out.warnings.find((w) => w.startsWith(`${PROJECT_STATE_DIR}:`));
    expect(warning).toMatch(/merge base/);
    expect(warning).toMatch(/took the incoming side/);
  });

  it('does not claim the state files merged when the final listing failed', async () => {
    const wt = await divergedPair(...stateSides());
    await openConflict(wt);
    shim = await killGit(DIFF_U, { after: 2 });
    const out = await resolveHaiveProjectionConflicts(wt);
    expect(out.resolved.filter((p) => p.startsWith(STATE_PREFIX))).toEqual([]);
  });
});
