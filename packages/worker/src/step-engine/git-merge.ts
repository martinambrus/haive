import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { schema, type Database } from '@haive/database';
import {
  chownNoFollow,
  isPathContainmentError,
  lstatNoFollow,
  readdirNoFollow,
  readLinkNoFollow,
  readTextNoFollow,
  removeNoFollow,
  renameNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import {
  secretMaskDeniesPath,
  type SecretMaskPolicy,
} from '../queues/cli-exec/secret-mask-policy.js';
import { ensureGitExcludeEntry } from '../repo/git-init.js';
import { gitRun, type GitRunResult } from '../repo/git-push.js';
import { HOST_REPO_ROOT } from '../repo/worktree-git-boundary.js';
import { workspaceAnchor } from '../repo/worktree-paths.js';
import { REPO_IS_DATA_MERGE_LINES, safeRef, safeTitle } from './steps/_untrusted-repo.js';

// Shared git-merge / conflict-resolution core. Extracted from dag-executor.ts so
// both the DAG executor (issue branches -> integration branch) and the
// worktree-cleanup merge phase (feature branch -> base branch) drive an identical
// host-side completion: the fix agent edits the conflicted files in the sandbox
// (git is unavailable there), then the host verifies the markers are gone, stages,
// and commits.

/** True once `branch` is merged into `worktreePath`'s HEAD: an aborted merge also leaves no
 *  MERGE_HEAD and nothing unmerged, so what marks a commit is that the branch is in HEAD. */
export async function mergeCommitted(worktreePath: string, branch: string): Promise<boolean> {
  const head = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (head.code === 0) return false; // merge still open (not committed)
  const status = await gitRun(worktreePath, ['--no-optional-locks', 'status', '--porcelain']);
  const unmerged = status.stdout.split('\n').some((l) => /^(DD|AU|UD|UA|DU|AA|UU) /.test(l));
  if (unmerged) return false;
  const ancestor = await gitRun(worktreePath, ['merge-base', '--is-ancestor', branch, 'HEAD']);
  return ancestor.code === 0;
}

function nulPaths(out: string): string[] {
  return [...new Set(out.split('\0').filter(Boolean))];
}

/** The paths still unmerged in `dir`, or null when git could not list them. Read with `-z`: without
 *  it git quotes a name holding a quote or a non-ASCII byte, and the quoted form names no file. */
export async function unmergedPaths(dir: string): Promise<string[] | null> {
  const res = await gitRun(dir, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return res.code === 0 ? nulPaths(res.stdout) : null;
}

async function revParse(dir: string, spec: string): Promise<string | null> {
  const res = await gitRun(dir, ['rev-parse', '-q', '--verify', spec]);
  return res.code === 0 ? res.stdout.trim() : null;
}

/** True while a merge of `ref` is open in `dir`. */
export async function mergeOpenFor(dir: string, ref: string): Promise<boolean> {
  const head = await revParse(dir, 'MERGE_HEAD');
  return head !== null && head === (await revParse(dir, `${ref}^{commit}`));
}

function gitDetail(res: GitRunResult): string {
  return (res.stderr || res.stdout).trim().split('\n').slice(0, 3).join(' ').slice(0, 300);
}

export type MergeOpen =
  { kind: 'merged' } | { kind: 'conflict' } | { kind: 'refused'; detail: string };

/** Merge `ref` into the branch checked out in `dir`. A conflict leaves MERGE_HEAD naming `ref`; a
 *  merge git refused (local changes or an untracked file in the way, a ref it cannot resolve) leaves
 *  none, and exits with the same codes a conflict does. */
export async function openMerge(
  dir: string,
  ref: string,
  flags: string[],
  env: Record<string, string>,
): Promise<MergeOpen> {
  const res = await gitRun(dir, ['merge', '--no-ff', ...flags, ref], env);
  if (res.code === 0) return { kind: 'merged' };
  if (await mergeOpenFor(dir, ref)) return { kind: 'conflict' };
  return { kind: 'refused', detail: gitDetail(res) };
}

export type MergeAbort = { ok: true } | { ok: false; blocking: string[]; detail: string };

/** A person's own checkout, mounted from the host: Haive discards nothing there. */
function isHostCheckout(dir: string): boolean {
  return dir === HOST_REPO_ROOT || dir.startsWith(`${HOST_REPO_ROOT}/`);
}

/** Paths the merge staged and something edited since, which is what makes `merge --abort` refuse. */
async function stagedThenEdited(dir: string): Promise<string[] | null> {
  const [staged, edited, unmerged] = await Promise.all([
    gitRun(dir, ['diff', '--cached', '--name-only', '-z']),
    gitRun(dir, ['diff', '--name-only', '-z']),
    unmergedPaths(dir),
  ]);
  if (staged.code !== 0 || edited.code !== 0 || unmerged === null) return null;
  const changed = new Set(nulPaths(edited.stdout));
  const open = new Set(unmerged);
  return nulPaths(staged.stdout).filter((p) => changed.has(p) && !open.has(p));
}

const PATHSPEC_CHUNK = 100;

/** End the merge open in `dir`, leaving the tree as the merge found it. `merge --abort` refuses once
 *  a file the merge staged is edited (a fixer's edit to a cleanly merged file), so those edits are
 *  put back from the index and the abort is tried again. In a host checkout nothing is put back and
 *  the paths are reported instead. */
export async function abortMerge(dir: string): Promise<MergeAbort> {
  if ((await revParse(dir, 'MERGE_HEAD')) === null) return { ok: true };
  const first = await gitRun(dir, ['merge', '--abort']);
  if ((await revParse(dir, 'MERGE_HEAD')) === null) return { ok: true };
  const blocking = (await stagedThenEdited(dir)) ?? [];
  if (blocking.length === 0 || isHostCheckout(dir)) {
    return { ok: false, blocking, detail: gitDetail(first) };
  }
  for (let i = 0; i < blocking.length; i += PATHSPEC_CHUNK) {
    const restore = await gitRun(
      dir,
      ['checkout', '--', ...blocking.slice(i, i + PATHSPEC_CHUNK)],
      { GIT_LITERAL_PATHSPECS: '1' },
    );
    if (restore.code !== 0) return { ok: false, blocking, detail: gitDetail(restore) };
  }
  const second = await gitRun(dir, ['merge', '--abort']);
  if ((await revParse(dir, 'MERGE_HEAD')) === null) return { ok: true };
  return {
    ok: false,
    blocking: (await stagedThenEdited(dir)) ?? blocking,
    detail: gitDetail(second),
  };
}

/** Clear the way to open a merge of `ref` in `dir`. A merge open for anything else is a stale
 *  attempt and is aborted, or in a host checkout the person's own, left alone and refused. */
export async function abortOtherMerge(dir: string, ref: string): Promise<MergeAbort> {
  const head = await revParse(dir, 'MERGE_HEAD');
  if (head === null || (await mergeOpenFor(dir, ref))) return { ok: true };
  if (isHostCheckout(dir)) {
    return {
      ok: false,
      blocking: [],
      detail: `a merge of ${head.slice(0, 12)} is already in progress there`,
    };
  }
  return abortMerge(dir);
}

/** One line naming what an abort could not undo, for a halt message. */
export function abortFailureNote(abort: { blocking: string[]; detail: string }): string {
  const shown = abort.blocking.slice(0, 5).map((p) => JSON.stringify(p));
  const more =
    abort.blocking.length > shown.length ? ` and ${abort.blocking.length - shown.length} more` : '';
  const paths =
    shown.length > 0 ? ` (changed after the merge staged them: ${shown.join(', ')}${more})` : '';
  return `The merge could not be aborted${paths}: ${abort.detail || 'git gave no reason'}. It is still open; abort or finish it by hand, then retry.`;
}

/** What a merge dir held when a fixer was sent in: the worktree as one git tree (tracked files and
 *  the untracked ones git does not ignore), what the merge had staged, a blob listing what git
 *  ignored, the paths the fixer was sent to resolve, and the merge it was sent into. */
export interface FixBaseline {
  tree: string;
  index: string;
  ignored: string;
  resolving: string[];
  head: string;
  mergeHead: string;
}

/** A baseline git could not record, kept so the relocation says why it checked nothing. */
export interface FixBaselineUnavailable {
  unavailable: string;
}

type TreeResult = { tree: string } | { error: string };

/** Listings name every file, and latin1 keeps each byte of a name as one character, so a name that
 *  is not UTF-8 compares and is written back as it was read. */
const LISTING = { maxBuffer: 64 * 1024 * 1024, encoding: 'latin1' } as const;

/** True when `p`, or a directory holding it, is one of `entries`. */
function covered(entries: ReadonlySet<string>, p: string): boolean {
  const rel = p.replace(/\/$/, '');
  if (entries.has(rel)) return true;
  for (let i = rel.indexOf('/'); i !== -1; i = rel.indexOf('/', i + 1)) {
    if (entries.has(rel.slice(0, i))) return true;
  }
  return false;
}

/** What git ignores in the worktree, kept as a blob so the baseline stays a few object ids.
 *  `--ignored=matching` names a directory only when a rule ignores the directory itself, and git
 *  cannot re-include anything under one, so a file created there later was ignored too. */
async function recordIgnored(dir: string): Promise<{ blob: string } | { error: string }> {
  const listed = await gitRun(
    dir,
    [
      '--no-optional-locks',
      'status',
      '--porcelain=v1',
      '-z',
      '--ignored=matching',
      '--untracked-files=normal',
      '--no-renames',
      '--ignore-submodules=all',
    ],
    undefined,
    LISTING,
  );
  if (listed.code !== 0) return { error: gitDetail(listed) };
  const entries = listed.stdout
    .split('\0')
    .filter((e) => e.startsWith('!! '))
    .map((e) => e.slice(3));
  const name = `haive-merge-snapshot-${randomUUID()}`;
  try {
    await writeFileNoFollow(os.tmpdir(), name, Buffer.from(entries.join('\0'), 'latin1'));
    const blob = await gitRun(dir, [
      'hash-object',
      '-w',
      '--no-filters',
      '--',
      path.join(os.tmpdir(), name),
    ]);
    return blob.code === 0 ? { blob: blob.stdout.trim() } : { error: gitDetail(blob) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    await removeNoFollow(os.tmpdir(), name).catch(() => false);
  }
}

async function readIgnored(dir: string, blob: string): Promise<Set<string> | { error: string }> {
  const res = await gitRun(dir, ['cat-file', 'blob', blob], undefined, LISTING);
  if (res.code !== 0) return { error: gitDetail(res) };
  return new Set(
    res.stdout
      .split('\0')
      .filter((e) => e !== '')
      .map((e) => e.replace(/\/$/, '')),
  );
}

/** Where the globs the sandbox masks with come from. Read at each snapshot, so a file created since
 *  the baseline is judged too. */
export type SecretMaskSource = () => Promise<SecretMaskPolicy | null>;

async function readMaskPolicy(
  source: SecretMaskSource,
): Promise<{ policy: SecretMaskPolicy | null } | { error: string }> {
  try {
    return { policy: await source() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

type RawBytes = { args: string[]; env: Record<string, string> };

/** Attributes read from the empty tree, no autocrlf and file modes honoured, so a snapshot stores
 *  a file as it is and a restore writes it back as it was: a clean filter or a line-ending
 *  conversion would record other bytes than the fixer found, and `core.fileMode=false` would hide
 *  a chmod. GIT_ATTR_SOURCE needs git 2.40; an older git applies the attributes as before. */
async function rawBytes(dir: string): Promise<RawBytes | { error: string }> {
  const empty = await gitRun(dir, ['hash-object', '-t', 'tree', '/dev/null']);
  if (empty.code !== 0) return { error: gitDetail(empty) };
  return {
    args: ['-c', 'core.autocrlf=false', '-c', 'core.fileMode=true'],
    env: { GIT_ATTR_SOURCE: empty.stdout.trim() },
  };
}

/** The worktree as one git tree, untracked files included and ignored ones left out. Built in a
 *  scratch index, since the merge's own index holds the conflict. An untracked file the sandbox
 *  masks is left out too: at a same-branch root the fixer's sandbox holds `.git`, and could read a
 *  masked file back from the blob a snapshot wrote. Read against a baseline, every path the
 *  baseline holds is read as it stands, whatever the ignore rules say now, and a file new since
 *  counts only when git ignored it neither then nor now: a fixer's `.gitignore` edit turns no
 *  ignored file into a new one and hides no recorded one. */
async function snapshotTree(
  dir: string,
  opts: {
    raw: RawBytes;
    secrets: SecretMaskPolicy | null;
    since?: { tree: string; ignored: ReadonlySet<string> };
  },
): Promise<TreeResult> {
  const { raw, secrets, since } = opts;
  const name = `haive-merge-snapshot-${randomUUID()}`;
  const env = { GIT_INDEX_FILE: path.join(os.tmpdir(), name) };
  const listName = `haive-merge-snapshot-${randomUUID()}`;
  try {
    const read = await gitRun(dir, ['read-tree', since?.tree ?? 'HEAD'], env);
    if (read.code !== 0) return { error: gitDetail(read) };
    const update = await gitRun(dir, [...raw.args, 'add', '-u'], { ...env, ...raw.env });
    if (update.code !== 0) return { error: gitDetail(update) };
    const others = await gitRun(dir, ['ls-files', '-z', '-o', '--exclude-standard'], env, LISTING);
    if (others.code !== 0) return { error: gitDetail(others) };
    const added = others.stdout
      .split('\0')
      .filter(
        (p) =>
          p !== '' &&
          !(since && covered(since.ignored, p)) &&
          !(secrets && secretMaskDeniesPath(secrets, Buffer.from(p, 'latin1').toString('utf8'))),
      );
    if (added.length > 0) {
      await writeFileNoFollow(os.tmpdir(), listName, Buffer.from(added.join('\0'), 'latin1'));
      const res = await gitRun(
        dir,
        [
          ...raw.args,
          'add',
          `--pathspec-from-file=${path.join(os.tmpdir(), listName)}`,
          '--pathspec-file-nul',
        ],
        { ...env, ...raw.env, GIT_LITERAL_PATHSPECS: '1' },
      );
      if (res.code !== 0) return { error: gitDetail(res) };
    }
    const tree = await gitRun(dir, ['write-tree'], env);
    return tree.code === 0 ? { tree: tree.stdout.trim() } : { error: gitDetail(tree) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    await removeNoFollow(os.tmpdir(), name).catch(() => false);
    await removeNoFollow(os.tmpdir(), listName).catch(() => false);
  }
}

/** What the merge staged, as one tree: HEAD with the index's resolved changes applied and the
 *  conflicted paths left as HEAD has them. Built from the changes alone, so it costs what the merge
 *  changed rather than what the repository holds. */
async function stagedTree(dir: string): Promise<TreeResult> {
  const changes = await gitRun(dir, ['diff-index', '--cached', '-z', '--no-renames', 'HEAD']);
  if (changes.code !== 0) return { error: gitDetail(changes) };
  const name = `haive-merge-snapshot-${randomUUID()}`;
  const env = { GIT_INDEX_FILE: path.join(os.tmpdir(), name) };
  try {
    const read = await gitRun(dir, ['read-tree', 'HEAD'], env);
    if (read.code !== 0) return { error: gitDetail(read) };
    const put: string[] = [];
    const drop: string[] = [];
    for (const c of rawChanges(changes.stdout)) {
      if (c.status === 'U') continue;
      if (c.status === 'D') drop.push(c.path);
      else put.push(`${c.dstMode},${c.dstSha},${c.path}`);
    }
    // Removals first: a directory/file conflict replaces HEAD's `foo` with `foo/bar`, and the
    // index refuses the new path while the old one stands.
    for (let i = 0; i < drop.length; i += PATHSPEC_CHUNK) {
      const paths = drop.slice(i, i + PATHSPEC_CHUNK);
      const res = await gitRun(dir, ['update-index', '--force-remove', '--', ...paths], env);
      if (res.code !== 0) return { error: gitDetail(res) };
    }
    for (let i = 0; i < put.length; i += PATHSPEC_CHUNK) {
      const infos = put.slice(i, i + PATHSPEC_CHUNK).flatMap((p) => ['--cacheinfo', p]);
      const res = await gitRun(dir, ['update-index', '--add', ...infos], env);
      if (res.code !== 0) return { error: gitDetail(res) };
    }
    const tree = await gitRun(dir, ['write-tree'], env);
    return tree.code === 0 ? { tree: tree.stdout.trim() } : { error: gitDetail(tree) };
  } finally {
    await removeNoFollow(os.tmpdir(), name).catch(() => false);
  }
}

/** The paths a fixer is sent to resolve: those git left unmerged, and for a directory/file conflict
 *  the path the file was moved away from. git gives the file a name of its own, reports only that
 *  and stages the directory side, so keeping the file means deleting the directory and putting the
 *  file back at its path. The partner is found by content, never by the name git chose: the same
 *  blob stands beside the moved file on its side, where the other side holds a directory, and its
 *  side changed it since the merge base: git takes the directory cleanly where it did not. */
async function resolvingPaths(dir: string, unmerged: string[]): Promise<string[] | null> {
  if (unmerged.length === 0) return [];
  const listed = await gitRun(dir, ['ls-files', '-u', '-z'], undefined, {
    maxBuffer: LISTING.maxBuffer,
  });
  if (listed.code !== 0) return null;
  const stages = new Map<string, Map<string, string>>();
  for (const record of listed.stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [, sha = '', stage = ''] = record.slice(0, tab).split(' ');
    const p = record.slice(tab + 1);
    stages.set(p, (stages.get(p) ?? new Map()).set(stage, sha));
  }
  const partners = new Set<string>();
  let base: string | null | undefined;
  for (const [p, byStage] of stages) {
    for (const [stage, side, other] of [
      ['2', 'HEAD', 'MERGE_HEAD'],
      ['3', 'MERGE_HEAD', 'HEAD'],
    ] as const) {
      const blob = byStage.get(stage);
      if (!blob || byStage.has(stage === '2' ? '3' : '2')) continue;
      const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
      const siblings = await gitRun(
        dir,
        ['ls-tree', '-z', side, ...(parent ? ['--', parent] : [])],
        {
          GIT_LITERAL_PATHSPECS: '1',
        },
      );
      if (siblings.code !== 0) return null;
      for (const entry of siblings.stdout.split('\0')) {
        const tab = entry.indexOf('\t');
        if (tab === -1) continue;
        const [, type, object] = entry.slice(0, tab).split(' ');
        const sibling = entry.slice(tab + 1);
        if (sibling === p || type !== 'blob' || object !== blob) continue;
        if (base === undefined) {
          const found = await gitRun(dir, ['merge-base', 'HEAD', 'MERGE_HEAD']);
          base = found.code === 0 ? found.stdout.trim() : null;
        }
        if (base !== null) {
          const was = await gitRun(dir, ['rev-parse', '-q', '--verify', `${base}:${sibling}`]);
          if (was.code === 0 && was.stdout.trim() === object) continue;
        }
        const kind = await gitRun(dir, ['cat-file', '-t', `${other}:${sibling}`]);
        if (kind.code === 0 && kind.stdout.trim() === 'tree') partners.add(sibling);
      }
    }
  }
  return [...new Set([...unmerged, ...partners])];
}

/** Record the tree before a fixer is sent into it, so what the fixer changes outside the conflict
 *  can be told from the merge and from what stood there already. Null for a person's own checkout,
 *  which the sandbox mounts read-only. What git could not record is kept as its reason, so the
 *  relocation reports it rather than reading the fixer's changes as none. */
export async function captureFixBaseline(
  dir: string,
  secrets: SecretMaskSource,
): Promise<FixBaseline | FixBaselineUnavailable | null> {
  if (isHostCheckout(dir)) return null;
  // `.haive/` holds other tasks' worktrees and earlier leftovers; excluded, no snapshot reads them.
  await ensureGitExcludeEntry(workspaceAnchor(dir).anchor).catch(() => undefined);
  const [head, mergeHead, unmerged] = await Promise.all([
    revParse(dir, 'HEAD'),
    revParse(dir, 'MERGE_HEAD'),
    unmergedPaths(dir),
  ]);
  const resolving = unmerged === null ? null : await resolvingPaths(dir, unmerged);
  if (head === null || mergeHead === null || resolving === null) {
    return { unavailable: 'git could not read the merge' };
  }
  const masked = await readMaskPolicy(secrets);
  if ('error' in masked) {
    return { unavailable: `the secret mask could not be read: ${masked.error}` };
  }
  const raw = await rawBytes(dir);
  if ('error' in raw) return { unavailable: `git could not record the tree: ${raw.error}` };
  const tree = await snapshotTree(dir, { raw, secrets: masked.policy });
  if ('error' in tree) return { unavailable: `git could not record the tree: ${tree.error}` };
  const ignored = await recordIgnored(dir);
  if ('error' in ignored) {
    return { unavailable: `git could not record the ignored files: ${ignored.error}` };
  }
  const index = await stagedTree(dir);
  if ('error' in index) return { unavailable: `git could not record the index: ${index.error}` };
  return { tree: tree.tree, index: index.tree, ignored: ignored.blob, resolving, head, mergeHead };
}

export interface FixerLeftovers {
  /** The attempt's folder, relative to the repository root. */
  folder: string;
  moved: string[];
  /** Changes left where they are, with why, and a link's target, which is all a link holds. */
  left: { path: string; reason: string; target?: string }[];
  /** Index entries the fixer staged outside the conflict, put back as the merge had them, with the
   *  blob each held (null for a staged deletion). */
  unstaged: { path: string; blob: string | null }[];
  /** Files deleted outside the conflict and put back, so a deletion is reported like any change. */
  restored: string[];
  /** Set when git could not say what the fixer changed, so part or all of it went unchecked. */
  unchecked?: string;
}

export const MERGE_LEFTOVERS_DIR = '.haive/merge-leftovers';
const GITLINK_MODE = '160000';
const NULL_SHA = /^0+$/;

/** Haive's own directories, which other writers keep: a relocation never touches them. */
function haiveOwned(p: string): boolean {
  return p === '.haive' || p.startsWith('.haive/') || p.startsWith('.haive-data/');
}

/** `diff-tree` / `diff-index` `-z` raw records; `--no-renames` keeps each to one path. */
function rawChanges(
  out: string,
): { srcMode: string; dstMode: string; dstSha: string; status: string; path: string }[] {
  const parts = out.split('\0');
  const changes = [];
  for (let i = 0; i + 1 < parts.length && parts[i]!.startsWith(':'); i += 2) {
    const [srcMode = '', dstMode = '', , dstSha = '', status = ''] = parts[i]!.slice(1).split(' ');
    changes.push({ srcMode, dstMode, dstSha, status: status.charAt(0), path: parts[i + 1]! });
  }
  return changes;
}

/** The directories a restore of `paths` will create: their parents that are missing now. */
async function missingParents(anchor: string, prefix: string, paths: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join('/');
      if (seen.has(parent)) continue;
      seen.add(parent);
      if ((await lstatNoFollow(anchor, `${prefix}${parent}`).catch(() => undefined)) === null) {
        missing.push(parent);
      }
    }
  }
  return missing;
}

/** A path left where it is, with the target of a link, since a scratch worktree removed later takes
 *  the link with it. */
async function leftEntry(
  anchor: string,
  prefix: string,
  p: string,
  reason: string,
): Promise<FixerLeftovers['left'][number]> {
  const target = await readLinkNoFollow(anchor, `${prefix}${p}`).catch(() => null);
  return target === null ? { path: p, reason } : { path: p, reason, target };
}

/** The paths to put back where a directory now stands that still holds something. git replaces
 *  such a directory with the file and takes what is in it along. */
async function occupiedDirectories(
  anchor: string,
  prefix: string,
  paths: string[],
): Promise<Set<string>> {
  const occupied = new Set<string>();
  for (const p of paths) {
    const entry = await lstatNoFollow(anchor, `${prefix}${p}`).catch(() => null);
    if (entry?.kind !== 'directory') continue;
    const inside = await readdirNoFollow(anchor, `${prefix}${p}`).catch(() => null);
    if (inside === null || inside.length > 0) occupied.add(p);
  }
  return occupied;
}

/** git writes what it puts back as this process, where the sandbox user owned what stood there: the
 *  restored files, and the directories git created for them, go back to the tree's owner. A
 *  directory that already stood keeps its own. */
async function giveBack(
  anchor: string,
  prefix: string,
  entries: string[],
  owner: { uid: number; gid: number },
): Promise<void> {
  for (const e of entries) {
    await chownNoFollow(anchor, `${prefix}${e}`, owner).catch(() => undefined);
  }
}

/** Move what a fixer changed outside the paths it was sent to resolve out of `dir`, into
 *  `<folder>/files/`, and put those paths back as the baseline had them, so neither the next fixer
 *  nor the merge commit inherits them. A path that cannot be moved (a link, a name git could not
 *  decode) stays in the tree and is reported. What the fixer staged outside those paths is put back
 *  in the index too, since the commit takes the whole index. The index is refreshed afterwards,
 *  since git rewrites the files and `merge --abort` refuses an entry whose stat data no longer
 *  matches. */
export async function relocateFixerChanges(
  dir: string,
  baseline: FixBaseline | FixBaselineUnavailable | null | undefined,
  run: { taskId: string; runId: string },
  secrets: SecretMaskSource,
): Promise<FixerLeftovers | null> {
  if (!baseline || isHostCheckout(dir)) return null;
  const folder = `${MERGE_LEFTOVERS_DIR}/${run.taskId}/${run.runId}`;
  const nothingChecked = (reason: string): FixerLeftovers => ({
    folder,
    moved: [],
    left: [],
    unstaged: [],
    restored: [],
    unchecked: reason,
  });
  if ('unavailable' in baseline) {
    return nothingChecked(`nothing was recorded before it ran (${baseline.unavailable})`);
  }
  // Once the merge was finished or aborted by hand the baseline no longer describes the tree, and
  // putting its paths back would write merged files into a tree with no merge open.
  if (
    (await revParse(dir, 'HEAD')) !== baseline.head ||
    (await revParse(dir, 'MERGE_HEAD')) !== baseline.mergeHead
  ) {
    return nothingChecked('the merge it was sent into is no longer open');
  }
  const masked = await readMaskPolicy(secrets);
  if ('error' in masked)
    return nothingChecked(`the secret mask could not be read: ${masked.error}`);
  const raw = await rawBytes(dir);
  if ('error' in raw) return nothingChecked(`git could not read the tree: ${raw.error}`);
  const ignored = await readIgnored(dir, baseline.ignored);
  if ('error' in ignored) {
    return nothingChecked(`git could not read what it ignored before it ran: ${ignored.error}`);
  }
  const after = await snapshotTree(dir, {
    raw,
    secrets: masked.policy,
    since: { tree: baseline.tree, ignored },
  });
  if ('error' in after) return nothingChecked(`git could not read the tree: ${after.error}`);
  const { anchor, prefix } = workspaceAnchor(dir);
  const tree = await lstatNoFollow(anchor, prefix.replace(/\/$/, ''), { strict: true }).catch(
    () => null,
  );
  const owner = tree ? { uid: tree.stats.uid, gid: tree.stats.gid } : undefined;
  const resolving = new Set(baseline.resolving);
  const outside = (c: { srcMode: string; dstMode: string; path: string }): boolean =>
    !covered(resolving, c.path) &&
    !haiveOwned(c.path) &&
    c.srcMode !== GITLINK_MODE &&
    c.dstMode !== GITLINK_MODE;
  const moved: string[] = [];
  const left: FixerLeftovers['left'] = [];
  const restore: string[] = [];
  const deleted = new Set<string>();
  if (after.tree !== baseline.tree) {
    const diff = await gitRun(dir, [
      'diff-tree',
      '-r',
      '-z',
      '--no-renames',
      baseline.tree,
      after.tree,
    ]);
    if (diff.code !== 0) return nothingChecked(gitDetail(diff));
    for (const c of rawChanges(diff.stdout)) {
      if (!outside(c)) continue;
      if (c.path.includes('�')) {
        left.push({ path: c.path, reason: 'its name is not UTF-8' });
        continue;
      }
      if (c.status !== 'D') {
        try {
          await renameNoFollow(anchor, `${prefix}${c.path}`, `${folder}/files/${c.path}`, {
            noReplace: true,
            createParents: true,
            owner,
          });
          moved.push(c.path);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          left.push(await leftEntry(anchor, prefix, c.path, reason));
          continue;
        }
      }
      if (c.status === 'D') deleted.add(c.path);
      if (c.status !== 'A') restore.push(c.path);
    }
  }
  const occupied = await occupiedDirectories(anchor, prefix, restore);
  for (const p of occupied) {
    left.push({
      path: p,
      reason: 'not put back: a directory stands in its place, holding what could not be moved',
    });
  }
  const putBack = restore.filter((p) => !occupied.has(p));
  const restored: string[] = [];
  for (let i = 0; i < putBack.length; i += PATHSPEC_CHUNK) {
    const chunk = putBack.slice(i, i + PATHSPEC_CHUNK);
    const created = owner ? await missingParents(anchor, prefix, chunk) : [];
    const res = await gitRun(
      dir,
      [...raw.args, 'restore', `--source=${baseline.tree}`, '--worktree', '--', ...chunk],
      { ...raw.env, GIT_LITERAL_PATHSPECS: '1' },
    );
    if (res.code !== 0) {
      for (const p of chunk) left.push({ path: p, reason: `not put back: ${gitDetail(res)}` });
      continue;
    }
    restored.push(...chunk.filter((p) => deleted.has(p)));
    if (owner) await giveBack(anchor, prefix, [...created, ...chunk], owner);
  }
  const unstaged: FixerLeftovers['unstaged'] = [];
  let indexUnchecked: string | undefined;
  const staged = await gitRun(dir, [
    'diff-index',
    '--cached',
    '-z',
    '--no-renames',
    baseline.index,
  ]);
  if (staged.code !== 0) {
    indexUnchecked = `git could not read the index: ${gitDetail(staged)}`;
  } else {
    const unstage: { path: string; blob: string | null }[] = [];
    for (const c of rawChanges(staged.stdout)) {
      // Haive's own paths and gitlinks stay in the tree, but `commit` takes the whole index.
      if (c.status === 'U' || covered(resolving, c.path)) continue;
      if (c.path.includes('�')) {
        left.push({ path: c.path, reason: 'staged, and its name is not UTF-8' });
        continue;
      }
      unstage.push({ path: c.path, blob: NULL_SHA.test(c.dstSha) ? null : c.dstSha });
    }
    for (let i = 0; i < unstage.length; i += PATHSPEC_CHUNK) {
      const chunk = unstage.slice(i, i + PATHSPEC_CHUNK);
      const res = await gitRun(
        dir,
        ['restore', '--staged', `--source=${baseline.index}`, '--', ...chunk.map((u) => u.path)],
        { GIT_LITERAL_PATHSPECS: '1' },
      );
      if (res.code !== 0) {
        for (const u of chunk)
          left.push({ path: u.path, reason: `still staged: ${gitDetail(res)}` });
      } else {
        unstaged.push(...chunk);
      }
    }
  }
  if (putBack.length > 0 || unstaged.length > 0) {
    await gitRun(dir, ['update-index', '-q', '--refresh']);
  }
  if (
    moved.length === 0 &&
    restored.length === 0 &&
    left.length === 0 &&
    unstaged.length === 0 &&
    !indexUnchecked
  ) {
    return null;
  }
  const manifest = {
    dir: prefix.replace(/\/$/, '') || '.',
    baseline: baseline.tree,
    after: after.tree,
    moved,
    restored,
    left,
    unstaged,
  };
  await writeFileNoFollow(
    anchor,
    `${folder}/manifest.json`,
    `${JSON.stringify(manifest, null, 2)}\n`,
    { createParents: true, owner },
  ).catch(() => undefined);
  return {
    folder,
    moved,
    left,
    unstaged,
    restored,
    ...(indexUnchecked ? { unchecked: indexUnchecked } : {}),
  };
}

/** One event per relocation, so every attempt's leftovers stay findable from the Activity tab. */
export async function recordFixerLeftovers(
  db: Database,
  taskId: string,
  taskStepId: string,
  branch: string,
  leftovers: FixerLeftovers,
): Promise<void> {
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId,
    eventType: 'merge.fixer_leftovers',
    payload: {
      branch,
      folder: leftovers.folder,
      moved: leftovers.moved.slice(0, 50),
      movedCount: leftovers.moved.length,
      left: leftovers.left.slice(0, 20),
      leftCount: leftovers.left.length,
      unstaged: leftovers.unstaged.slice(0, 50),
      unstagedCount: leftovers.unstaged.length,
      restored: leftovers.restored.slice(0, 50),
      restoredCount: leftovers.restored.length,
      ...(leftovers.unchecked ? { unchecked: leftovers.unchecked } : {}),
    },
  });
}

/** The step's warning. It names the task's folder rather than one attempt's, since every attempt
 *  adds its own. */
export function fixerLeftoversWarning(taskId: string, leftovers: FixerLeftovers): string {
  if (leftovers.unchecked) {
    return `Could not check what a merge fixer changed outside the conflicted files: ${leftovers.unchecked}.`;
  }
  const folder = `${MERGE_LEFTOVERS_DIR}/${taskId}/`;
  const notes: string[] = [];
  if (leftovers.moved.length > 0 || leftovers.left.length > 0) {
    notes.push(
      `A merge fixer changed files outside the conflicted ones, and none of them was committed. They were moved to ${folder}, a folder per attempt whose manifest.json also names any it could not move, with each link's target.`,
    );
  }
  if (leftovers.restored.length > 0) {
    notes.push(
      `A merge fixer deleted files outside the conflicted ones, and they were put back; the manifest.json in ${folder} names each.`,
    );
  }
  if (leftovers.unstaged.length > 0) {
    notes.push(
      `A merge fixer staged changes outside the conflicted files, and they were taken back out of the index before the commit; the manifest.json in ${folder} names each blob it had staged.`,
    );
  }
  return notes.join(' ');
}

/** Build the conflict-resolution agent's prompt. `title` is an optional
 *  human-readable label for the branch; `guidance` is the user's free-text answer
 *  to a prior clarification (omitted when none). The static instructions are the
 *  contract the host relies on — the agent edits files only, the host stages and
 *  commits afterward. */
export function buildMergeFixPrompt(branch: string, title?: string, guidance?: string): string {
  return [
    'A git merge conflict occurred while merging an implemented issue branch into the integration branch.',
    'Your working directory is the integration worktree, MID-MERGE — the conflict markers are live in the files.',
    `Conflicting branch: ${safeRef(branch)}${title ? ` (${safeTitle(title)})` : ''}.`,
    '',
    // Its OWN variant, not the coder's. This agent edits files and the host stages and commits
    // the result, so it needs the tree-is-data protection — but the acting variant tells an
    // agent to disregard instructions about how to behave, and `guidance` below is exactly
    // that AND legitimate: merge-resolver asks the USER how to resolve the conflict and passes
    // the answer through. "Take ours for the generated file" is behavioural, human and
    // authoritative, so the coder text would have pitted the guard against the operator.
    //
    // Spread rather than joined: this array is NOT `.filter(Boolean)`-ed, so blank lines live.
    ...REPO_IS_DATA_MERGE_LINES,
    ...(guidance ? ['', `User guidance for resolving this conflict: ${guidance}`] : []),
    '',
    'Resolve EVERY conflict by EDITING the conflicted files: remove the <<<<<<< / ======= / >>>>>>> markers',
    "and combine both sides as the implementation intends; don't drop either side's work.",
    'Change no other file: only the conflicted files are committed, and anything else you change is',
    'moved out of the tree.',
    'Do NOT run git — it is unavailable in this environment; the orchestrator stages and commits the merge',
    'after you finish. Do NOT run tests or any other commands.',
    'When every conflict marker is gone from the files, stop.',
  ].join('\n');
}

/** Complete a mid-merge in `worktreePath` after a fix agent edited the conflicted
 *  files. The agent cannot run git (the worktree's absolute gitdir path does not
 *  exist inside the sandbox), so the host verifies no conflict markers remain in
 *  the previously-unmerged paths, stages, and commits. Returns true when the merge
 *  commit landed. */
export async function completeMergeHostSide(
  worktreePath: string,
  gitEnv: Record<string, string>,
  branch: string,
): Promise<boolean> {
  // Fast path: already committed (e.g. an environment where git did work).
  if (await mergeCommitted(worktreePath, branch)) return true;
  const head = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (head.code !== 0) return false; // merge no longer open and not committed
  const files = await unmergedPaths(worktreePath);
  if (files === null) return false;
  const resolving = await resolvingPaths(worktreePath, files);
  if (resolving === null) return false;
  // The worktree is under `.haive/`, which the sandbox mounts read-write, so it is SPLIT rather
  // than used as the anchor: every path git reported is walked a component at a time.
  const { anchor, prefix } = workspaceAnchor(worktreePath);
  for (const f of files) {
    // A name that is not UTF-8 decodes to one naming no file, which would read as deleted.
    if (f.includes('\uFFFD')) return false;
    let content: string | null;
    try {
      content = await readTextNoFollow(anchor, `${prefix}${f}`, { strict: true });
    } catch (err) {
      // A REFUSAL must not collapse into the `null` below, which means "deleted as part of the
      // resolution" and lets the commit proceed: a path we cannot read is one whose conflict
      // markers we cannot check, so the merge stays incomplete instead. Every other read failure
      // keeps its old meaning, since `.catch(() => null)` treated those as resolved-by-deletion.
      if (isPathContainmentError(err)) return false;
      content = null;
    }
    if (content === null) continue; // deleted as part of the resolution
    if (/^(<{7}|>{7})( |$)/m.test(content)) return false; // markers remain
  }
  // Only the paths the fixer was sent to resolve: the merge staged everything else itself, and what
  // else the tree holds is someone's own work or a fixer's stray change, neither of it the merge's.
  for (let i = 0; i < resolving.length; i += PATHSPEC_CHUNK) {
    const add = await gitRun(
      worktreePath,
      ['add', '-A', '--', ...resolving.slice(i, i + PATHSPEC_CHUNK)],
      { GIT_LITERAL_PATHSPECS: '1' },
    );
    if (add.code !== 0) return false;
  }
  const commit = await gitRun(worktreePath, ['commit', '--no-edit'], gitEnv);
  if (commit.code !== 0) return false;
  return mergeCommitted(worktreePath, branch);
}

/** Collapse a merge that has ALREADY landed in `worktreePath` into a single commit on
 *  the current branch: `reset --soft` back to the pre-merge tip, then one commit of the
 *  merged index. The tree is unchanged — only the history is.
 *
 *  Deliberately NOT `git merge --squash`, which never writes MERGE_HEAD: the whole
 *  conflict loop is built on that file (completeMergeHostSide requires it, and
 *  `git merge --abort` fails without it), so squashing at merge time would break
 *  conflict resolution and leave a conflicted index behind. Merging normally and
 *  collapsing afterwards leaves every one of those paths untouched.
 *
 *  Returns the new commit's sha, or null when there was nothing to collapse. Safe to
 *  re-enter after a crash: a half-done attempt (HEAD already reset, changes staged)
 *  finishes with the commit, and a completed one collapses to an identical tree again.
 *
 *  Never touches a LIVE merge — the conflict loop owns that until its own commit lands. */
export async function squashMergeCommit(
  worktreePath: string,
  baseShaBefore: string,
  message: string,
  gitEnv: Record<string, string>,
): Promise<string | null> {
  const open = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (open.code === 0) return null;
  const head = await gitRun(worktreePath, ['rev-parse', 'HEAD']);
  if (head.code !== 0) return null;

  if (head.stdout.trim() !== baseShaBefore) {
    const reset = await gitRun(worktreePath, ['reset', '--soft', baseShaBefore]);
    if (reset.code !== 0) {
      throw new Error(
        `git reset --soft ${baseShaBefore} failed: ${reset.stderr || reset.stdout}`.trim(),
      );
    }
  }
  // Nothing staged: the merge was a no-op ("Already up to date"), so there is no
  // history to collapse. `git diff --cached --quiet` exits non-zero when it differs.
  const staged = await gitRun(worktreePath, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return null;

  const commit = await gitRun(worktreePath, ['commit', '-m', message], gitEnv);
  if (commit.code !== 0) {
    throw new Error(`git commit (squash) failed: ${commit.stderr || commit.stdout}`.trim());
  }
  const sha = await gitRun(worktreePath, ['rev-parse', 'HEAD']);
  return sha.code === 0 ? sha.stdout.trim() : null;
}
