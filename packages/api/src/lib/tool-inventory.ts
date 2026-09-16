import { CLI_PROVIDER_LIST } from '@haive/shared';
import { isPathContainmentError, lstatNoFollow, readdirNoFollow } from '@haive/shared/fs-safe';

/**
 * The installed half of the unused report: which persona and skill definition files a
 * repository holds, read from disk by NAME only.
 *
 * The api runs as root over trees sandboxed agents write, so every read goes through the
 * link-refusing primitives of `@haive/shared/fs-safe`: a link anywhere on the path is counted
 * under `skippedLinks` and never followed, and no file content is opened — an id is a file
 * name, and that is all this needs. The anchor is the repository ROOT (`storagePath` or
 * `localPath`), never a task worktree, which is transient and rewritten by the sandbox.
 *
 * Directories come from the provider catalog, not a hand list, so a provider added to
 * `CLI_PROVIDER_LIST` is scanned the day it lands. The `-legacy` quarantine siblings are not
 * scanned: nothing loads them, so nothing there can be unused.
 */

export interface InventoryDir {
  kind: 'agent' | 'skill';
  dir: string;
  /** The agent file extension the CLI reads; null for a skills directory. */
  ext: 'md' | 'toml' | null;
}

export interface ScannedToolingItem {
  kind: 'agent' | 'skill';
  id: string;
  /** Repository-relative definition paths, one per CLI directory the id is installed in. */
  paths: string[];
}

export interface ToolingInventory {
  items: ScannedToolingItem[];
  /** Catalog directories that exist under the anchor, in scan order. */
  dirsScanned: string[];
  /** Symlinks met anywhere in the scan: counted, never followed, never named. */
  skippedLinks: number;
  /** A directory held more than `INVENTORY_ENTRY_LIMIT` entries and the rest were not read. */
  truncated: boolean;
}

/** Per directory. A persona directory on this install holds ~45 files; five hundred is far
 *  past any real roster and bounds the lstat fan-out per request. */
export const INVENTORY_ENTRY_LIMIT = 500;

/** The anchor is not a readable directory — a repository whose path is absent in this container
 *  reads as this, never as an empty inventory. */
export class InventoryAnchorError extends Error {
  constructor(anchor: string) {
    super(`installed-tooling scan: not a readable directory: ${anchor}`);
    this.name = 'InventoryAnchorError';
  }
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function inventoryDirsFromCatalog(): InventoryDir[] {
  const out = new Map<string, InventoryDir>();
  for (const provider of CLI_PROVIDER_LIST) {
    if (provider.projectAgentsDir !== null && provider.agentFileFormat !== null) {
      out.set(`agent:${provider.projectAgentsDir}`, {
        kind: 'agent',
        dir: provider.projectAgentsDir,
        ext: provider.agentFileFormat === 'toml' ? 'toml' : 'md',
      });
    }
    out.set(`skill:${provider.projectSkillsDir}`, {
      kind: 'skill',
      dir: provider.projectSkillsDir,
      ext: null,
    });
  }
  return [...out.values()].sort((a, b) =>
    a.kind === b.kind ? compareStrings(a.dir, b.dir) : a.kind === 'agent' ? -1 : 1,
  );
}

/** `.md` / `.toml` with the stem captured; `README.md` is the index 07 writes, not a persona. */
function agentStem(name: string, ext: 'md' | 'toml'): string | null {
  if (!name.endsWith(`.${ext}`)) return null;
  const stem = name.slice(0, -(ext.length + 1));
  if (stem.length === 0 || stem.toLowerCase() === 'readme') return null;
  return stem;
}

export async function scanInstalledTooling(anchor: string): Promise<ToolingInventory> {
  const root = await lstatNoFollow(anchor, '');
  if (root === null || root.kind !== 'directory') throw new InventoryAnchorError(anchor);

  const items = new Map<string, ScannedToolingItem>();
  const add = (kind: 'agent' | 'skill', id: string, path: string): void => {
    const key = `${kind}:${id}`;
    const known = items.get(key);
    if (known) known.paths.push(path);
    else items.set(key, { kind, id, paths: [path] });
  };
  const dirsScanned: string[] = [];
  let skippedLinks = 0;
  let truncated = false;

  for (const spec of inventoryDirsFromCatalog()) {
    let entries;
    try {
      entries = await readdirNoFollow(anchor, spec.dir, { strict: true });
    } catch (err) {
      // The directory itself, or a parent, is a link: skipped like any other link.
      if (isPathContainmentError(err, 'link')) {
        skippedLinks += 1;
        continue;
      }
      throw err;
    }
    if (entries === null) continue;
    dirsScanned.push(spec.dir);
    const sorted = [...entries].sort((a, b) => compareStrings(a.name, b.name));
    if (sorted.length > INVENTORY_ENTRY_LIMIT) {
      truncated = true;
      sorted.length = INVENTORY_ENTRY_LIMIT;
    }
    for (const entry of sorted) {
      if (entry.isSymbolicLink()) {
        skippedLinks += 1;
        continue;
      }
      if (spec.kind === 'agent') {
        if (!entry.isFile() || spec.ext === null) continue;
        const stem = agentStem(entry.name, spec.ext);
        if (stem !== null) add('agent', stem, `${spec.dir}/${entry.name}`);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const skillFile = `${spec.dir}/${entry.name}/SKILL.md`;
      const info = await lstatNoFollow(anchor, skillFile);
      if (info === null) continue;
      if (info.kind === 'symlink') {
        skippedLinks += 1;
        continue;
      }
      if (info.kind === 'file') add('skill', entry.name, skillFile);
    }
  }

  return {
    items: [...items.values()]
      .map((item) => ({ ...item, paths: [...item.paths].sort(compareStrings) }))
      .sort((a, b) =>
        a.kind === b.kind ? compareStrings(a.id, b.id) : a.kind === 'agent' ? -1 : 1,
      ),
    dirsScanned,
    skippedLinks,
    truncated,
  };
}
