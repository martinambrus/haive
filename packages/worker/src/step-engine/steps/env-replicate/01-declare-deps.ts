import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { FormSchema, FormValues } from '@haive/shared';
import type { StepDefinition } from '../../step-definition.js';
import { deriveEnvTemplateName, getTaskEnvTemplate, linkTaskToEnvTemplate } from './_shared.js';

const ONBOARDING_LSP_TO_ENV_KEY: Record<string, LspKey> = {
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
  php: 'intelephense',
  'php-extended': 'intelephense-extended',
  java: 'jdtls',
};

async function loadOnboardingLspKeys(db: Database, repositoryId: string | null): Promise<LspKey[]> {
  if (!repositoryId) return [];
  const rows = await db
    .select({ output: schema.taskSteps.output })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.taskSteps.taskId, schema.tasks.id))
    .where(
      and(
        eq(schema.tasks.repositoryId, repositoryId),
        eq(schema.tasks.type, 'onboarding'),
        eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
        eq(schema.taskSteps.status, 'done'),
      ),
    )
    .orderBy(desc(schema.taskSteps.endedAt))
    .limit(1);
  const out = rows[0]?.output as { tooling?: { lspLanguages?: unknown } } | null;
  const langs = out?.tooling?.lspLanguages;
  if (!Array.isArray(langs)) return [];
  return langs
    .filter((v): v is string => typeof v === 'string')
    .map((l) => ONBOARDING_LSP_TO_ENV_KEY[l])
    .filter((v): v is LspKey => !!v);
}

type ContainerTool = 'ddev' | 'docker-compose' | 'docker' | 'none';
type DatabaseKind = 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'none';
type LanguageKey = 'node' | 'php' | 'python' | 'ruby' | 'go' | 'rust' | 'java';
type LspKey =
  | 'intelephense'
  | 'intelephense-extended'
  | 'vtsls'
  | 'pyright'
  | 'gopls'
  | 'rust-analyzer'
  | 'solargraph'
  | 'jdtls';
export type PackageManager =
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'composer'
  | 'pip'
  | 'poetry'
  | 'uv'
  | 'pdm'
  | 'pipenv'
  | 'bundler'
  | 'gomod'
  | 'cargo';

interface DetectedRuntime {
  language: LanguageKey;
  version: string | null;
  source: string;
  packageManager: PackageManager | null;
}

export interface DeclareDepsDetect {
  runtimes: DetectedRuntime[];
  containerTool: ContainerTool;
  ddevProjectName: string | null;
  database: { kind: DatabaseKind; version: string | null };
  suggestedLsp: LspKey[];
}

export interface DeclareDepsApply {
  envTemplateId: string;
  baseImage: string;
}

const CONTAINER_OPTIONS: { value: ContainerTool; label: string }[] = [
  { value: 'ddev', label: 'ddev (managed LAMP/LEMP stack)' },
  { value: 'docker-compose', label: 'docker compose' },
  { value: 'docker', label: 'plain docker' },
  { value: 'none', label: 'none' },
];

const DB_OPTIONS: { value: DatabaseKind; label: string }[] = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mariadb', label: 'MariaDB' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'sqlite', label: 'SQLite' },
  { value: 'none', label: 'none' },
];

const LSP_OPTIONS: { value: LspKey; label: string }[] = [
  { value: 'intelephense', label: 'Intelephense (PHP)' },
  {
    value: 'intelephense-extended',
    label: 'Intelephense + CMS extensions (.inc, .module, .install)',
  },
  { value: 'vtsls', label: 'vtsls (TypeScript/JavaScript)' },
  { value: 'pyright', label: 'Pyright (Python)' },
  { value: 'gopls', label: 'gopls (Go)' },
  { value: 'rust-analyzer', label: 'rust-analyzer (Rust)' },
  { value: 'solargraph', label: 'Solargraph (Ruby)' },
  { value: 'jdtls', label: 'jdtls (Java)' },
];

const RUNTIME_OPTIONS: { value: LanguageKey; label: string }[] = [
  { value: 'node', label: 'Node.js' },
  { value: 'php', label: 'PHP' },
  { value: 'python', label: 'Python' },
  { value: 'ruby', label: 'Ruby' },
  { value: 'go', label: 'Go' },
  { value: 'rust', label: 'Rust' },
  { value: 'java', label: 'Java' },
];

