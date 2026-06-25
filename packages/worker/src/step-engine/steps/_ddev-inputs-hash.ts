// Content hash over the AUTHORED `.ddev/` input set — everything under `.ddev/`
// that git does not ignore. Shared by 01c-ddev-env (baseline) and 07c-ddev-reconcile
// (target) to decide whether the post-implementation DDEV inputs drifted from the
// booted env. Lives in its own module (not `_ddev-config.ts`, which is intentionally
// dependency-free) because it shells out to git + reads files.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { gitRun } from '../../repo/git-push.js';

export interface DdevInputEntry {
  /** workspace-relative path, e.g. `.ddev/php/extra.ini`. */
  rel: string;
  content: Buffer;
}

/** Pure hash over the authored `.ddev/` input set. The path is folded into the
 *  digest (a rename with identical content still changes the hash) and entries are
 *  sorted, so git's listing order is irrelevant. Split out from the IO below so it
 *  is unit-testable without git/fs (mirrors how `classifyDrift` is pure + tested). */
export function hashDdevEntries(entries: DdevInputEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = createHash('sha256');
  for (const { rel, content } of sorted) {
    h.update(rel);
    h.update('\0');
    h.update(content);
    h.update('\0');
  }
  return h.digest('hex');
}

/** Hash the authored DDEV input files: everything under `.ddev/` that git does NOT
 *  ignore (`ls-files --cached --others --exclude-standard`). DDEV writes generated
 *  files into `.ddev/` at start (`.ddev-docker-compose-*.yaml`, `db_snapshots/`,
 *  `.global_commands/`, `traefik/`), all listed in DDEV's own `.ddev/.gitignore`, so
 *  they are excluded — the hash is stable across DDEV restarts and changes ONLY when
 *  an authored input is edited: `config.yaml`, `config.*.yaml`, `docker-compose.*.yaml`,
 *  `web-build/Dockerfile`, `php/*.ini`, `nginx_full/*`, `apache/*`, `mysql/*.cnf`, ….
 *  Returns null when `workspace` is not a git repo (git exits non-zero) so callers can
 *  fall back to a `config.yaml`-only hash and stay comparable on both sides of the diff. */
export async function hashDdevInputs(workspace: string): Promise<string | null> {
  const ls = await gitRun(workspace, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    '.ddev',
  ]);
  if (ls.code !== 0) return null;

  const rels = ls.stdout.split('\0').filter(Boolean);
  const entries: DdevInputEntry[] = [];
  for (const rel of rels) {
    // Listed-but-unreadable (a delete racing the listing) — skip; its absence still
    // changes the hash versus the baseline that included it.
    const content = await readFile(path.join(workspace, rel)).catch(() => null);
    if (content === null) continue;
    entries.push({ rel, content });
  }
  return hashDdevEntries(entries);
}
