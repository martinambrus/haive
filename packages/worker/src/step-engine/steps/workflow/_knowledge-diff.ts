import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

/** Builds the learning-step knowledge diff and writes it to
 *  `<workspacePath>/.haive/learning-knowledge-diff.json`.
 *
 *  The git side is the agent's Feature KB Sync edits — the working tree vs HEAD,
 *  scoped to `.claude/knowledge_base` (old content from the HEAD blob, new from the
 *  working tree, reusing the gate-3 builder internals). `extraFiles` are
 *  caller-synthesized entries (the learning insert/update/delete ops, added in
 *  slice 2) that have no git working-tree representation yet.
 *
 *  Always writes, even with zero files, so the web viewer renders "No changes to
 *  show" rather than a fetch error. Returns the absolute artifact path. */
export async function buildKnowledgeDiffArtifact(
  workspacePath: string,
  gitRun: GitRun,
  extraFiles: CommitDiffFile[] = [],
): Promise<string> {
  const statusRes = await gitRun(workspacePath, [
    'status',
    '--porcelain',
    '-z',
    '--',
    '.claude/knowledge_base',
  ]);
  const entries = parsePorcelainZ(statusRes.stdout).slice(0, MAX_FILES);

  const headShaRes = await gitRun(workspacePath, ['rev-parse', 'HEAD']);
  const headSha = headShaRes.code === 0 ? headShaRes.stdout.trim() : null;

  const kbFiles: CommitDiffFile[] = [];
  let used = 0;
  for (const e of entries) {
    const file = await buildFileEntry(workspacePath, gitRun, e, TOTAL_CONTENT_BUDGET - used);
    used += file.oldContent.length + file.newContent.length;
    kbFiles.push(file);
  }

  const files = [...kbFiles, ...extraFiles];
  const artifact: CommitDiffArtifact = {
    headSha,
    fileCount: files.length,
    truncated: false,
    files,
  };

  const artifactPath = path.join(workspacePath, '.haive', KNOWLEDGE_DIFF_ARTIFACT_NAME);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact), 'utf8');
  return artifactPath;
}
