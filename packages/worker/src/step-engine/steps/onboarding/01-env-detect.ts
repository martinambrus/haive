import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { FRAMEWORK_PATTERNS, type FrameworkName, type DetectResult } from '@haive/shared';
import type { StepContext, StepDefinition, LlmBuildArgs } from '../../step-definition.js';
import {
  buildTechInventory,
  renderTechInventoryTable,
  type TechInventory,
} from './_tech-inventory.js';
import { extractFencedJson } from '../_fenced-json.js';
import { matchYamlField, matchYamlBlockField } from '../_ddev-config.js';
import { buildFileTree, detectLanguages } from '../../../repo/framework-detect.js';
import {
  collectExtraManifestDeps,
  detectLanguageRuntimes,
  firstMajor,
  manifestPackages,
  numericVersion,
} from './_manifest-deps.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_NAMES = new Set([
  '',
  'unnamed-repo',
  'unnamed',
  'archive',
  'repo',
  'project',
  'unknown',
]);

function looksLikeBadName(name: string | null | undefined): boolean {
  if (!name) return true;
  const trimmed = name.trim().toLowerCase();
  if (GENERIC_NAMES.has(trimmed)) return true;
  if (UUID_RE.test(trimmed)) return true;
  return false;
}

function deriveNameFromGitUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/\.git\/?$/i, '').replace(/\/+$/, '');
  const lastSegment = cleaned.split(/[/:]/).pop();
  return lastSegment ? lastSegment.trim() : null;
}

async function detectGitRemoteName(repoPath: string): Promise<string | null> {
  const text = await readTextSafe(path.join(repoPath, '.git', 'config'));
  if (!text) return null;
  const originBlockMatch = text.match(/\[remote\s+"origin"\][\s\S]*?(?=\n\[|$)/);
  const block = originBlockMatch?.[0];
  if (!block) return null;
  const urlMatch = block.match(/^\s*url\s*=\s*(.+)$/m);
  const url = urlMatch?.[1]?.trim();
  if (!url) return null;
  return deriveNameFromGitUrl(url);
}

interface RepoMeta {
  name: string | null;
  detectedLanguages: Record<string, number> | null;
  fileTree: string[] | null;
}

async function loadRepoMetaForTask(
  db: Database | undefined,
  taskId: string,
): Promise<RepoMeta | null> {
  // Tests construct StepContext with `db: undefined as never`, so guard
  // before touching the query proxy.
  if (!db) return null;
  try {
    const taskRow = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { repositoryId: true },
    });
    if (!taskRow?.repositoryId) return null;
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, taskRow.repositoryId),
      columns: { name: true, detectedLanguages: true, fileTree: true },
    });
    if (!repo) return null;
    return {
      name: repo.name ?? null,
      detectedLanguages: repo.detectedLanguages ?? null,
      fileTree: repo.fileTree ?? null,
    };
  } catch {
    return null;
  }
}

type ContainerType = 'ddev' | 'docker-compose' | 'lando' | 'vagrant' | 'none';

interface ContainerDetection {
  type: ContainerType;
  configFile: string | null;
  projectName: string | null;
  frameworkHint: string | null;
  databaseType: string | null;
  databaseVersion: string | null;
  webserver: string | null;
  docroot: string | null;
  runtimeVersions: Record<string, string>;
}

interface StackDetection {
  language: string | null;
  framework: FrameworkName | null;
  /** Major version of the framework, parsed deterministically from the manifest
   *  (composer drupal/core, package.json next, ...). Distinguishes same-family
   *  majors (Drupal 11 vs 12) that `framework` alone cannot. Null when unknown. */
  frameworkMajor: string | null;
  database: { type: string | null; version: string | null };
  runtimeVersions: Record<string, string>;
  indicators: string[];
  /** Direct manifest dependencies as `name@major` (composer + npm). Generic,
   *  deterministic per-package version scoping for the global KB — no per-package
   *  code, works for any dependency in a parsed manifest. */
  packages: string[];
}

interface PathsDetection {
  testPaths: string[];
  envFiles: string[];
  customCodePaths: { include: readonly string[]; exclude: readonly string[] };
}

interface EnvDetectData {
  project: {
    name: string;
    framework: FrameworkName;
    /** Major version of the framework (e.g. "11" for Drupal 11). Drives the
     *  global KB `frameworkMajor` facet at query time. */
    frameworkMajor?: string | null;
    /** Direct manifest dependencies as `name@major`; drives the `packages` facet. */
    packages?: string[];
    primaryLanguage: string;
    description: string | null;
  };
  container: ContainerDetection;
  stack: StackDetection;
  paths: PathsDetection;
  localUrl: string | null;
  testFrameworks: string[];
  buildTool: string | null;
  source: 'llm' | 'deterministic';
}

