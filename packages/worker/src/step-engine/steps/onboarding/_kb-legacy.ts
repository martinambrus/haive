import path from 'node:path';
import { LEGACY_KNOWLEDGE_MIGRATIONS } from '@haive/shared/knowledge-paths';
import {
  lstatNoFollow,
  readdirNoFollow,
  removeNoFollow,
  renameNoFollow,
} from '@haive/shared/fs-safe';

/** Where a legacy file lands when its canonical slot is already taken. Inside the knowledge
 *  base on purpose: `scanExistingKb` recurses, so the reuse prompt lists it alongside the
 *  page that displaced it and the agent's KEEP/IMPROVE contract can fold the two. Parking it
 *  outside the KB is what left the content stranded in the first place. */
export const LEGACY_IMPORT_SUBDIR = 'legacy';

export interface LegacyKnowledgeMigration {
  /** Repo-relative destination of each file that moved straight to its canonical slot. */
  moved: string[];
  /** Repo-relative destination of each file imported under `legacy/` because its canonical
   *  slot was taken, so the agent can merge it into the page that displaced it. */
  pendingMerge: string[];
  /** Repo-relative legacy files deliberately left alone, or that could not be moved. */
  skipped: string[];
}

/** Move a pre-`.haive-data` knowledge tree into its canonical home.
 *
 *  Restores a capability rather than adding one. Onboarding's reuse path — "these
 *  knowledge_base files already exist (e.g. copied in from a prior orchestration), READ
 *  each one, then KEEP or IMPROVE it" — worked on a legacy KB for free while `KB_DIR` was
 *  `.claude/knowledge_base`. Moving the root left every such tree unreadable by the scan
 *  that feeds that prompt, so a real project's accumulated knowledge was silently ignored
 *  and then regenerated from scratch.
 *
 *  A MOVE, not a copy: two knowledge bases in one repo is worse than either, because the
 *  RAG collectors and every agent prompt key on the canonical prefixes and would index one
 *  while a human reads the other. The repo is a git worktree, so the move is reviewable and
 *  revertable as an ordinary diff — which is the same argument the update path already
 *  makes for rewriting a KB file in place.
 *
 *  A taken destination is never OVERWRITTEN — canonical content is the newer claim, since 08
 *  may have just generated it — but nor is it abandoned. MEASURED on a repo onboarded after
 *  the move, 7 of its 41 legacy filenames collide with freshly written ones, and those 7 are
 *  the topics with the most history behind them (months of task-by-task syncs) against one
 *  agent's fresh read of the code. Skipping them keeps the newer page and discards the
 *  accumulated one, which is the wrong half to lose, so a collision is imported under
 *  `legacy/` where the reuse prompt can see both and merge them.
 *
 *  The root `INDEX.md` is the one thing left alone: 08 regenerates it from whatever the KB
 *  ends up holding, so importing a stale copy as `legacy/INDEX.md` would publish a
 *  generated artifact as if it were knowledge. */
export async function migrateLegacyKnowledge(
  repoPath: string,
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  },
): Promise<LegacyKnowledgeMigration> {
  const result: LegacyKnowledgeMigration = { moved: [], pendingMerge: [], skipped: [] };
  for (const { from, to } of LEGACY_KNOWLEDGE_MIGRATIONS) {
    // Rels throughout: `from` and `to` are already repo-relative, and the absolutes they used to be
    // resolved into existed only to be handed to `fs`. Building the rel directly also retires the
    // `relUnder` round-trips the rename below used to need.
    if (!(await isDirectory(repoPath, from))) continue;
    let left = 0;
    for (const relPosix of await listFiles(repoPath, from)) {
      const srcRel = `${from}/${relPosix}`;
      const destRel = `${to}/${relPosix}`;
      let targetRel = destRel;
      let bucket = result.moved;
      if (await exists(repoPath, destRel)) {
        // A generated root INDEX.md is not knowledge; 08 rewrites it from the final KB.
        if (relPosix === 'INDEX.md') {
          result.skipped.push(path.posix.join(from, relPosix));
          left++;
          continue;
        }
        targetRel = `${to}/${LEGACY_IMPORT_SUBDIR}/${relPosix}`;
        bucket = result.pendingMerge;
        // Already imported by an earlier run — leave the source rather than clobber it.
        if (await exists(repoPath, targetRel)) {
          result.skipped.push(path.posix.join(from, relPosix));
          left++;
          continue;
        }
      }
      try {
        // `createParents` does the `mkdir -p`, and `noReplace` closes the window the `exists`
        // check above leaves open — a name taken between the probe and the move is EEXIST here
        // rather than a silent clobber, and a planted link at the destination counts as taken.
        await renameNoFollow(repoPath, srcRel, targetRel, {
          noReplace: true,
          createParents: true,
        });
        bucket.push(
          path.posix.join(to, bucket === result.pendingMerge ? LEGACY_IMPORT_SUBDIR : '', relPosix),
        );
      } catch (err) {
        // Best-effort per file: one unmovable file must not abandon the other forty.
        logger?.warn({ err, src: srcRel }, 'kb: could not migrate a legacy knowledge file');
        result.skipped.push(path.posix.join(from, relPosix));
        left++;
      }
    }
    // ONLY when nothing was left behind. A blanket remove here would delete the very files
    // this function declined to move — tracked knowledge, destroyed by the step that was
    // supposed to rescue it.
    if (left === 0) await removeNoFollow(repoPath, from, { recursive: true }).catch(() => {});
  }
  if (result.moved.length + result.pendingMerge.length + result.skipped.length > 0) {
    logger?.info(
      {
        moved: result.moved.length,
        pendingMerge: result.pendingMerge.length,
        skipped: result.skipped.length,
      },
      'kb: migrated knowledge from the pre-.haive-data location',
    );
  }
  return result;
}

async function isDirectory(root: string, rel: string): Promise<boolean> {
  return (await lstatNoFollow(root, rel))?.kind === 'directory';
}

/** Whether ANYTHING occupies `rel` — a link included, which is the point: a planted link at a
 *  destination counts as taken rather than as free space to move onto. */
async function exists(root: string, rel: string): Promise<boolean> {
  return (await lstatNoFollow(root, rel)) !== null;
}

/** Every file under `<root>/<prefix>`, relative to `prefix`, recursing into subdirectories.
 *
 *  A directory that cannot be listed contributes nothing, where the bare `readdir` it replaces
 *  would have thrown out of the caller's loop. */
async function listFiles(root: string, prefix: string, sub = ''): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdirNoFollow(root, sub === '' ? prefix : `${prefix}/${sub}`);
  if (entries === null) return out;
  for (const entry of entries) {
    const rel = sub === '' ? entry.name : `${sub}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listFiles(root, prefix, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}
