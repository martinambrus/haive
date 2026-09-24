import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  secretsService,
  userSecretsService,
  logger,
  type CliExecJobPayload,
} from '@haive/shared';
import { initDatabase, getDb } from '../src/db.js';
import { initRedis, closeRedis } from '../src/redis.js';
import { closeTaskQueue } from '../src/queues/task-queue.js';
import { SANDBOX_WORKDIR } from '../src/sandbox/sandbox-runner.js';
import { resolveDagPhase } from '../src/step-engine/dag-executor.js';
import { loadLedgerEntries, recordLedgerEntry } from '../src/step-engine/task-ledger.js';
import { dagExecuteStep } from '../src/step-engine/steps/workflow/06c-dag-execute.js';
import { TaskCancelledError, type StepContext } from '../src/step-engine/step-definition.js';
import type { AdvanceStepParams } from '../src/step-engine/step-runner.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

// Slice 5 review smoke: two issues at one level with reviewEnabled. Each issue
// runs the inner loop — reviewer says fix_required once, a fix coder runs, then
// the reviewer approves — before the (non-conflicting) merge. Validates the
// coder<->reviewer loop, dag_agent_runs tracking, the review-gated merge, and the
// task ledger each review-loop agent reads and a fix coder writes.

const SEEDED_FACT = 'the fixture has no build step, so nothing needs running before a review';
const FIXER_CONCERN = 'the fixture keeps every issue file at the worktree root';

const log = logger.child({ module: 'dag-review-smoke' });

for (const k of ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

const BRANCH = 'feat-review';

interface State {
  fixtureDir?: string;
  userId?: string;
  repoId?: string;
  taskId?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();
}

function fence(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

async function createFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'haive-dag-review-'));
  await writeFile(path.join(dir, 'README.md'), '# fixture\n');
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'smoke@test.local']);
  git(dir, ['config', 'user.name', 'Smoke']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  await writeFile(path.join(dir, '.git', 'info', 'exclude'), '.haive/\n');
  git(dir, [
    'worktree',
    'add',
    path.join(dir, '.haive', 'worktrees', BRANCH),
    '-b',
    BRANCH,
    'main',
  ]);
  return dir;
}

