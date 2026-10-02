/**
 * Two installations, each with its own database, sharing one git remote: A onboards a repository
 * through the real deterministic onboarding steps (01, 02, 04, 06_5, 07, 12, their LLM passes
 * absent) and pushes, and B clones it. Throwaway user, database and temp directory, removed after.
 * Track B's plan is docs/plans/two-install-project-sync.md.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';
import { logger, type FormSchema } from '@haive/shared';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import {
  emptyProjectState,
  normalizeProjectState,
  renderProjectState,
} from '@haive/shared/project-state';
import { applyPlanPatch } from '@haive/shared/plan';
import { handleClone, handleScan } from '../src/repo/clone.js';
import { stampRepositoryOnboarded } from '../src/repo/onboarded.js';
import {
  TaskCancelledError,
  type StepContext,
  type StepDefinition,
} from '../src/step-engine/step-definition.js';
import { envDetectStep } from '../src/step-engine/steps/onboarding/01-env-detect.js';
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

const log = logger.child({ module: 'two-install-smoke' });

if (!process.env.DATABASE_URL) {
  console.error('[smoke] missing env DATABASE_URL');
  process.exit(2);
}
const urlA = process.env.DATABASE_URL;

/** What a second install cannot do yet, each with the Track B PR that closes it. A gap that
 *  passes fails the run, so the PR that closes one removes it here. */
const KNOWN_GAPS: Record<string, string> = {
  'B holds a live claim for every path A claims': 'B1.6',
  "B's upgrade plan reads every claimed path as unchanged": 'B1.6',
  "a second 12 run leaves A's checkout clean": 'B1.7',
};
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
async function upgradePlan(
  install: Install,
): Promise<{ taskId: string; plan: UpgradePlanDetect | null; error: string | null }> {
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
    return { taskId: upgrade!.id, plan, error: null };
  } catch (err) {
    if (!(err instanceof RenderContextUnresolvedError)) throw err;
    return { taskId: upgrade!.id, plan: null, error: err.message };
  }
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
    const wantRecord = contextA === null ? null : recordOf(contextA);
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
      "A's sync starts from the record it wrote, with no error",
      wantRecord !== null &&
        'rows' in syncA &&
        syncA.rows.length === 1 &&
        isDeepStrictEqual(
          asJson(syncA.rows[0]!.base_snapshot),
          asJson(normalizeProjectState(wantRecord)),
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
      "B's sync starts from the record A committed, with no error",
      wantRecord !== null &&
        'rows' in syncB &&
        syncB.rows.length === 1 &&
        isDeepStrictEqual(
          asJson(syncB.rows[0]!.base_snapshot),
          asJson(normalizeProjectState(wantRecord)),
        ) &&
        syncB.rows[0]!.last_error === null,
      syncB,
    );
    // A rescan reads the same record again: nothing differs, so nothing is written, whatever order
    // the database hands a jsonb value back in.
    const syncStateB = () =>
      rowsOf<Record<string, unknown>>(
        b.db,
        sql`select r.render_context, s.base_snapshot, s.last_error, s.updated_at from repositories r left join project_state_sync s on s.repository_id = r.id where r.id = ${b.repositoryId}`,
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
      "a rescan of B's checkout leaves its render_context and its sync row as they were",
      'rows' in beforeRescan &&
        'rows' in afterRescan &&
        beforeRescan.rows.length === 1 &&
        beforeRescan.rows[0]!.base_snapshot !== null &&
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

    // ---- what B cannot do yet ---------------------------------------------------------------
    const pathsA = await livePaths(a);
    const pathsB = await livePaths(b);
    check('A records its claims', pathsA.length > 0, pathsA.length);
    check(
      'B holds a live claim for every path A claims',
      pathsA.length > 0 && isDeepStrictEqual(pathsA, pathsB),
      { a: pathsA.length, b: pathsB.length },
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
