import path from 'node:path';
import type {
  CommitDiffArtifact,
  CommitDiffFile,
  CommitDiffLink,
  CommitDiffStatus,
} from '@haive/shared/commit-diff-artifact';
import {
  lstatNoFollow,
  openDirNoFollow,
  readFileNoFollow,
  readLinkNoFollow,
  removeNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import { gitGaveNoAnswer } from '../../../repo/git-exec.js';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';

/** Runs git in `cwd` and returns stdout/stderr/exit code. Matches the gitRun
 *  helper in 10-gate-3-commit.ts so the builder can reuse it. */
export type GitRun = (
  cwd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Worktree-relative location of the artifact. Lives under `.haive/`, which
 *  01-worktree-setup adds to `.git/info/exclude`, so `git add -A` never stages
 *  it and it is not committed. */
export const COMMIT_DIFF_ARTIFACT_NAME = 'gate3-diff.json';

// Per-side content cap. Files larger than this on either side are reported as
// `truncated` with no content rather than bloating the artifact / risking the
// git-show maxBuffer. 512 KB mirrors the api's MAX_FILE_CONTENT_BYTES.
const PER_FILE_CONTENT_CAP = 512 * 1024;
// Hard cap on the number of changed files materialised into the artifact.
export const MAX_FILES = 500;
// Cumulative content budget across all files; once exceeded, remaining files
// keep their metadata but drop content (truncated) so a pathological diff can't
// produce a multi-hundred-MB artifact.
export const TOTAL_CONTENT_BUDGET = 16 * 1024 * 1024;

export interface CommitDiffResult {
  /** In-memory snapshot for callers that also need to describe the pending commit. */
  artifact: CommitDiffArtifact;
  /** Absolute path to the written artifact. */
  artifactPath: string;
  changedFileCount: number;
  /** File list was capped (mirrors artifact.truncated). */
  truncated: boolean;
}

interface PorcelainEntry {
  x: string;
  y: string;
  path: string;
  oldPath?: string;
}

/** Parses `git status --porcelain -z`. Records are NUL-separated; each is
 *  `XY<space><path>`. For renames/copies, in either column, the destination path
 *  is in the XY record and the source path follows as the next NUL field (verified
 *  against git: `R  new\0old\0`, and ` R new\0old\0` for an intent-to-add file). */
export function parsePorcelainZ(out: string): PorcelainEntry[] {
  const tokens = out.split('\0');
  const entries: PorcelainEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    // XY + space + at least one path char => length >= 4. Skip the trailing ''.
    if (!tok || tok.length < 4) {
      i += 1;
      continue;
    }
    const x = tok.charAt(0);
    const y = tok.charAt(1);
    const entry: PorcelainEntry = { x, y, path: tok.slice(3) };
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const src = tokens[i + 1];
      if (src !== undefined) {
        entry.oldPath = src;
        i += 1; // consume the source-path field
      }
    }
    entries.push(entry);
    i += 1;
  }
  return entries;
}

function classify(e: PorcelainEntry): CommitDiffStatus {
  if (e.x === 'R' || e.x === 'C' || e.y === 'R' || e.y === 'C') return 'renamed';
  if (e.x === '?' || e.y === '?') return 'added';
  if (e.x === 'A' || e.y === 'A') return 'added';
  if (e.x === 'D' || e.y === 'D') return 'deleted';
  return 'modified';
}

const GITLINK_MODE = '160000';
const HEAD_ENTRY = /^(\d{6}) \w+ ([0-9a-f]{40,64}) +(\d+|-)\t/;
const INDEX_GITLINK = /^160000 ([0-9a-f]{40,64}) 0\t/;

const subprojectText = (commit: string): string => `Subproject commit ${commit}\n`;
const literal = (rel: string): string => `:(literal)${rel}`;

/** What HEAD holds at `rel`: mode, object id and a blob's size; null when git lists none. */
async function headEntry(
  gitRun: GitRun,
  cwd: string,
  rel: string,
): Promise<{ mode: string; id: string; size: number | null } | null> {
  const res = await gitRun(cwd, ['ls-tree', '-l', '-z', 'HEAD', '--', literal(rel)]);
  const match = res.code === 0 ? HEAD_ENTRY.exec(res.stdout) : null;
  if (match === null) return null;
  return {
    mode: match[1] ?? '',
    id: match[2] ?? '',
    size: match[3] === '-' ? null : Number(match[3]),
  };
}

