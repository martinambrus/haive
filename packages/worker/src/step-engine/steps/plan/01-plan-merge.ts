import { and, asc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  CONFIG_KEYS,
  PLAN_MERGE_MESSAGE_EVENT,
  configService,
  type FormSchema,
} from '@haive/shared';
import type { Database } from '@haive/database';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { completeMergeHostSide } from '../../git-merge.js';
import { resolveGitEnv } from '../../../secrets/user-git-identity.js';
import {
  commitMerge,
  conflictedPaths,
  divergence,
  ensurePlanMergeWorktree,
  fetchOrigin,
  landPlanMerge,
  mergeOriginInto,
  planMergeWorktreePath,
  removePlanMergeWorktree,
} from '../../../plan/merge.js';
import {
  flushPlanMirrorForRepository,
  reconcilePlanMirror,
  writePlanMirror,
} from '../../../plan/mirror.js';
import { commitPlanSnapshotFiles } from '../../../plan/snapshot-git.js';
import { pushBranch, gitRun } from '../../../repo/git-push.js';
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
  /** The merge worktree relative to the repo root — which is where the sandbox
   *  actually runs, because a plan task has no worktree-setup step. */
  worktreeRelPath: string;
  /** Agent passes already spent on this conflict set. */
  attempts: number;
  /** Unmerged paths still awaiting a decision. Empty once the agent has resolved
   *  them, which is what turns the next pass into a collect pass. */
  conflicts: string[];
  unrelated: boolean;
  transcript: { role: string; body: string }[];
  /** The guidance this pass is acting on — the newest user message with nothing
   *  after it. Null once the agent has replied to it. */
  pendingGuidance: string | null;
  /** True while the merge is live in the worktree. */
  mergeOpen: boolean;
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
  cliProviderId?: string | null,
): Promise<void> {
  await db.insert(schema.taskEvents).values({
    taskId,
    taskStepId,
    eventType: PLAN_MERGE_MESSAGE_EVENT,
    payload: { role, body, ...(cliProviderId ? { cliProviderId } : {}) },
  });
}

async function loadTranscript(
  db: Database,
  taskId: string,
): Promise<{ role: string; body: string }[]> {
  const rows = await db
    .select({ payload: schema.taskEvents.payload })
    .from(schema.taskEvents)
    .where(
      and(
        eq(schema.taskEvents.taskId, taskId),
        eq(schema.taskEvents.eventType, PLAN_MERGE_MESSAGE_EVENT),
      ),
    )
    .orderBy(asc(schema.taskEvents.createdAt));
  return rows.map((r) => {
    const p = (r.payload ?? {}) as { role?: string; body?: string };
    return { role: p.role ?? 'assistant', body: p.body ?? '' };
  });
}

async function currentBranch(repoPath: string): Promise<string> {
  const res = await gitRun(repoPath, ['branch', '--show-current']);
  return res.code === 0 ? res.stdout.trim() : '';
}

