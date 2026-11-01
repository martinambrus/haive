import { createHash } from 'node:crypto';
import {
  chownNoFollow,
  ensureDirNoFollow,
  lstatNoFollow,
  readFileNoFollow,
  readdirNoFollow,
  WALK_MAX_DEPTH,
} from '@haive/shared/fs-safe';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import { namesGitData } from '@haive/shared/project-state';
import { SANDBOX_GID, SANDBOX_UID } from '../../../sandbox/sandbox-identity.js';

/** Strict listing: unreadable KB state must never look like an empty baseline. Links
 * are not KB pages, and metadata must not be handed through a hard-link alias. */
async function kbEntries(repoPath: string): Promise<{ rel: string; directory: boolean }[]> {
  const entriesFound: { rel: string; directory: boolean }[] = [{ rel: KB_DIR, directory: true }];
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (depth > WALK_MAX_DEPTH) throw new Error('knowledge base directory is too deep');
    const entries = await readdirNoFollow(repoPath, rel, { strict: true });
    if (entries === null) throw new Error(`knowledge base directory is unavailable: ${rel}`);
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (namesGitData(child)) continue;
      if (entry.isDirectory()) {
        entriesFound.push({ rel: child, directory: true });
        await visit(child, depth + 1);
      } else if (entry.isFile()) entriesFound.push({ rel: child, directory: false });
    }
  };
  await visit(KB_DIR, 0);
  return entriesFound;
}

/** Only the KB is handed over, including root-owned pages left by an earlier 08.
 * The production worker is root and the sandbox's node identity is fixed. A host
 * worker without chown privileges retains its repository owner's identity, like
 * prepareAgentWritableDir. No modes or other repository trees are changed. */
export async function handOverKnowledgeBase(repoPath: string): Promise<void> {
  const root = await lstatNoFollow(repoPath, '', { strict: true });
  if (!root) throw new Error('repository root is unavailable');
  const owner =
    process.getuid?.() === 0
      ? { uid: SANDBOX_UID, gid: SANDBOX_GID }
      : { uid: root.stats.uid, gid: root.stats.gid };
  await ensureDirNoFollow(repoPath, KB_DIR, { owner });
  for (const { rel, directory } of await kbEntries(repoPath)) {
    const info = await lstatNoFollow(repoPath, rel, { strict: true });
    if (
      !info ||
      info.kind !== (directory ? 'directory' : 'file') ||
      (!directory && info.stats.nlink !== 1)
    ) {
      throw new Error(`knowledge base ownership refused for aliased or unavailable file: ${rel}`);
    }
    await chownNoFollow(repoPath, rel, owner);
  }
}

/** Hash real markdown pages, without copying document bodies into step state. */
export async function snapshotKnowledgeBase(repoPath: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const { rel, directory } of await kbEntries(repoPath)) {
    if (directory || !rel.endsWith('.md') || rel === `${KB_DIR}/INDEX.md`) continue;
    const file = await readFileNoFollow(repoPath, rel, { strict: true, maxBytes: 8 * 1024 * 1024 });
    if (!file || file.truncated) throw new Error(`knowledge base page cannot be verified: ${rel}`);
    hashes[rel] = createHash('sha256').update(file.data).digest('hex');
  }
  return hashes;
}