/** The commit the index pins for the submodule at `rel`; null when that is no gitlink. */
async function stagedCommit(gitRun: GitRun, cwd: string, rel: string): Promise<string | null> {
  const res = await gitRun(cwd, ['ls-files', '-s', '-z', '--', literal(rel)]);
  if (res.code !== 0) return null;
  for (const record of res.stdout.split('\0')) {
    const match = INDEX_GITLINK.exec(record);
    if (match !== null) return match[1] ?? null;
  }
  return null;
}

/** The commit the submodule or untracked nested repository at `rel` has checked out; an unborn
 *  repository returns a null commit for the unreadable reason. Asked of a held descriptor on its directory
 *  so that a name swapped after the check cannot point git at another repository. */
async function checkedOutCommit(
  gitRun: GitRun,
  workspacePath: string,
  rel: string,
): Promise<{ commit: string | null } | null> {
  const wa = workspaceAnchor(workspacePath);
  const dir = await openDirNoFollow(wa.anchor, `${wa.prefix}${rel}`).catch(() => null);
  if (dir === null) return null;
  try {
    const cwd = `/proc/self/fd/${dir.fd}`;
    // Inspect the held directory, not its name. A plain directory must never borrow the
    // superproject's HEAD, even if its .git marker vanishes before git starts.
    const marker = await lstatNoFollow(cwd, '.git');
    if (marker?.kind !== 'directory' && marker?.kind !== 'file') return null;
    const res = await gitRun(cwd, ['--git-dir=.git', 'rev-parse', '--verify', '--quiet', 'HEAD']);
    if (gitGaveNoAnswer(res)) return null;
    if (res.code === 1) return { commit: null };
    if (res.code !== 0) return null;
    const sha = res.stdout.trim();
    return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha) ? { commit: sha } : null;
  } finally {
    await dir.close().catch(() => undefined);
  }
}

/** A link's target, or the commit a submodule or untracked nested repository is at;
 *  an unreadable reason when the nested repository is unborn, or null when neither can be read. */
async function readLinkSide(
  workspacePath: string,
  gitRun: GitRun,
  e: PorcelainEntry,
): Promise<{ link: CommitDiffLink; text: string } | { unreadableReason: string } | null> {
  const wa = workspaceAnchor(workspacePath);
  const rel = `${wa.prefix}${e.path}`;
  const target = await readLinkNoFollow(wa.anchor, rel);
  if (target !== null) return { link: 'symlink', text: target };
  if ((await lstatNoFollow(wa.anchor, rel))?.kind !== 'directory') return null;
  const staged = await stagedCommit(gitRun, workspacePath, e.path);
  if (staged === null) {
    if (e.x !== '?' || e.y !== '?') return null;
    // git status keeps an untracked repository as dir/ even with -uall. git add -A
    // records its checked-out commit as a gitlink, or refuses it if HEAD is unborn.
    const checkout = await checkedOutCommit(gitRun, workspacePath, e.path);
    if (checkout === null) return null;
    return checkout.commit === null
      ? {
          unreadableReason:
            'Nested repository HEAD could not be read; git add -A cannot stage it without a checked-out commit.',
        }
      : { link: 'gitlink', text: subprojectText(checkout.commit) };
  }
  // Y = M (checkout ahead of the index) or A (intent to add: the empty blob) means a repository is
  // checked out; git run in an uninitialised submodule's empty directory reports the superproject.
  const commit =
    e.y === 'M' || e.y === 'A'
      ? ((await checkedOutCommit(gitRun, workspacePath, e.path))?.commit ?? null)
      : staged;
  return commit === null ? null : { link: 'gitlink', text: subprojectText(commit) };
}

