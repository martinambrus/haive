/**
 * Two installations, each with its own database, sharing one git remote: A onboards a repository
 * through the real 07 and 12 steps and pushes, and B clones it. Throwaway user, database and temp
 * directory, removed after. Track B's plan is docs/plans/two-install-project-sync.md.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';
import { logger, type FormSchema } from '@haive/shared';
import { applyPlanPatch } from '@haive/shared/plan';
import { handleClone } from '../src/repo/clone.js';
import { stampRepositoryOnboarded } from '../src/repo/onboarded.js';
import {
  TaskCancelledError,
  type StepContext,
  type StepDefinition,
} from '../src/step-engine/step-definition.js';
import { generateFilesStep } from '../src/step-engine/steps/onboarding/07-generate-files.js';
import { postOnboardingStep } from '../src/step-engine/steps/onboarding/12-post-onboarding.js';
import { upgradePlanStep } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';

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

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

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
  repositoryId: string;
  repoPath: string;
}

/** One install's user, CLI and repository, cloned from the shared remote as the repo queue would. */
async function cloneInstall(
  name: Install['name'],
  db: Database,
  storage: string,
  remoteUrl: string,
): Promise<Install> {
  const userId = randomUUID();
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
  await db
    .insert(schema.cliProviders)
    .values({ userId, name: 'claude-code', label: `two-install-smoke ${name}` });
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
  return { name, db, userId, repositoryId, repoPath: path.join(storage, userId, repositoryId) };
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
    cliProviderId: null,
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
): Promise<O> {
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
  return output;
}

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
  const nameA = new URL(urlA).pathname.slice(1);
  const nameB = `${nameA}_two_install_b`;
  const urlB = new URL(urlA);
  urlB.pathname = `/${nameB}`;
  const admin = postgres(urlA, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${nameB}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${nameB}"`);
  execFileSync(
    'node',
    [fileURLToPath(new URL('migrate/index.js', import.meta.resolve('@haive/database')))],
    { env: { ...process.env, DATABASE_URL: urlB.toString() }, stdio: 'pipe' },
  );

  const dbA = createDatabase(urlA);
  const dbB = createDatabase(urlB.toString());
  const tmp = await mkdtemp(path.join(tmpdir(), 'two-install-smoke-'));
  let userA: string | null = null;

  try {
    const origin = path.join(tmp, 'origin.git');
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = path.join(tmp, 'seed');
    git(tmp, 'clone', '-q', `file://${origin}`, seed);
    await writeFile(path.join(seed, 'README.md'), '# two-install smoke\n');
    git(seed, 'add', 'README.md');
    git(seed, 'commit', '-q', '-m', 'seed');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const remoteUrl = `file://${origin}`;

    // ---- A onboards ----------------------------------------------------------------------
    const a = await cloneInstall('A', dbA, path.join(tmp, 'storage-a'), remoteUrl);
    userA = a.userId;
    const environment = {
      schemaVersion: 1,
      envDetectData: { project: { name: 'two-install-smoke' } },
      confirmedValues: { framework: 'none' },
    };
    const portableTooling = { ragMode: 'none', lspLanguages: [], rtkEnabled: false };
    const globs = ['vendor/**', 'build/**'];
    await a.db
      .update(schema.repositories)
      .set({
        onboardingEnvironment: environment,
        onboardingTooling: {
          schemaVersion: 1,
          tooling: { ...portableTooling, ollamaUrl: 'http://only-on-a:11434' },
        },
        scopeExcludeGlobs: globs,
        rtkEnabled: false,
      })
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
    const [row07, row12] = await a.db
      .insert(schema.taskSteps)
      .values([
        {
          taskId: taskA,
          stepId: '07-generate-files',
          stepIndex: 7,
          title: 'Generate workflow files',
          status: 'pending',
        },
        {
          taskId: taskA,
          stepId: '12-post-onboarding',
          stepIndex: 16,
          title: 'Post-onboarding commit',
          status: 'pending',
        },
      ])
      .returning({ id: schema.taskSteps.id });

    const generated = await runStep(a, generateFilesStep, taskA, row07!.id);
    check('A generates its files', generated.wroteFiles.length > 0, generated.wroteFiles);
    const posted = await runStep(a, postOnboardingStep, taskA, row12!.id, { commit: true });
    check('A commits its onboarding', posted.commitPerformed && posted.commitSha !== null, posted);
    await a.db
      .update(schema.tasks)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(schema.tasks.id, taskA));
    await stampRepositoryOnboarded(a.db, taskA);
    // 13-onboarding-push runs inside the step runner's merge phase, so the push is done here.
    git(a.repoPath, 'push', '-q', 'origin', 'HEAD:main');
    const headA = git(a.repoPath, 'rev-parse', 'HEAD');
    check("the remote holds A's onboarding commit", git(origin, 'rev-parse', 'main') === headA);

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
        present: await exists(path.join(b.repoPath, rel)),
      })),
    );
    check(
      "B has A's generated files",
      filesOnB.every((f) => f.present),
      filesOnB,
    );
    check(
      'B restores the environment A recorded',
      isDeepStrictEqual(repoB?.onboardingEnvironment, environment),
      repoB?.onboardingEnvironment,
    );
    check(
      "B restores A's tooling without its machine-local keys",
      isDeepStrictEqual(repoB?.onboardingTooling, { schemaVersion: 1, tooling: portableTooling }),
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
    let planError: string | null = null;
    try {
      entries = (await upgradePlanStep.detect!(ctxFor(b, upgrade!.id, planRow!.id))).entries;
    } catch (err) {
      planError = err instanceof Error ? err.message : String(err);
    }
    check("B's upgrade plan resolves its render context", entries !== null, planError);
    const notUnchanged = entries
      ?.filter((e) => e.bucket !== 'unchanged')
      .map((e) => `${e.diskPath}: ${e.bucket}`);
    check(
      "B's upgrade plan reads every claimed path as unchanged",
      entries !== null && entries.length > 0 && notUnchanged!.length === 0,
      notUnchanged ?? planError,
    );

    await runStep(a, postOnboardingStep, taskA, row12!.id);
    const dirty = git(a.repoPath, 'status', '--porcelain');
    check("a second 12 run leaves A's checkout clean", dirty === '', dirty.split('\n'));

    for (const name of Object.keys(KNOWN_GAPS)) {
      if (gapsChecked.has(name)) continue;
      failures += 1;
      log.error({ check: name }, 'FAILED: a known gap was never checked');
    }
  } finally {
    if (userA) await dbA.delete(schema.users).where(eq(schema.users.id, userA));
    await dbA.$client.end({ timeout: 5 });
    await dbB.$client.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${nameB}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
    await rm(tmp, { recursive: true, force: true });
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
