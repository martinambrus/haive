import { WORKTREE_SUBDIR } from '@haive/shared';
import {
  copyReplaceFileIfIdentityNoFollow,
  worktreeAliasSkipKind,
  syncDirectoryNoFollow,
  lstatNoFollow,
  readdirNoFollow,
  recoverWorktreeAliasArtifactsNoFollow,
  type FileIdentity,
} from '@haive/shared/fs-safe';

export const WORKTREE_ALIAS_LIMITS = {
  maxDirectoryEntries: 10_000,
  maxLinkedNames: 200_000,
  maxEntries: 2_000_000,
  maxDepth: 128,
  maxPasses: 4,
} as const;
export interface WorktreeAliasOptions {
  maxDirectoryEntries?: number;
  maxLinkedNames?: number;
  maxEntries?: number;
  maxDepth?: number;
  maxPasses?: number;
  maxBytes?: number;
  staleTempMs?: number;
  resume?: AliasCheckpoint;
}
export interface AliasName {
  path: string;
  dev: string;
  ino: string;
}
export interface AliasRetry {
  attempts: number;
  retryAt: number;
}
export interface AliasScanState {
  cursor: string;
  examined: number;
  complete: boolean;
  pass?: number;
  detached?: number;
  skipped?: Record<string, number>;
  retry?: AliasRetry;
  outcome?: 'done' | 'done-with-skips';
}
export interface AliasCheckpoint {
  scan: AliasScanState;
  names: AliasName[];
}
export interface AliasProgress {
  examined: number;
  replaced: number;
  skipped?: Record<string, number>;
  scan?: AliasScanState;
  discovered?: AliasName;
}

function comparePaths(a: string, b: string): number {
  const left = a.split('/'),
    right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return left.length - right.length;
}
// A park-like directory is untrusted content, never a directory the sweep should enter.
export const isAliasArtifact = (name: string): boolean =>
  /\.haive-(?:alias-(?:park|kept|tmp)|park|tmp)-/.test(name);

/** Bounded, resumable passes. Entry failures are counted; only repository/root failures escape
 * to the persisted backoff. Each pass that detaches anything owes a fresh complete discovery. */
