import { removeNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import path from 'node:path';
import type { CommitDiffArtifact, CommitDiffFile } from '@haive/shared/commit-diff-artifact';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import {
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

/** The same artifact for the external catch-up gate (01e-external-kb-sync). Its own name
 *  for the same two reasons the commit gate has one: the three gates must not overwrite
 *  each other's diff, and the web viewer's collapsed state is keyed on the basename. */
export const EXTERNAL_KB_DIFF_ARTIFACT_NAME = 'external-kb-diff.json';

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
 *  new side back. Deleted, binary, truncated and unreadable files do not: there is nothing to
 *  edit, no text to show, and (for truncated or unreadable) the content in hand is not the file.
 *
 *  Writes even with zero files, so the web viewer renders "No changes to show" rather
 *  than a fetch error. A failed git status throws and clears the old artifact instead, so the
 *  viewer cannot show an earlier round's changes. Returns the absolute artifact path. */
export async function buildKnowledgeDiffArtifact(
  workspacePath: string,
  gitRun: GitRun,
  extraFiles: CommitDiffFile[] = [],
  opts: { pathspecs?: readonly string[]; artifactName?: string } = {},
): Promise<string> {
  const name = opts.artifactName ?? KNOWLEDGE_DIFF_ARTIFACT_NAME;
  // Anchored at the repository root, not the worktree this is handed — see `workspaceAnchor`.
  const wa = workspaceAnchor(workspacePath);
  const pathspecs = opts.pathspecs ?? [KB_DIR];
  const statusRes = await gitRun(workspacePath, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '-z',
    // Otherwise git groups an untracked directory into one entry ("?? dir/"),
    // which is not a readable file and would leave its entire diff empty.
    '--untracked-files=all',
    '--',
    ...pathspecs,
  ]);
  if (statusRes.code !== 0) {
    // Preserve the status error even if clearing the stale artifact fails.
    await removeNoFollow(wa.anchor, `${wa.prefix}.haive/${name}`).catch(() => undefined);
    throw new Error(
      `git status failed in ${workspacePath}: ${statusRes.stderr.trim() || statusRes.stdout.trim()}`,
    );
  }
  const entries = parsePorcelainZ(statusRes.stdout);
  const capped = entries.slice(0, MAX_FILES);

  const headShaRes = await gitRun(workspacePath, ['rev-parse', 'HEAD']);
  const headSha = headShaRes.code === 0 ? headShaRes.stdout.trim() : null;

  const kbFiles: CommitDiffFile[] = [];
  let used = 0;
  for (const e of capped) {
    const file = await buildFileEntry(workspacePath, gitRun, e, TOTAL_CONTENT_BUDGET - used);
    used += file.oldContent.length + file.newContent.length;
    if (file.status !== 'deleted' && !file.binary && !file.truncated && !file.unreadable) {
      file.editPath = path.join(workspacePath, file.path);
    }
    kbFiles.push(file);
  }

  const files = [...kbFiles, ...extraFiles];
  const artifact: CommitDiffArtifact = {
    headSha,
    fileCount: entries.length + extraFiles.length,
    truncated: entries.length > capped.length,
    files,
  };

  const artifactPath = path.join(workspacePath, '.haive', name);
  await writeFileNoFollow(wa.anchor, `${wa.prefix}.haive/${name}`, JSON.stringify(artifact), {
    createParents: true,
  });
  return artifactPath;
}