export async function buildFileEntry(
  workspacePath: string,
  gitRun: GitRun,
  e: PorcelainEntry,
  remainingBudget: number,
): Promise<CommitDiffFile> {
  const status = classify(e);
  const needsOld = status === 'modified' || status === 'deleted' || status === 'renamed';
  const oldRef = status === 'renamed' && e.oldPath ? e.oldPath : e.path;

  let unreadable = false;
  let unreadableReason: string | undefined;
  let link: CommitDiffLink | undefined;
  let newContent = '';
  let newBinary = false;
  let newTooBig = false;
  if (status !== 'deleted') {
    // One capped read from the verified descriptor, where it used to be `stat` by path and then
    // `readFile` by the same path — two resolutions of a name git reported, in a tree the agents
    // write. A FIFO or a vanished file is flagged unreadable; a link is read for what it points at.
    const wa = workspaceAnchor(workspacePath);
    const read = await readFileNoFollow(wa.anchor, `${wa.prefix}${e.path}`, {
      maxBytes: PER_FILE_CONTENT_CAP + 1,
    });
    if (read === null) {
      const side = await readLinkSide(workspacePath, gitRun, e);
      if (side === null || 'unreadableReason' in side) {
        unreadable = true;
        unreadableReason = side?.unreadableReason;
      } else {
        link = side.link;
        newContent = side.text;
      }
    } else {
      if (read.size > PER_FILE_CONTENT_CAP) {
        newTooBig = true;
      } else {
        newBinary = read.data.includes(0);
        if (!newBinary) newContent = read.data.toString('utf8');
      }
    }
  }

  let oldContent = '';
  let oldBinary = false;
  let oldTooBig = false;
  if (needsOld) {
    const entry = await headEntry(gitRun, workspacePath, oldRef);
    if (entry?.mode === GITLINK_MODE) {
      oldContent = subprojectText(entry.id);
    } else if (entry === null || entry.size === null) {
      unreadable = true;
    } else if (entry.size > PER_FILE_CONTENT_CAP) {
      oldTooBig = true;
    } else {
      const show = await gitRun(workspacePath, ['show', `HEAD:${oldRef}`]);
      if (show.code !== 0) {
        unreadable = true;
      } else {
        oldBinary = show.stdout.includes('\u0000');
        if (!oldBinary) oldContent = show.stdout;
      }
    }
  }

  const binary = newBinary || oldBinary;
  const overBudget = oldContent.length + newContent.length > remainingBudget;
  const truncated = newTooBig || oldTooBig || overBudget;
  if (binary || truncated || unreadable) {
    oldContent = '';
    newContent = '';
  }

  const file: CommitDiffFile = {
    path: e.path,
    status,
    binary,
    truncated,
    oldContent,
    newContent,
  };
  if (status === 'renamed' && e.oldPath) file.oldPath = e.oldPath;
  if (unreadable) file.unreadable = true;
  if (unreadableReason) file.unreadableReason = unreadableReason;
  if (link) file.link = link;
  return file;
}

/** Builds the gate-3 commit-diff artifact for the worktree and writes it to
 *  `<workspacePath>/.haive/gate3-diff.json`. The changed-file set comes from
 *  `git status --porcelain -z --untracked-files=all` (the exact set `git add -A` will commit,
 *  including untracked files that `git diff HEAD` omits). Old content is read
 *  from the HEAD blob (a submodule's from its tree entry), new content from the working tree. */
export async function buildCommitDiffArtifact(
  workspacePath: string,
  gitRun: GitRun,
): Promise<CommitDiffResult> {
  // Anchored at the repository root, not the worktree this is handed — see `workspaceAnchor`.
  const wa = workspaceAnchor(workspacePath);
  const statusRes = await gitRun(workspacePath, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '-z',
    // Otherwise git groups an untracked directory into one entry ("?? dir/"),
    // which is not a readable file and would leave its entire diff empty.
    '--untracked-files=all',
  ]);
  if (statusRes.code !== 0) {
    // Preserve the status error even if clearing the stale artifact fails.
    await removeNoFollow(wa.anchor, `${wa.prefix}.haive/${COMMIT_DIFF_ARTIFACT_NAME}`).catch(
      () => undefined,
    );
    throw new Error(
      `git status failed in ${workspacePath}: ${statusRes.stderr.trim() || statusRes.stdout.trim()}`,
    );
  }
  const entries = parsePorcelainZ(statusRes.stdout);

  const headShaRes = await gitRun(workspacePath, ['rev-parse', 'HEAD']);
  const headSha = headShaRes.code === 0 ? headShaRes.stdout.trim() : null;

  const capped = entries.slice(0, MAX_FILES);
  const files: CommitDiffFile[] = [];
  let used = 0;
  for (const e of capped) {
    const file = await buildFileEntry(workspacePath, gitRun, e, TOTAL_CONTENT_BUDGET - used);
    used += file.oldContent.length + file.newContent.length;
    files.push(file);
  }

  const artifact: CommitDiffArtifact = {
    headSha,
    fileCount: entries.length,
    truncated: entries.length > capped.length,
    files,
  };

  const artifactPath = path.join(workspacePath, '.haive', COMMIT_DIFF_ARTIFACT_NAME);
  await writeFileNoFollow(
    wa.anchor,
    `${wa.prefix}.haive/${COMMIT_DIFF_ARTIFACT_NAME}`,
    JSON.stringify(artifact),
    { createParents: true },
  );

  return {
    artifact,
    artifactPath,
    changedFileCount: entries.length,
    truncated: artifact.truncated,
  };
}