const STACK_INDICATORS: { file: string; language: string }[] = [
  { file: 'package.json', language: 'javascript' },
  { file: 'composer.json', language: 'php' },
  { file: 'requirements.txt', language: 'python' },
  { file: 'pyproject.toml', language: 'python' },
  { file: 'Gemfile', language: 'ruby' },
  { file: 'Cargo.toml', language: 'rust' },
  { file: 'go.mod', language: 'go' },
  { file: 'pom.xml', language: 'java' },
  { file: 'build.gradle', language: 'java' },
  { file: 'mix.exs', language: 'elixir' },
];

// Languages that are rarely a project's "primary" language on their own —
// markup, styling and data formats. Excluded when inferring primaryLanguage
// from the file-count histogram so a CSS/HTML-heavy app isn't mislabelled.
const NON_PRIMARY_LANGUAGES = new Set([
  'CSS',
  'SCSS',
  'LESS',
  'HTML',
  'JSON',
  'YAML',
  'Markdown',
  'SQL',
  'Shell',
  'XML',
]);

// Server-side languages preferred over JS/TS when both are present, so a PHP
// backend with a vendored JavaScript frontend (whose file count can dominate)
// is still reported as PHP.
const SERVER_LANGUAGES = new Set([
  'PHP',
  'Python',
  'Ruby',
  'Go',
  'Rust',
  'Java',
  'Kotlin',
  'C#',
  'Elixir',
  'Scala',
  'Swift',
  'C',
  'C++',
]);

/** Infer a lowercase primary language from a linguist-style
 *  {languageName: fileCount} histogram (as produced at repo ingest). Returns
 *  null when the histogram carries no usable signal. Used as a fallback when
 *  no root manifest (composer.json, package.json, ...) reveals the language. */
export function pickPrimaryLanguage(
  histogram: Record<string, number> | null | undefined,
): string | null {
  if (!histogram) return null;
  const entries = Object.entries(histogram).filter(
    ([lang, count]) => count > 0 && !NON_PRIMARY_LANGUAGES.has(lang),
  );
  if (entries.length === 0) return null;
  const servers = entries.filter(([lang]) => SERVER_LANGUAGES.has(lang));
  const pool = servers.length > 0 ? servers : entries;
  pool.sort((a, b) => b[1] - a[1]);
  const winner = pool[0]?.[0];
  return winner ? winner.toLowerCase() : null;
}

// Map the tech-inventory catalog db slug onto the vocabulary the container
// detector and the confirmation form already use.
const DB_NAME_TO_TYPE: Record<string, string> = {
  postgresql: 'postgres',
  mysql: 'mysql',
  sqlite: 'sqlite',
  mongodb: 'mongodb',
  redis: 'redis',
};

/** Pick a database type from a tech inventory (source + manifest scan).
 *  Prefers a real database over redis (a cache), ranked by file usage. Returns
 *  null when no db tech was found. Used when container orchestration config
 *  (docker-compose / ddev / lando) did not reveal a database. */
export function pickDatabaseFromInventory(inventory: TechInventory | null): string | null {
  if (!inventory) return null;
  const dbItems = inventory.items.filter((it) => it.category === 'db');
  if (dbItems.length === 0) return null;
  const nonRedis = dbItems.filter((it) => it.name !== 'redis');
  const pool = nonRedis.length > 0 ? nonRedis : dbItems;
  pool.sort((a, b) => b.fileCount - a.fileCount);
  const top = pool[0];
  return top ? (DB_NAME_TO_TYPE[top.name] ?? top.name) : null;
}

