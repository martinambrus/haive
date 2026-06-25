import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

export type CommitDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface CommitDiffFile {
  /** Repo-relative path (the new path for renames). */
  path: string;
  /** Source path, present only for renames. */
  oldPath?: string;
  status: CommitDiffStatus;
  /** Either side is binary; content omitted. */
  binary: boolean;
  /** Either side exceeded the size cap or the total budget; content omitted. */
  truncated: boolean;
  oldContent: string;
  newContent: string;
}

export interface CommitDiffArtifact {
  headSha: string | null;
  /** Total changed files detected (may exceed files.length when capped). */
  fileCount: number;
  /** File list was capped at MAX_FILES. */
  truncated: boolean;
  files: CommitDiffFile[];
}

export interface CommitDiffResult {
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
 *  `XY<space><path>`. For renames/copies the destination path is in the XY
 *  record and the source path follows as the next NUL field (verified against
 *  git: `R  new\0old\0`). */
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
    if (x === 'R' || x === 'C') {
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
  if (e.x === 'R' || e.x === 'C') return 'renamed';
  if (e.x === '?' || e.y === '?') return 'added';
  if (e.x === 'A' || e.y === 'A') return 'added';
  if (e.x === 'D' || e.y === 'D') return 'deleted';
  return 'modified';
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

  let newContent = '';
  let newBinary = false;
  let newTooBig = false;
  if (status !== 'deleted') {
    try {
      const st = await stat(path.join(workspacePath, e.path));
      if (st.isFile()) {
        if (st.size > PER_FILE_CONTENT_CAP) {
          newTooBig = true;
        } else {
          const buf = await readFile(path.join(workspacePath, e.path));
          newBinary = buf.includes(0);
          if (!newBinary) newContent = buf.toString('utf8');
        }
      }
    } catch {
      // working file missing/unreadable -> treat as empty
    }
  }

  let oldContent = '';
  let oldBinary = false;
  let oldTooBig = false;
  if (needsOld) {
    const sizeRes = await gitRun(workspacePath, ['cat-file', '-s', `HEAD:${oldRef}`]);
    if (sizeRes.code === 0) {
      const size = Number.parseInt(sizeRes.stdout.trim(), 10);
      if (Number.isFinite(size) && size > PER_FILE_CONTENT_CAP) {
        oldTooBig = true;
      } else {
        const show = await gitRun(workspacePath, ['show', `HEAD:${oldRef}`]);
        if (show.code === 0) {
          oldBinary = show.stdout.includes('\u0000');
          if (!oldBinary) oldContent = show.stdout;
        }
      }
    }
  }

  const binary = newBinary || oldBinary;
  const overBudget = oldContent.length + newContent.length > remainingBudget;
  const truncated = newTooBig || oldTooBig || overBudget;
  if (binary || truncated) {
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
  return file;
}

/** Builds the gate-3 commit-diff artifact for the worktree and writes it to
 *  `<workspacePath>/.haive/gate3-diff.json`. The changed-file set comes from
 *  `git status --porcelain -z` (the exact set `git add -A` will commit,
 *  including untracked files that `git diff HEAD` omits). Old content is read
 *  from the HEAD blob, new content from the working tree. */
export async function buildCommitDiffArtifact(
  workspacePath: string,
  gitRun: GitRun,
): Promise<CommitDiffResult> {
  const statusRes = await gitRun(workspacePath, ['status', '--porcelain', '-z']);
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
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact), 'utf8');

  return {
    artifactPath,
    changedFileCount: entries.length,
    truncated: artifact.truncated,
  };
}
