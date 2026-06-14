import { readFile, readdir } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

// Deterministic, dependency-free manifest parsing for the global-KB `packages`
// facet. Each parser turns a manifest's text into direct `[name, constraint]`
// pairs; `manifestPackages` reduces them to deduped `name@major` tokens that
// step 08 anchors a global entry to (techAnchorFacets matches a tech slug to a
// `name@major`, hasInstalledVersionAnchor confirms it is installed). Parsing is
// best-effort and bounded: under-capture just keeps an entry local (the safe
// direction), over-capture only matters if a spurious name collides with a tech
// slug. No TOML/YAML libraries — the repo parses these formats with regex.

/** A direct dependency: tuple of package name and its version constraint. */
export type ManifestDep = [name: string, constraint: string];

const MAX_WORKSPACE_DIRS = 300;
const MAX_PACKAGES = 800;

/** Leading integer of a version constraint as the major token: "^11.0" -> "11",
 *  "~10.3" -> "10", ">=9.5 <11" -> "9", "v2.3.4" -> "2". Null when there is no
 *  integer. Major-only by design — minors churn, majors are API-stable. */
export function firstMajor(constraint: string | undefined | null): string | null {
  if (!constraint) return null;
  const m = String(constraint).match(/\d+/);
  return m ? m[0] : null;
}

/** First full numeric version token in a string: ">=24.0.0" -> "24.0.0",
 *  "v20" -> "20", "^8.2" -> "8.2", "lts/iron" -> null. Keeps minor/patch (unlike
 *  firstMajor) for runtime-version capture. */
export function numericVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = String(raw).match(/\d+(?:\.\d+)*/);
  return m ? m[0] : null;
}

/** Direct manifest dependencies reduced to deduped `name@major` tokens. Composer
 *  platform requirements (php, ext-*, lib-*) are skipped (not packages). Bounded
 *  to keep the project facet set small. */
export function manifestPackages(deps: ManifestDep[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const [name, constraint] of deps) {
    if (!name) continue;
    if (name === 'php' || name === 'hhvm' || name.startsWith('ext-') || name.startsWith('lib-')) {
      continue;
    }
    const major = firstMajor(constraint);
    if (!major) continue;
    const token = `${name}@${major}`;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= MAX_PACKAGES) break;
  }
  return out;
}