const TEST_DIR_CANDIDATES = [
  'test',
  'tests',
  'spec',
  'cypress',
  'e2e',
  '__tests__',
  'integration',
  'test-playwright',
  'playwright',
  'features',
];

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readTextSafe(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function detectContainer(repoPath: string): Promise<ContainerDetection> {
  const empty: ContainerDetection = {
    type: 'none',
    configFile: null,
    projectName: null,
    frameworkHint: null,
    databaseType: null,
    databaseVersion: null,
    webserver: null,
    docroot: null,
    runtimeVersions: {},
  };

  const ddevConfig = path.join(repoPath, '.ddev', 'config.yaml');
  if (await pathExists(ddevConfig)) {
    const text = (await readTextSafe(ddevConfig)) ?? '';
    const result: ContainerDetection = {
      type: 'ddev',
      configFile: '.ddev/config.yaml',
      projectName: matchYamlField(text, 'name'),
      frameworkHint: matchYamlField(text, 'type'),
      databaseType: matchYamlBlockField(text, 'database', 'type'),
      databaseVersion: matchYamlBlockField(text, 'database', 'version'),
      webserver: matchYamlField(text, 'webserver_type'),
      docroot: matchYamlField(text, 'docroot'),
      runtimeVersions: {},
    };
    const php = matchYamlField(text, 'php_version');
    if (php) result.runtimeVersions.php = php;
    const node = matchYamlField(text, 'nodejs_version');
    if (node) result.runtimeVersions.node = node;
    return result;
  }

  for (const compose of [
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml',
  ]) {
    const composeFile = path.join(repoPath, compose);
    if (!(await pathExists(composeFile))) continue;
    const text = (await readTextSafe(composeFile)) ?? '';
    let dbType: string | null = null;
    if (/\b(postgres|postgresql)\b/i.test(text)) dbType = 'postgres';
    else if (/\bmariadb\b/i.test(text)) dbType = 'mariadb';
    else if (/\bmysql\b/i.test(text)) dbType = 'mysql';
    else if (/\bmongo(?:db)?\b/i.test(text)) dbType = 'mongodb';
    return {
      type: 'docker-compose',
      configFile: compose,
      projectName: null,
      frameworkHint: null,
      databaseType: dbType,
      databaseVersion: null,
      webserver: null,
      docroot: null,
      runtimeVersions: {},
    };
  }

  const lando = path.join(repoPath, '.lando.yml');
  if (await pathExists(lando)) {
    const text = (await readTextSafe(lando)) ?? '';
    return {
      type: 'lando',
      configFile: '.lando.yml',
      projectName: matchYamlField(text, 'name'),
      frameworkHint: matchYamlField(text, 'recipe'),
      databaseType: null,
      databaseVersion: null,
      webserver: null,
      docroot: null,
      runtimeVersions: {},
    };
  }

  if (await pathExists(path.join(repoPath, 'Vagrantfile'))) {
    return { ...empty, type: 'vagrant', configFile: 'Vagrantfile' };
  }

  return empty;
}

interface PackageJsonShape {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  volta?: { node?: string };
}

interface ComposerJsonShape {
  name?: string;
  require?: Record<string, string>;
  ['require-dev']?: Record<string, string>;
  config?: { platform?: Record<string, string> };
}

function detectNodeFramework(pkg: PackageJsonShape): FrameworkName {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if ('next' in deps) return 'nextjs';
  if ('react' in deps || 'vue' in deps || '@angular/core' in deps) return 'nodejs';
  return 'nodejs';
}

function detectPhpFramework(composer: ComposerJsonShape): FrameworkName {
  const deps = { ...(composer.require ?? {}), ...(composer['require-dev'] ?? {}) };
  if (
    'drupal/core' in deps ||
    'drupal/core-recommended' in deps ||
    'drupal/recommended-project' in deps
  ) {
    return 'drupal';
  }
  if ('laravel/framework' in deps) return 'laravel';
  return 'general';
}

/** Manifest dependency keys that hold each framework's version, keyed by the
 *  FrameworkName env-detect classifies into. Deterministic coverage is BOUNDED
 *  by the frameworks we recognize — not arbitrary user input — so each line maps
 *  one known framework to its version dep, looked up across the union of every
 *  parsed manifest (composer, npm + workspaces, Gemfile, requirements/pyproject,
 *  ...). Frameworks not listed (general / nodejs / python / wordpress / ...) get
 *  no frameworkMajor; the kb-author LLM fills the major for arbitrary stacks at
 *  authoring time. Extend by adding a line. */
const FRAMEWORK_VERSION_KEYS: Partial<Record<FrameworkName, string[]>> = {
  drupal: ['drupal/core', 'drupal/core-recommended', 'drupal/recommended-project'],
  laravel: ['laravel/framework'],
  nextjs: ['next'],
  rails: ['rails'],
  django: ['Django', 'django'],
};

/** Deterministic framework MAJOR from the merged manifest deps. drupal7 is
 *  implicit; otherwise look up the framework's version dep(s) and take its leading
 *  integer. Null for frameworks without a registered key (the LLM handles those
 *  when authoring an entry against a specific repo). */
function extractFrameworkMajor(
  framework: FrameworkName,
  deps: Record<string, string>,
): string | null {
  if (framework === 'drupal7') return '7';
  const keys = FRAMEWORK_VERSION_KEYS[framework];
  if (!keys) return null;
  for (const key of keys) {
    const major = firstMajor(deps[key]);
    if (major) return major;
  }
  return null;
}

/** Node runtime version from the repo's own pins, in precedence order: .nvmrc,
 *  .node-version, package.json volta.node, then engines.node (a range — used
 *  last). Null when none yields a number. Lets the global KB scope by Node major
 *  WITHOUT a DDEV container (a Node project never has one). */
async function detectNodeVersion(
  repoPath: string,
  pkg: PackageJsonShape | null,
): Promise<string | null> {
  const fromFile = async (name: string): Promise<string | null> =>
    numericVersion((await readTextSafe(path.join(repoPath, name)))?.trim() ?? null);
  return (
    (await fromFile('.nvmrc')) ??
    (await fromFile('.node-version')) ??
    numericVersion(pkg?.volta?.node) ??
    numericVersion(pkg?.engines?.node)
  );
}

/** PHP runtime version from composer.json: the pinned config.platform.php wins
 *  over the require.php constraint. Null when neither is set. Decouples PHP
 *  version-scoping from DDEV. */
function detectPhpVersion(composer: ComposerJsonShape | null): string | null {
  if (!composer) return null;
  return numericVersion(composer.config?.platform?.php) ?? numericVersion(composer.require?.php);
}

async function detectStack(
  repoPath: string,
  container: ContainerDetection,
): Promise<StackDetection> {
  const indicators: string[] = [];
  const runtimeVersions: Record<string, string> = { ...container.runtimeVersions };
  let language: string | null = null;
  let framework: FrameworkName | null = null;
  let packageDeps: Record<string, string> = {};
  let composerDeps: Record<string, string> = {};
  let pkg: PackageJsonShape | null = null;
  let composer: ComposerJsonShape | null = null;

  for (const { file, language: lang } of STACK_INDICATORS) {
    if (await pathExists(path.join(repoPath, file))) {
      indicators.push(file);
      if (!language) language = lang;
    }
  }

  if (indicators.includes('package.json')) {
    const text = await readTextSafe(path.join(repoPath, 'package.json'));
    if (text) {
      try {
        pkg = JSON.parse(text) as PackageJsonShape;
        packageDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        framework = detectNodeFramework(pkg);
      } catch {
        framework = 'nodejs';
      }
    } else {
      framework = 'nodejs';
    }
  }

  if (indicators.includes('composer.json')) {
    const text = await readTextSafe(path.join(repoPath, 'composer.json'));
    let phpFramework: FrameworkName = 'general';
    if (text) {
      try {
        composer = JSON.parse(text) as ComposerJsonShape;
        composerDeps = { ...(composer.require ?? {}), ...(composer['require-dev'] ?? {}) };
        phpFramework = detectPhpFramework(composer);
      } catch {
        /* ignore parse error */
      }
    }
    if (phpFramework === 'drupal') {
      framework = (await pathExists(path.join(repoPath, 'includes', 'bootstrap.inc')))
        ? 'drupal7'
        : 'drupal';
    } else if (phpFramework === 'laravel') {
      framework = 'laravel';
    } else if (!framework) {
      framework = 'general';
    }
    language = 'php';
  }

  if (indicators.includes('pyproject.toml') || indicators.includes('requirements.txt')) {
    if (await pathExists(path.join(repoPath, 'manage.py'))) {
      framework = 'django';
    } else if (!framework) {
      framework = 'python';
    }
    language = 'python';
  }

  if (indicators.includes('go.mod') && !framework) {
    framework = 'go';
    language = 'go';
  }
  if (indicators.includes('Cargo.toml') && !framework) {
    framework = 'rust';
    language = 'rust';
  }
  if (indicators.includes('Gemfile') && !framework) {
    framework = 'rails';
    language = 'ruby';
  }

  if (await pathExists(path.join(repoPath, 'wp-config.php'))) {
    framework = 'wordpress';
    language = 'php';
  }

  if (!framework) framework = 'general';

  // Runtime language majors from the repo's own manifests, so version-scoping the
  // global KB does not depend on a DDEV container. A container value (if any)
  // already sits in runtimeVersions and wins — only fill the gaps.
  if (!runtimeVersions.node) {
    const node = await detectNodeVersion(repoPath, pkg);
    if (node) runtimeVersions.node = node;
  }
  if (!runtimeVersions.php) {
    const php = detectPhpVersion(composer);
    if (php) runtimeVersions.php = php;
  }
  // Other supported languages (python/ruby/go/rust) from their own version files
  // / manifests — captured so the confirmation step can show and confirm them.
  const langRuntimes = await detectLanguageRuntimes(repoPath);
  for (const [lang, version] of Object.entries(langRuntimes)) {
    if (!runtimeVersions[lang]) runtimeVersions[lang] = version;
  }

  // Root composer.json / package.json deps (already parsed) PLUS every other
  // supported manifest (npm workspaces, Gemfile, requirements/pyproject, go.mod,
  // Cargo.toml) so a monorepo or non-JS/PHP stack still yields `name@major`
  // anchors for the global KB and a rails/django framework major.
  const extraDeps = await collectExtraManifestDeps(repoPath);
  const allDeps: Record<string, string> = {
    ...composerDeps,
    ...packageDeps,
    ...Object.fromEntries(extraDeps),
  };
  const frameworkMajor = extractFrameworkMajor(framework, allDeps);
  const packages = manifestPackages([
    ...Object.entries(composerDeps),
    ...Object.entries(packageDeps),
    ...extraDeps,
  ]);

  const dbType = container.databaseType;
  const dbVersion = container.databaseVersion;

  return {
    language,
    framework,
    frameworkMajor,
    database: { type: dbType, version: dbVersion },
    runtimeVersions,
    indicators,
    packages,
  };
}

async function detectPaths(repoPath: string, framework: FrameworkName): Promise<PathsDetection> {
  const testPaths: string[] = [];
  for (const candidate of TEST_DIR_CANDIDATES) {
    const full = path.join(repoPath, candidate);
    try {
      const s = await stat(full);
      if (s.isDirectory()) testPaths.push(candidate);
    } catch {
      /* missing dir */
    }
  }

  const envFiles: string[] = [];
  await collectEnvFiles(repoPath, '', 0, envFiles);

  const pattern = FRAMEWORK_PATTERNS[framework] ?? FRAMEWORK_PATTERNS.general;
  return {
    testPaths,
    envFiles,
    customCodePaths: {
      include: pattern.customPaths,
      exclude: pattern.excludePaths,
    },
  };
}

async function collectEnvFiles(
  root: string,
  rel: string,
  depth: number,
  out: string[],
): Promise<void> {
  if (depth > 2 || out.length >= 10) return;
  const dir = path.join(root, rel);
  let entries: Dirent[] = [];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'vendor') continue;
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isFile() && entry.name.startsWith('.env')) {
      out.push(childRel);
      if (out.length >= 10) return;
    } else if (entry.isDirectory() && depth < 2) {
      await collectEnvFiles(root, childRel, depth + 1, out);
      if (out.length >= 10) return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* LLM enrichment types + helpers                                      */
/* ------------------------------------------------------------------ */

interface LlmEnrichment {
  projectName: string | null;
  framework: string | null;
  primaryLanguage: string | null;
  localUrl: string | null;
  databaseType: string | null;
  databaseVersion: string | null;
  webserver: string | null;
  docroot: string | null;
  runtimeVersions: Record<string, string>;
  testFrameworks: string[];
  buildTool: string | null;
  projectDescription: string | null;
}

function parseEnrichment(raw: unknown): LlmEnrichment | null {
  if (!raw) return null;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object' && !Array.isArray(raw)) {
    // Already parsed object from the dispatcher
    return isValidEnrichment(raw as Record<string, unknown>)
      ? (raw as unknown as LlmEnrichment)
      : null;
  } else {
    return null;
  }
  const body = extractFencedJson(text) ?? text;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return isValidEnrichment(parsed) ? (parsed as unknown as LlmEnrichment) : null;
  } catch {
    return null;
  }
}

