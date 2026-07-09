import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
} from '@haive/shared';
import type {
  FormSchema,
  FormValues,
  OnboardingEnvironmentMirror,
  OnboardingToolingMirror,
} from '@haive/shared';
import type { StepDefinition } from '../../step-definition.js';
import { deriveEnvTemplateName, getTaskEnvTemplate, linkTaskToEnvTemplate } from './_shared.js';

// Both PHP language keys map to the single surviving env key (intelephense-extended):
// after the PHP-LSP consolidation plain php and php-extended are the same server
// (intelephense + drupal-php-lsp with CMS extensions). Legacy `php` selections
// therefore converge to the survivor here too.
const ONBOARDING_LSP_TO_ENV_KEY: Record<string, LspKey> = {
  typescript: 'vtsls',
  python: 'pyright',
  go: 'gopls',
  rust: 'rust-analyzer',
  php: 'intelephense-extended',
  'php-extended': 'intelephense-extended',
  java: 'jdtls',
};

async function loadOnboardingLspKeys(db: Database, repositoryId: string | null): Promise<LspKey[]> {
  if (!repositoryId) return [];
  const toLspKeys = (langs: unknown): LspKey[] => {
    if (!Array.isArray(langs)) return [];
    return langs
      .filter((v): v is string => typeof v === 'string')
      .map((l) => ONBOARDING_LSP_TO_ENV_KEY[l])
      .filter((v): v is LspKey => !!v);
  };

  // Prefer the repo-level onboarding mirror (survives a clone to another
  // machine); fall back to the onboarding task's 04-tooling step output for
  // repos onboarded before the mirror column existed (no backfill).
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { onboardingTooling: true },
  });
  const mirror = repo?.onboardingTooling as OnboardingToolingMirror | null | undefined;
  if (mirror?.schemaVersion === ONBOARDING_TOOLING_SCHEMA_VERSION && mirror.tooling) {
    return toLspKeys((mirror.tooling as { lspLanguages?: unknown }).lspLanguages);
  }

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
  return toLspKeys(out?.tooling?.lspLanguages);
}

// Map an onboarding-confirmed primaryLanguage / framework to the env-replicate
// LanguageKeys, so a stack the user already confirmed pre-fills the right runtimes
// here even when the in-repo scan comes up empty.
const ONBOARDING_LANGUAGE_TO_KEY: Record<string, LanguageKey> = {
  php: 'php',
  javascript: 'node',
  typescript: 'node',
  node: 'node',
  python: 'python',
  ruby: 'ruby',
  go: 'go',
  rust: 'rust',
  java: 'java',
};

const ONBOARDING_FRAMEWORK_TO_KEY: Record<string, LanguageKey> = {
  drupal: 'php',
  drupal7: 'php',
  laravel: 'php',
  wordpress: 'php',
  symfony: 'php',
  nodejs: 'node',
  nextjs: 'node',
  django: 'python',
  rails: 'ruby',
};

const ONBOARDING_VERSION_KEYS: { field: string; language: LanguageKey }[] = [
  { field: 'phpVersion', language: 'php' },
  { field: 'nodeVersion', language: 'node' },
  { field: 'pythonVersion', language: 'python' },
  { field: 'rubyVersion', language: 'ruby' },
  { field: 'goVersion', language: 'go' },
  { field: 'rustVersion', language: 'rust' },
  { field: 'javaVersion', language: 'java' },
];

/** Coerce a free-text onboarding database type into an env-replicate DatabaseKind. */
function normalizeDbKind(raw: string | null | undefined): DatabaseKind {
  const v = (raw ?? '').toLowerCase().trim();
  if (v === 'mariadb') return 'mariadb';
  if (v === 'postgres' || v === 'postgresql' || v === 'pgsql') return 'postgres';
  if (v === 'mysql') return 'mysql';
  if (v === 'sqlite' || v === 'sqlite3') return 'sqlite';
  return 'none';
}

interface OnboardingDetection {
  databaseType: string | null;
  databaseVersion: string | null;
  languages: LanguageKey[];
  runtimeVersions: Partial<Record<LanguageKey, string>>;
}

