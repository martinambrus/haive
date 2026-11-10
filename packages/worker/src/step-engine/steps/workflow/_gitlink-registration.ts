import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { lstatNoFollow, removeNoFollow } from '@haive/shared/fs-safe';
import {
  GIT_MAX_BUFFER,
  gitGaveNoAnswer,
  gitRun,
  type GitRunResult,
} from '../../../repo/git-exec.js';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import type { StepContext } from '../../step-definition.js';
import { warnStep } from '../../../project-state/branch-revert.js';
import { parsePorcelainZ } from './_commit-diff.js';

const GITLINK_MODE = '160000';
const REGISTRATION_KEY = /^submodule\.(.+)\.(path|url)$/;
// latin1 keeps each byte of a name as one character, so a name that is not UTF-8 goes back to git as read.
const LISTING = { maxBuffer: GIT_MAX_BUFFER, encoding: 'latin1' } as const;

// A split index writes `.git/sharedindex.*` into the repository, so every scratch-index write turns it off.
const NO_SPLIT_INDEX = ['-c', 'core.splitIndex=false'] as const;

import { stageAllArgs } from '../../../repo/git-stage.js';
export { stageAllArgs } from '../../../repo/git-stage.js';

function failure(what: string, res: GitRunResult): Error {
  const line = res.stderr.trim().split('\n', 1)[0] ?? '';
  return new Error(`${what} failed (exit ${res.code})${line ? `: ${line}` : ''}`);
}

function expectOk(what: string, res: GitRunResult): void {
  if (gitGaveNoAnswer(res) || res.code !== 0) throw failure(what, res);
}

async function newGitlinks(workspace: string, env?: Record<string, string>): Promise<string[]> {
  const head = await gitRun(workspace, ['rev-parse', '-q', '--verify', 'HEAD']);
  if (head.code !== 0 && head.code !== 1) throw failure('git HEAD read', head);
  const res = await gitRun(
    workspace,
    [
      head.code === 1 ? 'diff' : 'diff-index',
      '--cached',
      '--raw',
      '-z',
      '--no-renames',
      '--ignore-submodules=none',
      '--diff-filter=AT',
      ...(head.code === 1 ? [] : ['HEAD']),
    ],
    env,
  );
  expectOk('git diff-index', res);
  const parts = res.stdout.split('\0');
  const found: string[] = [];
  for (let i = 0; i + 1 < parts.length && parts[i]!.startsWith(':'); i += 2) {
    const [srcMode = '', dstMode = ''] = parts[i]!.slice(1).split(' ');
    if (dstMode === GITLINK_MODE && srcMode !== GITLINK_MODE) found.push(parts[i + 1]!);
  }
  return found;
}

/** Paths with a `.gitmodules` entry that names them and gives a non-empty url, as the index holds it. */
async function registeredPaths(
  workspace: string,
  env: Record<string, string>,
): Promise<Set<string>> {
  const listed = await gitRun(
    workspace,
    ['ls-files', '-s', '-z', '--', ':(top,literal).gitmodules'],
    env,
  );
  expectOk('git ls-files', listed);
  const [meta = ''] = listed.stdout.split('\0');
  const [mode = '', oid = ''] = meta.split(/[ \t]/);
  if (mode !== '100644' && mode !== '100755') return new Set();
  const config = await gitRun(workspace, ['config', '--blob', oid, '--null', '--list'], env);
  expectOk('git config', config);
  const entries = new Map<string, { path?: string; url?: string }>();
  for (const record of config.stdout.split('\0')) {
    const newline = record.indexOf('\n');
    const key = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? '' : record.slice(newline + 1);
    const match = REGISTRATION_KEY.exec(key);
    if (!match) continue;
    const entry = entries.get(match[1]!) ?? {};
    entry[match[2] as 'path' | 'url'] = value;
    entries.set(match[1]!, entry);
  }
  const registered = new Set<string>();
  for (const entry of entries.values()) {
    if (entry.path !== undefined && (entry.url ?? '').trim() !== '') registered.add(entry.path);
  }
  return registered;
}

/**
 * `git add` passes over what these two flags hide, and `ls-files -s` does not carry them, so without
 * this the scratch add stages an edit the real add would leave out.
 */
