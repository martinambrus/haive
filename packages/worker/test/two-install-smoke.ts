/**
 * Two installations, each with its own database, sharing one git remote: A onboards a repository
 * through the real deterministic onboarding steps (01, 02, 04, 06_5, 07, 12, their LLM passes
 * absent) and pushes, and B clones it. Throwaway user, database and temp directory, removed after.
 * Track B's plan is docs/plans/two-install-project-sync.md.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';
import { logger, type FormSchema } from '@haive/shared';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { applyPlanPatch } from '@haive/shared/plan';
import { handleClone } from '../src/repo/clone.js';
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
  "B's upgrade plan resolves its render context": 'B1.4',
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
): Promise<{ detected: D; output: O }> {
  const ctx = ctxFor(install, taskId, taskStepId);
  const detected = await step.detect!(ctx);
  await install.db
    .update(schema.taskSteps)
    .set({ detectOutput: detected, status: 'running' })
    .where(eq(schema.taskSteps.id, taskStepId));
  const form = step.form ? await step.form(ctx, detected) : null;
  const formValues = { ...defaultValues(form), ...overrides };
  const output = await step.apply(ctx, {
    detected,
    formValues,
    iteration: 0,
    previousIterations: [],
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
    await runStep(a, agentDiscoveryStep, taskA, rowOf(agentDiscoveryStep));
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

    const [upgrade] = await b.db
      .insert(schema.tasks)
      .values({
        userId: b.userId,
        repositoryId: b.repositoryId,
        type: 'onboarding_upgrade',
        title: 'two-install-smoke',
        status: 'running',
      })
      .returning({ id: schema.tasks.id });
    const [planRow] = await b.db
      .insert(schema.taskSteps)
      .values({
        taskId: upgrade!.id,
        stepId: '01-upgrade-plan',
        stepIndex: 1,
        title: 'Plan upgrade',
        status: 'running',
      })
      .returning({ id: schema.taskSteps.id });
    let entries: { diskPath: string; bucket: string }[] | null = null;
    let contextB: Record<string, unknown> | null = null;
    let planError: string | null = null;
    try {
      const planB = await upgradePlanStep.detect!(ctxFor(b, upgrade!.id, planRow!.id));
      entries = planB.entries;
      contextB = planB.renderCtxSnapshot;
    } catch (err) {
      if (!(err instanceof RenderContextUnresolvedError)) throw err;
      planError = err.message;
    }
    check(
      "B's upgrade plan resolves its render context",
      contextB !== null &&
        contextB.framework === rendered.framework &&
        // Both are sets to every renderer, so the record may store them sorted.
        isDeepStrictEqual(sorted(contextB.acceptedAgentIds), sorted(rendered.acceptedAgentIds)) &&
        isDeepStrictEqual(sorted(contextB.lspLanguages), sorted(rendered.lspLanguages)),
      planError ?? contextB,
    );
    const notUnchanged = entries
      ?.filter((e) => e.bucket !== 'unchanged')
      .map((e) => `${e.diskPath}: ${e.bucket}`);
    check(
      "B's upgrade plan reads every claimed path as unchanged",
      entries !== null && entries.length > 0 && notUnchanged!.length === 0,
      notUnchanged ?? planError,
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