async function readSafe(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** Body lines of a TOML section (`[header]`) until the next section header.
 *  Null when the section is absent. */
function tomlSectionBody(text: string, header: string): string | null {
  const lines = text.split('\n');
  const esc = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startRe = new RegExp(`^\\s*\\[${esc}\\]\\s*$`);
  const start = lines.findIndex((l) => startRe.test(l));
  if (start === -1) return null;
  const body: string[] = [];
  for (let j = start + 1; j < lines.length; j++) {
    if (/^\s*\[/.test(lines[j]!)) break;
    body.push(lines[j]!);
  }
  return body.join('\n');
}

/** dependencies + devDependencies of a package.json as `[name, constraint]`. */
export function parsePackageJsonDeps(text: string): ManifestDep[] {
  try {
    const pkg = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return [
      ...Object.entries(pkg.dependencies ?? {}),
      ...Object.entries(pkg.devDependencies ?? {}),
    ];
  } catch {
    return [];
  }
}

/** require + require-dev of a composer.json as `[name, constraint]`. */
export function parseComposerDeps(text: string): ManifestDep[] {
  try {
    const c = JSON.parse(text) as {
      require?: Record<string, string>;
      ['require-dev']?: Record<string, string>;
    };
    return [...Object.entries(c.require ?? {}), ...Object.entries(c['require-dev'] ?? {})];
  } catch {
    return [];
  }
}

/** Workspace globs from a pnpm-workspace.yaml `packages:` list and/or a root
 *  package.json `workspaces` field (array, or `{ packages: [] }`). Negations
 *  (`!glob`) are dropped — they exclude, never add. */
export function parseWorkspaceGlobs(pnpmYaml: string | null, rootPkgText: string | null): string[] {
  const globs = new Set<string>();
  if (pnpmYaml) {
    let inPackages = false;
    for (const raw of pnpmYaml.split('\n')) {
      if (/^packages:\s*(#.*)?$/.test(raw)) {
        inPackages = true;
        continue;
      }
      if (!inPackages) continue;
      if (/^\S/.test(raw)) break; // dedent to a new top-level key ends the list
      const lm = raw.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
      if (lm?.[1]) globs.add(lm[1].trim());
    }
  }
  if (rootPkgText) {
    try {
      const pkg = JSON.parse(rootPkgText) as {
        workspaces?: string[] | { packages?: string[] };
      };
      const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
      for (const g of ws) if (typeof g === 'string') globs.add(g);
    } catch {
      /* ignore */
    }
  }
  return [...globs].filter((g) => g && !g.startsWith('!'));
}

/** Expand workspace globs to existing package directories under `repoPath`.
 *  Supports the common shapes: an exact path, and a single wildcard level
 *  (`packages/*`, `apps/**` — both read one level under the literal prefix).
 *  node_modules and dot-dirs are skipped; the count is bounded. */
async function expandWorkspaceDirs(repoPath: string, globs: string[]): Promise<string[]> {
  const dirs = new Set<string>();
  for (const glob of globs) {
    if (dirs.size >= MAX_WORKSPACE_DIRS) break;
    const starIdx = glob.indexOf('*');
    if (starIdx === -1) {
      dirs.add(path.join(repoPath, glob));
      continue;
    }
    // Literal prefix = everything up to (not including) the wildcard segment.
    const base = glob
      .slice(0, starIdx)
      .replace(/\/[^/]*$/, '')
      .replace(/\/+$/, '');
    let entries: Dirent[] = [];
    try {
      entries = (await readdir(path.join(repoPath, base), { withFileTypes: true })) as Dirent[];
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      dirs.add(path.join(repoPath, base, e.name));
      if (dirs.size >= MAX_WORKSPACE_DIRS) break;
    }
  }
  return [...dirs];
}

/** Direct gems from a Gemfile (`gem 'name', '~> 1.2'`); the version is optional. */
export function parseGemfile(text: string): ManifestDep[] {
  const out: ManifestDep[] = [];
  const re = /^\s*gem\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push([m[1]!, m[2] ?? '']);
  return out;
}

/** Resolved versions from a Gemfile.lock `specs:` block — top-level entries only
 *  (`    rails (7.1.0)`, 4-space indent; 6-space lines are transitive sub-deps). */
export function parseGemfileLock(text: string): ManifestDep[] {
  const out: ManifestDep[] = [];
  const re = /^ {4}([A-Za-z0-9._-]+) \(([^)]+)\)$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push([m[1]!, m[2]!]);
  return out;
}

/** Direct requirements from a requirements.txt. Comments, flags (`-r`, `-e`) and
 *  unpinned lines are skipped; extras and env markers are tolerated. */
export function parseRequirementsTxt(text: string): ManifestDep[] {
  const out: ManifestDep[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const m = line.match(
      /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(?:===|==|>=|~=|>|<|!=)\s*v?([0-9][\w.*+-]*)/,
    );
    if (m) out.push([m[1]!, m[2]!]);
  }
  return out;
}

/** Direct dependencies from a pyproject.toml — PEP 621 (`[project].dependencies`)
 *  and Poetry (`[tool.poetry.dependencies]`). The `python` runtime pin is dropped
 *  (it is a language version, not a package). */
export function parsePyprojectDeps(text: string): ManifestDep[] {
  const out: ManifestDep[] = [];
  const pep = text.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (pep?.[1]) {
    for (const qm of pep[1].matchAll(/['"]([^'"]+)['"]/g)) {
      const m = qm[1]!.match(
        /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(?:===|==|>=|~=|>|<|!=)\s*v?([0-9][\w.*+-]*)/,
      );
      if (m) out.push([m[1]!, m[2]!]);
    }
  }
  const poetry = tomlSectionBody(text, 'tool.poetry.dependencies');
  if (poetry) {
    for (const line of poetry.split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9._-]+)\s*=\s*['"]([^'"]+)['"]/);
      if (m && m[1]!.toLowerCase() !== 'python') out.push([m[1]!, m[2]!]);
    }
  }
  return out;
}

