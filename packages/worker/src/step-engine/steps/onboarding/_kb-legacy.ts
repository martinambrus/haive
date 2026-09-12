import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { LEGACY_KNOWLEDGE_MIGRATIONS } from '@haive/shared/knowledge-paths';

export interface LegacyKnowledgeMigration {
  /** Repo-relative destination of each file that moved. */
  moved: string[];
  /** Repo-relative legacy files left in place because the canonical slot was taken. */
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
 *  A taken destination is SKIPPED, never overwritten. Canonical content is the newer claim
 *  (08 may have just generated it), and MEASURED on a repo that was onboarded after the
 *  move, 7 of its 41 legacy filenames collide with freshly written canonical ones. Losing
 *  the new file to an older one of the same name is the one outcome worse than leaving the
 *  legacy copy where it is, and the caller reports what it left. */
export async function migrateLegacyKnowledge(
  repoPath: string,
  logger?: {
    info: (obj: unknown, msg?: string) => void;
    warn: (obj: unknown, msg?: string) => void;
  },
): Promise<LegacyKnowledgeMigration> {
  const result: LegacyKnowledgeMigration = { moved: [], skipped: [] };
  for (const { from, to } of LEGACY_KNOWLEDGE_MIGRATIONS) {
    const fromAbs = path.resolve(repoPath, from);
    if (!(await isDirectory(fromAbs))) continue;
    let left = 0;
    for (const rel of await listFiles(fromAbs)) {
      const src = path.join(fromAbs, rel);
      const dest = path.resolve(repoPath, to, rel);
      if (await exists(dest)) {
        result.skipped.push(path.posix.join(from, rel.split(path.sep).join('/')));
        left++;
        continue;
      }
      try {
        await mkdir(path.dirname(dest), { recursive: true });
        await rename(src, dest);
        result.moved.push(path.posix.join(to, rel.split(path.sep).join('/')));
      } catch (err) {
        // Best-effort per file: one unmovable file must not abandon the other forty.
        logger?.warn({ err, src }, 'kb: could not migrate a legacy knowledge file');
        result.skipped.push(path.posix.join(from, rel.split(path.sep).join('/')));
        left++;
      }
    }
    // ONLY when nothing was left behind. A blanket remove here would delete the very files
    // this function declined to move — tracked knowledge, destroyed by the step that was
    // supposed to rescue it.
    if (left === 0) await rm(fromAbs, { recursive: true, force: true }).catch(() => {});
  }
  if (result.moved.length > 0 || result.skipped.length > 0) {
    logger?.info(
      { moved: result.moved.length, skipped: result.skipped.length },
      'kb: migrated knowledge from the pre-.haive-data location',
    );
  }
  return result;
}

async function isDirectory(abs: string): Promise<boolean> {
  try {
    return (await stat(abs)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

/** Every file under `root`, repo-relative to it, recursing into subdirectories. */
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}