function isValidEnrichment(v: Record<string, unknown>): boolean {
  // Minimal shape check: at least one enriched field present
  return (
    typeof v === 'object' &&
    v !== null &&
    (typeof v.projectName === 'string' ||
      typeof v.framework === 'string' ||
      typeof v.primaryLanguage === 'string' ||
      typeof v.databaseType === 'string' ||
      typeof v.localUrl === 'string' ||
      typeof v.projectDescription === 'string' ||
      typeof v.buildTool === 'string' ||
      Array.isArray(v.testFrameworks))
  );
}

function mergeEnrichment(base: EnvDetectData, enrichment: LlmEnrichment): EnvDetectData {
  const merged = { ...base, source: 'llm' as const };

  if (enrichment.projectName && enrichment.projectName.trim().length > 0) {
    const cleaned = enrichment.projectName.trim();
    // Only override when the deterministic name is bad (UUID-shaped or
    // generic placeholder). Otherwise keep the deterministic pick — the
    // user will see and can edit it in the confirmation form anyway.
    if (looksLikeBadName(merged.project.name) && !looksLikeBadName(cleaned)) {
      merged.project = { ...merged.project, name: cleaned };
    }
  }

  if (enrichment.framework) {
    const fw = enrichment.framework as FrameworkName;
    if (fw in FRAMEWORK_PATTERNS) {
      merged.project = { ...merged.project, framework: fw };
    }
  }
  if (enrichment.primaryLanguage) {
    merged.project = { ...merged.project, primaryLanguage: enrichment.primaryLanguage };
  }
  if (enrichment.projectDescription) {
    merged.project = { ...merged.project, description: enrichment.projectDescription };
  }
  if (enrichment.localUrl) {
    merged.localUrl = enrichment.localUrl;
  }
  if (enrichment.databaseType) {
    const dbVersion = enrichment.databaseVersion ?? merged.stack.database.version;
    merged.stack = {
      ...merged.stack,
      database: { type: enrichment.databaseType, version: dbVersion },
    };
    // The confirmation form (02) and file generation (07) read the db from
    // container.databaseType, so keep it in sync or the value never surfaces.
    merged.container = {
      ...merged.container,
      databaseType: enrichment.databaseType,
      databaseVersion: enrichment.databaseVersion ?? merged.container.databaseVersion,
    };
  }
  if (enrichment.webserver) {
    merged.container = { ...merged.container, webserver: enrichment.webserver };
  }
  if (enrichment.docroot) {
    merged.container = { ...merged.container, docroot: enrichment.docroot };
  }
  if (enrichment.runtimeVersions && typeof enrichment.runtimeVersions === 'object') {
    merged.stack = {
      ...merged.stack,
      runtimeVersions: { ...merged.stack.runtimeVersions, ...enrichment.runtimeVersions },
    };
  }
  if (Array.isArray(enrichment.testFrameworks) && enrichment.testFrameworks.length > 0) {
    merged.testFrameworks = enrichment.testFrameworks;
  }
  if (enrichment.buildTool) {
    merged.buildTool = enrichment.buildTool;
  }
  return merged;
}

