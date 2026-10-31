import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, ne, or } from 'drizzle-orm';
import { lockRepositoryTasksKey, schema } from '@haive/database';
import {
  CONFIG_KEYS,
  PLAN_MERGE_MESSAGE_EVENT,
  configService,
  type FormSchema,
} from '@haive/shared';
import { lockPlanMerge } from '@haive/shared/plan';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared/logger';
import type { StepDefinition } from '../../step-definition.js';
import {
  abortMerge as abortGitMerge,
  completeMergeHostSide,
  fixerIndexHeldNote,
  fixerLeftoversWarning,
  recordFixerLeftovers,
  relocateFixerChanges,
  type FixBaseline,
  type FixBaselineUnavailable,
} from '../../git-merge.js';
import { HAIVE_OWN_FILES_LINE, handBackAfterMove } from '../../git-merge.js';
import { isSingleLine, REPO_IS_DATA_MERGE_LINES, survivesFence } from '../_untrusted-repo.js';
import { resolveGitEnv } from '../../../secrets/user-git-identity.js';
import {
  MOVE_ATTEMPTS,
  putBackProjections,
  recoverAfterMoveFailure,
  restoreKeptMetadata,
  restoreProjectionsInTx,
  resyncHaiveProjections,
  setAsideHaiveProjections,
  type KeptFiles,
} from '../../../project-state/set-aside.js';
import {
  commitMerge,
  conflictCount,
  conflictedPaths,
  divergence,
  ensurePlanMergeWorktree,
  PLAN_MERGE_LIVE_STATUSES,
  fetchOrigin,
  headCommit,
  landPlanMerge,
  mergeOriginInto,
  planMergeWorktreePath,
  removePlanMergeWorktree,
  reopenResolvedMerge,
  unlandedResolvedMerge,
  type ConflictedPaths,
} from '../../../plan/merge.js';
import {
  PLAN_MERGE_PRIOR_EVENT,
  priorResolutionLines,
  readPriorResolution,
  type PriorRef,
  type PriorResolution,
} from '../../../plan/merge-prior.js';
import {
  advancePlanBaseFromCommit,
  flushPlanMirrorForRepository,
  reconcilePlanFromCheckout,
  seedPlanBaseFromCheckout,
  writePlanMirror,
} from '../../../plan/mirror.js';
import {
  moveAsideFixerLeftovers,
  moveAsideRecordedLeftovers,
  planMergeFixBaseline,
} from '../../../plan/merge-baseline.js';
import { commitPlanSnapshotFiles } from '../../../plan/snapshot-git.js';
import { taskSecretMaskPolicy } from '../../../queues/cli-exec/secret-mask.js';
import { pushBranch, gitRun } from '../../../repo/git-push.js';
import { gitGaveNoAnswer } from '../../../repo/git-exec.js';
import { checkoutHoldingTasks } from '../../../repo/refresh.js';
import { WORKTREE_SUBDIR } from '../../../repo/worktree-paths.js';

/** Must match the directory `planMergeWorktreePath` builds. */
const PLAN_MERGE_DIR_NAME = 'plan-merge';

/**
 * Resolve a conflicted plan pull, as a conversation.
 *
 * `save()` and `pull()` integrate the remote on their own whenever they can; this
 * exists for the case they cannot — a merge with conflicts outside the plan mirror's
 * own two files. The prompting case is the ordinary one: a blank Haive repository
 * pushed at a GitHub repository created with a README, which share no commit at all,
 * so every file present on both sides collides.
 *
 * A task rather than something the plan-mirror job could do itself, because the fix
 * agent needs one: `cli_invocations.task_id` is NOT NULL, `CliExecJobPayload.taskId`
 * is required, and `resumeStepIfLinked` returns early without a step row — nothing
 * would ever wake the loop back up.
 *
 * ONE turn is TWO passes, exactly as 01-plan-chat describes: the engine runs form()
 * before the LLM, so a step that parks first cannot answer first.
 *
 *   answer pass  — work is pending, so no form is offered. The agent resolves the
 *                  conflicts, the host verifies, and the step re-enters itself.
 *   collect pass — the resolution is ready to look at, so the form is offered and the
 *                  step parks. Confirm lands and pushes; a message runs another pass.
 *
 * The transcript lives in `task_events`, not in this step's output, because the
 * revise loop resets the step row every cycle and would take the history with it.
 * A table like `plan_node_messages` would be the wrong shape: that exists because a
 * NODE accumulates conversations across many tasks, while a merge conversation
 * belongs to one task and dies with it.
 */