async function mergeIsOpen(worktreePath: string): Promise<boolean> {
  const res = await gitRun(worktreePath, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  return res.code === 0;
}

/**
 * The resolution prompt.
 *
 * Deliberately NOT `buildMergeFixPrompt`: that one opens with "Your working directory
 * is the integration worktree, MID-MERGE", which is true for the step-machine merge
 * (the sandbox IS the worktree) and false here. A plan task has no worktree-setup
 * step, so the sandbox runs at the REPO ROOT and the merge is one directory down.
 * MEASURED: pointed at the wrong directory the agent found nothing to edit and
 * reported success 12 times in a row while `git status` still said `AA README.md`.
 */
/** Whether THIS pass runs the agent. The single source both `llm.skipIf` and `form`
 *  read, so they cannot disagree about which of the two passes this is. */
function needsAgentPass(d: PlanMergeDetect): boolean {
  return d.conflicts.length > 0 && d.attempts < MAX_AGENT_PASSES;
}

function buildPrompt(d: PlanMergeDetect): string {
  return [
    'A git merge conflict is live in this repository and you are resolving it.',
    '',
    `The merge is in the worktree \`${d.worktreeRelPath}\`, RELATIVE TO YOUR WORKING`,
    'DIRECTORY — not in the directory you start in. Every path below is relative to',
    'your working directory and can be opened and edited directly.',
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
    `Conflicting files (${d.conflicts.length}):`,
    ...d.conflicts.map((p) => `- ${d.worktreeRelPath}/${p}`),
    '',
    'Resolve EVERY conflict by EDITING those files: remove the <<<<<<< / ======= / >>>>>>>',
    'markers and leave the content you want to keep.',
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
    const transcript = await loadTranscript(ctx.db, ctx.taskId);
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
      columns: { credentialsSecretId: true },
    });
    await ensurePlanMergeWorktree(ctx.repoPath);
    let open = await mergeIsOpen(worktreePath);
    let unrelated = false;
    if (!open) {
      await fetchOrigin({
        repoPath: ctx.repoPath,
        branch,
        db: ctx.db,
        userId: ctx.userId,
        ...(repo?.credentialsSecretId ? { credentialId: repo.credentialsSecretId } : {}),
      });
      const gap = await divergence(ctx.repoPath, branch);
      unrelated = gap.unrelated;
      if (gap.behind > 0) {
        const attempt = await mergeOriginInto(worktreePath, branch, gap.unrelated, identity);
        open = !attempt.clean;
      }
    } else {
      unrelated = (await divergence(ctx.repoPath, branch)).unrelated;
    }

    return {
      repositoryId,
      branch,
      worktreePath,
      worktreeRelPath,
      attempts,
      conflicts: await conflictedPaths(worktreePath),
      unrelated,
      transcript,
      pendingGuidance: last?.role === 'user' ? last.body : null,
      mergeOpen: open,
    };
  },

  llm: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 20 * 60 * 1000,
    // Nothing unresolved means nothing to ask an agent: the pass that follows a
    // confirm, or one re-entered with the conflicts already gone, finalizes without
    // spending an invocation. Mirrors 01-plan-chat's skipIf/form complement.
    // Nothing unresolved, or the budget for this conflict set is spent — either way
    // there is nothing to ask an agent, and form() offers the complementary form.
    skipIf: ({ detected }) => !needsAgentPass(detected as PlanMergeDetect),
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
    const stuck = detected.conflicts.length > 0;
    return {
      title: stuck ? 'The agent could not finish this merge' : 'Merge the remote into this plan',
      description: stuck
        ? `Still conflicted after ${detected.attempts} attempt(s): ${detected.conflicts.join(', ')}. ` +
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
      conflicts: d.conflicts.length,
      summary: '',
      continueRequested: false,
      pass: d.conflicts.length > 0 ? 'answer' : 'collect',
    };
    if (!d.repositoryId) {
      result.summary = 'This task has no repository, so there is nothing to merge.';
      return result;
    }

    // --- Answer pass: the agent has just edited the conflicted files. ---
    if (d.conflicts.length > 0) {
      const identity = await resolveGitEnv(ctx.db, {
        userId: ctx.userId,
        repositoryId: d.repositoryId,
      });
      const said = typeof args.llmOutput === 'string' ? args.llmOutput.trim() : '';
      const committed = await completeMergeHostSide(d.worktreePath, identity);
      const left = await conflictedPaths(d.worktreePath);
      result.resolved = committed && left.length === 0;
      result.summary = result.resolved
        ? said || `Resolved ${d.conflicts.length} file(s).`
        : `Still unresolved: ${left.join(', ') || 'the merge did not commit'}.`;
      await recordMessage(
        ctx.db,
        ctx.taskId,
        ctx.taskStepId,
        'assistant',
        result.summary,
        ctx.cliProviderId,
      );
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
    if (left.length > 0) {
      await recordMessage(
        ctx.db,
        ctx.taskId,
        ctx.taskStepId,
        'assistant',
        `Cannot merge that in — still unresolved: ${left.join(', ')}.`,
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
    if (!sha) throw new Error('the merge produced no commit to fast-forward onto');
    await landPlanMerge(ctx.repoPath, sha);
    result.landed = true;

    // The merge brought in the other side's plan.json; fold it into the database and
    // rewrite both files from there, so what is pushed is the union rather than
    // whichever side the text merge happened to keep.
    await reconcilePlanMirror(ctx.db, d.repositoryId, ctx.repoPath);
    await flushPlanMirrorForRepository(ctx.db, d.repositoryId);
    await commitPlanSnapshotFiles({
      repoPath: ctx.repoPath,
      message: 'docs: save project plan',
      identity,
    });

    const repo = await ctx.db.query.repositories.findFirst({
      where: eq(schema.repositories.id, d.repositoryId),
      columns: { credentialsSecretId: true },
    });
    const upstream = await gitRun(ctx.repoPath, ['rev-parse', '--abbrev-ref', '@{upstream}']);
    await pushBranch({
      cwd: ctx.repoPath,
      branch: d.branch,
      setUpstream: upstream.code !== 0,
      ...(repo?.credentialsSecretId ? { credentialId: repo.credentialsSecretId } : {}),
      db: ctx.db,
      userId: ctx.userId,
    });
    result.pushed = true;

    // Only now is the scratch worktree disposable. Removed on the success path only —
    // an abandoned conversation keeps it, which is what makes it resumable.
    await removePlanMergeWorktree(ctx.repoPath);
    await writePlanMirror(ctx.db, d.repositoryId, ctx.repoPath).catch(() => undefined);

    result.summary = `Merged origin/${d.branch} and pushed.`;
    await recordMessage(ctx.db, ctx.taskId, ctx.taskStepId, 'assistant', result.summary);
    return result;
  },
};

/** The scratch worktree a cancelled conversation leaves behind. */
export async function discardPlanMerge(ctx: Pick<StepContext, 'repoPath'>): Promise<void> {
  await removePlanMergeWorktree(ctx.repoPath);
}