async function collectConfigFileContents(repoPath: string): Promise<string> {
  const candidates = [
    'package.json',
    'composer.json',
    '.ddev/config.yaml',
    'docker-compose.yml',
    'docker-compose.yaml',
    '.lando.yml',
    'README.md',
    'README',
    'README.txt',
    '.env.example',
    '.env.dist',
    'Makefile',
    'Taskfile.yml',
    'turbo.json',
    'nx.json',
  ];
  const parts: string[] = [];
  for (const name of candidates) {
    const content = await readTextSafe(path.join(repoPath, name));
    if (content !== null) {
      // Truncate large files (README etc.) to keep prompt reasonable
      const truncated =
        content.length > 4000 ? content.slice(0, 4000) + '\n[...truncated]' : content;
      parts.push(`--- ${name} ---\n${truncated}`);
    }
  }
  return parts.join('\n\n');
}

// Source files whose names suggest database wiring or schema — surfaced to the
// LLM so it can pin down db type/version even when no manifest/container config
// exists. Matches e.g. database.php, db.inc, wp-config.php, settings.py, *.sql.
const DB_HINT_FILE_RE =
  /(?:^|\/)(?:database|db|config|configuration|connect(?:ion)?|settings|wp-config)[^/]*\.(?:php|inc|module|install|py|rb|js|ts|env)$|\.sql$/i;