/** Direct module requirements from a go.mod (`require` blocks and single lines).
 *  `// indirect` (transitive) lines are skipped. */
export function parseGoMod(text: string): ManifestDep[] {
  const out: ManifestDep[] = [];
  const blockRe = /require\s*\(([\s\S]*?)\)/g;
  for (let b = blockRe.exec(text); b; b = blockRe.exec(text)) {
    for (const line of b[1]!.split('\n')) {
      if (/\/\/\s*indirect/.test(line)) continue;
      const m = line.match(/^\s*(\S+)\s+v([0-9][\w.\-+]*)/);
      if (m) out.push([m[1]!, m[2]!]);
    }
  }
  const singleRe = /^require\s+(\S+)\s+v([0-9][\w.\-+]*)/gm;
  for (let m = singleRe.exec(text); m; m = singleRe.exec(text)) out.push([m[1]!, m[2]!]);
  return out;
}

/** Direct crates from a Cargo.toml — `[dependencies]`, `[dev-dependencies]`,
 *  `[build-dependencies]`. Both `name = "1.0"` and `name = { version = "1.0" }`
 *  forms are handled. */
export function parseCargoToml(text: string): ManifestDep[] {
  const out: ManifestDep[] = [];
  for (const section of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
    const body = tomlSectionBody(text, section);
    if (!body) continue;
    for (const line of body.split('\n')) {
      const direct = line.match(/^\s*([A-Za-z0-9._-]+)\s*=\s*['"]([^'"]+)['"]/);
      const table = line.match(
        /^\s*([A-Za-z0-9._-]+)\s*=\s*\{[^}]*\bversion\s*=\s*['"]([^'"]+)['"]/,
      );
      const m = direct ?? table;
      if (m) out.push([m[1]!, m[2]!]);
    }
  }
  return out;
}

/** Go language version from a go.mod `go 1.22` directive. */
export function parseGoVersion(text: string): string | null {
  const m = text.match(/^go\s+(\d+(?:\.\d+){1,2})/m);
  return m ? m[1]! : null;
}

