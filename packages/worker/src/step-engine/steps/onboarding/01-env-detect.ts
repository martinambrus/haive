import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { FRAMEWORK_PATTERNS, type FrameworkName, type DetectResult } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';

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
  project: { name: string; framework: FrameworkName; primaryLanguage: string };
  container: ContainerDetection;
  stack: StackDetection;
  paths: PathsDetection;
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
  return parts.join(' ');
}

export const envDetectStep: StepDefinition<DetectResult, { directoriesCreated: string[] }> = {
  metadata: {
    id: '01-env-detect',
    workflowType: 'onboarding',
    index: 1,
    title: 'Environment detection',
    description:
      'Scans the repository for container config, language and framework indicators, test directories and env files. No CLI required.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<DetectResult> {
    const container = await detectContainer(ctx.repoPath);
    const stack = await detectStack(ctx.repoPath, container);
    const projectName = container.projectName ?? path.basename(path.resolve(ctx.repoPath));
    const data: EnvDetectData = {
      project: {
        name: projectName,
        framework: stack.framework ?? 'general',
        primaryLanguage: stack.language ?? 'unknown',
      },
      container,
      stack,
      paths: await detectPaths(ctx.repoPath, stack.framework ?? 'general'),
    };
    const warnings: string[] = [];
    if (data.stack.indicators.length === 0) {
      warnings.push('no language indicators detected');
    }
    return {
      summary: buildSummary(data),
      data: data as unknown as Record<string, unknown>,
      warnings,
    };
  },

  async apply(ctx, args): Promise<{ directoriesCreated: string[] }> {
    const created: string[] = [];
    for (const dir of ['.claude', path.join('.claude', 'knowledge_base')]) {
      const full = path.join(ctx.repoPath, dir);
      await mkdir(full, { recursive: true });
      created.push(dir);
    }
    ctx.logger.info(
      { detected: (args.detected as DetectResult).summary, created },
      'env-detect apply complete',
    );
    return { directoriesCreated: created };
  },
};