async function collectSourceSamples(repoPath: string, fileTree: string[]): Promise<string> {
  const hits = fileTree.filter((p) => DB_HINT_FILE_RE.test(p)).slice(0, 2);
  const parts: string[] = [];
  for (const rel of hits) {
    const content = await readTextSafe(path.join(repoPath, rel));
    if (content !== null) {
      const truncated =
        content.length > 2500 ? content.slice(0, 2500) + '\n[...truncated]' : content;
      parts.push(`--- ${rel} ---\n${truncated}`);
    }
  }
  return parts.join('\n\n');
}

function renderLanguageHistogram(histogram: Record<string, number> | null): string {
  if (!histogram) return '(unknown)';
  const entries = Object.entries(histogram)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return '(none)';
  return entries.map(([lang, count]) => `${lang}: ${count}`).join(', ');
}

function renderFileTreeSummary(fileTree: string[], limit = 200): string {
  if (fileTree.length === 0) return '(empty)';
  const shown = fileTree.slice(0, limit);
  const suffix = fileTree.length > limit ? `\n[...${fileTree.length - limit} more files]` : '';
  return shown.join('\n') + suffix;
}

interface RepoIntel {
  histogram: Record<string, number> | null;
  fileTree: string[];
  techInventory: TechInventory | null;
  sourceSamples: string;
}

function buildRepoIntelSection(intel: RepoIntel): string {
  return [
    '## Repository intelligence',
    '',
    '### Detected languages (file counts)',
    renderLanguageHistogram(intel.histogram),
    '',
    '### Secondary technologies (source + manifest scan)',
    intel.techInventory ? renderTechInventoryTable(intel.techInventory) : '(none)',
    '',
    '### File tree (truncated)',
    renderFileTreeSummary(intel.fileTree),
    '',
    '### Key source samples',
    intel.sourceSamples || '(none)',
  ].join('\n');
}