export const declareDepsStep: StepDefinition<DeclareDepsDetect, DeclareDepsApply> = {
  metadata: {
    id: '01-declare-deps',
    workflowType: 'env_replicate',
    index: 1,
    title: 'Declare dependencies',
    description:
      'Detects runtimes, container tools, database and language servers needed by the project.',
    requiresCli: false,
  },

  async detect(ctx) {
    const result = await scanRepoForDeps(ctx.repoPath);
    const taskRow = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { repositoryId: true },
    });
    const onboardingLsp = await loadOnboardingLspKeys(ctx.db, taskRow?.repositoryId ?? null);
    if (onboardingLsp.length > 0) {
      result.suggestedLsp = Array.from(new Set([...result.suggestedLsp, ...onboardingLsp]));
    }
    return result;
  },

  form(_ctx, detected) {
    const defaultContainer = detected.containerTool;
    const defaultDb = detected.database.kind;
    const defaultRuntimes = detected.runtimes.map((r) => r.language);

    const fields: FormSchema['fields'] = [
      {
        type: 'multi-select',
        id: 'runtimes',
        label: 'Language runtimes',
        required: true,
        options: RUNTIME_OPTIONS,
        defaults: defaultRuntimes,
      },
      {
        type: 'text',
        id: 'nodeVersion',
        label: 'Node.js version',
        default: findVersion(detected.runtimes, 'node') ?? '22',
        placeholder: '22',
      },
      {
        type: 'text',
        id: 'phpVersion',
        label: 'PHP version',
        default: findVersion(detected.runtimes, 'php') ?? '8.3',
        placeholder: '8.3',
      },
      {
        type: 'text',
        id: 'pythonVersion',
        label: 'Python version',
        default: findVersion(detected.runtimes, 'python') ?? '3.12',
        placeholder: '3.12',
      },
      {
        type: 'text',
        id: 'javaVersion',
        label: 'Java version',
        default: findVersion(detected.runtimes, 'java') ?? '17',
        placeholder: '17',
      },
      {
        type: 'select',
        id: 'containerTool',
        label: 'Container tool',
        options: CONTAINER_OPTIONS,
        default: defaultContainer,
      },
      {
        type: 'select',
        id: 'databaseKind',
        label: 'Database',
        options: DB_OPTIONS,
        default: defaultDb,
      },
      {
        type: 'text',
        id: 'databaseVersion',
        label: 'Database version',
        default: detected.database.version ?? '',
        placeholder: 'e.g. 15 or 10.11',
      },
      {
        type: 'multi-select',
        id: 'lspServers',
        label: 'Language servers to preinstall',
        options: LSP_OPTIONS,
        defaults: detected.suggestedLsp,
      },
      {
        type: 'checkbox',
        id: 'preinstallDeps',
        label: 'Install project dependencies at image build time',
        description:
          'Bakes the package-manager install (npm/pnpm/composer/pip/etc.) into the Docker image so tasks start with vendored dependencies already in place. Trade-off: the image rebuilds whenever a lockfile changes. Leave off if you prefer a smaller, faster-to-build image and are happy to install deps on each task run.',
        default: detected.runtimes.length > 0,
      },
      {
        type: 'checkbox',
        id: 'browserTesting',
        label: 'Install Chrome + chrome-devtools-mcp for browser testing',
        default: false,
      },
      {
        type: 'textarea',
        id: 'extraPackages',
        label: 'Extra system packages (one per line)',
        rows: 4,
        placeholder: 'vim\ncurl\njq',
      },
    ];

    return {
      title: 'Environment dependencies',
      description:
        'Confirm the languages, services and tooling the sandboxed environment should include.',
      fields,
      submitLabel: 'Save dependencies',
    };
  },

  async apply(ctx, args) {
    const values = args.formValues as DeclareDepsFormValues;
    const baseImage = computeBaseImage(values.containerTool);

    const templateName = deriveEnvTemplateName(ctx.taskId);
    const existing = await getTaskEnvTemplate(ctx.db, ctx.taskId);

    const task = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { repositoryId: true },
    });

    const packageManagers: Partial<Record<LanguageKey, PackageManager | null>> = {};
    for (const detected of args.detected.runtimes) {
      if (values.runtimes.includes(detected.language)) {
        packageManagers[detected.language] = detected.packageManager;
      }
    }

    const declaredDeps: Record<string, unknown> = {
      runtimes: values.runtimes,
      versions: {
        node: values.nodeVersion || null,
        php: values.phpVersion || null,
        python: values.pythonVersion || null,
        java: values.javaVersion || null,
      },
      packageManagers,
      preinstallDeps: values.preinstallDeps ?? true,
      containerTool: values.containerTool,
      database: {
        kind: values.databaseKind,
        version: values.databaseVersion || null,
      },
      lspServers: values.lspServers ?? [],
      browserTesting: values.browserTesting,
      extraPackages: parseExtraPackages(values.extraPackages ?? ''),
    };

    if (existing) {
      await ctx.db
        .update(schema.envTemplates)
        .set({
          baseImage,
          declaredDeps,
          repositoryId: task?.repositoryId ?? existing.repositoryId,
          status: 'pending',
          dockerfileHash: null,
          imageTag: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.envTemplates.id, existing.id));
      ctx.logger.info(
        { envTemplateId: existing.id, baseImage, templateName },
        'env template updated',
      );
      return { envTemplateId: existing.id, baseImage };
    }

    const inserted = await ctx.db
      .insert(schema.envTemplates)
      .values({
        userId: ctx.userId,
        repositoryId: task?.repositoryId ?? null,
        name: templateName,
        baseImage,
        declaredDeps,
        status: 'pending',
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error('failed to insert env_template row');
    await linkTaskToEnvTemplate(ctx.db, ctx.taskId, row.id);
    ctx.logger.info({ envTemplateId: row.id, baseImage, templateName }, 'env template declared');
    return { envTemplateId: row.id, baseImage };
  },
};

