import { readUpgradeFile } from '@haive/shared/rules-files';
import {
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  extractRegion,
  normalizeContent,
  sha256Hex,
} from '@haive/shared';

export const UNREAD_HASH = 'unread';

/** What a claim's path holds on disk, as the upgrade plan reads it: the bytes a claim covers (the
 *  marker-delimited region for cli-rules, the whole file otherwise) and their normalised hash.
 *  `null` where nothing is claimed there; `unread` where the path could not be read. */
export async function readClaimedBytes(
  repoPath: string,
  claim: { path: string; kind: string },
): Promise<{ content: string; hash: string } | 'unread' | null> {
  const read = await readUpgradeFile(repoPath, claim.path);
  if (read.kind === 'absent') return null;
  if (read.kind === 'unread') return 'unread';
  let content = read.text;
  if (claim.kind === CLI_RULES_TEMPLATE_KIND) {
    const region = extractRegion(content, CLI_RULES_START, CLI_RULES_END);
    if (region === null) return null;
    content = region;
  }
  return { content, hash: sha256Hex(normalizeContent(content)) };
}

/** The hash the merge compares a claim's `writtenHash` with: null where nothing is claimed there. */
export async function claimDiskHash(
  repoPath: string,
  claim: { path: string; kind: string },
): Promise<string | null> {
  const read = await readClaimedBytes(repoPath, claim);
  if (read === null) return null;
  return read === 'unread' ? UNREAD_HASH : read.hash;
}