export async function* sweepWorktreeAliases(
  anchor: string,
  opts: WorktreeAliasOptions = {},
): AsyncGenerator<AliasProgress> {
  const limits = {
    maxDirectoryEntries: opts.maxDirectoryEntries ?? WORKTREE_ALIAS_LIMITS.maxDirectoryEntries,
    maxLinkedNames: opts.maxLinkedNames ?? WORKTREE_ALIAS_LIMITS.maxLinkedNames,
    maxEntries: opts.maxEntries ?? WORKTREE_ALIAS_LIMITS.maxEntries,
    maxDepth: opts.maxDepth ?? WORKTREE_ALIAS_LIMITS.maxDepth,
    maxPasses: opts.maxPasses ?? WORKTREE_ALIAS_LIMITS.maxPasses,
  };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Invalid sweep limit');
  if (!limits.maxPasses) throw new RangeError('Invalid pass limit');
  // A missing volume must not certify repositories as empty.
  if ((await lstatNoFollow(anchor, '', { strict: true }))?.kind !== 'directory')
    throw new Error('Repository anchor is unavailable');
  const tree = await lstatNoFollow(anchor, WORKTREE_SUBDIR, { strict: true });
  if (tree !== null && tree.kind !== 'directory') throw new Error('Worktrees must be a directory');
  let scan: AliasScanState = {
    cursor: '',
    examined: 0,
    complete: false,
    pass: 1,
    detached: 0,
    ...opts.resume?.scan,
  };
  if (scan.cursor && !scan.cursor.startsWith(`${WORKTREE_SUBDIR}/`))
    throw new Error('Invalid worktree scan cursor');
  if (
    !Number.isSafeInteger(scan.examined) ||
    scan.examined < 0 ||
    scan.examined > limits.maxEntries ||
    !Number.isSafeInteger(scan.pass) ||
    scan.pass! < 1 ||
    scan.pass! > limits.maxPasses
  )
    throw new RangeError('Invalid worktree scan state');
  // Discovery completed before an interruption can contain old parked names. Re-list for
  // recovery, retaining pass, skipped counts and detached debt; failures never erase the DB cursor.
  if (opts.resume?.scan.complete) scan = { ...scan, cursor: '', examined: 0, complete: false };
  const skipped = { ...scan.skipped };
  const skip = (kind: string) => {
    skipped[kind] = (skipped[kind] ?? 0) + 1;
  };
  let replaced = 0;
  const snapshot = (discovered?: AliasName): AliasProgress => ({
    examined: scan.examined,
    replaced,
    skipped: { ...skipped },
    scan: { ...scan, skipped: { ...skipped } },
    discovered,
  });
  if (tree === null) {
    yield snapshot();
    return;
  }
  for (;;) {
    const groups = new Map<string, { identity: FileIdentity; names: string[] }>();
    const known = new Set<string>();
    const remember = (name: AliasName): boolean => {
      if (!name.path.startsWith(`${WORKTREE_SUBDIR}/`))
        throw new Error('Invalid worktree alias path');
      if (known.has(name.path)) return false;
      if (known.size >= limits.maxLinkedNames) {
        skip('linked_name_limit');
        return false;
      }
      known.add(name.path);
      const dev = BigInt(name.dev),
        ino = BigInt(name.ino);
      const owner = name.path.slice(WORKTREE_SUBDIR.length + 1).split('/')[0];
      const key = `${owner}:${dev}:${ino}`;
      const group = groups.get(key) ?? { identity: { dev, ino }, names: [] };
      group.names.push(name.path);
      groups.set(key, group);
      return true;
    };
    for (const name of opts.resume?.names ?? []) remember(name);
    // A resumed name journal applies to the first pass only.
    opts = { ...opts, resume: undefined };
    async function* visit(rel: string, depth: number): AsyncGenerator<AliasProgress> {
      let entries;
      try {
        entries = await readdirNoFollow(anchor, rel, {
          strict: true,
          strictNames: true,
          onInvalidName: () => skip('non_utf8_name'),
          maxEntries: limits.maxDirectoryEntries,
        });
        if (entries === null) {
          if (depth === 0) throw new Error('Worktrees root vanished during listing');
          skip('vanished');
          yield snapshot();
          return;
        }
        const recovery = await recoverWorktreeAliasArtifactsNoFollow(
          anchor,
          rel,
          entries.map((e) => e.name),
          { staleTempMs: opts.staleTempMs },
        );
        if (recovery.foreignParks)
          skipped.foreign_park = (skipped.foreign_park ?? 0) + recovery.foreignParks;
        if (recovery.changed)
          entries = await readdirNoFollow(anchor, rel, {
            strict: true,
            strictNames: true,
            onInvalidName: () => skip('non_utf8_name'),
            maxEntries: limits.maxDirectoryEntries,
          });
        if (entries === null) {
          if (depth === 0) throw new Error('Worktrees root vanished during listing');
          skip('vanished');
          yield snapshot();
          return;
        }
      } catch (err) {
        const kind = worktreeAliasSkipKind(err);
        if (depth === 0 || !kind) throw err;
        skip(kind);
        yield snapshot();
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const child = `${rel}/${entry.name}`;
        const behind = comparePaths(child, scan.cursor) <= 0;
        if (behind && !(child === scan.cursor || scan.cursor.startsWith(`${child}/`))) continue;
        if (!behind && scan.examined >= limits.maxEntries) {
          skip('entry_limit');
          yield snapshot();
          return;
        }
        if (!behind) {
          scan.examined++;
          scan.cursor = child;
        }
        if (isAliasArtifact(entry.name)) {
          if (!behind) yield snapshot();
          continue;
        }
        let info;
        try {
          // Do not trust d_type: DT_UNKNOWN must still descend toward a durable cursor.
          info = await lstatNoFollow(anchor, child, { strict: true, bigint: true });
        } catch (err) {
          const kind = worktreeAliasSkipKind(err);
          if (!kind) throw err;
          skip(kind);
          yield snapshot();
          continue;
        }
        if (info === null) {
          skip('vanished');
          yield snapshot();
          continue;
        }
        if (info.kind === 'directory') {
          if (depth >= limits.maxDepth) {
            skip('depth_limit');
            yield snapshot();
            continue;
          }
          if (!behind) yield snapshot();
          yield* visit(child, depth + 1);
        } else if (!behind) {
          let discovered: AliasName | undefined;
          if (info.kind === 'file' && info.stats.nlink > 1n) {
            const candidate = {
              path: child,
              dev: info.stats.dev.toString(),
              ino: info.stats.ino.toString(),
            };
            if (remember(candidate)) discovered = candidate;
          }
          yield snapshot(discovered);
        }
      }
      try {
        await syncDirectoryNoFollow(anchor, rel);
      } catch (err) {
        const kind = worktreeAliasSkipKind(err);
        if (depth === 0 || !kind) throw err;
        skip(kind);
      }
    }
    if (!scan.complete) {
      yield* visit(WORKTREE_SUBDIR, 0);
      scan.complete = true;
      yield snapshot();
    }
    for (const group of groups.values()) {
      const names: string[] = [];
      for (const name of group.names) {
        try {
          const current = await lstatNoFollow(anchor, name, { strict: true, bigint: true });
          if (
            current?.kind === 'file' &&
            current.stats.dev === group.identity.dev &&
            current.stats.ino === group.identity.ino
          )
            names.push(name);
          else skip(current === null ? 'vanished' : 'changed_entry');
        } catch (err) {
          const kind = worktreeAliasSkipKind(err);
          if (!kind) throw err;
          skip(kind);
        }
        yield snapshot();
      }
      let remaining = names.length;
      for (const name of names) {
        try {
          const result = await copyReplaceFileIfIdentityNoFollow(anchor, name, group.identity, {
            internalNames: remaining,
            maxBytes: opts.maxBytes,
          });
          if (result === 'replaced') {
            replaced++;
            scan.detached = (scan.detached ?? 0) + 1;
            remaining--;
          } else if (result === 'absent' || result === 'changed') {
            skip(result === 'absent' ? 'vanished' : 'changed_entry');
            remaining--;
          }
        } catch (err) {
          const kind = worktreeAliasSkipKind(err);
          if (!kind) throw err;
          skip(kind);
        }
        yield snapshot();
      }
    }
    if (!scan.detached) {
      yield snapshot();
      return;
    }
    if (scan.pass! >= limits.maxPasses) {
      skip('pass_limit');
      yield snapshot();
      return;
    }
    scan = { cursor: '', examined: 0, complete: false, pass: scan.pass! + 1, detached: 0 };
    yield snapshot();
  }
}
