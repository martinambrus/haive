import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `../src/fs-safe.ts` replaces path-based `node:fs` calls on repository paths one PR at a time, and
// nothing else stops a new one landing meanwhile (there is no ESLint). This pins the count per
// source file: a conversion lowers its entry, a new call raises it where a reviewer sees it. Exact
// counts, so the baseline cannot drift stale in either direction.
//
// Refresh after a conversion:  UPDATE_FS_RATCHET=1 pnpm --filter @haive/shared test -- fs-ratchet

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const BASELINE = path.join(HERE, 'fs-ratchet.json');
const SCAN_ROOTS = ['packages/api/src', 'packages/worker/src', 'packages/shared/src/repo'];

const CALLS = [
  'readFile',
  'writeFile',
  'appendFile',
  'mkdir',
  'rm',
  'rmdir',
  'unlink',
  'rename',
  'copyFile',
  'cp',
  'chmod',
  'chown',
  'stat',
  'access',
  'exists',
  'readdir',
  'opendir',
  'open',
  'truncate',
  'createReadStream',
  'createWriteStream',
  'realpath',
];
const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;
const IMPORT = /import\s+(?:\*\s+as\s+(\w+)|(\w+)|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;

/** Path-based fs calls in one source: bare names when the file has a named import from the fs
 *  module, and `<alias>.name(` / `<alias>.promises.name(` for a namespace or default import of it.
 *  Methods on anything else (`fh.stat()`, `handle.readFile()`) act on a descriptor, not a path, and
 *  do not count. Sync variants count like their async twins. */
export function countFsCalls(source: string): number {
  const aliases = new Set<string>();
  let named = false;
  for (const m of source.matchAll(IMPORT)) {
    if (!FS_MODULE.test(m[3]!)) continue;
    const alias = m[1] ?? m[2];
    if (alias) aliases.add(alias);
    else named = true;
  }
  if (!named && aliases.size === 0) return 0;
  const names = CALLS.join('|');
  const forms: string[] = [];
  if (named) forms.push(`(?<![\\w.$])(?:${names})(?:Sync)?\\(`);
  if (aliases.size > 0) {
    forms.push(
      `(?<![\\w.$])(?:${[...aliases].join('|')})\\.(?:promises\\.)?(?:${names})(?:Sync)?\\(`,
    );
  }
  return source.match(new RegExp(forms.join('|'), 'g'))?.length ?? 0;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') out.push(...sourceFiles(full));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function measure(): Record<string, number> {
  const counts: [string, number][] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
      const n = countFsCalls(readFileSync(file, 'utf8'));
      if (n > 0) counts.push([path.relative(REPO_ROOT, file).split(path.sep).join('/'), n]);
    }
  }
  counts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(counts);
}

describe('path-based fs call ratchet', () => {
  it('counts the forms the baseline is measured in', () => {
    expect(
      countFsCalls(
        "import { readFile, stat } from 'node:fs/promises';\nawait readFile(p); await stat(p); await fh.stat();",
      ),
    ).toBe(2);
    expect(
      countFsCalls(
        "import fs from 'node:fs';\nfs.readFileSync(p); fs.promises.rm(p); other.rm(p);",
      ),
    ).toBe(2);
    expect(countFsCalls("import * as fsp from 'fs/promises';\nawait fsp.open(p);")).toBe(1);
    expect(countFsCalls("import type { Dirent } from 'node:fs';\nopen(p);")).toBe(0);
    expect(countFsCalls("import { open } from './mine.js';\nopen(p);")).toBe(0);
  });

  it('matches the per-file baseline exactly', () => {
    const current = measure();
    if (process.env.UPDATE_FS_RATCHET) {
      writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;
    const problems: string[] = [];
    for (const [file, n] of Object.entries(current)) {
      const pinned = baseline[file] ?? 0;
      if (n !== pinned)
        problems.push(`${file}: ${n} path-based fs call(s), baseline says ${pinned}`);
    }
    for (const file of Object.keys(baseline)) {
      if (!(file in current)) problems.push(`${file}: in the baseline but has no such calls now`);
    }
    expect(
      problems,
      'Path-based node:fs calls on repository paths go through @haive/shared/fs-safe. ' +
        'If a change here is intended, refresh the baseline with UPDATE_FS_RATCHET=1 and say why in the PR.',
    ).toEqual([]);
  });
});
