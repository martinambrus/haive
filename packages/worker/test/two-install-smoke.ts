/**
 * Two installations, each with its own database, sharing one git remote: A onboards a repository
 * through the real deterministic onboarding steps (01, 02, 04, 06_5, 07, 12, their LLM passes
 * absent) and pushes, and B clones it. Throwaway user, database and temp directory, removed after.
 * Track B's plan is docs/plans/two-install-project-sync.md.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';
import { logger, normalizeContent, sha256Hex, type FormSchema } from '@haive/shared';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import {
  bundleFileName,
  claimFileName,
  emptyProjectState,
  normalizeProjectState,
  PROJECT_STATE_IMPORT_STEP_ID,
  renderProjectState,
} from '@haive/shared/project-state';
import { applyPlanPatch } from '@haive/shared/plan';
import { upgradeAdmission } from '@haive/shared/onboarding-admission';
import { handleClone, handleScan } from '../src/repo/clone.js';
import { handleRefresh } from '../src/repo/refresh.js';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';
import { writeProjectStateRecord } from '../src/project-state/write.js';
import { stampRepositoryOnboarded } from '../src/repo/onboarded.js';
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
  execFileSync('git', ['-c', 'gc.auto=0', ...args], { cwd, env: gitEnv, encoding: 'utf8' }).trim();

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

/** One install's user, CLI and repository, cloned from the shared remote as the repo queue would. */
async function cloneInstall(
  name: Install['name'],
  db: Database,
  storage: string,
  remoteUrl: string,
  userId: string = randomUUID(),
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
  const [provider] = await db
    .insert(schema.cliProviders)
    .values({ userId, name: 'claude-code', label: `two-install-smoke ${name}` })
    .returning({ id: schema.cliProviders.id });
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
    providerId: provider!.id,
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
  render: {
    projectInfo: context.projectInfo,
    framework: context.framework,
    acceptedAgentIds: context.acceptedAgentIds,
    customAgentSpecs: context.customAgentSpecs,
    lspLanguages: context.lspLanguages,
  } as never,
});

