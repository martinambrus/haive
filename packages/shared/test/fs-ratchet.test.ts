import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `../src/fs-safe.ts` replaces path-based `node:fs` calls on repository paths one PR at a time, and
// nothing else stops a new one landing meanwhile (there is no ESLint). This pins the count per
// source file: a conversion lowers its entry, a new call raises it where a reviewer sees it. Exact
// counts, so the baseline cannot drift stale in either direction.
//
// Refresh after a conversion:  UPDATE_FS_RATCHET=1 pnpm --filter @haive/shared test

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const BASELINE = path.join(HERE, 'fs-ratchet.json');
const SCAN_ROOTS = ['packages/api/src', 'packages/worker/src', 'packages/shared/src/repo'];

const CALLS = new Set([
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
  'lstat',
  'readlink',
  'symlink',
  'link',
  'lchown',
  'lchmod',
  'utimes',
  'lutimes',
  'mkdtemp',
  'mkdtempDisposable',
  'watch',
  'watchFile',
  'unwatchFile',
  'statfs',
  'glob',
  'openAsBlob',
]);
const FS_MODULE = /^(?:node:)?fs(?:\/promises)?$/;
const IMPORT = /import\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g;

/** One of the path-taking fs functions, in its async or its sync form. */
function isPathCall(name: string): boolean {
  return CALLS.has(name) || (name.endsWith('Sync') && CALLS.has(name.slice(0, -4)));
}

interface FsBindings {
  /** Bindings whose members are called as `<alias>.name(`: `* as fs`, a default import, and
   *  `{ promises as fsp }`. */
  namespaces: string[];
  /** Local names of named imports of path-taking functions, aliased or not. */
  locals: string[];
}

/** What a source binds from the fs module. Type-only imports bind nothing callable. An aliased
 *  named import counts under its LOCAL name, or `import { readFile as readRepoFile }` would be a
 *  call the baseline never sees. */
function fsBindings(source: string): FsBindings {
  const namespaces = new Set<string>();
  const locals = new Set<string>();
  for (const match of source.matchAll(IMPORT)) {
    const clause = match[1]!.trim();
    if (!FS_MODULE.test(match[2]!) || clause.startsWith('type ')) continue;
    const star = /\*\s+as\s+(\w+)/.exec(clause);
    if (star) namespaces.add(star[1]!);
    const dflt = /^(\w+)\s*(?:,|$)/.exec(clause);
    if (dflt) namespaces.add(dflt[1]!);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (!braces) continue;
    for (const spec of braces[1]!.split(',')) {
      const [imported, alias] = spec.trim().split(/\s+as\s+/);
      const local = alias ?? imported;
      if (!imported || !local || imported.startsWith('type ')) continue;
      if (imported === 'promises') namespaces.add(local);
      else if (isPathCall(imported)) locals.add(local);
    }
  }
  return { namespaces: [...namespaces], locals: [...locals] };
}

/** Path-based fs calls in one source: the local names of named imports, and `<alias>.name(` /
 *  `<alias>.promises.name(` for namespace-like bindings. Methods on anything else (`fh.stat()`,
 *  `handle.readFile()`) act on a descriptor, not a path, and do not count. Sync variants count like
 *  their async twins. */
export function countFsCalls(source: string): number {
  const { namespaces, locals } = fsBindings(source);
  const forms: string[] = [];
  // `(?:\.native)?` is `realpath.native` / `realpathSync.native`, the one member call form.
  if (locals.length > 0) forms.push(`(?<![\\w.$])(?:${locals.join('|')})(?:\\.native)?\\(`);
  if (namespaces.length > 0) {
    const names = [...CALLS].join('|');
    forms.push(
      `(?<![\\w.$])(?:${namespaces.join('|')})\\.(?:promises\\.)?(?:${names})(?:Sync)?(?:\\.native)?\\(`,
    );
  }
  if (forms.length === 0) return 0;
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
        "import { readFile, stat } from 'node:fs/promises';\nawait readFile(p); await stat(p); await fh.stat(); open(p);",
      ),
    ).toBe(2);
    expect(
      countFsCalls(
        "import { readFile as readRepoFile } from 'node:fs/promises';\nawait readRepoFile(p); readFile(p);",
      ),
    ).toBe(1);
    expect(
      countFsCalls(
        "import fs from 'node:fs';\nfs.readFileSync(p); fs.promises.rm(p); other.rm(p);",
      ),
    ).toBe(2);
    expect(countFsCalls("import * as fsp from 'fs/promises';\nawait fsp.open(p);")).toBe(1);
    expect(
      countFsCalls("import { promises as fsp } from 'node:fs';\nawait fsp.writeFile(p, d);"),
    ).toBe(1);
    expect(
      countFsCalls("import fs, { mkdirSync } from 'node:fs';\nfs.statSync(p); mkdirSync(p);"),
    ).toBe(2);
    expect(
      countFsCalls(
        "import { lstat, readlink, symlink } from 'node:fs/promises';\nawait lstat(p); await readlink(p); await symlink(t, p);",
      ),
    ).toBe(3);
    expect(
      countFsCalls(
        "import fs from 'node:fs';\nfs.realpath.native(p, cb); fs.realpathSync.native(p);",
      ),
    ).toBe(2);
    expect(countFsCalls("import { realpath } from 'node:fs';\nrealpath.native(p, cb);")).toBe(1);
    expect(
      countFsCalls(
        "import { mkdtempDisposable } from 'node:fs/promises';\nimport fs from 'node:fs';\nawait mkdtempDisposable(p); fs.mkdtempDisposableSync(p);",
      ),
    ).toBe(2);
    expect(countFsCalls("import { constants, type Dirent } from 'node:fs';\nopen(p);")).toBe(0);
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
