import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import {
  type CommitDiffArtifact,
  type CommitDiffFile,
  type GitRun,
  MAX_FILES,
  TOTAL_CONTENT_BUDGET,
  buildFileEntry,
  parsePorcelainZ,
} from './_commit-diff.js';

/** Worktree-relative artifact the learning step (11-phase-8-learning) writes for
 *  its form-gate diff viewer. Lives under `.haive/`, which 01-worktree-setup adds
 *  to `.git/info/exclude`, so it is never staged or committed. */
export const KNOWLEDGE_DIFF_ARTIFACT_NAME = 'learning-knowledge-diff.json';
/** The same artifact for the commit gate (11b-kb-commit). Its own name so the two
 *  gates do not overwrite each other's diff — and so the web viewer's collapsed
 *  state, keyed on the basename, is per-gate. */
export const KB_COMMIT_DIFF_ARTIFACT_NAME = 'kb-commit-diff.json';

/** Builds the knowledge diff and writes it to
 *  `<workspacePath>/.haive/learning-knowledge-diff.json`.
 *
 *  The git side is on-disk knowledge changes — the working tree vs HEAD, scoped to
 *  `pathspecs` (old content from the HEAD blob, new from the working tree, reusing
 *  the gate-3 builder internals). `extraFiles` are caller-synthesized entries (the
 *  learning insert/update/delete ops) that have no git working-tree representation
 *  yet. Defaults to the knowledge-base root alone, which is what the learning step
 *  wants — its learnings arrive as `extraFiles`; 11b-kb-commit passes both trees,
 *  since by then the learnings are written files like any other.
 *
 *  Every git-side text file gets an `editPath`, so the gate's viewer can write the
 *  new side back. Deleted, binary and truncated files do not: there is nothing to
 *  edit, no text to show, and (for truncated) the content in hand is not the file.
 *
 *  Always writes, even with zero files, so the web viewer renders "No changes to
 *  show" rather than a fetch error. Returns the absolute artifact path. */
export async function buildKnowledgeDiffArtifact(
  workspacePath: string,
  gitRun: GitRun,
  extraFiles: CommitDiffFile[] = [],
  opts: { pathspecs?: readonly string[]; artifactName?: string } = {},
): Promise<string> {
  const pathspecs = opts.pathspecs ?? [KB_DIR];
  const statusRes = await gitRun(workspacePath, [
    'status',
    '--porcelain',
    '-z',
    '--',
    ...pathspecs,
  ]);
  const entries = parsePorcelainZ(statusRes.stdout).slice(0, MAX_FILES);

  const headShaRes = await gitRun(workspacePath, ['rev-parse', 'HEAD']);
  const headSha = headShaRes.code === 0 ? headShaRes.stdout.trim() : null;

  const kbFiles: CommitDiffFile[] = [];
  let used = 0;
  for (const e of entries) {
    const file = await buildFileEntry(workspacePath, gitRun, e, TOTAL_CONTENT_BUDGET - used);
    used += file.oldContent.length + file.newContent.length;
    if (file.status !== 'deleted' && !file.binary && !file.truncated) {
      file.editPath = path.join(workspacePath, file.path);
    }
    kbFiles.push(file);
  }

  const files = [...kbFiles, ...extraFiles];
  const artifact: CommitDiffArtifact = {
    headSha,
    fileCount: files.length,
    truncated: false,
    files,
  };

  const artifactPath = path.join(
    workspacePath,
    '.haive',
    opts.artifactName ?? KNOWLEDGE_DIFF_ARTIFACT_NAME,
  );
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact), 'utf8');
  return artifactPath;
}