const BUNDLE_DESCRIPTOR = { source: 'zip:smoke-kit', name: 'smoke-kit' };

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
  pick: (plan: UpgradePlanDetect) => Record<string, unknown>,
): Promise<{ error: string | null }> {
  const planned = await upgradePlan(install);
  if (planned.plan === null) return { error: planned.error };
  const planCtx = ctxFor(install, planned.taskId, planned.stepId);
  const output = await upgradePlanStep.apply(planCtx, {
    detected: planned.plan,
    formValues: {},
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
    formValues: { ...defaultValues(form), ...pick(planned.plan) },
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
    sql`select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = current_schema() and table_name = ${table} and (${only ?? null}::text is null or column_name = ${only ?? null})`,
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
  let tmp: string | null = null;
  let userA: string | null = null;

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
    tmp = await mkdtemp(path.join(tmpdir(), 'two-install-smoke-'));

    const origin = path.join(tmp, 'origin.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = path.join(tmp, 'seed');
    git(tmp, 'clone', '-q', `file://${origin}`, seed);
    await writeFile(path.join(seed, 'README.md'), '# two-install smoke\n');
    await writeFile(
      path.join(seed, 'composer.json'),
      `${JSON.stringify({ name: 'acme/two-install', require: { 'drupal/core-recommended': '^10.3' } }, null, 2)}\n`,
    );
    git(seed, 'add', 'README.md', 'composer.json');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const remoteUrl = `file://${origin}`;

    // ---- A onboards ----------------------------------------------------------------------
    // Known before the clone runs, so a clone that fails still has its rows removed.
    userA = randomUUID();
    const a = await cloneInstall('A', dbA, path.join(tmp, 'storage-a'), remoteUrl, userA);
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
    const posted = await runStep(a, postOnboardingStep, taskA, rowOf(postOnboardingStep), {
      commit: true,
    });
    check(
      'A commits its onboarding',
      posted.output.commitPerformed && posted.output.commitSha !== null,
      posted.output,
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
    const wantRecord =
      contextA === null ? null : { ...recordOf(contextA), bundles: [BUNDLE_DESCRIPTOR] };
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
      'migration 0171 gives repositories a nullable render_context and creates project_state_sync as specified',
      shapeOf(renderColumn, 'render_context') === 'jsonb YES' &&
        'rows' in syncColumns &&
        syncColumns.rows.length === 4 &&
        shapeOf(syncColumns, 'repository_id') === 'uuid NO' &&
        shapeOf(syncColumns, 'base_snapshot') === 'jsonb NO' &&
        shapeOf(syncColumns, 'last_error') === 'text YES' &&
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
    const mirrorA = JSON.parse(git(a.repoPath, 'show', 'HEAD:.haive-data/environment.json')) as {
      envDetectData?: Record<string, unknown>;
    };
    const mirroredKeys = Object.keys(mirrorA.envDetectData ?? {});
    check(
      "A's committed environment mirror carries no prompt-only field",
      mirroredKeys.length > 0 && !mirroredKeys.some((key) => key.startsWith('__')),
      mirroredKeys,
    );

    // ---- B clones --------------------------------------------------------------------------
    const b = await cloneInstall('B', dbB, path.join(tmp, 'storage-b'), remoteUrl);
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
      "B's render_context holds the portable render fields of A's record, records its RTK choice and holds no per-install field",
      wantRender !== null &&
        isDeepStrictEqual(
          asJson(renderContextB),
          asJson({ ...wantRender, rtkChoiceRecorded: true }),
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
    check(
      "B restores A's tooling without its machine-local keys",
      isDeepStrictEqual(repoB?.onboardingTooling, {
        schemaVersion: toolingA.schemaVersion,
        tooling: portableTooling,
      }),
      repoB?.onboardingTooling,
    );
    check(
      "B restores A's scope exclusions",
      isDeepStrictEqual(repoB?.scopeExcludeGlobs, globs),
      repoB?.scopeExcludeGlobs,
    );
    check("B takes A's RTK switch", repoB?.rtkEnabled === false, repoB?.rtkEnabled);
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

    await runStep(a, postOnboardingStep, taskA, rowOf(postOnboardingStep));
    const dirty = git(a.repoPath, 'status', '--porcelain');
    check("a second 12 run leaves A's checkout clean", dirty === '', dirty.split('\n'));

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

      const unitsOf = (install: Install) =>
        rowsOf<{
          id: string;
          unit: string;
          base: { v: unknown } | null;
          local: { v: unknown } | null;
          incoming: { v: unknown } | null;
          resolved_at: Date | null;
        }>(
          install.db,
          sql`select id, unit, base, local, incoming, resolved_at from project_state_conflicts where repository_id = ${install.repositoryId} order by unit`,
        );
      const pendingB = await unitsOf(b);
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
      const again = await syncProjectStateFromCheckout(b.db, {
        repositoryId: b.repositoryId,
        repoPath: b.repoPath,
      });
      const stillPending = await unitsOf(b);
      check(
        'and the next sync meets the same conflict, with no second row',
        again.outcome === 'conflict' && 'rows' in stillPending && stillPending.rows.length === 1,
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
      const noConflictOnA = await unitsOf(a);
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
      const afterTake = await unitsOf(b);
      const columnTaken = await repoStateOf(b);
      const admittedAfterTake = await admissionOf();
      const syncAfterTake = await syncProjectStateFromCheckout(b.db, {
        repositoryId: b.repositoryId,
        repoPath: b.repoPath,
      });
      check(
        "B answers take theirs: the row is closed, the column holds A's value, the file and the base agree",
        taken.kind === 'resolved' &&
          taken.written.length === 0 &&
          'rows' in afterTake &&
          afterTake.rows.length === 1 &&
          afterTake.rows[0]!.resolved_at !== null &&
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
        const second = await unitsOf(b);
        const open = 'rows' in second ? second.rows.find((r) => r.resolved_at === null) : undefined;
        check(
          'the same setting changed again on both sides opens a new question',
          open !== undefined &&
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
        const afterA = await unitsOf(a);
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

    for (const name of Object.keys(KNOWN_GAPS)) {
      if (gapsChecked.has(name)) continue;
      failures += 1;
      log.error({ check: name }, 'FAILED: a known gap was never checked');
    }
  } finally {
    if (userA && dbA) await dbA.delete(schema.users).where(eq(schema.users.id, userA));
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
