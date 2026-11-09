import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { removeNoFollow } from '@haive/shared/fs-safe';
import {
  GIT_MAX_BUFFER,
  gitGaveNoAnswer,
  gitRun,
  type GitRunResult,
} from '../../../repo/git-exec.js';
import { parsePorcelainZ } from './_commit-diff.js';

const GITLINK_MODE = '160000';
const REGISTRATION_KEY = /^submodule\.(.+)\.(path|url)$/;
// latin1 keeps each byte of a name as one character, so a name that is not UTF-8 goes back to git as read.
const LISTING = { maxBuffer: GIT_MAX_BUFFER, encoding: 'latin1' } as const;

// A split index writes `.git/sharedindex.*` into the repository, so every scratch-index write turns it off.
const NO_SPLIT_INDEX = ['-c', 'core.splitIndex=false'] as const;

/** The argv of the gate's `git add -A`, shared by the real add and the check of what it would stage. */
export function stageAllArgs(excluded: string[]): string[] {
  return [
    'add',
    '-A',
    ...(excluded.length
      ? ['--', '.', ...excluded.map((p) => `:(top,exclude,literal)${p.slice(0, -1)}`)]
      : []),
  ];
}

function failure(what: string, res: GitRunResult): Error {
  const line = res.stderr.trim().split('\n', 1)[0] ?? '';
  return new Error(`${what} failed (exit ${res.code})${line ? `: ${line}` : ''}`);
}

function expectOk(what: string, res: GitRunResult): void {
  if (gitGaveNoAnswer(res) || res.code !== 0) throw failure(what, res);
}

async function newGitlinks(workspace: string, env?: Record<string, string>): Promise<string[]> {
  const res = await gitRun(
    workspace,
    [
      'diff-index',
      '--cached',
      '--raw',
      '-z',
      '--no-renames',
      '--ignore-submodules=none',
      '--diff-filter=AT',
      'HEAD',
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

/**
 * Index paths of gitlinks the commit about to be made would add that no `.gitmodules` entry in that
 * commit registers with a url. What `git add -A` would stage is worked out on a scratch copy of the
 * index, so the real index is never written. Throws when git cannot answer: a refusal is never skipped.
 */
export async function unregisteredGitlinks(
  workspace: string,
  status: string,
  excluded: string[],
): Promise<string[]> {
  const staged = await newGitlinks(workspace);
  // A nested repository that replaces a tracked file shows as ` T path`, and one that replaces an
  // intent-to-add file as ` A path`, not as `?? path/`.
  const mayAddGitlink = parsePorcelainZ(status).some(
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
    const add = await gitRun(workspace, [...NO_SPLIT_INDEX, ...stageAllArgs(excluded)], env);
    expectOk('git add', add);
    const added = await newGitlinks(workspace, env);
    if (added.length === 0) return [];
    const registered = await registeredPaths(workspace, env);
    return added.filter((p) => !registered.has(p));
  } finally {
    await removeNoFollow(os.tmpdir(), name).catch(() => false);
  }
}

export function unregisteredGitlinksMessage(paths: string[]): string {
  return [
    'Nothing was committed. These paths are nested git repositories that are not registered as a submodule:',
    ...paths.map((p) => `- ${JSON.stringify(p)}`),
    'Committing one would record only a commit id with no URL, so a clone could not fetch it.',
    'There are two ways out, then retry this step:',
    '(1) Register it as a submodule: a `.gitmodules` entry with its path and a url, for example `git submodule add URL PATH`.',
    "(2) Include its files as ordinary files by removing its nested `.git` directory (this drops that repository's own history).",
  ].join('\n');
}