function buildEnvDetectPrompt(args: LlmBuildArgs): string {
  const detected = args.detected as DetectResult;
  const data = detected.data as unknown as EnvDetectData;
  const configContents =
    ((detected.data as Record<string, unknown>).__configContents as string) ?? '';
  const repoIntel = ((detected.data as Record<string, unknown>).__repoIntel as string) ?? '';

  return [
    'You are analysing a software repository to detect its development environment.',
    'Below is what deterministic file scanning already found, plus the raw contents of key config files.',
    'Your job: confirm or correct the detection, and fill in fields that file scanning cannot determine.',
    '',
    '## Deterministic detection results',
    '```json',
    JSON.stringify(
      {
        project: data.project,
        container: { type: data.container.type, configFile: data.container.configFile },
        stack: data.stack,
        paths: data.paths,
      },
      null,
      2,
    ),
    '```',
    '',
    '## Config file contents',
    configContents || '(no config files found)',
    '',
    repoIntel,
    '',
    '## Instructions',
    `1. Project name: the deterministic guess is "${data.project.name}". If that looks like a UUID, random hex, or a generic placeholder (unnamed-repo, archive, repo, project, unknown), derive a better human-readable name from the README title, package.json "name", composer.json "name" (use the part after the slash), or similar metadata. Otherwise emit null to keep the deterministic name.`,
    '2. Confirm or correct: framework, primaryLanguage. Use the "Detected languages" file counts and the file tree above — the dominant server-side language is usually the primary language even when there is no manifest (e.g. a PHP app with no composer.json). Emit primaryLanguage as a lowercase token (php, javascript, python, ...).',
    '3. Detect the local development URL (from DDEV config, docker-compose port mappings, .env files, etc.)',
    '4. Detect database type and version. Infer from the secondary-technologies table and the key source samples (e.g. mysqli_*/mysql_* or PDO mysql -> mysql; pg_* -> postgres) even when no container config declares a database.',
    '5. Identify the webserver (nginx, apache, etc.) and document root',
    '6. Identify test frameworks (jest, vitest, phpunit, playwright, cypress, pytest, etc.) from config files or dependencies',
    '7. Identify build tooling (vite, webpack, esbuild, turbo, nx, etc.)',
    '8. Write a 1-2 sentence project description based on README or project structure',
    '9. Detect runtime versions (PHP, Node, Python, etc.) from config files',
    '',
    '## Required output format',
    'Emit exactly ONE JSON object inside a ```json fenced code block with this shape:',
    '```',
    '{',
    '  "projectName": "<human-readable name or null to keep the deterministic guess>",',
    '  "framework": "<FrameworkName or null if deterministic was correct>",',
    '  "primaryLanguage": "<language or null>",',
    '  "localUrl": "<url or null>",',
    '  "databaseType": "<type or null>",',
    '  "databaseVersion": "<version or null>",',
    '  "webserver": "<nginx|apache|... or null>",',
    '  "docroot": "<relative path or null>",',
    '  "runtimeVersions": { "php": "8.3", "node": "22" },',
    '  "testFrameworks": ["phpunit", "playwright"],',
    '  "buildTool": "<vite|webpack|... or null>",',
    '  "projectDescription": "<1-2 sentence description or null>"',
    '}',
    '```',
    'Only emit fields you can determine from the provided data. Use null for unknowns.',
    'Do not emit any prose outside the fenced block.',
  ].join('\n');
}

function buildSummary(data: EnvDetectData): string {
  const parts: string[] = [];
  parts.push(`framework=${data.project.framework}`);
  parts.push(`language=${data.project.primaryLanguage}`);
  if (data.container.type !== 'none') parts.push(`container=${data.container.type}`);
  if (data.stack.database.type) {
    parts.push(
      `db=${data.stack.database.type}${data.stack.database.version ? `@${data.stack.database.version}` : ''}`,
    );
  }
  if (data.paths.testPaths.length > 0) parts.push(`tests=${data.paths.testPaths.length}`);
  if (data.localUrl) parts.push(`url=${data.localUrl}`);
  if (data.testFrameworks.length > 0) parts.push(`testfw=${data.testFrameworks.join(',')}`);
  if (data.buildTool) parts.push(`build=${data.buildTool}`);
  parts.push(`source=${data.source}`);
  return parts.join(' ');
}

export type EnvDetectApply = {
  directoriesCreated: string[];
  enrichedData: EnvDetectData;
  source: 'llm' | 'deterministic';
};