async function copyIndexFlags(workspace: string, env: Record<string, string>): Promise<void> {
  const tagged = await gitRun(workspace, ['ls-files', '-v', '-z'], undefined, LISTING);
  expectOk('git ls-files', tagged);
  const assumed: string[] = [];
  const skipped: string[] = [];
  for (const record of tagged.stdout.split('\0')) {
    if (!record) continue;
    const tag = record.charAt(0);
    const name = record.slice(2);
    if (tag !== tag.toUpperCase()) assumed.push(name);
    if (tag.toUpperCase() === 'S') skipped.push(name);
  }
  for (const [flag, names] of [
    ['--assume-unchanged', assumed],
    ['--skip-worktree', skipped],
  ] as const) {
    if (names.length === 0) continue;
    const marked = await gitRun(
      workspace,
      [...NO_SPLIT_INDEX, 'update-index', '-z', flag, '--stdin'],
      env,
      { input: Buffer.from(`${names.join('\0')}\0`, 'latin1') },
    );
    expectOk('git update-index', marked);
  }
}

export class FlattenedRepositoryError extends Error {
  constructor(
    readonly paths: string[],
    issue?: { key: string; worktree?: string | null },
  ) {
    super(
      [
        `${issue ? `Nothing was committed for DAG issue ${issue.key}.` : 'Nothing was committed.'} A \`.git\` sits inside these tracked directories; staging their untracked files could discard repository history:`,
        ...paths.map((p) => `- ${JSON.stringify(p)}`),
        ...(issue
          ? [
              `Act in that issue's worktree${issue.worktree ? `, ${issue.worktree}` : ''}, then retry this step. The issue is not coded again; its work is committed as it stands.`,
            ]
          : []),
        'For each path, keep it out of the commit, or remove its `.git` to include the files on purpose. Then retry this step.',
      ].join('\n'),
    );
    this.name = 'FlattenedRepositoryError';
  }
}

/** Untracked files inside a tracked directory with a `.git` would be flattened by git add. */
async function refuseFlattenedRepositories(
  workspace: string,
  entries: ReturnType<typeof parsePorcelainZ>,
  excluded: string[],
): Promise<void> {
  const { anchor, prefix } = workspaceAnchor(workspace);
  const checked = new Map<string, { directory: boolean; nested: boolean }>();
  const found = new Set<string>();
  for (const entry of entries) {
    if (entry.x !== '?' || entry.y !== '?') continue;
    const file = entry.path;
    if (excluded.some((p) => file === p.slice(0, -1) || file.startsWith(p))) continue;
    const segments = file.replace(/\/$/, '').split('/');
    for (let i = 1; i < segments.length; i++) {
      const dir = segments.slice(0, i).join('/');
      let entry = checked.get(dir);
      if (entry === undefined) {
        const directory =
          (await lstatNoFollow(anchor, `${prefix}${dir}`, { strict: true }))?.kind === 'directory';
        entry = {
          directory,
          nested:
            directory &&
            (await lstatNoFollow(anchor, `${prefix}${dir}/.git`, { strict: true })) !== null,
        };
        checked.set(dir, entry);
      }
      if (!entry.directory) break;
      if (entry.nested) found.add(dir);
    }
  }
  if (found.size) throw new FlattenedRepositoryError([...found]);
}

/**
 * Index paths of gitlinks the commit about to be made would add that no `.gitmodules` entry in that
 * commit registers with a url. What `git add -A` would stage is worked out on a scratch copy of the
 * index, so the real index is never written. Throws when git cannot answer: a refusal is never skipped.
 * Throws `FlattenedRepositoryError` when the add would flatten a nested repository in a tracked directory.
 */
export async function unregisteredGitlinks(
  workspace: string,
  status: string,
  excluded: string[],
  scope?: readonly string[],
): Promise<string[]> {
  await refuseFlattenedRepositories(
    workspace,
    parsePorcelainZ(status).filter((entry) => pathInScope(entry.path, scope)),
    excluded,
  );
  return computeUnregisteredGitlinks(workspace, status, excluded, scope);
}

function pathInScope(file: string, scope?: readonly string[]): boolean {
  return (
    !scope || scope.some((p) => file === p || file.startsWith(`${p}/`) || p.startsWith(`${file}/`))
  );
}

