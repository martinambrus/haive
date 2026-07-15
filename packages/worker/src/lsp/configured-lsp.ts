import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { ONBOARDING_TOOLING_SCHEMA_VERSION, type OnboardingToolingMirror } from '@haive/shared';
import type { LspLanguage } from '../cli-adapters/types.js';

/**
 * Persisted LSP selections use language names during onboarding and concrete
 * server names in environment templates. Normalize both shapes to the CLI
 * plugin bridge's language keys without collapsing a multi-server selection.
 *
 * Solargraph is intentionally absent: Haive can bake that standalone server
 * into an environment image, but none of the supported CLI adapters currently
 * exposes a Ruby LSP bridge. A Solargraph-only environment therefore must not
 * make prompts claim that LSP tools are available to the model.
 */
const PERSISTED_LSP_TO_LANGUAGE: Record<string, LspLanguage> = {
  typescript: 'typescript',
  vtsls: 'typescript',
  python: 'python',
  pyright: 'python',
  go: 'go',
  gopls: 'go',
  rust: 'rust',
  'rust-analyzer': 'rust',
  php: 'php',
  intelephense: 'php',
  'php-extended': 'php-extended',
  'intelephense-extended': 'php-extended',
  java: 'java',
  jdtls: 'java',
};

const LSP_LANGUAGE_TO_SMOKE_CHECK: Record<LspLanguage, string> = {
  typescript: 'lsp-vtsls',
  python: 'lsp-pyright',
  go: 'lsp-gopls',
  rust: 'lsp-rust-analyzer',
  php: 'lsp-intelephense',
  'php-extended': 'lsp-intelephense',
  java: 'lsp-jdtls',
};

/** null means the persisted field is absent; [] is an explicit "none" choice. */
export function parseConfiguredLspLanguages(value: unknown): LspLanguage[] | null {
  if (!Array.isArray(value)) return null;
  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => PERSISTED_LSP_TO_LANGUAGE[entry])
        .filter((entry): entry is LspLanguage => entry !== undefined),
    ),
  );
}

/**
 * Resolve the LSP bridges configured for a task. The task's environment
 * template is authoritative because env replication can override onboarding.
 * Older/onboarding-only tasks fall back through their own tooling step, the
 * repository mirror, then the latest completed legacy onboarding step.
 */
export async function loadConfiguredLspLanguages(
  db: Database,
  taskId: string,
): Promise<LspLanguage[]> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { envTemplateId: true, repositoryId: true },
  });
  if (!task) return [];

  if (task.envTemplateId) {
    const envTemplate = await db.query.envTemplates.findFirst({
      where: eq(schema.envTemplates.id, task.envTemplateId),
      columns: { declaredDeps: true },
    });
    // A linked environment is the task's actual selection, even for legacy
    // rows where lspServers is absent. Never resurrect desired onboarding
    // settings that were not baked into this task's image.
    return (
      parseConfiguredLspLanguages(
        (envTemplate?.declaredDeps as { lspServers?: unknown } | null)?.lspServers,
      ) ?? []
    );
  }

  const ownTooling = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
    ),
    columns: { output: true },
  });
  const fromOwnTooling = parseConfiguredLspLanguages(
    (ownTooling?.output as { tooling?: { lspLanguages?: unknown } } | null)?.tooling?.lspLanguages,
  );
  if (fromOwnTooling) return fromOwnTooling;

  if (!task.repositoryId) return [];

  const repository = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, task.repositoryId),
    columns: { onboardingTooling: true },
  });
  const mirror = repository?.onboardingTooling as OnboardingToolingMirror | null | undefined;
  if (mirror?.schemaVersion === ONBOARDING_TOOLING_SCHEMA_VERSION && mirror.tooling) {
    const fromMirror = parseConfiguredLspLanguages(
      (mirror.tooling as { lspLanguages?: unknown }).lspLanguages,
    );
    if (fromMirror) return fromMirror;
  }

  const rows = await db
    .select({ output: schema.taskSteps.output })
    .from(schema.taskSteps)
    .innerJoin(schema.tasks, eq(schema.taskSteps.taskId, schema.tasks.id))
    .where(
      and(
        eq(schema.tasks.repositoryId, task.repositoryId),
        eq(schema.tasks.type, 'onboarding'),
        eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
        eq(schema.taskSteps.status, 'done'),
      ),
    )
    .orderBy(desc(schema.taskSteps.endedAt))
    .limit(1);
  return (
    parseConfiguredLspLanguages(
      (rows[0]?.output as { tooling?: { lspLanguages?: unknown } } | null)?.tooling?.lspLanguages,
    ) ?? []
  );
}

