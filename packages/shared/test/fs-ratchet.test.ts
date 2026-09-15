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

/** Every path-taking export of `node:fs` / `node:fs/promises` on Node 26.7.0 (checked against
 *  the runtime's own export list: what is absent here is descriptor-based — `fstat`, `ftruncate`,
 *  `read`, `write`, … — or takes no path). Sync twins follow from the suffix rule below. */
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
const FS_SPEC = `['"](?:node:)?fs(?:\\/promises)?['"]`;
const IMPORT = /import\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g;
/** `const { a, b: c } = await import('node:fs')` and `const fs = await import('node:fs')`. */
const DYNAMIC_IMPORT = new RegExp(
  `(?:const|let|var)\\s+(\\{[^}]*\\}|\\w+)\\s*=\\s*await\\s+import\\(\\s*${FS_SPEC}\\s*\\)`,
  'g',
);
/** `(await import('node:fs')).readFile(` — a member call on the module expression itself. */
const INLINE_IMPORT = `\\(await\\s+import\\(\\s*${FS_SPEC}\\s*\\)\\)`;
/** Every dynamic import of the module, parsed or not. */
const ANY_DYNAMIC_IMPORT = new RegExp(`import\\(\\s*${FS_SPEC}`, 'g');
/** CJS routes into a builtin. Neither appears in this ESM tree; a file that adds one is looked at,
 *  not silently undercounted. */
const CJS_ROUTES = /(?:getBuiltinModule|createRequire)\(/g;

/** `.name(` / `.promises.name(` for a counted function; `(?:\.native)?` is `realpath.native` /
 *  `realpathSync.native`, the one member-call form. */
const MEMBER = `\\.(?:promises\\.)?(?:${[...CALLS].join('|')})(?:Sync)?(?:\\.native)?\\(`;

/** One of the path-taking fs functions, in its async or its sync form. */
function isPathCall(name: string): boolean {
  return CALLS.has(name) || (name.endsWith('Sync') && CALLS.has(name.slice(0, -4)));
}

interface FsBindings {
  /** Bindings whose members are called as `<alias>.name(`: `* as fs`, a default import,
   *  `{ promises as fsp }`, `const fs = await import(...)`. */
  namespaces: Set<string>;
  /** Local names of imported path-taking functions, aliased or not. */
  locals: Set<string>;
  /** Ways of reaching the module the parser does not understand. */
  unclassified: number;
}

/** One specifier list — `{ readFile, stat as statPath }` from a static import (`sep` = ` as `) or
 *  `{ readFile, stat: statPath }` from a destructured dynamic one (`sep` = `:`). A path-taking
 *  import binds its LOCAL name, or `import { readFile as readRepoFile }` would be a call the
 *  baseline never sees; `promises` binds a namespace; a type specifier binds nothing callable. */
function bindSpecifiers(list: string, sep: RegExp, into: FsBindings): void {
  for (const spec of list.split(',')) {
    const [imported, alias] = spec.trim().split(sep);
    const local = (alias ?? imported)?.trim();
    if (!imported || !local || imported.startsWith('type ')) continue;
    if (imported === 'promises') into.namespaces.add(local);
    else if (isPathCall(imported)) into.locals.add(local);
  }
}

/** What a source binds from the fs module, through static and dynamic imports. */
function fsBindings(source: string): FsBindings {
  const into: FsBindings = { namespaces: new Set(), locals: new Set(), unclassified: 0 };
  for (const match of source.matchAll(IMPORT)) {
    const clause = match[1]!.trim();
    if (!FS_MODULE.test(match[2]!) || clause.startsWith('type ')) continue;
    const star = /\*\s+as\s+(\w+)/.exec(clause);
    if (star) into.namespaces.add(star[1]!);
    const dflt = /^(\w+)\s*(?:,|$)/.exec(clause);
    if (dflt) into.namespaces.add(dflt[1]!);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) bindSpecifiers(braces[1]!, /\s+as\s+/, into);
  }
  let parsed = 0;
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    parsed += 1;
    const target = match[1]!;
    if (target.startsWith('{')) bindSpecifiers(target.slice(1, -1), /\s*:\s*/, into);
    else into.namespaces.add(target);
  }
  // Parsed only when the member call follows directly: `(await import('node:fs')).default` bound
  // to a name would otherwise be credited here and its later calls counted under nothing.
  parsed += source.match(new RegExp(`${INLINE_IMPORT}${MEMBER}`, 'g'))?.length ?? 0;
  const dynamic = source.match(ANY_DYNAMIC_IMPORT)?.length ?? 0;
  into.unclassified = dynamic - parsed + (source.match(CJS_ROUTES)?.length ?? 0);
  return into;
}

/** Path-based fs calls in one source: the local names bound above, `<alias>.name(` /
 *  `<alias>.promises.name(` on a namespace binding, and `(await import('node:fs')).name(`.
 *  Methods on anything else (`fh.stat()`, `handle.readFile()`) act on a descriptor, not a path,
 *  and do not count. Sync variants count like their async twins. Throws for a source that
 *  reaches the module in a shape this cannot classify, so the file fails the test instead of
 *  counting low. */
export function countFsCalls(source: string): number {
  const { namespaces, locals, unclassified } = fsBindings(source);
  if (unclassified > 0) {
    throw new Error(
      'reaches node:fs through a dynamic import, createRequire or getBuiltinModule shape the ratchet cannot count',
    );
  }
  const forms = [`${INLINE_IMPORT}${MEMBER}`];
  if (locals.size > 0) forms.push(`(?<![\\w.$])(?:${[...locals].join('|')})(?:\\.native)?\\(`);
  if (namespaces.size > 0) forms.push(`(?<![\\w.$])(?:${[...namespaces].join('|')})${MEMBER}`);
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

function measure(): { counts: Record<string, number>; uncountable: string[] } {
  const counts: [string, number][] = [];
  const uncountable: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(path.join(REPO_ROOT, root))) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      try {
        const n = countFsCalls(readFileSync(file, 'utf8'));
        if (n > 0) counts.push([rel, n]);
      } catch (err) {
        uncountable.push(`${rel}: ${(err as Error).message}`);
      }
    }
  }
  counts.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { counts: Object.fromEntries(counts), uncountable };
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

  it('counts dynamic imports, and refuses a shape it cannot classify', () => {
    expect(
      countFsCalls(
        "const { readFile, stat: statPath } = await import('node:fs/promises');\nawait readFile(p); await statPath(p);",
      ),
    ).toBe(2);
    expect(
      countFsCalls("const fsp = await import('node:fs/promises');\nawait fsp.readFile(p);"),
    ).toBe(1);
    expect(countFsCalls("(await import('node:fs')).readFileSync(p);")).toBe(1);
    expect(() => countFsCalls("import('node:fs').then((fs) => fs.readFile(p));")).toThrow(
      /cannot count/,
    );
    expect(() =>
      countFsCalls("const fs = (await import('node:fs')).default;\nfs.readFileSync(p);"),
    ).toThrow(/cannot count/);
    expect(() => countFsCalls("const fs = process.getBuiltinModule('node:fs');")).toThrow(
      /cannot count/,
    );
    expect(() =>
      countFsCalls("import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)"),
    ).toThrow(/cannot count/);
  });

  it('matches the per-file baseline exactly', () => {
    const { counts: current, uncountable } = measure();
    if (process.env.UPDATE_FS_RATCHET) {
      writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`);
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;
    const problems: string[] = [...uncountable];
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