async function computeUnregisteredGitlinks(
  workspace: string,
  status: string,
  excluded: string[],
  scope?: readonly string[],
): Promise<string[]> {
  const inScope = (file: string) => pathInScope(file, scope);
  const entries = parsePorcelainZ(status).filter((entry) => inScope(entry.path));
  const staged = (await newGitlinks(workspace)).filter(inScope);
  // A nested repository that replaces a tracked file shows as ` T path`, and one that replaces an
  // intent-to-add file as ` A path`, not as `?? path/`.
  const mayAddGitlink = entries.some(
    (e) =>
      (e.x === '?' && e.y === '?' && e.path.endsWith('/') && !excluded.includes(e.path)) ||
      e.y === 'T' ||
      e.y === 'A',
  );
  if (staged.length === 0 && !mayAddGitlink) return [];
  const name = `gate-3-gitlinks-index-${randomUUID()}`;
  const env = { GIT_INDEX_FILE: path.join(os.tmpdir(), name) };
  try {
    const listing = await gitRun(workspace, ['ls-files', '-s', '-z'], undefined, LISTING);
    expectOk('git ls-files', listing);
    const fill = await gitRun(
      workspace,
      [...NO_SPLIT_INDEX, 'update-index', '--add', '-z', '--index-info'],
      env,
      { input: Buffer.from(listing.stdout, 'latin1') },
    );
    expectOk('git update-index', fill);
    await copyIndexFlags(workspace, env);
    const batches = scope
      ? Array.from({ length: Math.ceil(scope.length / 128) }, (_, i) => [
          'add',
          '-A',
          '--',
          ...scope.slice(i * 128, (i + 1) * 128).map((p) => `:(top,literal)${p}`),
        ])
      : [stageAllArgs(excluded)];
    for (const args of batches) {
      const add = await gitRun(workspace, [...NO_SPLIT_INDEX, ...args], env);
      expectOk('git add', add);
    }
    const added = (await newGitlinks(workspace, env)).filter(inScope);
    if (added.length === 0) return [];
    const registered = await registeredPaths(workspace, env);
    return added.filter((p) => !registered.has(p));
  } finally {
    await removeNoFollow(os.tmpdir(), name).catch(() => false);
  }
}

/**
 * Without `issue` this is gate 3's text. With it, the refusal of a DAG issue commit: it names the issue
 * and where to act, that issue's worktree, and leaves out `git submodule add`, since the worktree's
 * gitfile names a host path the task terminal does not have, so git does not run there.
 */
export function unregisteredGitlinksMessage(
  paths: string[],
  issue?: { key: string; worktree?: string | null },
): string {
  return [
    issue
      ? `Nothing was committed for DAG issue ${issue.key}. These paths in its worktree are nested git repositories that are not registered as a submodule:`
      : 'Nothing was committed. These paths are nested git repositories that are not registered as a submodule:',
    ...paths.map((p) => `- ${JSON.stringify(p)}`),
    'Committing one would record only a commit id with no URL, so a clone could not fetch it.',
    ...(issue
      ? [
          `Act in that issue's worktree${issue.worktree ? `, ${issue.worktree}` : ''}, then retry this step. The issue is not coded again; its work is committed as it stands.`,
          'There are two ways out:',
          "(1) Register it as a submodule: add a `.gitmodules` entry with its path and a url to that worktree's `.gitmodules` file.",
        ]
      : [
          'There are two ways out, then retry this step:',
          '(1) Register it as a submodule: a `.gitmodules` entry with its path and a url, for example `git submodule add URL PATH`.',
        ]),
    "(2) Include its files as ordinary files by removing its nested `.git` directory (this drops that repository's own history).",
  ].join('\n');
}

/** An uploaded tree must remain onboardable even when the nested-check or warning write fails. */
export async function initialGitlinkWarnings(
  ctx: Pick<StepContext, 'repoPath' | 'logger' | 'db' | 'taskStepId'>,
): Promise<string[]> {
  try {
    const status = await gitRun(ctx.repoPath, [
      '--no-optional-locks',
      'status',
      '--porcelain',
      '-z',
      '-uall',
    ]);
    expectOk('git status', status);
    const paths = await computeUnregisteredGitlinks(ctx.repoPath, status.stdout, []);
    const warnings = paths.map(
      (p) =>
        `${JSON.stringify(p)} is a nested git repository without a registered submodule URL. The initial commit records only a commit id, so that directory will be empty in task worktrees and a clone cannot fetch it.`,
    );
    for (const warning of warnings) ctx.logger.warn(warning);
    try {
      await warnStep(ctx, warnings);
    } catch (err) {
      ctx.logger.warn({ err }, 'Could not save initial-commit warnings; continuing');
    }
    return warnings;
  } catch (err) {
    ctx.logger.warn(
      { err },
      'Could not check nested repositories before the initial commit; continuing',
    );
    return [];
  }
}