/**
 * Runtime prompt/tool availability is stricter than desired configuration:
 * require a built task image, successful smoke evidence for every configured
 * bridged server, and the provider plugin that exposes those servers to the
 * CLI. Onboarding mirrors are intentionally not consulted here.
 */
export async function hasReadyLspBridge(db: Database, taskId: string): Promise<boolean> {
  const task = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { envTemplateId: true },
  });
  if (!task?.envTemplateId) return false;

  const envTemplate = await db.query.envTemplates.findFirst({
    where: eq(schema.envTemplates.id, task.envTemplateId),
    columns: { declaredDeps: true, generatedDockerfile: true, lastBuiltAt: true, status: true },
  });
  if (
    envTemplate?.status !== 'ready' ||
    !envTemplate.generatedDockerfile?.trim() ||
    !envTemplate.lastBuiltAt
  ) {
    return false;
  }
  const configuredLanguages =
    parseConfiguredLspLanguages(
      (envTemplate.declaredDeps as { lspServers?: unknown } | null)?.lspServers,
    ) ?? [];
  if (configuredLanguages.length === 0) return false;

  // 03-build-image marks the image ready before 04 runs. Do not let that
  // transient state (or a user omitting a server check) advertise tools that
  // the sandbox has not actually proved are executable. The timestamp also
  // prevents smoke evidence for an older image from validating a rebuild.
  const verificationStep = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '04-verify-environment'),
    ),
    columns: { endedAt: true, output: true, status: true },
    orderBy: [desc(schema.taskSteps.endedAt)],
  });
  const verification = verificationStep?.output as
    | {
        envTemplateId?: unknown;
        reports?: Array<{ id?: unknown; passed?: unknown }>;
      }
    | null
    | undefined;
  const verificationReports = verification?.reports;
  if (
    verificationStep?.status !== 'done' ||
    !verificationStep.endedAt ||
    verificationStep.endedAt.getTime() < envTemplate.lastBuiltAt.getTime() ||
    verification?.envTemplateId !== task.envTemplateId ||
    !Array.isArray(verificationReports)
  ) {
    return false;
  }
  const passedChecks = new Set(
    verificationReports
      .filter(
        (report): report is { id: string; passed: true } =>
          typeof report?.id === 'string' && report.passed === true,
      )
      .map((report) => report.id),
  );
  const requiredChecks = new Set(
    configuredLanguages.map((language) => LSP_LANGUAGE_TO_SMOKE_CHECK[language]),
  );
  if (![...requiredChecks].every((checkId) => passedChecks.has(checkId))) return false;

  // Current LSP-capable adapters obtain their callable bridge through the
  // provider-sensitive plugin step. A ready server binary alone is not enough:
  // run_app tasks omit this step, users can skip it, and legacy rows may say
  // done while their old detector skipped installation.
  const pluginStep = await db.query.taskSteps.findFirst({
    where: and(
      eq(schema.taskSteps.taskId, taskId),
      eq(schema.taskSteps.stepId, '01b-install-plugins'),
    ),
    columns: { output: true, status: true },
  });
  return (
    pluginStep?.status === 'done' &&
    (pluginStep.output as { skipped?: unknown } | null)?.skipped === false
  );
}
