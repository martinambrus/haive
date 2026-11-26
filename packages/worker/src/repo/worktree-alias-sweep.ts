import { WORKTREE_SUBDIR } from '@haive/shared';
import {
  copyReplaceFileIfIdentityNoFollow,
  lstatNoFollow,
  readdirNoFollow,
  type FileIdentity,
} from '@haive/shared/fs-safe';

export const WORKTREE_ALIAS_LIMITS = {
  maxDirectoryEntries: 10_000,
  maxLinkedNames: 200_000,
  maxEntries: 2_000_000,
  maxDepth: 128,
} as const;
export interface WorktreeAliasOptions {
  maxDirectoryEntries?: number;
  maxLinkedNames?: number;
  maxEntries?: number;
  maxDepth?: number;
  maxBytes?: number;
  resume?: AliasCheckpoint;
}
export interface AliasName {
  path: string;
  dev: string;
  ino: string;
}
export interface AliasScanState {
  cursor: string;
  examined: number;
  complete: boolean;
}
export interface AliasCheckpoint {
  scan: AliasScanState;
  names: AliasName[];
}
export interface AliasProgress {
  examined: number;
  replaced: number;
  scan?: AliasScanState;
  discovered?: AliasName;
}

// DFS orders whole segments, not pathname strings (a/x precedes its sibling a-file).
function comparePaths(a: string, b: string): number {
  const left = a.split('/'),
    right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return left.length - right.length;
}

/** Incremental one-time scan. A worker restart resumes checkpointed discovery, while completed replacements
 * remain detached: no untrusted on-disk cursor or inode map is accepted as authority. Memory,
 * directory allocations, descriptor depth and each copy have explicit bounds. The caller drives
 * only a small window per tick; a limit or unreadable path never certifies completion. */
export async function* sweepWorktreeAliases(
  anchor: string,
  opts: WorktreeAliasOptions = {},
): AsyncGenerator<AliasProgress> {
  const limits = {
    maxDirectoryEntries: opts.maxDirectoryEntries ?? WORKTREE_ALIAS_LIMITS.maxDirectoryEntries,
    maxLinkedNames: opts.maxLinkedNames ?? WORKTREE_ALIAS_LIMITS.maxLinkedNames,
    maxEntries: opts.maxEntries ?? WORKTREE_ALIAS_LIMITS.maxEntries,
    maxDepth: opts.maxDepth ?? WORKTREE_ALIAS_LIMITS.maxDepth,
  };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid sweep limit');
  }
  const groups = new Map<string, { identity: FileIdentity; names: string[] }>();
  const resume = opts.resume?.scan.complete ? undefined : opts.resume;
  const scan = { cursor: '', examined: 0, complete: false, ...resume?.scan };
  if (scan.cursor && !scan.cursor.startsWith(`${WORKTREE_SUBDIR}/`))
    throw new Error('Invalid worktree scan cursor');
  if (
    !Number.isSafeInteger(scan.examined) ||
    scan.examined < 0 ||
    scan.examined > limits.maxEntries
  )
    throw new RangeError('Worktree scan entry limit');
  const progress = { examined: scan.examined, replaced: 0 };
  let linkedNames = 0;
  const known = new Set<string>();
  const remember = (name: AliasName) => {
    if (!name.path.startsWith(`${WORKTREE_SUBDIR}/`))
      throw new Error('Invalid worktree alias path');
    if (known.has(name.path)) return;
    known.add(name.path);
    if (++linkedNames > limits.maxLinkedNames) throw new RangeError('Worktree linked-name limit');
    const dev = BigInt(name.dev),
      ino = BigInt(name.ino);
    const key = `${dev}:${ino}`;
    const group = groups.get(key) ?? { identity: { dev, ino }, names: [] };
    group.names.push(name.path);
    groups.set(key, group);
  };
  for (const name of resume?.names ?? []) remember(name);
  async function* visit(rel: string, depth: number): AsyncGenerator<AliasProgress> {
    const entries = await readdirNoFollow(anchor, rel, {
      strict: true,
      recoverParks: true,
      strictNames: true,
      maxEntries: limits.maxDirectoryEntries,
    });
    if (entries === null) throw new Error('Worktree directory changed; rescan required');
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (comparePaths(child, scan.cursor) <= 0) {
        if (entry.isDirectory() && (child === scan.cursor || scan.cursor.startsWith(`${child}/`))) {
          if (depth >= limits.maxDepth) throw new RangeError('Worktree scan depth limit');
          yield* visit(child, depth + 1);
        }
        continue;
      }
      if (++progress.examined > limits.maxEntries)
        throw new RangeError('Worktree scan entry limit');
      const info = await lstatNoFollow(anchor, child, { strict: true, bigint: true });
      if (info === null) throw new Error('Worktree entry changed; rescan required');
      scan.cursor = child;
      scan.examined = progress.examined;
      if (info?.kind === 'directory') {
        if (depth >= limits.maxDepth) throw new RangeError('Worktree scan depth limit');
        yield { ...progress, scan: { ...scan } };
        yield* visit(child, depth + 1);
      } else {
        let discovered: AliasName | undefined;
        if (info?.kind === 'file' && info.stats.nlink > 1n) {
          discovered = {
            path: child,
            dev: info.stats.dev.toString(),
            ino: info.stats.ino.toString(),
          };
          remember(discovered);
        }
        yield { ...progress, scan: { ...scan }, discovered };
      }
    }
  }
  // A final directory link is refused rather than treated as an empty migration.
  const tree = await lstatNoFollow(anchor, WORKTREE_SUBDIR, { strict: true });
  if (tree === null) return;
  if (tree.kind !== 'directory') throw new Error('Worktrees must be a directory');
  if (!scan.complete) {
    yield* visit(WORKTREE_SUBDIR, 0);
    scan.complete = true;
    yield { ...progress, scan: { ...scan } };
  }
  for (const group of groups.values()) {
    // Refresh the count: a concurrently removed internal name must not hide an outside alias.
    const names: string[] = [];
    for (const name of group.names) {
      const current = await lstatNoFollow(anchor, name, { strict: true, bigint: true });
      if (
        current?.kind !== 'file' ||
        current.stats.dev !== group.identity.dev ||
        current.stats.ino !== group.identity.ino
      ) {
        throw new Error('Worktree changed; rescan required');
      }
      names.push(name);
      yield { ...progress };
    }
    let remaining = names.length;
    for (const name of names) {
      const result = await copyReplaceFileIfIdentityNoFollow(anchor, name, group.identity, {
        internalNames: remaining,
        maxBytes: opts.maxBytes,
      });
      if (result === 'changed' || result === 'absent')
        throw new Error('Worktree changed; rescan required');
      if (result === 'replaced') {
        progress.replaced += 1;
        remaining -= 1;
      }
      yield { ...progress };
    }
  }
}
