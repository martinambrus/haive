import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { FRAMEWORK_PATTERNS, type FrameworkName, type DetectResult } from '@haive/shared';
import type { StepContext, StepDefinition, LlmBuildArgs } from '../../step-definition.js';

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

async function loadRepoNameForTask(
  db: Database | undefined,
  taskId: string,
): Promise<string | null> {
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
      columns: { name: true },
    });
    return repo?.name ?? null;
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
  database: { type: string | null; version: string | null };
  runtimeVersions: Record<string, string>;
  indicators: string[];
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

function matchYamlField(text: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm');
  const m = text.match(re);
  return m && m[1] ? m[1].trim() : null;
}

function matchYamlBlockField(text: string, block: string, key: string): string | null {
  const blockRe = new RegExp(`^${block}:\\s*\\n((?:[ \\t]+.+\\n?)+)`, 'm');
  const blockMatch = text.match(blockRe);
  if (!blockMatch || !blockMatch[1]) return null;
  const inner = blockMatch[1];
  const fieldRe = new RegExp(`^[ \\t]+${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm');
  const m = inner.match(fieldRe);
  return m && m[1] ? m[1].trim() : null;
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
}

interface ComposerJsonShape {
  name?: string;
  require?: Record<string, string>;
  ['require-dev']?: Record<string, string>;
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

async function detectStack(
  repoPath: string,
  container: ContainerDetection,
): Promise<StackDetection> {
  const indicators: string[] = [];
  const runtimeVersions: Record<string, string> = { ...container.runtimeVersions };
  let language: string | null = null;
  let framework: FrameworkName | null = null;

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
        const pkg = JSON.parse(text) as PackageJsonShape;
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
        phpFramework = detectPhpFramework(JSON.parse(text) as ComposerJsonShape);
      } catch {
        /* ignore parse error */
      }
    }
    if (phpFramework === 'drupal') {
      if (await pathExists(path.join(repoPath, 'includes', 'bootstrap.inc'))) {
        framework = 'drupal7';
      } else {
        framework = 'drupal';
      }
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

  const dbType = container.databaseType;
  const dbVersion = container.databaseVersion;

  return {
    language,
    framework,
    database: { type: dbType, version: dbVersion },
    runtimeVersions,
    indicators,
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
  const fenceRe = /```json\s*([\s\S]*?)```/;
  const match = fenceRe.exec(text);
  const body = match?.[1] ?? text;
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
    merged.stack = {
      ...merged.stack,
      database: {
        type: enrichment.databaseType,
        version: enrichment.databaseVersion ?? merged.stack.database.version,
      },
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

function buildEnvDetectPrompt(args: LlmBuildArgs): string {
  const detected = args.detected as DetectResult;
  const data = detected.data as unknown as EnvDetectData;
  const configContents =
    ((detected.data as Record<string, unknown>).__configContents as string) ?? '';

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
    '## Instructions',
    `1. Project name: the deterministic guess is "${data.project.name}". If that looks like a UUID, random hex, or a generic placeholder (unnamed-repo, archive, repo, project, unknown), derive a better human-readable name from the README title, package.json "name", composer.json "name" (use the part after the slash), or similar metadata. Otherwise emit null to keep the deterministic name.`,
    '2. Confirm or correct: framework, primaryLanguage',
    '3. Detect the local development URL (from DDEV config, docker-compose port mappings, .env files, etc.)',
    '4. Detect database type and version more precisely if possible',
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
    const stack = await detectStack(ctx.repoPath, container);
    const gitRemoteName = await detectGitRemoteName(ctx.repoPath);
    const dbRepoName = await loadRepoNameForTask(ctx.db, ctx.taskId);
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

    // Collect config file contents for the LLM prompt
    const configContents = await collectConfigFileContents(ctx.repoPath);

    const warnings: string[] = [];
    if (data.stack.indicators.length === 0) {
      warnings.push('no language indicators detected');
    }
    return {
      summary: buildSummary(data),
      data: { ...(data as unknown as Record<string, unknown>), __configContents: configContents },
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
    // Remove the transient config contents before persisting
    delete rawData.__configContents;
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
