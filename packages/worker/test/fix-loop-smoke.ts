import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { and, asc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  configService,
  secretsService,
  userSecretsService,
  logger,
  QUEUE_NAMES,
  TASK_JOB_NAMES,
  type TaskJobPayload,
} from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, getBullRedis, closeRedis } from '../src/redis.js';
import { closeTaskQueue, startTaskWorker } from '../src/queues/task-queue.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import { createBuildImageStep } from '../src/step-engine/steps/env-replicate/03-build-image.js';
import { createVerifyEnvironmentStep } from '../src/step-engine/steps/env-replicate/04-verify-environment.js';
import { phase4ValidateStep } from '../src/step-engine/steps/workflow/07b-phase-4-validate.js';
import type {
  DockerBuildOpts,
  DockerBuildResult,
  DockerInspectResult,
  DockerRemoveResult,
  DockerRunOpts,
  DockerRunResult,
  DockerRunner,
  DockerVolumeOpResult,
} from '../src/sandbox/docker-runner.js';

// End-to-end fix-loop smoke. A workflow task is driven (LLM bypassed) to the implement
// step; 07b-phase-4-validate is overridden to ALWAYS report ISSUES_FOUND, so every round
// routes back to implement. With max_fix_rounds = 3 it loops to the cap then parks the
// interactive escalation gate on 07b. The drive resolves it: Continue (one more round →
// re-gates), then Abort (task fails). Verifies: multiple round rows materialise, the
// escalation/continued/aborted events fire, and Abort fails the task.

function createFakeRunner(): DockerRunner {
  return {
    async build(opts: DockerBuildOpts): Promise<DockerBuildResult> {
      return {
        exitCode: 0,
        imageTag: opts.tag,
        imageId: `sha256:${randomBytes(16).toString('hex')}`,
        durationMs: 50,
        stderr: '',
        timedOut: false,
      };
    },
    async run(opts: DockerRunOpts): Promise<DockerRunResult> {
      return {
        exitCode: 0,
        stdout: `fake-ok ${opts.cmd.join(' ')}`,
        stderr: '',
        durationMs: 7,
        timedOut: false,
      };
    },
    // Unused on the fix-loop path (the loop short-circuits at 07b) but required by the
    // DockerRunner contract.
    async inspect(): Promise<DockerInspectResult> {
      return { exists: true, imageId: `sha256:${randomBytes(16).toString('hex')}` };
    },
    async remove(): Promise<DockerRemoveResult> {
      return { ok: true, stderr: '' };
    },
    async volumeCreate(): Promise<DockerVolumeOpResult> {
      return { ok: true, stderr: '' };
    },
    async volumeExists(): Promise<boolean> {
      return false;
    },
    async volumeRemove(): Promise<DockerVolumeOpResult> {
      return { ok: true, stderr: '' };
    },
  };
}

process.env.HAIVE_TEST_BYPASS_LLM = '1';

const log = logger.child({ module: 'fix-loop-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

interface State {
  fixtureDir?: string;
  userId?: string;
  repoId?: string;
  taskId?: string;
  worker?: Awaited<ReturnType<typeof startTaskWorker>>;
  queue?: Queue<TaskJobPayload>;
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  predicate: (val: T) => boolean,
  label: string,
  timeoutMs = 30000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val !== null && predicate(val)) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function createFixtureRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-fix-loop-smoke-'));
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fix-loop-smoke-fixture', scripts: { test: 'echo no-tests' } }, null, 2),
  );
  await mkdir(path.join(dir, '.claude', 'knowledge_base'), { recursive: true });
  await writeFile(
    path.join(dir, '.claude', 'knowledge_base', 'architecture.md'),
    '# Architecture\n\nMonolith with API, worker, and web layers.\n',
  );
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'smoke@test.local']);
  git(['config', 'user.name', 'Smoke Test']);
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
  return dir;
}

/** Override 07b to always report ISSUES_FOUND so its fixLoop hook routes back every
 *  round, with no internal validator/fixer loop or CLI dispatch. */