/** Rust toolchain version from a Cargo.toml `rust-version = "1.75"` (MSRV). */
export function parseRustVersion(text: string): string | null {
  const m = text.match(/^\s*rust-version\s*=\s*['"](\d+(?:\.\d+){0,2})/m);
  return m ? m[1]! : null;
}

/** Python version from a pyproject.toml — PEP 621 `requires-python` or the Poetry
 *  `python` pin. The version token is normalized (">=3.11" -> "3.11"). */
export function parsePythonVersion(text: string): string | null {
  const req = text.match(/requires-python\s*=\s*['"]([^'"]+)['"]/);
  if (req) return numericVersion(req[1]);
  const poetry = text.match(/^\s*python\s*=\s*['"]([^'"]+)['"]/m);
  return poetry ? numericVersion(poetry[1]) : null;
}

/** Ruby version from a Gemfile `ruby "3.3.0"` directive. */
export function parseRubyVersion(text: string): string | null {
  const m = text.match(/^\s*ruby\s+['"]([^'"]+)['"]/m);
  return m ? numericVersion(m[1]) : null;
}

/** Best-effort runtime versions for the non-PHP/Node languages we support, read
 *  from their version files / manifests (`.python-version`, `runtime.txt`,
 *  pyproject; `.ruby-version`, Gemfile; go.mod; Cargo.toml). Keyed by language
 *  token; an empty record when nothing is found. */
export async function detectLanguageRuntimes(repoPath: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  const pyFile = numericVersion((await readSafe(path.join(repoPath, '.python-version')))?.trim());
  const runtimeTxt = await readSafe(path.join(repoPath, 'runtime.txt'));
  const pyproject = await readSafe(path.join(repoPath, 'pyproject.toml'));
  const python =
    pyFile ??
    (runtimeTxt ? numericVersion(runtimeTxt.match(/python-([\d.]+)/i)?.[1]) : null) ??
    (pyproject ? parsePythonVersion(pyproject) : null);
  if (python) out.python = python;

  const rbFile = numericVersion((await readSafe(path.join(repoPath, '.ruby-version')))?.trim());
  const gemfile = await readSafe(path.join(repoPath, 'Gemfile'));
  const ruby = rbFile ?? (gemfile ? parseRubyVersion(gemfile) : null);
  if (ruby) out.ruby = ruby;

  const goMod = await readSafe(path.join(repoPath, 'go.mod'));
  const go = goMod ? parseGoVersion(goMod) : null;
  if (go) out.go = go;

  const cargo = await readSafe(path.join(repoPath, 'Cargo.toml'));
  const rust = cargo ? parseRustVersion(cargo) : null;
  if (rust) out.rust = rust;

  return out;
}

async function collectWorkspaceNpmDeps(
  repoPath: string,
  rootPkgText: string | null,
): Promise<ManifestDep[]> {
  const pnpmYaml = await readSafe(path.join(repoPath, 'pnpm-workspace.yaml'));
  const globs = parseWorkspaceGlobs(pnpmYaml, rootPkgText);
  if (globs.length === 0) return [];
  const dirs = await expandWorkspaceDirs(repoPath, globs);
  const out: ManifestDep[] = [];
  for (const dir of dirs) {
    const text = await readSafe(path.join(dir, 'package.json'));
    if (text) out.push(...parsePackageJsonDeps(text));
  }
  return out;
}

async function collectRubyDeps(repoPath: string): Promise<ManifestDep[]> {
  const gemfile = await readSafe(path.join(repoPath, 'Gemfile'));
  if (!gemfile) return [];
  const direct = parseGemfile(gemfile);
  const lockText = await readSafe(path.join(repoPath, 'Gemfile.lock'));
  const lockMap = new Map(lockText ? parseGemfileLock(lockText) : []);
  // Bound to direct gems; fill a missing inline version from the resolved lock.
  return direct.map(([name, ver]) => [name, ver || lockMap.get(name) || '']);
}

/** Collect direct deps as `[name, constraint]` from every supported manifest
 *  BEYOND the root package.json/composer.json (which the caller already parses):
 *  npm workspaces, Gemfile(.lock), requirements.txt, pyproject.toml, go.mod and
 *  Cargo.toml. Best-effort and bounded — a missing or malformed file yields
 *  nothing rather than throwing. */
export async function collectExtraManifestDeps(repoPath: string): Promise<ManifestDep[]> {
  const rootPkgText = await readSafe(path.join(repoPath, 'package.json'));
  const [workspace, ruby, reqs, pyproj, gomod, cargo] = await Promise.all([
    collectWorkspaceNpmDeps(repoPath, rootPkgText),
    collectRubyDeps(repoPath),
    readSafe(path.join(repoPath, 'requirements.txt')).then((t) =>
      t ? parseRequirementsTxt(t) : [],
    ),
    readSafe(path.join(repoPath, 'pyproject.toml')).then((t) => (t ? parsePyprojectDeps(t) : [])),
    readSafe(path.join(repoPath, 'go.mod')).then((t) => (t ? parseGoMod(t) : [])),
    readSafe(path.join(repoPath, 'Cargo.toml')).then((t) => (t ? parseCargoToml(t) : [])),
  ]);
  return [...workspace, ...ruby, ...reqs, ...pyproj, ...gomod, ...cargo];
}