/** The stack the user confirmed during onboarding (02-detection-confirmation):
 *  database, per-language runtime versions, and the languages implied by the
 *  primary language / framework. Reused here so an env-replicate task pre-fills
 *  what the in-repo scan can miss (e.g. a DB version only declared in onboarding).
 *  Returns null when the repo was never onboarded. */
export async function loadOnboardingDetection(
  db: Database,
  repositoryId: string | null,
): Promise<OnboardingDetection | null> {
  if (!repositoryId) return null;

  // Prefer the repo-level onboarding mirror (survives a clone to another
  // machine); fall back to the onboarding task's 02-detection-confirmation
  // output for repos onboarded before the mirror column existed.
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { onboardingEnvironment: true },
  });
  const mirror = repo?.onboardingEnvironment as OnboardingEnvironmentMirror | null | undefined;
  let values: Record<string, unknown> | undefined;
  if (mirror?.schemaVersion === ONBOARDING_ENVIRONMENT_SCHEMA_VERSION) {
    values = mirror.confirmedValues;
  } else {
    const rows = await db
      .select({ output: schema.taskSteps.output })
      .from(schema.taskSteps)
      .innerJoin(schema.tasks, eq(schema.taskSteps.taskId, schema.tasks.id))
      .where(
        and(
          eq(schema.tasks.repositoryId, repositoryId),
          eq(schema.tasks.type, 'onboarding'),
          eq(schema.taskSteps.stepId, '02-detection-confirmation'),
          eq(schema.taskSteps.status, 'done'),
        ),
      )
      .orderBy(desc(schema.taskSteps.endedAt))
      .limit(1);
    values = (rows[0]?.output as { values?: Record<string, unknown> } | null)?.values;
  }
  if (!values) return null;

  const str = (k: string): string | null => {
    const v = values[k];
    return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
  };

  const languages = new Set<LanguageKey>();
  const lang = str('primaryLanguage')?.toLowerCase();
  if (lang && ONBOARDING_LANGUAGE_TO_KEY[lang]) languages.add(ONBOARDING_LANGUAGE_TO_KEY[lang]);
  const framework = str('framework')?.toLowerCase();
  if (framework && ONBOARDING_FRAMEWORK_TO_KEY[framework]) {
    languages.add(ONBOARDING_FRAMEWORK_TO_KEY[framework]);
  }
  const runtimeVersions: Partial<Record<LanguageKey, string>> = {};
  for (const { field, language } of ONBOARDING_VERSION_KEYS) {
    const v = str(field);
    if (v) {
      runtimeVersions[language] = v;
      languages.add(language);
    }
  }

  return {
    databaseType: str('databaseType'),
    databaseVersion: str('databaseVersion'),
    languages: Array.from(languages),
    runtimeVersions,
  };
}

type ContainerTool = 'ddev' | 'docker-compose' | 'docker' | 'none';
type WebserverType = 'apache-fpm' | 'nginx-fpm';
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
  /** DDEV webserver_type default for the config 01c generates. apache-fpm when a
   *  .htaccess is found (honors Apache rewrite/SAPI behavior), else nginx-fpm. */
  webserver: WebserverType;
  ddevProjectName: string | null;
  database: { kind: DatabaseKind; version: string | null };
  suggestedLsp: LspKey[];
  /** This task's repository id, for the bottom tooling-page link. */
  repositoryId?: string | null;
  /** Per-LSP-option version badge (env key → "version (latest)"); absent for the
   *  unpinnable servers (rust-analyzer, jdtls). */
  lspVersionByOption?: Record<string, string>;
  /** "version (latest)" label for the chrome-devtools-mcp browser-testing line. */
  chromeVersionLabel?: string;
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

const WEBSERVER_OPTIONS: { value: WebserverType; label: string }[] = [
  { value: 'nginx-fpm', label: 'nginx (nginx-fpm) — DDEV default' },
  { value: 'apache-fpm', label: 'Apache (apache-fpm) — honors .htaccess, mod_php behavior' },
];

const DB_OPTIONS: { value: DatabaseKind; label: string }[] = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mariadb', label: 'MariaDB' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'sqlite', label: 'SQLite' },
  { value: 'none', label: 'none' },
];