export const envDetectStep: StepDefinition<DetectResult, EnvDetectApply> = {
  metadata: {
    id: '01-env-detect',
    workflowType: 'onboarding',
    index: 1,
    title: 'Environment detection',
    description:
      'Scans the repository for container config, language and framework indicators, test directories and env files, then optionally enriches via LLM analysis.',
    requiresCli: true,
  },

  async detect(ctx: StepContext): Promise<DetectResult> {
    const container = await detectContainer(ctx.repoPath);

    // Shared repo intelligence: reuse the language histogram + file tree
    // computed at ingest (fall back to scanning disk when absent), plus a
    // source/manifest tech scan. Drives the deterministic fallbacks below and
    // is embedded into the LLM prompt.
    const meta = await loadRepoMetaForTask(ctx.db, ctx.taskId);
    const fileTree = meta?.fileTree ?? (await buildFileTree(ctx.repoPath).catch(() => []));
    const histogram =
      meta?.detectedLanguages ?? (fileTree.length > 0 ? detectLanguages(fileTree) : null);
    const techInventory = await buildTechInventory(ctx.repoPath).catch(() => null);

    // DB fallback: when container orchestration config revealed no database,
    // infer it from source/manifest usage. Setting it on container.databaseType
    // lets detectStack derive stack.database and the confirmation form show it.
    if (!container.databaseType) {
      const dbFromSource = pickDatabaseFromInventory(techInventory);
      if (dbFromSource) container.databaseType = dbFromSource;
    }

    const stack = await detectStack(ctx.repoPath, container);

    // Language fallback: when no root manifest revealed a language, infer the
    // primary language from the file-count histogram.
    if (!stack.language) {
      const langFromHistogram = pickPrimaryLanguage(histogram);
      if (langFromHistogram) stack.language = langFromHistogram;
    }

    const gitRemoteName = await detectGitRemoteName(ctx.repoPath);
    const dbRepoName = meta?.name ?? null;
    const dirBasename = path.basename(path.resolve(ctx.repoPath));
    const projectName =
      container.projectName ??
      (gitRemoteName && !looksLikeBadName(gitRemoteName) ? gitRemoteName : null) ??
      (dbRepoName && !looksLikeBadName(dbRepoName) ? dbRepoName : null) ??
      dirBasename;
    const data: EnvDetectData = {
      project: {
        name: projectName,
        framework: stack.framework ?? 'general',
        frameworkMajor: stack.frameworkMajor,
        packages: stack.packages,
        primaryLanguage: stack.language ?? 'unknown',
        description: null,
      },
      container,
      stack,
      paths: await detectPaths(ctx.repoPath, stack.framework ?? 'general'),
      localUrl: null,
      testFrameworks: [],
      buildTool: null,
      source: 'deterministic',
    };

    // Collect config file contents + repo intelligence for the LLM prompt.
    const configContents = await collectConfigFileContents(ctx.repoPath);
    const sourceSamples = await collectSourceSamples(ctx.repoPath, fileTree);
    const repoIntel = buildRepoIntelSection({ histogram, fileTree, techInventory, sourceSamples });

    const warnings: string[] = [];
    if (!stack.language) {
      warnings.push('no language indicators detected');
    }
    return {
      summary: buildSummary(data),
      data: {
        ...(data as unknown as Record<string, unknown>),
        __configContents: configContents,
        __repoIntel: repoIntel,
      },
      warnings,
    };
  },

  llm: {
    requiredCapabilities: [],
    buildPrompt: buildEnvDetectPrompt,
    parseOutput: (raw: string, _parsed: unknown) => parseEnrichment(raw),
  },

  async apply(ctx, args): Promise<EnvDetectApply> {
    const detectResult = args.detected as DetectResult;
    const rawData = { ...detectResult.data } as Record<string, unknown>;
    // Remove the transient prompt-only fields before persisting
    delete rawData.__configContents;
    delete rawData.__repoIntel;
    let data = rawData as unknown as EnvDetectData;

    // Merge LLM enrichment if available
    const enrichment = parseEnrichment(args.llmOutput ?? null);
    if (enrichment) {
      data = mergeEnrichment(data, enrichment);
      ctx.logger.info({ source: 'llm' }, 'env-detect enriched by LLM');
    } else {
      ctx.logger.info({ source: 'deterministic' }, 'env-detect using deterministic results only');
    }

    const created: string[] = [];
    for (const dir of ['.claude', path.join('.claude', 'knowledge_base')]) {
      const full = path.join(ctx.repoPath, dir);
      await mkdir(full, { recursive: true });
      created.push(dir);
    }
    ctx.logger.info(
      { detected: detectResult.summary, created, source: data.source },
      'env-detect apply complete',
    );
    return { directoriesCreated: created, enrichedData: data, source: data.source };
  },
};