/** How many agent passes one conflict set gets before the user is asked. Mirrors
 *  MAX_MERGE_CONFLICT_RETRIES in merge-resolver.ts, and for the same reason: without
 *  a cap a resolver that cannot resolve spends an invocation per round forever.
 *  MEASURED before it existed — 17 invocations and 12 identical "Still unresolved"
 *  turns on one README. Counted since the last USER message, so guidance refills the
 *  budget exactly as a guided retry does there. */
const MAX_AGENT_PASSES = 4;

interface PlanMergeDetect {
  repositoryId: string | null;
  branch: string;
  worktreePath: string;
  /** The merge worktree relative to the repo root, which is the agent's working directory. */
  worktreeRelPath: string;
  /** Agent passes already spent on this conflict set. */
  attempts: number;
  /** Unmerged paths still awaiting a decision. Empty once the agent has resolved
   *  them, which is what turns the next pass into a collect pass. */
  conflicts: string[];
  /** Further unmerged paths whose names are not UTF-8. Absent in a detect saved before it existed. */
  undecodable?: number;
  unrelated: boolean;
  transcript: { role: string; body: string }[];
  /** The guidance this pass is acting on — the newest user message with nothing
   *  after it. Null once the agent has replied to it. */
  pendingGuidance: string | null;
  /** True while the merge is live in the worktree. */
  mergeOpen: boolean;
  /** The answer a reopen took back, read for the conflicts still open; absent unless this merge is that reopen's. */
  priorResolution?: PriorResolution;
  /** The tree the agent is sent into on an answer pass; absent on a collect pass. */
  fixBaseline?: FixBaseline | FixBaselineUnavailable | null;
  /** Set when that tree came from an earlier pass, whose fixer may have changed it since. */
  fixBaselineReused?: boolean;
  /** The task that recorded it, which may be another conversation that left this merge open. */
  fixBaselineOwner?: string;
}

interface PlanMergeApply {
  resolved: boolean;
  landed: boolean;
  pushed: boolean;
  conflicts: number;
  summary: string;
  continueRequested: boolean;
  pass: 'answer' | 'collect';
}

async function recordMessage(
  db: Database,
  taskId: string,
  taskStepId: string,
  role: 'user' | 'assistant',
  body: string,
): Promise<void> {
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId,
    eventType: PLAN_MERGE_MESSAGE_EVENT,
    payload: { role, body },
  });
}

async function loadConversation(
  db: Database,
  taskId: string,
): Promise<{ transcript: { role: string; body: string }[]; prior: PriorRef | null }> {
  const rows = await db
    .select({ eventType: schema.taskEvents.eventType, payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        inArray(schema.taskEvents.eventType, [PLAN_MERGE_MESSAGE_EVENT, PLAN_MERGE_PRIOR_EVENT]),
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt));
  const transcript: { role: string; body: string }[] = [];
  let prior: PriorRef | null = null;
  for (const r of rows) {
    if (r.eventType === PLAN_MERGE_PRIOR_EVENT) {
      const p = (r.payload ?? {}) as { sha?: unknown; head?: unknown };
      prior =
        typeof p.sha === 'string' && typeof p.head === 'string'
          ? { sha: p.sha, head: p.head }
          : null;
      continue;
    }
    const p = (r.payload ?? {}) as { role?: string; body?: string };
    transcript.push({ role: p.role ?? 'assistant', body: p.body ?? '' });
  }
  return { transcript, prior };
}