interface DeclareDepsFormValues extends FormValues {
  runtimes: LanguageKey[];
  nodeVersion: string;
  phpVersion: string;
  pythonVersion: string;
  javaVersion: string;
  containerTool: ContainerTool;
  databaseKind: DatabaseKind;
  databaseVersion: string;
  lspServers: LspKey[];
  preinstallDeps: boolean;
  browserTesting: boolean;
  extraPackages: string;
}

function computeBaseImage(containerTool: ContainerTool): string {
  switch (containerTool) {
    case 'ddev':
      return 'ddev/ddev-webserver:v1.25.2';
    case 'docker-compose':
    case 'docker':
    case 'none':
      return 'ubuntu:24.04';
  }
}

function findVersion(runtimes: DetectedRuntime[], language: LanguageKey): string | null {
  return runtimes.find((r) => r.language === language)?.version ?? null;
}

function parseExtraPackages(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export async function scanRepoForDeps(repoPath: string): Promise<DeclareDepsDetect> {
  const runtimes: DetectedRuntime[] = [];
  const suggestedLsp = new Set<LspKey>();

  const packageJson = await readJsonIfExists(path.join(repoPath, 'package.json'));
  if (packageJson) {
    const engines = (packageJson as Record<string, unknown>).engines as
      | Record<string, string>
      | undefined;
    const nodeVersion = engines?.node ?? null;
    runtimes.push({
      language: 'node',
      version: nodeVersion ? sanitizeVersion(nodeVersion) : null,
      source: 'package.json',
      packageManager: await detectNodePackageManager(repoPath),
    });
    suggestedLsp.add('vtsls');
  }

  const composerJson = await readJsonIfExists(path.join(repoPath, 'composer.json'));
  let isCmsPhpProject = false;
  if (composerJson) {
    const requireField = (composerJson as Record<string, unknown>).require as
      | Record<string, string>
      | undefined;
    const phpSpec = requireField?.['php'];
    runtimes.push({
      language: 'php',
      version: phpSpec ? sanitizeVersion(phpSpec) : null,
      source: 'composer.json',
      packageManager: 'composer',
    });
    // Detect CMS frameworks that use non-standard PHP extensions (.inc, .module, etc.)
    const allDeps = Object.keys(requireField ?? {});
    isCmsPhpProject = allDeps.some(
      (dep) =>
        dep.startsWith('drupal/') ||
        dep === 'drupal/core' ||
        dep === 'drupal/core-recommended' ||
        dep === 'laravel/framework',
    );
    suggestedLsp.add(isCmsPhpProject ? 'intelephense-extended' : 'intelephense');
  }

  const requirementsTxt = await fileExists(path.join(repoPath, 'requirements.txt'));
  const pyprojectToml = await fileExists(path.join(repoPath, 'pyproject.toml'));
  if (requirementsTxt || pyprojectToml) {
    const pythonVersionFile = await readTextIfExists(path.join(repoPath, '.python-version'));
    runtimes.push({
      language: 'python',
      version: pythonVersionFile?.trim() || null,
      source: pyprojectToml ? 'pyproject.toml' : 'requirements.txt',
      packageManager: await detectPythonPackageManager(repoPath),
    });
    suggestedLsp.add('pyright');
  }

  const goMod = await readTextIfExists(path.join(repoPath, 'go.mod'));
  if (goMod) {
    const match = goMod.match(/^go\s+(\S+)/m);
    runtimes.push({
      language: 'go',
      version: match?.[1] ?? null,
      source: 'go.mod',
      packageManager: 'gomod',
    });
    suggestedLsp.add('gopls');
  }

  const cargoToml = await readTextIfExists(path.join(repoPath, 'Cargo.toml'));
  if (cargoToml) {
    const match = cargoToml.match(/rust-version\s*=\s*"([^"]+)"/);
    runtimes.push({
      language: 'rust',
      version: match?.[1] ?? null,
      source: 'Cargo.toml',
      packageManager: 'cargo',
    });
    suggestedLsp.add('rust-analyzer');
  }

  const pomXml = await readTextIfExists(path.join(repoPath, 'pom.xml'));
  const buildGradle = await readTextIfExists(path.join(repoPath, 'build.gradle'));
  const buildGradleKts = await readTextIfExists(path.join(repoPath, 'build.gradle.kts'));
  if (pomXml || buildGradle || buildGradleKts) {
    let version: string | null = null;
    if (pomXml) {
      const m =
        pomXml.match(/<maven\.compiler\.(?:source|release)>([^<]+)</) ??
        pomXml.match(/<java\.version>([^<]+)</);
      version = m?.[1]?.trim() ?? null;
    }
    if (!version && buildGradle) {
      const m =
        buildGradle.match(/sourceCompatibility\s*=?\s*['"]?(?:JavaVersion\.VERSION_)?([\d_.]+)/) ??
        buildGradle.match(/targetCompatibility\s*=?\s*['"]?(?:JavaVersion\.VERSION_)?([\d_.]+)/);
      version = m?.[1]?.replace(/_/g, '.') ?? null;
    }
    if (!version && buildGradleKts) {
      const m = buildGradleKts.match(/JavaVersion\.VERSION_([\d_]+)/);
      version = m?.[1]?.replace(/_/g, '.') ?? null;
    }
    runtimes.push({
      language: 'java',
      version: normalizeJavaVersion(version),
      source: pomXml ? 'pom.xml' : buildGradle ? 'build.gradle' : 'build.gradle.kts',
      packageManager: null,
    });
    suggestedLsp.add('jdtls');
  }

  const gemfile = await readTextIfExists(path.join(repoPath, 'Gemfile'));
  if (gemfile) {
    const match = gemfile.match(/ruby\s+['"]([^'"]+)['"]/);
    runtimes.push({
      language: 'ruby',
      version: match?.[1] ?? null,
      source: 'Gemfile',
      packageManager: 'bundler',
    });
    suggestedLsp.add('solargraph');
  }

  const ddev = await readDdevConfig(repoPath);
  const dockerCompose = await fileExists(path.join(repoPath, 'docker-compose.yml'));
  const dockerComposeAlt = await fileExists(path.join(repoPath, 'compose.yml'));

  const containerTool: ContainerTool = ddev.present
    ? 'ddev'
    : dockerCompose || dockerComposeAlt
      ? 'docker-compose'
      : 'none';

  const database =
    ddev.database.kind !== 'none' ? ddev.database : await inferDatabaseFromCompose(repoPath);

  if (ddev.phpVersion) {
    const phpEntry = runtimes.find((r) => r.language === 'php');
    if (phpEntry && !phpEntry.version) phpEntry.version = ddev.phpVersion;
    if (!phpEntry) {
      runtimes.push({
        language: 'php',
        version: ddev.phpVersion,
        source: '.ddev/config.yaml',
        packageManager: null,
      });
      // DDEV projects are typically Drupal/CMS — prefer extended
      suggestedLsp.add(isCmsPhpProject || ddev.present ? 'intelephense-extended' : 'intelephense');
    }
  }

  return {
    runtimes,
    containerTool,
    ddevProjectName: ddev.projectName,
    database,
    suggestedLsp: Array.from(suggestedLsp),
  };
}

interface DdevInfo {
  present: boolean;
  phpVersion: string | null;
  projectName: string | null;
  database: { kind: DatabaseKind; version: string | null };
}

async function readDdevConfig(repoPath: string): Promise<DdevInfo> {
  const cfgPath = path.join(repoPath, '.ddev', 'config.yaml');
  const text = await readTextIfExists(cfgPath);
  if (!text) {
    return {
      present: false,
      phpVersion: null,
      projectName: null,
      database: { kind: 'none', version: null },
    };
  }
  return {
    present: true,
    phpVersion: matchYamlField(text, 'php_version'),
    projectName: matchYamlField(text, 'name'),
    database: parseDdevDatabase(text),
  };
}

function parseDdevDatabase(text: string): { kind: DatabaseKind; version: string | null } {
  const typeMatch = text.match(/database:\s*\n\s+type:\s*([a-z]+)/);
  const versionMatch = text.match(/database:\s*\n(?:\s+[^\n]+\n)*?\s+version:\s*"?([^\s"]+)"?/);
  const rawType = typeMatch?.[1]?.toLowerCase() ?? 'none';
  const kind: DatabaseKind =
    rawType === 'mariadb'
      ? 'mariadb'
      : rawType === 'mysql'
        ? 'mysql'
        : rawType === 'postgres' || rawType === 'postgresql'
          ? 'postgres'
          : 'none';
  return { kind, version: versionMatch?.[1] ?? null };
}

async function inferDatabaseFromCompose(
  repoPath: string,
): Promise<{ kind: DatabaseKind; version: string | null }> {
  const candidates = ['docker-compose.yml', 'compose.yml'];
  for (const file of candidates) {
    const text = await readTextIfExists(path.join(repoPath, file));
    if (!text) continue;
    if (/image:\s*postgres(?::|\s)/i.test(text)) {
      const version = text.match(/image:\s*postgres:(\S+)/i)?.[1] ?? null;
      return { kind: 'postgres', version };
    }
    if (/image:\s*mariadb(?::|\s)/i.test(text)) {
      const version = text.match(/image:\s*mariadb:(\S+)/i)?.[1] ?? null;
      return { kind: 'mariadb', version };
    }
    if (/image:\s*mysql(?::|\s)/i.test(text)) {
      const version = text.match(/image:\s*mysql:(\S+)/i)?.[1] ?? null;
      return { kind: 'mysql', version };
    }
  }
  return { kind: 'none', version: null };
}

function matchYamlField(text: string, field: string): string | null {
  const regex = new RegExp(`^${field}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm');
  const match = text.match(regex);
  return match?.[1]?.trim() ?? null;
}

function sanitizeVersion(raw: string): string {
  return raw.replace(/^[\^~><=!]+/, '').trim();
}

function normalizeJavaVersion(raw: string | null): string | null {
  if (!raw) return raw;
  const trimmed = raw.trim();
  const parts = trimmed.split('.');
  if (parts[0] === '1' && parts[1]) return parts[1];
  return trimmed;
}

async function detectNodePackageManager(repoPath: string): Promise<PackageManager> {
  if (await fileExists(path.join(repoPath, 'bun.lockb'))) return 'bun';
  if (await fileExists(path.join(repoPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await fileExists(path.join(repoPath, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

async function detectPythonPackageManager(repoPath: string): Promise<PackageManager> {
  if (await fileExists(path.join(repoPath, 'uv.lock'))) return 'uv';
  if (await fileExists(path.join(repoPath, 'poetry.lock'))) return 'poetry';
  if (await fileExists(path.join(repoPath, 'pdm.lock'))) return 'pdm';
  if (await fileExists(path.join(repoPath, 'Pipfile.lock'))) return 'pipenv';
  return 'pip';
}

async function readJsonIfExists(filePath: string): Promise<unknown | null> {
  const text = await readTextIfExists(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