function overrideValidateAlwaysFails(): void {
  stepRegistry.override({
    ...phase4ValidateStep,
    shouldRun: async () => true,
    loop: undefined,
    llm: undefined,
    agentMining: undefined,
    async detect() {
      return {
        worktreePath: '',
        sandboxWorktreePath: '',
        spec: '',
        implementationFiles: [],
        debtBlock: '',
      };
    },
    async apply() {
      return {
        verdict: 'ISSUES_FOUND' as const,
        summary: 'forced failure for the fix-loop smoke',
        issues: [{ description: 'smoke-forced issue' }],
        dimensions: [],
        fixesApplied: [],
        findingsSummary: 'Smoke-forced ISSUES_FOUND to drive the fix loop.',
        report: '',
        validatorPasses: 1,
        source: 'stub' as const,
      };
    },
  });
}

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  try {
    log.info('bootstrapping');
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);

    state.fixtureDir = await createFixtureRepo();
    const now = new Date();
    const userId = randomUUID();
    state.userId = userId;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'fix-loop-smoke@test.local',
      emailBlindIndex: `fixloop-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'fix-loop-smoke-fixture',
        source: 'local_path',
        localPath: state.fixtureDir,
        storagePath: state.fixtureDir,
        status: 'ready',
      })
      .returning();
    if (!repo) throw new Error('repo insert failed');
    state.repoId = repo.id;

    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId: repo.id,
        type: 'workflow',
        title: 'Fix-loop smoke',
        description: 'Drive the fix loop to the cap and exercise the escalation gate.',
        status: 'created',
      })
      .returning();
    if (!task) throw new Error('task insert failed');
    state.taskId = task.id;

    state.worker = startTaskWorker();
    const fakeRunner = createFakeRunner();
    stepRegistry.override(createBuildImageStep(fakeRunner));
    stepRegistry.override(createVerifyEnvironmentStep(fakeRunner));
    overrideValidateAlwaysFails();

    state.queue = new Queue<TaskJobPayload>(QUEUE_NAMES.TASK, { connection: getBullRedis() });
    await state.queue.add(TASK_JOB_NAMES.START, { taskId: task.id, userId });

    // Canned form values for the gated steps. 06-run-config sets max_fix_rounds = 2 and
    // disables the optional fix-loop steps (07a/08a/08d) so the loop lands at 07b.
    const formPayloads: Record<string, Record<string, unknown>> = {
      // 00-triage runs first now; pick the full pipeline explicitly so the
      // fix-loop steps (07b/08/08c -> 07) are all present and the walk does not
      // fall back to the heuristic default (which could trim the path).
      '00-triage': { path: 'full_workflow' },
      '01-declare-deps': {
        runtimes: ['node'],
        nodeVersion: '22',
        phpVersion: '8.3',
        pythonVersion: '3.12',
        containerTool: 'none',
        databaseKind: 'none',
        databaseVersion: '',
        lspServers: [],
        browserTesting: false,
        extraPackages: '',
      },
      '02-generate-dockerfile': {
        dockerfile: 'FROM busybox\nWORKDIR /workspace\nCMD ["sh"]\n',
      },
      '03-build-image': { imageTag: 'haive-fix-loop:latest', forceRebuild: true },
      '04-verify-environment': { selectedChecks: ['node', 'bash'] },
      '01-worktree-setup': {
        branchName: 'feature/fix-loop',
        useWorktree: false,
        baseBranch: 'main',
      },
      '02-pre-rag-sync': { runSync: false },
      '03-phase-0a-discovery': { extraContext: '' },
      '03b-business-requirements': { guidance: '' },
      '03c-business-requirements-review': { decision: 'approve', feedback: '' },
      '04-phase-0b-pre-planning': { scope: 'Minimal smoke change.' },
      '05-phase-0b5-spec-quality': { maxIterations: '3', focusAreas: '' },
      '05a-resolve-spec-warnings': { action: 'continue' },
      '06-gate-1-spec-approval': { decision: 'approve', feedback: 'Smoke run.' },
      '06-run-config': {
        adversarialQaLevel: 'none',
        simplifyCode: false,
        sprintDecision: 'use_single_agent',
        sprintAutoResolveConflicts: false,
        sprintReviewEnabled: false,
        verifyRunTest: false,
        verifyRunLint: false,
        verifyRunTypecheck: false,
        browserMode: 'skip',
        browserCheckConsoleErrors: false,
        browserCheckNetworkErrors: false,
        testAction: 'skip',
        testRunTests: false,
        exposeDbPort: false,
        // Lowest valid option (3/5/10) — keeps the loop short while still proving
        // several rounds materialise before the cap escalates to the gate.
        maxFixRounds: '3',
      },
      '07-phase-2-implement': { instructions: '' },
    };

    // Round-aware drive: track submissions by (stepId, round) so the same stepId in a
    // later fix round is not flagged as already submitted. The escalation gate is the
    // 07b row that carries the fixLoopAction field; resolve Continue then Abort.
    const submitted = new Set<string>();
    const gateDecisions = ['continue', 'abort'];
    let gateIdx = 0;
    let lastKey: string | null = null;
    let iterations = 0;
    let sawGate = false;
    while (iterations < 80) {
      iterations += 1;
      const t = await pollUntil(
        async () =>
          (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, task.id) })) ?? null,
        (tt) => {
          if (tt.status === 'completed' || tt.status === 'failed') return true;
          if (tt.status === 'waiting_user') {
            const key = `${tt.currentStepId}:${tt.currentRound}`;
            return key !== lastKey;
          }
          return false;
        },
        `task transition (iter ${iterations})`,
        45000,
      );

      if (t.status === 'failed') break;
      if (t.status === 'completed') break;

      const stepId = t.currentStepId;
      const round = t.currentRound;
      if (!stepId) throw new Error('waiting_user but no currentStepId');
      const key = `${stepId}:${round}`;
      if (submitted.has(key)) throw new Error(`already submitted ${key} but still waiting`);

      const [row] = await db
        .select()
        .from(schema.taskSteps)
        .where(
          and(
            eq(schema.taskSteps.taskId, task.id),
            eq(schema.taskSteps.stepId, stepId),
            eq(schema.taskSteps.round, round),
            eq(schema.taskSteps.status, 'waiting_form'),
          ),
        )
        .limit(1);
      const schemaFields =
        (row?.formSchema as { fields?: { id: string; default?: unknown }[] } | null)?.fields ?? [];
      const fieldIds = schemaFields.map((f) => f.id);

      let values: Record<string, unknown>;
      if (fieldIds.includes('fixLoopAction')) {
        sawGate = true;
        const decision = gateDecisions[Math.min(gateIdx, gateDecisions.length - 1)]!;
        gateIdx += 1;
        log.info({ stepId, round, decision }, 'resolving escalation gate');
        values = { fixLoopAction: decision };
      } else if (formPayloads[stepId]) {
        values = formPayloads[stepId]!;
      } else {
        // Unlisted gated step (e.g. 06a/06b in this fixture): submit its form defaults.
        values = Object.fromEntries(
          schemaFields.filter((f) => f.default !== undefined).map((f) => [f.id, f.default]),
        );
        log.info({ stepId, round, values }, 'submitting form defaults for unlisted step');
      }

      await state.queue.add(TASK_JOB_NAMES.ADVANCE_STEP, {
        taskId: task.id,
        userId,
        stepId,
        round,
        formValues: values,
      });
      submitted.add(key);
      lastKey = key;
    }

    const finalTask = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, task.id) });
    if (!finalTask) throw new Error('final task vanished');

    const allSteps = await db
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, task.id))
      .orderBy(asc(schema.taskSteps.round), asc(schema.taskSteps.stepIndex));
    const implementRounds = new Set(
      allSteps.filter((s) => s.stepId === '07-phase-2-implement').map((s) => s.round),
    );
    const events = await db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, task.id));
    const eventTypes = new Set(events.map((e) => e.eventType));

    // Assertions.
    const problems: string[] = [];
    if (!sawGate) problems.push('escalation gate never appeared');
    if (!eventTypes.has('fix_loop.escalated')) problems.push('missing fix_loop.escalated event');
    if (!eventTypes.has('fix_loop.continued')) problems.push('missing fix_loop.continued event');
    if (!eventTypes.has('fix_loop.aborted')) problems.push('missing fix_loop.aborted event');
    if (implementRounds.size < 2) {
      problems.push(`expected >= 2 implement rounds, saw ${implementRounds.size}`);
    }
    if (finalTask.status !== 'failed') {
      problems.push(`expected task failed (aborted), got ${finalTask.status}`);
    }
    if (!(finalTask.errorMessage ?? '').toLowerCase().includes('abort')) {
      problems.push(`expected an abort error, got: ${finalTask.errorMessage}`);
    }
    if (problems.length > 0)
      throw new Error(`fix-loop assertions failed:\n- ${problems.join('\n- ')}`);

    log.info(
      {
        implementRounds: [...implementRounds].sort(),
        gateEvents: [...eventTypes].filter((e) => e.startsWith('fix_loop')),
        finalStatus: finalTask.status,
      },
      'fix-loop smoke PASSED',
    );
    console.log('[smoke] fix-loop PASSED');
  } catch (err) {
    exitCode = 1;
    log.error({ err }, 'smoke failed');
    console.error('[smoke] FAILED:', err);
  } finally {
    try {
      const db = getDb();
      if (state.taskId) await db.delete(schema.tasks).where(eq(schema.tasks.id, state.taskId));
      if (state.repoId) {
        await db.delete(schema.repositories).where(eq(schema.repositories.id, state.repoId));
      }
      if (state.userId) await db.delete(schema.users).where(eq(schema.users.id, state.userId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr }, 'cleanup db rows failed');
    }
    if (state.fixtureDir)
      await rm(state.fixtureDir, { recursive: true, force: true }).catch(() => {});
    if (state.worker) await state.worker.close().catch(() => {});
    if (state.queue) await state.queue.close().catch(() => {});
    await closeTaskQueue().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();