async function currentBranch(repoPath: string): Promise<string> {
  const res = await gitRun(repoPath, ['branch', '--show-current']);
  if (res.code !== 0) {
    throw new Error(`git branch failed in ${repoPath}: ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return res.stdout.trim();
}

async function mergeIsOpen(worktreePath: string): Promise<boolean> {
  const res = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (res.code === 0) return true;
  if (res.code === 1) return false;
  throw new Error(
    `git rev-parse MERGE_HEAD failed in ${worktreePath}: ${(res.stderr || res.stdout).trim()}`,
  );
}

const conflictTotal = (d: Pick<PlanMergeDetect, 'conflicts' | 'undecodable'>): number =>
  d.conflicts.length + (d.undecodable ?? 0);

/** Whether THIS pass runs the agent. The single source both `llm.skipIf` and `form`
 *  read, so they cannot disagree about which of the two passes this is. */
function needsAgentPass(d: PlanMergeDetect): boolean {
  return conflictTotal(d) > 0 && d.attempts < MAX_AGENT_PASSES;
}

/** The names a message can show: those that fit a line, then how many more there are. */
function conflictList(found: Pick<ConflictedPaths, 'paths' | 'undecodable'>): string {
  const more = found.undecodable > 0 ? [`${found.undecodable} more whose names are not UTF-8`] : [];
  return [...found.paths, ...more].join(', ');
}

const otherTasksWorking = (n: number): string =>
  `${n} other task${n === 1 ? ' is' : 's are'} working in this checkout; confirm again once ${n === 1 ? 'it finishes' : 'they finish'}`;

/** A name that would open a line of its own stays off the prompt: the agent would read it as text. */
function fitsPromptLine(path: string): boolean {
  return isSingleLine(path) && survivesFence(path);
}

/** The resolution prompt. The agent's working directory is the merge worktree itself. */
function buildPrompt(d: PlanMergeDetect): string {
  const listed = d.conflicts.filter(fitsPromptLine);
  const unlisted = conflictTotal(d) - listed.length;
  return [
    'A git merge conflict is live in this repository and you are resolving it.',
    '',
    'Your working directory IS the merge. Every path below is relative to it and can be',
    'opened and edited directly.',
    '',
    ...REPO_IS_DATA_MERGE_LINES,
    '',
    ...(d.pendingGuidance ? ['', `What the user asked for: ${d.pendingGuidance}`, ''] : []),
    d.unrelated
      ? 'These two histories are UNRELATED — this repository was created separately from ' +
        'the remote, so every file that exists on both sides collides even though nobody ' +
        'edited them against each other. Prefer the side that is genuinely the project and ' +
        'fold in anything worth keeping from the other; a placeholder generated by a tool ' +
        'should give way to real content.'
      : 'These two histories diverged from a common ancestor, so each conflict is a real ' +
        "two-sided edit. Combine them; don't drop either side's work.",
    '',
    `Conflicting files (${conflictTotal(d)}):`,
    ...listed.map((p) => `- ${p}`),
    ...(unlisted > 0
      ? [
          `- and ${unlisted} more whose names cannot be shown on a line; find them by their conflict markers.`,
        ]
      : []),
    '',
    ...(d.priorResolution ? [...priorResolutionLines(d.transcript, d.priorResolution), ''] : []),
    'Resolve EVERY conflict by EDITING those files: remove the <<<<<<< / ======= / >>>>>>>',
    'markers and leave the content you want to keep. Change no other file: only the conflicted',
    'files are committed.',
    HAIVE_OWN_FILES_LINE,
    'Do NOT run git — it is unavailable here; the orchestrator stages and commits the merge',
    'after you finish. Do NOT run tests or any other commands.',
    '',
    'When every conflict marker is gone, write ONE short paragraph saying what you did to',
    'each file, so a person can confirm it without reading the diff.',
  ].join('\n');
}

export const planMergeStep: StepDefinition<PlanMergeDetect, PlanMergeApply> = {
  metadata: {
    id: '01-plan-merge',
    workflowType: 'plan_merge',
    index: 0,
    title: 'Resolve plan merge',
    description:
      'Merges the remote into this checkout and resolves the conflicting files, as a conversation you confirm.',
    requiresCli: true,
  },

  async shouldRun(): Promise<boolean> {
    return (await configService.getBoolean(CONFIG_KEYS.PLAN_CANVAS_ENABLED, true)) !== false;
  },

  async detect(ctx): Promise<PlanMergeDetect> {
    const [task] = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    const repositoryId = task?.repositoryId ?? null;
    const branch = await currentBranch(ctx.repoPath);
    const worktreePath = planMergeWorktreePath(ctx.repoPath);
    const worktreeRelPath = `${WORKTREE_SUBDIR}/${PLAN_MERGE_DIR_NAME}`;
    const { transcript, prior: recordedPrior } = await loadConversation(ctx.db, ctx.taskId);
    const last = transcript.at(-1);
    // Passes since the last thing the USER said. A new instruction is a new problem.
    const sinceUser = [...transcript].reverse().findIndex((m) => m.role === 'user');
    const attempts = (
      sinceUser === -1 ? transcript : transcript.slice(transcript.length - sinceUser)
    ).filter((m) => m.role === 'assistant').length;

    const empty: PlanMergeDetect = {
      repositoryId,
      branch,
      worktreePath,
      worktreeRelPath,
      attempts,
      conflicts: [],
      unrelated: false,
      transcript,
      pendingGuidance: null,
      mergeOpen: false,
    };
    if (!repositoryId || !branch) return empty;

    // The merge is (re)established here rather than in apply, so a step reset — which
    // the revise loop does on every cycle — cannot leave the conversation talking
    // about a worktree that no longer has a merge in it.
    const identity = await resolveGitEnv(ctx.db, { userId: ctx.userId, repositoryId });
    const repo = await ctx.db.query.repositories.findFirst({
      where: eq(schema.repositories.id, repositoryId),
      columns: { credentialsSecretId: true, remoteUrl: true },
    });
    await ensurePlanMergeWorktree(ctx.repoPath);
    let open = await mergeIsOpen(worktreePath);
    let opened = false;
    let unrelated = false;
    let priorRef = recordedPrior;
    if (!open) {
      await fetchOrigin({
        repoPath: ctx.repoPath,
        branch,
        db: ctx.db,
        userId: ctx.userId,
        remoteUrl: repo?.remoteUrl,
        ...(repo?.credentialsSecretId ? { credentialId: repo.credentialsSecretId } : {}),
      });
      const gap = await divergence(ctx.repoPath, branch);
      unrelated = gap.unrelated;
      if (gap.behind > 0) {
        const unlanded =
          last?.role === 'user'
            ? await unlandedResolvedMerge({ repoPath: ctx.repoPath, worktreePath, branch })
            : null;
        // Before the reset takes the answer back, and not twice for one that a crash left half taken.
        if (unlanded && unlanded.sha !== priorRef?.sha) {
          await ctx.db.insert(schema.taskEvents).values({
            taskId: ctx.taskId,
            taskStepId: ctx.taskStepId,
            eventType: PLAN_MERGE_PRIOR_EVENT,
            payload: unlanded,
          });
          priorRef = unlanded;
        }
        const reopened = unlanded
          ? await reopenResolvedMerge({
              worktreePath,
              branch,
              unrelated: gap.unrelated,
              gitEnv: identity,
              prior: unlanded.sha,
            })
          : null;
        const attempt =
          reopened ?? (await mergeOriginInto(worktreePath, branch, gap.unrelated, identity));
        open = !attempt.clean;
        opened = open;
      }
    } else {
      unrelated = (await divergence(ctx.repoPath, branch)).unrelated;
    }

    const unmerged = await conflictedPaths(worktreePath);
    const found: PlanMergeDetect = {
      repositoryId,
      branch,
      worktreePath,
      worktreeRelPath,
      attempts,
      conflicts: unmerged.paths,
      ...(unmerged.undecodable > 0 ? { undecodable: unmerged.undecodable } : {}),
      unrelated,
      transcript,
      pendingGuidance: last?.role === 'user' ? last.body : null,
      mergeOpen: open,
    };
    if (!open || conflictTotal(found) === 0) return found;
    const {
      baseline: fixBaseline,
      reused,
      ownerTaskId,
    } = await planMergeFixBaseline(
      ctx.db,
      { repositoryId, taskId: ctx.taskId, taskStepId: ctx.taskStepId, worktreePath },
      opened,
    );
    if (!needsAgentPass(found)) return found;
    const priorResolution = priorRef
      ? await readPriorResolution(worktreePath, priorRef, found.conflicts)
      : null;
    return {
      ...found,
      ...(priorResolution ? { priorResolution } : {}),
      fixBaseline,
      ...(reused ? { fixBaselineReused: true } : {}),
      ...(ownerTaskId ? { fixBaselineOwner: ownerTaskId } : {}),
    };
  },

  llm: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 20 * 60 * 1000,
    worktreeRel: ({ detected }) => (detected as PlanMergeDetect).worktreeRelPath,
    // Nothing unresolved means nothing to ask an agent: the pass that follows a
    // confirm, or one re-entered with the conflicts already gone, finalizes without
    // spending an invocation. Mirrors 01-plan-chat's skipIf/form complement.
    // Nothing unresolved, or the budget for this conflict set is spent — either way
    // there is nothing to ask an agent, and form() offers the complementary form.
    skipIf: ({ detected }) => !needsAgentPass(detected as PlanMergeDetect),
    // Each fixer starts from the tree the merge left, whatever an earlier one that failed, was
    // stopped or was re-dispatched left behind.
    prepareWorkspace: async ({ ctx, detected }) => {
      const d = detected as PlanMergeDetect;
      if (!d.fixBaseline) return;
      // One git could not record has nothing to report before a first fixer, but one an earlier pass
      // recorded may already hold what its fixer changed.
      if ('unavailable' in d.fixBaseline && !d.fixBaselineReused) return;
      await moveAsideFixerLeftovers(
        ctx.db,
        d.worktreePath,
        {
          baseline: d.fixBaseline,
          taskId: ctx.taskId,
          taskStepId: ctx.taskStepId,
          ...(d.fixBaselineOwner ? { ownerTaskId: d.fixBaselineOwner } : {}),
        },
        `origin/${d.branch}`,
      );
    },
    buildPrompt: ({ detected }) => buildPrompt(detected as PlanMergeDetect),
    bypassStub: () => 'test bypass — no change',
  },

  form(_ctx, detected): FormSchema | null {
    if (!detected.repositoryId) return null;
    // Conflicts outstanding are resolved in THIS pass, so offering a form here would
    // park before the agent had done anything and show an empty resolution.
    // Exactly the complement of llm.skipIf, which is the invariant that keeps a turn
    // to two passes: a pass that will run the agent must not also park.
    if (needsAgentPass(detected)) return null;
    const stuck = conflictTotal(detected) > 0;
    return {
      title: stuck ? 'The agent could not finish this merge' : 'Merge the remote into this plan',
      description: stuck
        ? `Still conflicted after ${detected.attempts} attempt(s): ${conflictList({ paths: detected.conflicts, undecodable: detected.undecodable ?? 0 })}. ` +
          'Say what to do differently and it will try again, or discard the merge — your ' +
          'checkout has not moved either way. Confirming now would commit the conflict ' +
          'markers, so it is not offered.'
        : 'The conflicts are resolved in a scratch worktree — your checkout has not moved. ' +
          'Confirm to bring the result in and push it, or say what to change and the agent ' +
          'goes again.',
      fields: [
        {
          type: 'select',
          id: 'decision',
          label: 'What next',
          required: true,
          default: stuck ? 'revise' : 'confirm',
          // Confirm is withheld while anything is still unmerged: landing then would
          // commit conflict markers into the branch.
          options: stuck
            ? [
                {
                  value: 'revise',
                  label: 'Try again with these instructions',
                  description: 'Describe what to do differently; the agent resolves again.',
                },
              ]
            : [
                {
                  value: 'confirm',
                  label: 'Confirm — merge it in and push',
                  description: 'Fast-forwards your branch onto the resolved merge, then pushes.',
                },
                {
                  value: 'revise',
                  label: 'Change something first',
                  description: 'Describe what to do differently; the agent resolves again.',
                },
              ],
        },
        {
          type: 'textarea',
          id: 'message',
          label: 'What to change',
          description: 'Only read when you chose to change something.',
          required: false,
        },
      ],
    };
  },

  reviseLoop: {
    // Self-target, exactly as the plan chat does: the conversation stays on ONE card
    // rather than accumulating a step per turn. Human-gated — an answer pass always
    // hands over to a collect pass, which parks — so it can only advance when a
    // person submits, and it ends when they confirm.
    evaluate: (out) => (out.continueRequested ? { targetStepId: '01-plan-merge' } : null),
  },

  async apply(ctx, args): Promise<PlanMergeApply> {
    const d = args.detected;
    const result: PlanMergeApply = {
      resolved: false,
      landed: false,
      pushed: false,
      conflicts: conflictTotal(d),
      summary: '',
      continueRequested: false,
      pass: conflictTotal(d) > 0 ? 'answer' : 'collect',
    };
    if (!d.repositoryId) {
      result.summary = 'This task has no repository, so there is nothing to merge.';
      return result;
    }

    // --- Answer pass: the agent has just edited the conflicted files. ---
    if (conflictTotal(d) > 0) {
      const identity = await resolveGitEnv(ctx.db, {
        userId: ctx.userId,
        repositoryId: d.repositoryId,
      });
      const said = typeof args.llmOutput === 'string' ? args.llmOutput.trim() : '';
      const leftovers = await relocateFixerChanges(
        d.worktreePath,
        d.fixBaseline,
        {
          taskId: ctx.taskId,
          runId: args.llmInvocationId ?? randomUUID(),
          ...(d.fixBaselineOwner ? { ownerTaskId: d.fixBaselineOwner } : {}),
        },
        () => taskSecretMaskPolicy(ctx.db, ctx.taskId),
      );
      if (leftovers) {
        await recordFixerLeftovers(
          ctx.db,
          ctx.taskId,
          ctx.taskStepId,
          `origin/${d.branch}`,
          leftovers,
        );
      }
      if (leftovers?.indexHeld) throw new Error(fixerIndexHeldNote(leftovers.indexHeld));
      const committed = await completeMergeHostSide(d.worktreePath, identity, `origin/${d.branch}`);
      const left = await conflictedPaths(d.worktreePath);
      result.resolved = committed && conflictCount(left) === 0;
      result.summary = [
        result.resolved
          ? said || `Resolved ${conflictTotal(d)} file(s).`
          : `Still unresolved: ${conflictList(left) || 'the merge did not commit'}.`,
        leftovers ? fixerLeftoversWarning(ctx.taskId, leftovers) : '',
      ]
        .filter(Boolean)
        .join(' ');
      await recordMessage(ctx.db, ctx.taskId, ctx.taskStepId, 'assistant', result.summary);
      // Re-enter either way — but `needsAgentPass` decides what the next pass IS.
      // Resolved, it becomes a collect pass and parks for confirmation; unresolved,
      // it runs the agent again until the budget is spent and then parks with the
      // failure. Without that budget this line span forever, one invocation a round.
      result.continueRequested = true;
      return result;
    }

    // --- Collect pass: the user is looking at the resolution. ---
    const values = (args.formValues ?? {}) as { decision?: unknown; message?: unknown };
    const decision = typeof values.decision === 'string' ? values.decision : 'confirm';
    const message = String(values.message ?? '').trim();

    if (decision === 'revise') {
      await recordMessage(
        ctx.db,
        ctx.taskId,
        ctx.taskStepId,
        'user',
        message || 'Please try that again.',
      );
      result.summary = 'Asked for another pass.';
      result.continueRequested = true;
      return result;
    }

    // Confirm on a still-conflicted merge would commit the markers. The form does not
    // offer it, but a stale tab or a direct submit reaches here regardless.
    const left = await conflictedPaths(d.worktreePath);
    if (conflictCount(left) > 0) {
      await recordMessage(
        ctx.db,
        ctx.taskId,
        ctx.taskStepId,
        'assistant',
        `Cannot merge that in — still unresolved: ${conflictList(left)}.`,
      );
      result.summary = 'Refused: the merge still has unresolved conflicts.';
      result.continueRequested = true;
      return result;
    }
    const identity = await resolveGitEnv(ctx.db, {
      userId: ctx.userId,
      repositoryId: d.repositoryId,
    });
    const sha = await commitMerge(d.worktreePath, `Merge origin/${d.branch}`, identity);
    await seedPlanBaseFromCheckout(ctx.db, d.repositoryId, ctx.repoPath);

    const repositoryId = d.repositoryId;
    // Another task working in the checkout itself (no worktree of its own) has it moved under it.
    const fence = (conn: Parameters<typeof checkoutHoldingTasks>[0]) =>
      checkoutHoldingTasks(conn, repositoryId, { excludeTaskId: ctx.taskId, rootOnly: true });
    const kept: KeptFiles = new Map();
    const before = await headCommit(ctx.repoPath);
    let refusal: string | null = null;
    let movedFrom: string | null = null;
    try {
      for (let attempt = 1; ; attempt++) {
        const aside = await setAsideHaiveProjections(ctx.db, repositoryId, ctx.repoPath, fence);
        if (aside.outcome === 'held') {
          refusal = otherTasksWorking(aside.holding);
          break;
        }
        if (aside.outcome === 'refused') {
          refusal = aside.reason;
          break;
        }
        if (aside.outcome === 'set-aside') {
          for (const [file, was] of aside.kept) if (!kept.has(file)) kept.set(file, was);
        }
        // A file found rewritten ends the transaction unmoved and goes back to the set-aside.
        const moved = await ctx.db.transaction(async (tx) => {
          await lockPlanMerge(tx, repositoryId);
          // Every task's start and every revival take this lock, so none lands between the fence and the move.
          await lockRepositoryTasksKey(tx, repositoryId);
          const found = await restoreProjectionsInTx(tx, repositoryId, ctx.repoPath);
          if (found.outcome !== 'clean') return { found, holding: 0, from: null };
          const holding = await fence(tx);
          const from = holding === 0 ? await landPlanMerge(ctx.repoPath, sha) : null;
          return { found, holding, from };
        });
        if (moved.from !== null) movedFrom = moved.from;
        if (moved.holding > 0) {
          refusal = otherTasksWorking(moved.holding);
          break;
        }
        if (moved.found.outcome === 'clean') break;
        if (moved.found.outcome === 'refused') {
          refusal = moved.found.reason;
          break;
        }
        if (attempt === MOVE_ATTEMPTS) {
          refusal = "Haive's project files kept changing under the move";
          break;
        }
      }
      if (refusal === null) {
        result.landed = true;
        if (movedFrom !== null) await handBackAfterMove(ctx.repoPath, movedFrom);

        // The merge brought in the other side's plan.json; fold it into the database and
        // rewrite both files from there, so what is pushed is the union rather than
        // whichever side the text merge happened to keep.
        await reconcilePlanFromCheckout(ctx.db, d.repositoryId, ctx.repoPath);
        await flushPlanMirrorForRepository(ctx.db, d.repositoryId);
        await commitPlanSnapshotFiles({
          repoPath: ctx.repoPath,
          message: 'docs: save project plan',
          identity,
        });
        await resyncHaiveProjections(ctx.db, repositoryId, ctx.repoPath);
        await restoreKeptMetadata(ctx.repoPath, kept);
      }
    } catch (err) {
      return recoverAfterMoveFailure(ctx.db, repositoryId, ctx.repoPath, kept, before, err);
    }
    if (refusal !== null) {
      await putBackProjections(ctx.db, repositoryId, ctx.repoPath, kept);
      await recordMessage(
        ctx.db,
        ctx.taskId,
        ctx.taskStepId,
        'assistant',
        `Cannot merge that in — ${refusal}. Your checkout has not moved.`,
      );
      result.summary = `Refused: ${refusal}.`;
      result.continueRequested = true;
      return result;
    }

    const repo = await ctx.db.query.repositories.findFirst({
      where: eq(schema.repositories.id, d.repositoryId),
      columns: { credentialsSecretId: true, remoteUrl: true },
    });
    const upstream = await gitRun(ctx.repoPath, ['rev-parse', '--abbrev-ref', '@{upstream}']);
    const head = await gitRun(ctx.repoPath, [
      'rev-parse',
      '--verify',
      `refs/heads/${d.branch}^{commit}`,
    ]);
    const pushedHead = head.code === 0 ? head.stdout.trim() : null;
    if (!pushedHead) {
      throw new Error('could not read branch tip; the merge is saved locally, retry the push');
    }
    await pushBranch({
      sha: pushedHead,
      cwd: ctx.repoPath,
      branch: d.branch,
      setUpstream: upstream.code !== 0 && !gitGaveNoAnswer(upstream),
      remoteUrl: repo?.remoteUrl,
      ...(repo?.credentialsSecretId ? { credentialId: repo.credentialsSecretId } : {}),
      db: ctx.db,
      userId: ctx.userId,
    });
    result.pushed = true;
    await advancePlanBaseFromCommit(ctx.db, d.repositoryId, ctx.repoPath, pushedHead, d.branch);

    // Only now is the scratch worktree disposable. Removed on the success path only —
    // an abandoned conversation keeps it, which is what makes it resumable.
    await removePlanMergeWorktree(ctx.repoPath);
    await writePlanMirror(ctx.db, d.repositoryId, ctx.repoPath).catch((err: unknown) => {
      ctx.logger.warn({ err }, 'plan mirror write failed (non-fatal)');
    });

    result.summary = `Merged origin/${d.branch} and pushed.`;
    await recordMessage(ctx.db, ctx.taskId, ctx.taskStepId, 'assistant', result.summary);
    return result;
  },
};

/** Discard a cancelled conversation's scratch worktree unless another conversation of the repository
 *  may hold it: a live one, or a failed one opened after this one, whose Retry resumes it. Never
 *  throws: a cancel must finish. */
export async function discardPlanMerge(db: Database, taskId: string): Promise<void> {
  const note = (eventType: string, payload: Record<string, unknown>) =>
    db
      .insert(schema.taskEvents)
      .values({ taskId, taskStepId: null, eventType, payload })
      .catch(() => undefined);
  try {
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { type: true, repositoryId: true, createdAt: true },
    });
    if (task?.type !== 'plan_merge' || !task.repositoryId) return;
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, task.repositoryId),
      columns: { storagePath: true, localPath: true },
    });
    const repoPath = repo?.storagePath ?? repo?.localPath;
    if (!repoPath) return;
    const repositoryId = task.repositoryId;
    await db.transaction(async (tx) => {
      await lockPlanMerge(tx, repositoryId);
      const [other] = await tx.query.tasks.findMany({
        where: and(
          eq(schema.tasks.repositoryId, repositoryId),
          eq(schema.tasks.type, 'plan_merge'),
          ne(schema.tasks.id, taskId),
          or(
            inArray(schema.tasks.status, [...PLAN_MERGE_LIVE_STATUSES]),
            and(eq(schema.tasks.status, 'failed'), gt(schema.tasks.createdAt, task.createdAt)),
          ),
        ),
        columns: { id: true },
        limit: 1,
      });
      if (other) {
        await note('plan_merge.discard_skipped', { otherTaskId: other.id });
        return;
      }
      const worktreePath = planMergeWorktreePath(repoPath);
      await moveAsideRecordedLeftovers(
        db,
        repositoryId,
        worktreePath,
        `origin/${await currentBranch(repoPath)}`,
      );
      const aborted = await abortGitMerge(worktreePath).catch((err: unknown) => ({
        ok: false as const,
        detail: err instanceof Error ? err.message : String(err),
      }));
      await removePlanMergeWorktree(repoPath);
      // A forced removal takes an open merge with it, so the worktree being gone is what counts.
      const listed = await gitRun(repoPath, ['worktree', 'list', '--porcelain', '-z']);
      if (listed.code !== 0) {
        throw new Error(
          `the scratch worktree could not be confirmed gone: ${listed.stderr || listed.stdout}`,
        );
      }
      if (listed.stdout.split('\0').includes(`worktree ${worktreePath}`)) {
        throw new Error(
          `the scratch worktree is still there${aborted.ok ? '' : `; the merge abort also failed: ${aborted.detail}`}`,
        );
      }
    });
  } catch (err) {
    logger.warn({ err, taskId }, 'discarding the cancelled plan merge failed');
    await note('plan_merge.discard_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