async function main(): Promise<void> {
  const state: State = {};
  let exitCode = 0;
  try {
    initRedis(process.env.REDIS_URL!);
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    await userSecretsService.initialize(db, await secretsService.getMasterKek());

    state.fixtureDir = await createFixture();
    const repoPath = state.fixtureDir;
    const integrationWorktree = path.join(repoPath, '.haive', 'worktrees', BRANCH);

    const now = new Date();
    const userId = randomUUID();
    state.userId = userId;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'dag-review@test.local',
      emailBlindIndex: `dagr-${randomBytes(4).toString('hex')}`,
      passwordHash: 'x',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    const [provider] = await db
      .insert(schema.cliProviders)
      .values({
        userId,
        name: 'claude-code',
        label: 'review smoke',
        executablePath: '/bin/true',
        supportsSubagents: true,
        authMode: 'subscription',
        enabled: true,
      })
      .returning();
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId,
        name: 'dag-review',
        source: 'local_path',
        localPath: repoPath,
        storagePath: repoPath,
        status: 'ready',
      })
      .returning();
    state.repoId = repo!.id;
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId: repo!.id,
        cliProviderId: provider!.id,
        type: 'workflow',
        title: 'dag review smoke',
        status: 'running',
      })
      .returning();
    state.taskId = task!.id;

    // One attached file, so every reviewer and fix coder prompt must carry the attachments notice.
    const uploadsDir = path.join(repoPath, '.haive', 'task-uploads', task!.id);
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(path.join(uploadsDir, 'brief.md'), '# brief\n');
    await db.insert(schema.taskAttachments).values({
      taskId: task!.id,
      userId,
      filename: 'brief.md',
      storedPath: path.join(uploadsDir, 'brief.md'),
      sizeBytes: 8,
    });

    // One fact an earlier step established, so every review-loop prompt must carry the ledger.
    await recordLedgerEntry(db, task!.id, null, {
      stepId: '04-phase-0b',
      round: 0,
      text: SEEDED_FACT,
    });

    await db.insert(schema.taskSteps).values({
      taskId: task!.id,
      stepId: '01-worktree-setup',
      stepIndex: 1,
      title: 'Worktree setup',
      status: 'done',
      output: {
        worktreePath: integrationWorktree,
        sandboxWorktreePath: `${SANDBOX_WORKDIR}/.haive/worktrees/${BRANCH}`,
        branchName: BRANCH,
      },
    });
    const [planStep] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '06b-sprint-planning',
        stepIndex: 6.2,
        title: 'Sprint planning',
        status: 'done',
        output: { mode: 'dag' },
      })
      .returning();
    const levels = [['ISSUE-001', 'ISSUE-002']];
    const [plan] = await db
      .insert(schema.taskDagPlans)
      .values({
        taskId: task!.id,
        taskStepId: planStep!.id,
        mode: 'dag',
        maxParallel: 2,
        levels,
        planJson: {},
        reviewEnabled: true, // <-- the feature under test
      })
      .returning();
    await db.insert(schema.taskDagLevels).values({
      dagPlanId: plan!.id,
      level: 0,
      issueKeys: levels[0],
      phase: 'pending',
    });
    for (const key of ['ISSUE-001', 'ISSUE-002']) {
      await db.insert(schema.taskDagIssues).values({
        dagPlanId: plan!.id,
        taskId: task!.id,
        issueKey: key,
        level: 0,
        title: `Implement ${key}`,
        acceptanceCriteria: [`${key} works`],
        outcome: 'pending',
      });
    }
    const [execStep] = await db
      .insert(schema.taskSteps)
      .values({
        taskId: task!.id,
        stepId: '06c-dag-execute',
        stepIndex: 6.5,
        title: 'DAG implementation',
        status: 'running',
      })
      .returning();

    // Fake spawner: initial coder writes the issue file; reviewer says
    // fix_required on its first pass (iteration 0) then approve; fix coder is a
    // no-op that reports completed for ISSUE-001 and leaves no result for ISSUE-002.
    const enqueueCliInvocation = async (payload: CliExecJobPayload): Promise<void> => {
      const finish = (out: unknown) =>
        db
          .update(schema.cliInvocations)
          .set({
            exitCode: 0,
            rawOutput: typeof out === 'string' ? out : fence(out),
            endedAt: new Date(),
          })
          .where(eq(schema.cliInvocations.id, payload.invocationId));

      const issue = await db.query.taskDagIssues.findFirst({
        where: eq(schema.taskDagIssues.cliInvocationId, payload.invocationId),
      });
      if (issue?.worktreePath) {
        await writeFile(
          path.join(issue.worktreePath, `${issue.issueKey}.txt`),
          `impl ${issue.issueKey}\n`,
        );
        await finish({
          issue_id: issue.issueKey,
          outcome: 'completed',
          files_modified: [`${issue.issueKey}.txt`],
          debt_items: [],
          concerns: '',
          similar_sites: [{ path: 'shared/a.ts', lines: '3', reason: 'coder' }],
        });
        return;
      }
      const run = await db.query.dagAgentRuns.findFirst({
        where: eq(schema.dagAgentRuns.cliInvocationId, payload.invocationId),
      });
      if (run?.role === 'reviewer') {
        await finish(
          run.iteration === 0
            ? {
                verdict: 'fix_required',
                criteria_results: [],
                issues: [{ severity: 'low', description: 'tidy up', suggestion: 'add a comment' }],
              }
            : { verdict: 'approve', criteria_results: [], issues: [] },
        );
        return;
      }
      const fixing = await db.query.taskDagIssues.findFirst({
        where: eq(schema.taskDagIssues.id, run!.dagIssueId),
      });
      if (fixing?.issueKey === 'ISSUE-002') {
        await finish('fixed it, but no result block');
        return;
      }
      // fix coder: repeats one site the coder reported and adds its own
      await finish({
        issue_id: 'fix',
        outcome: 'completed',
        files_modified: [],
        debt_items: [],
        concerns: FIXER_CONCERN,
        similar_sites: [
          { path: 'shared/a.ts', lines: '3', reason: 'repeat' },
          { path: 'shared/b.ts', reason: 'fixer' },
        ],
      });
    };

    const controller = new AbortController();
    const ctx: StepContext = {
      round: 0,
      taskId: task!.id,
      taskStepId: execStep!.id,
      userId,
      repoPath,
      workspacePath: repoPath,
      sandboxWorkdir: SANDBOX_WORKDIR,
      cliProviderId: provider!.id,
      db,
      logger: log.child({ stepId: '06c-dag-execute' }),
      signal: controller.signal,
      throwIfCancelled: () => {
        if (controller.signal.aborted) throw new TaskCancelledError();
      },
      async emitProgress() {},
    };
    const params: AdvanceStepParams = {
      db,
      taskId: task!.id,
      userId,
      repoPath,
      workspacePath: repoPath,
      cliProviderId: provider!.id,
      stepDef: dagExecuteStep,
      providers: [provider as CliProviderRecord],
      deps: { enqueueCliInvocation },
    };

    let current = execStep!;
    let resolved = false;
    for (let i = 0; i < 24 && !resolved; i += 1) {
      const r = await resolveDagPhase(db, dagExecuteStep, current, ctx, params);
      if (r.resolved) {
        resolved = true;
        break;
      }
      if (r.result.status === 'failed') {
        throw new Error(`review smoke failed: ${(r.result as { error: string }).error}`);
      }
      current = r.result.row;
    }
    if (!resolved) throw new Error('review smoke did not complete');

    // --- Assertions ---
    const issues = await db
      .select()
      .from(schema.taskDagIssues)
      .where(eq(schema.taskDagIssues.dagPlanId, plan!.id));
    if (!issues.every((i) => i.resolution === 'approved')) {
      throw new Error(
        `expected all approved, got ${issues.map((i) => `${i.issueKey}=${i.resolution}`).join(', ')}`,
      );
    }
    if (!issues.every((i) => i.innerIteration === 1 && i.stuckCount === 1)) {
      throw new Error('expected one fix iteration per issue');
    }
    const runs = await db
      .select()
      .from(schema.dagAgentRuns)
      .where(eq(schema.dagAgentRuns.taskId, task!.id));
    const reviewers = runs.filter((r) => r.role === 'reviewer').length;
    const fixers = runs.filter((r) => r.role === 'coder').length;
    // 2 issues x (reviewer iter0 + fix coder + reviewer iter1) = 4 reviewers + 2 fixers.
    if (reviewers !== 4 || fixers !== 2) {
      throw new Error(`expected 4 reviewer + 2 fix runs, got ${reviewers} + ${fixers}`);
    }
    // Every pass that reports similar sites adds to the issue's list; none overwrites it.
    // Compared as tuples because jsonb does not keep an object's key order.
    const siteTuples = (sites: { path: string; lines?: string; reason: string }[]) =>
      JSON.stringify(sites.map((x) => [x.path, x.lines ?? null, x.reason]));
    const wantSites: Record<string, string> = {
      'ISSUE-001': JSON.stringify([
        ['shared/a.ts', '3', 'coder'],
        ['shared/b.ts', null, 'fixer'],
      ]),
      // Its fix coder left no result, so only the level coder's report is kept.
      'ISSUE-002': JSON.stringify([['shared/a.ts', '3', 'coder']]),
    };
    for (const i of issues) {
      if (siteTuples(i.similarSites) !== wantSites[i.issueKey]) {
        throw new Error(`${i.issueKey} similar sites: ${JSON.stringify(i.similarSites)}`);
      }
    }

    // Every reviewer and fix coder was told what the task has attached, as the coders were.
    const invocationIds = runs.flatMap((r) => (r.cliInvocationId ? [r.cliInvocationId] : []));
    const sent = await db
      .select({ id: schema.cliInvocations.id, prompt: schema.cliInvocations.prompt })
      .from(schema.cliInvocations)
      .where(inArray(schema.cliInvocations.id, invocationIds));
    if (sent.length !== runs.length) {
      throw new Error(`expected ${runs.length} review-loop prompts, found ${sent.length}`);
    }
    const uninformed = sent.filter(
      ({ prompt }) => !prompt.includes('[User-attached files]') || !prompt.includes('brief.md'),
    );
    if (uninformed.length > 0) {
      throw new Error(`${uninformed.length} review-loop prompt(s) carry no attachments notice`);
    }
    // ...and what earlier agents established, as the level coders were.
    const noLedger = sent.filter(({ prompt }) => !prompt.includes(SEEDED_FACT));
    if (noLedger.length > 0) {
      throw new Error(`${noLedger.length} review-loop prompt(s) carry no task ledger`);
    }

    // A fix coder's concerns reach the ledger; a fix coder that left no result adds nothing.
    const ledger = await loadLedgerEntries(db, task!.id);
    const fixerEntries = ledger.filter((e) => e.stepId === '06c-dag-execute/ISSUE-001');
    if (fixerEntries.length !== 1 || fixerEntries[0]!.text !== FIXER_CONCERN) {
      throw new Error(`fix coder concerns not recorded: ${JSON.stringify(ledger)}`);
    }
    if (ledger.some((e) => e.stepId === '06c-dag-execute/ISSUE-002')) {
      throw new Error(`a fix coder with no result was recorded: ${JSON.stringify(ledger)}`);
    }
    // The re-review that follows ISSUE-001's fix coder already reads what it recorded.
    const issue1 = issues.find((i) => i.issueKey === 'ISSUE-001')!;
    const reReview = runs.find(
      (r) => r.dagIssueId === issue1.id && r.role === 'reviewer' && r.iteration === 1,
    );
    const reReviewPrompt = sent.find((x) => x.id === reReview?.cliInvocationId)?.prompt ?? '';
    if (!reReviewPrompt.includes(FIXER_CONCERN)) {
      throw new Error('the re-review does not carry the fix coder concerns');
    }

    // Every agent this task ran was given the terseness directive exactly once.
    const tersenessOff = (await configService.get(CONFIG_KEYS.TERSENESS_LEVEL)) === 'off';
    const allPrompts = await db
      .select({ prompt: schema.cliInvocations.prompt })
      .from(schema.cliInvocations)
      .where(eq(schema.cliInvocations.taskId, task!.id));
    const misstyled = allPrompts.filter(
      ({ prompt }) => prompt.split('## Response style').length - 1 !== (tersenessOff ? 0 : 1),
    );
    if (allPrompts.length < 8 || misstyled.length > 0) {
      throw new Error(`${misstyled.length} of ${allPrompts.length} prompts misstate the directive`);
    }

    console.log(
      JSON.stringify({
        smoke: 'DAG_REVIEW_OK',
        issues: issues.map((i) => ({
          key: i.issueKey,
          resolution: i.resolution,
          iter: i.innerIteration,
        })),
        agentRuns: runs.length,
      }),
    );
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
      log.warn({ err: cleanupErr }, 'db cleanup failed');
    }
    if (state.fixtureDir) {
      try {
        git(state.fixtureDir, ['worktree', 'prune']);
      } catch {
        /* ignore */
      }
      await rm(state.fixtureDir, { recursive: true, force: true }).catch(() => {});
    }
    await closeTaskQueue().catch(() => {});
    await closeRedis().catch(() => {});
    process.exit(exitCode);
  }
}

void main();