const LSP_OPTIONS: { value: LspKey; label: string }[] = [
  // Single PHP LSP option — plain `intelephense` dropped (duplicate of the
  // extended one after the PHP-LSP consolidation). Legacy key still installs
  // fine; migration 0084 normalizes stored repo values.
  { value: 'intelephense-extended', label: 'Intelephense (PHP)' },
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

// Per-language runtime version fields. Each renders only when its language is
// relevant to the project (detected in-repo or carried over from onboarding), so
// irrelevant version boxes are hidden entirely.
const VERSION_FIELDS: { id: string; label: string; language: LanguageKey; fallback: string }[] = [
  { id: 'nodeVersion', label: 'Node.js version', language: 'node', fallback: '22' },
  { id: 'phpVersion', label: 'PHP version', language: 'php', fallback: '8.3' },
  { id: 'pythonVersion', label: 'Python version', language: 'python', fallback: '3.12' },
  { id: 'javaVersion', label: 'Java version', language: 'java', fallback: '17' },
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
    reuseLastCompletedFormValues: true,
  },

  async detect(ctx) {
    const result = await scanRepoForDeps(ctx.repoPath);
    const taskRow = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { repositoryId: true, title: true, description: true },
    });
    const repositoryId = taskRow?.repositoryId ?? null;

    // A legacy project that is ADDING a container tool has no marker file on disk
    // yet, so scanRepoForDeps returns 'none'. Honor an explicit intent in the task
    // title/description ("add ddev", "docker compose", …) so the Container tool is
    // pre-selected — otherwise 01a-app-boot tries to boot an app that cannot run
    // yet and 01c-ddev-env never generates the .ddev config. An on-disk marker
    // (ddev/compose already present) always wins; intent only fills the 'none' case.
    if (result.containerTool === 'none') {
      const intent = detectContainerToolIntent(
        `${taskRow?.title ?? ''}\n${taskRow?.description ?? ''}`,
      );
      if (intent) result.containerTool = intent;
    }

    const onboardingLsp = await loadOnboardingLspKeys(ctx.db, repositoryId);
    if (onboardingLsp.length > 0) {
      result.suggestedLsp = Array.from(new Set([...result.suggestedLsp, ...onboardingLsp]));
    }
    // Reuse the stack confirmed during onboarding to fill what the in-repo scan
    // missed: the database, and any runtimes (with versions) not found on disk —
    // a non-standard repo layout can otherwise leave the form blank.
    const onboarding = await loadOnboardingDetection(ctx.db, repositoryId);
    if (onboarding) {
      if (result.database.kind === 'none' && normalizeDbKind(onboarding.databaseType) !== 'none') {
        result.database = {
          kind: normalizeDbKind(onboarding.databaseType),
          version: onboarding.databaseVersion,
        };
      } else if (!result.database.version && onboarding.databaseVersion) {
        result.database.version = onboarding.databaseVersion;
      }
      for (const language of onboarding.languages) {
        const existing = result.runtimes.find((r) => r.language === language);
        if (existing) {
          if (!existing.version && onboarding.runtimeVersions[language]) {
            existing.version = onboarding.runtimeVersions[language]!;
          }
        } else {
          result.runtimes.push({
            language,
            version: onboarding.runtimeVersions[language] ?? null,
            source: 'onboarding',
            packageManager: null,
          });
        }
      }
    }

    // A previously declared webserver wins over the .htaccess-derived default, so
    // re-running this step never silently reverts an Apache choice to nginx for a
    // markerless legacy app the scan can't detect (no .htaccess to key on).
    const existingTpl = await getTaskEnvTemplate(ctx.db, ctx.taskId);
    const savedWebserver = (existingTpl?.declaredDeps as Record<string, unknown> | null)?.webserver;
    if (savedWebserver === 'apache-fpm' || savedWebserver === 'nginx-fpm') {
      result.webserver = savedWebserver;
    }

    // Version labels for the LSP badges + the browser-testing (chrome-devtools-mcp)
    // line, mirroring onboarding step 04. Newest = head of the sorted-desc cache
    // list (falls back to the dist-tag latest).
    const toolRows = await ctx.db
      .select({
        name: schema.toolPackageVersions.name,
        versions: schema.toolPackageVersions.versions,
        latestVersion: schema.toolPackageVersions.latestVersion,
      })
      .from(schema.toolPackageVersions);
    const newestByTool = new Map<string, string | null>();
    for (const r of toolRows) newestByTool.set(r.name, r.versions?.[0] ?? r.latestVersion ?? null);
    const lspVersionByOption: Record<string, string> = {};
    for (const opt of LSP_OPTIONS) {
      const tool = opt.value === 'intelephense-extended' ? 'intelephense' : opt.value;
      const v = newestByTool.get(tool);
      if (v) lspVersionByOption[opt.value] = `${v} (latest)`;
    }
    const chromeNewest = newestByTool.get('chrome-devtools-mcp');
    result.repositoryId = repositoryId;
    result.lspVersionByOption = lspVersionByOption;
    result.chromeVersionLabel = chromeNewest ? `${chromeNewest} (latest)` : 'latest';

    return result;
  },

  form(_ctx, detected) {
    const defaultContainer = detected.containerTool;
    const defaultDb = detected.database.kind;
    const defaultRuntimes = detected.runtimes.map((r) => r.language);
    const relevantLanguages = new Set<LanguageKey>(defaultRuntimes);

    // Show each LSP server's version as a badge (absent for the unpinnable
    // servers). Versions are pinned on the tooling page (linked at the bottom).
    const lspVersionByOption = detected.lspVersionByOption ?? {};
    const lspOptions = LSP_OPTIONS.map((o) =>
      lspVersionByOption[o.value]
        ? { ...o, badge: lspVersionByOption[o.value], badgeColor: 'green' as const }
        : o,
    );

    const fields: FormSchema['fields'] = [
      {
        type: 'multi-select',
        id: 'runtimes',
        label: 'Language runtimes',
        required: true,
        options: RUNTIME_OPTIONS,
        defaults: defaultRuntimes,
      },
      // Runtime version fields render only for languages relevant to this project
      // (found in-repo or carried over from the confirmed onboarding stack), so a
      // PHP project is not asked for Node / Python / Java versions.
      ...VERSION_FIELDS.filter((vf) => relevantLanguages.has(vf.language)).map(
        (vf): FormSchema['fields'][number] => ({
          type: 'text',
          id: vf.id,
          label: vf.label,
          default: findVersion(detected.runtimes, vf.language) ?? vf.fallback,
          placeholder: vf.fallback,
        }),
      ),
      {
        type: 'select',
        id: 'containerTool',
        label: 'Container tool',
        options: CONTAINER_OPTIONS,
        default: defaultContainer,
      },
      // Only DDEV consumes webserver_type, so this is hidden unless DDEV is the
      // selected container tool (evaluated live against the select above). apache-fpm
      // matches a legacy Apache/mod_php app and honors .htaccess; nginx-fpm is DDEV's
      // default. Prefilled to apache-fpm when a .htaccess was detected in the repo.
      {
        type: 'select',
        id: 'webserver',
        label: 'DDEV web server',
        description:
          'apache-fpm matches an Apache/mod_php project (honors .htaccess and the $_SERVER vars Apache populates); nginx-fpm is DDEV’s default. Only used when the container tool is DDEV.',
        options: WEBSERVER_OPTIONS,
        default: detected.webserver,
        visibleWhen: { field: 'containerTool', equals: 'ddev' },
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
        options: lspOptions,
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
        description: `Installs headed Chromium + chrome-devtools-mcp (currently ${detected.chromeVersionLabel ?? 'latest'}) for the browser-verification steps.`,
        default: true,
      },
      {
        type: 'textarea',
        id: 'extraPackages',
        label: 'Extra system packages (one per line)',
        rows: 4,
        placeholder: 'vim\ncurl\njq',
      },
      ...(detected.repositoryId
        ? [
            {
              type: 'note' as const,
              id: 'toolingLink',
              label: 'Tooling page',
              body: `Pin LSP server and Chrome DevTools MCP versions for this repository on the [tooling page](/repos/${detected.repositoryId}/tooling) (opens in a new tab).`,
            },
          ]
        : []),
    ];

    return {
      title: 'Environment dependencies',
      description:
        'Confirm the languages, services and tooling the sandboxed environment should include.',
      fields,
      submitLabel: 'Save dependencies',
    };
  },

  reconcileReusedFormValues(_ctx, detected, reused) {
    return reconcileStaleDeps(detected, reused as DeclareDepsFormValues);
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

    // Repo-level component version pins (set via the tooling-upgrade / management
    // UI). Injected into declaredDeps below so renderDockerfile + the MCP launcher
    // honor them. They live on the repo (not only in declaredDeps) because this
    // step rebuilds declaredDeps from the form every task and would otherwise wipe
    // them — including for a brand-new task that has no prior template to inherit.
    let repoLspVersions: Record<string, string | null> | null = null;
    let repoChromeMcpVersion: string | null = null;
    let repoLspServers: string[] | null = null;
    if (task?.repositoryId) {
      const repoRow = await ctx.db
        .select({
          lspServerVersions: schema.repositories.lspServerVersions,
          chromeDevtoolsMcpVersion: schema.repositories.chromeDevtoolsMcpVersion,
          lspServers: schema.repositories.lspServers,
        })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, task.repositoryId))
        .limit(1);
      repoLspVersions = repoRow[0]?.lspServerVersions ?? null;
      repoChromeMcpVersion = repoRow[0]?.chromeDevtoolsMcpVersion ?? null;
      repoLspServers = repoRow[0]?.lspServers ?? null;
    }

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
      // DDEV is the only consumer of webserver_type (01c-ddev-env reads this when it
      // generates .ddev/config.yaml). Store it only for DDEV so non-DDEV deps stay
      // clean; the select is hidden for other container tools, so default defensively.
      ...(values.containerTool === 'ddev' ? { webserver: values.webserver ?? 'nginx-fpm' } : {}),
      database: {
        kind: values.databaseKind,
        version: values.databaseVersion || null,
      },
      // Repo-level LSP override (tooling management page) wins over the
      // form/onboarding-derived set so enable/disable survives the per-task rebuild.
      lspServers: repoLspServers ?? values.lspServers ?? [],
      ...(repoLspVersions ? { lspServerVersions: repoLspVersions } : {}),
      browserTesting: values.browserTesting,
      ...(repoChromeMcpVersion ? { chromeDevtoolsMcpVersion: repoChromeMcpVersion } : {}),
      extraPackages: parseExtraPackages(values.extraPackages ?? ''),
    };

    if (existing) {
      // A changed base image or declared-deps set makes the previously saved
      // Dockerfile (and any image built from it) stale — it was rendered from
      // the OLD inputs. Drop both so step 02 re-renders from the new deps and
      // step 03 rebuilds, instead of 02's reuse path silently keeping the old
      // Dockerfile (e.g. a PHP 8.3 -> 5.6 change, which the unbuildable-PHP
      // self-heal does NOT catch). An unchanged re-run keeps any hand-edits.
      const staleDockerfile =
        baseImage !== existing.baseImage ||
        stableStringify(declaredDeps) !== stableStringify(existing.declaredDeps ?? {});
      await ctx.db
        .update(schema.envTemplates)
        .set({
          baseImage,
          declaredDeps,
          repositoryId: task?.repositoryId ?? existing.repositoryId,
          status: 'pending',
          dockerfileHash: null,
          imageTag: null,
          ...(staleDockerfile
            ? { generatedDockerfile: null, builtImageId: null, lastBuiltAt: null }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.envTemplates.id, existing.id));
      ctx.logger.info(
        { envTemplateId: existing.id, baseImage, templateName, staleDockerfile },
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

/** Prior-task reuse (metadata.reuseLastCompletedFormValues) auto-submits the last
 *  completed task's answers verbatim. Those answers can be stale: a repo with no
 *  container tool and no database when that task ran may have gained a DDEV project
 *  since — which is exactly what an "add ddev" task does. Replayed unchanged, the
 *  stale `containerTool: 'none'` lands in declaredDeps and 01c-ddev-env's shouldRun
 *  never fires, so the DDEV stack the repo now carries is never brought up.
 *
 *  Only a reused 'none' — the "nothing found" sentinel of either select — is
 *  refreshed from this task's detection. A tool or database the user picked is
 *  never overwritten, including when it has since disappeared from the repo.
 *  Manual mode never reaches here (reuse is auto-continue-gated) and already shows
 *  the freshly detected values as its form defaults. */
export function reconcileStaleDeps(
  detected: DeclareDepsDetect,
  reused: DeclareDepsFormValues,
): DeclareDepsFormValues {
  const patch: Partial<DeclareDepsFormValues> = {};

  if (reused.containerTool === 'none' && detected.containerTool !== 'none') {
    patch.containerTool = detected.containerTool;
    // The webserver select is hidden while the container tool is not DDEV, so the
    // prior task's value for it carries no user intent — take the .htaccess-derived
    // default rather than letting apply() fall back to nginx for an Apache app.
    if (detected.containerTool === 'ddev') patch.webserver = detected.webserver;
  }

  if (reused.databaseKind === 'none' && detected.database.kind !== 'none') {
    patch.databaseKind = detected.database.kind;
    if (!reused.databaseVersion && detected.database.version) {
      patch.databaseVersion = detected.database.version;
    }
  }

  return Object.keys(patch).length > 0 ? { ...reused, ...patch } : reused;
}

/** Stable, key-sorted JSON serialization for comparing two declared-deps
 *  objects regardless of property order (arrays keep their order, which is
 *  semantically meaningful). Used to decide whether a re-declared dependency
 *  set actually changed, so the saved Dockerfile is only invalidated on a real
 *  change rather than on every step-01 re-run. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface DeclareDepsFormValues extends FormValues {
  runtimes: LanguageKey[];
  nodeVersion?: string;
  phpVersion?: string;
  pythonVersion?: string;
  javaVersion?: string;
  containerTool: ContainerTool;
  webserver?: WebserverType;
  databaseKind: DatabaseKind;
  databaseVersion: string;
  lspServers: LspKey[];
  preinstallDeps: boolean;
  browserTesting: boolean;
  extraPackages: string;
}

export function computeBaseImage(containerTool: ContainerTool): string {
  switch (containerTool) {
    case 'ddev':
      // DDEV provides the app runtime (php/db/web) itself in its own nested-Docker
      // env (01c-ddev-env). The env-replicate image is only the CLI-agent sandbox,
      // so a lightweight ubuntu base + tools/LSPs is enough — and it avoids trying
      // to apt-install legacy PHP (e.g. 5.6) onto the ddev-webserver/debian base.
      return 'ubuntu:24.04';
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

// A `.htaccess` (repo root or a common docroot) means the app relies on Apache
// rewrite/SAPI behavior — DDEV's apache-fpm honors it, nginx-fpm does not — so the
// generated DDEV config should default to apache-fpm. Markerless legacy apps (no
// .htaccess) fall back to nginx-fpm and the user flips the selector if needed.
const APACHE_DOCROOT_CANDIDATES = ['', 'web', 'docroot', 'public', 'html'];
async function detectWebserver(repoPath: string): Promise<WebserverType> {
  for (const sub of APACHE_DOCROOT_CANDIDATES) {
    if (await fileExists(path.join(repoPath, sub, '.htaccess'))) return 'apache-fpm';
  }
  return 'nginx-fpm';
}

// Container-tool intent parsed from the task title/description. Pre-selects the
// Container tool when no marker is on disk yet (a legacy project ADDING a tool).
// Matched most-specific-first so "docker compose" and "ddev" win over bare
// "docker"; the word boundaries keep "dockerize"/"Dockerfile" from matching.
// Returns null when nothing is mentioned (containerTool stays whatever the scan
// found). The select is user-editable, so a false positive is one click to undo.
function detectContainerToolIntent(text: string): ContainerTool | null {
  const t = text.toLowerCase();
  if (/\bddev\b/.test(t)) return 'ddev';
  if (/\bdocker[-\s]?compose\b/.test(t)) return 'docker-compose';
  if (/\bdocker\b/.test(t)) return 'docker';
  return null;
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

  const webserver = await detectWebserver(repoPath);

  return {
    runtimes,
    containerTool,
    webserver,
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
