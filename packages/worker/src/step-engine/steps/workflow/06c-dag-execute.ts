import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { DagCoderContext, StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import {
  commentPolicyLines,
  ddevConfigGuidanceLines,
  retrievalGuidanceLines,
} from '../_retrieval-guidance.js';

// Phase 3 — DAG execution. Runs only when 2c sprint planning chose 'dag'. The
// heavy lifting (per-level worktrees, parallel coders, barrier, merge,
// checkpoint) lives in the runner's resolveDagPhase (see dag-executor.ts), which
// the dagExecute hook activates; this step just supplies the coder prompt and
// reports completion. apply is reached only once every level has checkpointed.

interface DagExecuteDetect {
  mode: string;
  issueCount: number;
  levelCount: number;
}

interface DagExecuteApply {
  ran: boolean;
  issues: number;
  levels: number;
  /** Issues whose code was never merged: the replanner skipped them, or they ended
   *  unrecoverable. Optional — apply outputs are persisted, so a task that finished before
   *  this existed must still render. */
  dropped?: { issueKey: string; resolution: string; reason: string | null }[];
  /** Set whenever `dropped` is non-empty. Lifted verbatim by computeDegradedNote, which
   *  honours an explicit note BEFORE its llm/agentMining guard — so a dagExecute step can
   *  set one with no change to the runner. */
  degradedNote?: string;
}

function buildCoderPrompt(issue: DagCoderContext, upstreamDebt: string): string {
  return [
    `You are implementing ${issue.issueKey}: ${issue.title}`,
    '',
    'Your working directory is already set to your isolated git worktree:',
    `  ${issue.sandboxWorktreePath}`,
    'Implement ONLY this issue (a vertical slice: implementation + its tests together).',
    'Match the existing code style and conventions. Do not invent requirements.',
    ...commentPolicyLines(),
    '',
    'Before implementing, search for the existing patterns this issue touches, in this order:',
    ...retrievalGuidanceLines(),
    'Follow the patterns you find; avoid documented anti-patterns. Your issue names the spec',
    'sections it implements, but the standards it must meet are usually written down elsewhere —',
    'look them up rather than assuming the spec repeated them.',
    '',
    issue.description ? `Description: ${issue.description}` : '',
    issue.provides ? `Deliverable: ${issue.provides}` : '',
    issue.specSections.length > 0
      ? `Spec sections to implement:\n- ${issue.specSections.join('\n- ')}`
      : '',
    issue.spec ? `\n=== Spec (the sections above live in this document) ===\n${issue.spec}` : '',
    // Names the file indirectly: the pointer sentence inside a condensed view already
    // carries the path, and repeating that construction here would be two copies to sync.
    issue.specCondensed && issue.specSections.length > 0
      ? 'Your sections are listed above. Read them IN FULL from the spec file named above before implementing — the embedded text is only the section index.'
      : '',
    issue.acceptanceCriteria.length > 0
      ? `Acceptance criteria (for this issue only):\n- ${issue.acceptanceCriteria.join('\n- ')}`
      : '',
    issue.planImpact ? `\n${issue.planImpact}` : '',
    upstreamDebt ? `\n${upstreamDebt}` : '',
    ...ddevConfigGuidanceLines(
      [issue.title, issue.description, issue.provides, ...issue.specSections].join(' '),
    ),
    '',
    'Do NOT run git — it is unavailable in this environment; the orchestrator commits your work after you finish.',
    'When finished, emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    `{ "issue_id": "${issue.issueKey}", "outcome": "completed|completed_with_debt|failed_unrecoverable", "files_modified": ["path/one"], "debt_items": [], "concerns": "<notes or empty>" }`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Named individually in the note; the rest are counted. Same shape as the fan-out loss
 *  note — this is banner copy, not a log. */
const DROPPED_ISSUES_NAMED = 8;
const DROPPED_REASON_CHARS = 160;

/** Resolutions that mean "this issue's code is not in the branch". `skipped` is the
 *  replanner's CONTINUE/REDUCE_SCOPE/MODIFY_DAG path; `failed_unrecoverable` is an issue
 *  that reached the end still failed. Both are excluded from acceptedForMerge. */
const DROPPED_RESOLUTIONS = ['skipped', 'failed_unrecoverable'];

async function loadDroppedIssues(
  ctx: StepContext,
): Promise<{ issueKey: string; resolution: string; reason: string | null }[]> {
  const plan = await ctx.db.query.taskDagPlans.findFirst({
    where: eq(schema.taskDagPlans.taskId, ctx.taskId),
    columns: { id: true },
  });
  if (!plan) return [];
  const issues = await ctx.db
    .select({
      issueKey: schema.taskDagIssues.issueKey,
      resolution: schema.taskDagIssues.resolution,
      errorMessage: schema.taskDagIssues.errorMessage,
      concerns: schema.taskDagIssues.concerns,
    })
    .from(schema.taskDagIssues)
    .where(eq(schema.taskDagIssues.dagPlanId, plan.id));
  return issues
    .filter((i) => i.resolution !== null && DROPPED_RESOLUTIONS.includes(i.resolution))
    .map((i) => ({
      issueKey: i.issueKey,
      resolution: i.resolution!,
      // errorMessage first: `concerns` is what the coder chose to say, which on a failure is
      // often advice rather than the cause.
      reason:
        (i.errorMessage ?? i.concerns)
          ?.trim()
          .replace(/\s+/g, ' ')
          .slice(0, DROPPED_REASON_CHARS) ?? null,
    }));
}

export const dagExecuteStep: StepDefinition<DagExecuteDetect, DagExecuteApply> = {
  metadata: {
    id: '06c-dag-execute',
    workflowType: 'workflow',
    index: 6.5,
    title: 'Phase 3: DAG implementation',
    description:
      'Implements the spec in parallel — one agent per issue across dependency levels, each in its own worktree, merged into the feature branch level by level.',
    requiresCli: true,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const sprint = await loadPreviousStepOutput(ctx.db, ctx.taskId, '06b-sprint-planning');
    return (sprint?.output as { mode?: string } | null)?.mode === 'dag';
  },

  async detect(ctx: StepContext): Promise<DagExecuteDetect> {
    const plan = await ctx.db.query.taskDagPlans.findFirst({
      where: eq(schema.taskDagPlans.taskId, ctx.taskId),
      columns: { id: true, mode: true },
    });
    if (!plan) {
      throw new Error('06c-dag-execute: no DAG plan found (06b-sprint-planning must run first)');
    }
    const issues = await ctx.db
      .select({ id: schema.taskDagIssues.id })
      .from(schema.taskDagIssues)
      .where(eq(schema.taskDagIssues.dagPlanId, plan.id));
    const levels = await ctx.db
      .select({ id: schema.taskDagLevels.id })
      .from(schema.taskDagLevels)
      .where(eq(schema.taskDagLevels.dagPlanId, plan.id));
    return { mode: plan.mode, issueCount: issues.length, levelCount: levels.length };
  },

  dagExecute: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 60 * 60 * 1000,
    buildCoderPrompt,
  },

  async apply(ctx: StepContext, args): Promise<DagExecuteApply> {
    // Reached only after resolveDagPhase resolved (all levels checkpointed).
    const detected = args.detected;
    // Read the issues' REAL end state rather than echoing detect's counts. With review on,
    // a coder failure the replanner does not ABORT on is skipIssue'd — `resolution:
    // 'skipped'`, a value nothing in the repo reads back — then dropped from
    // acceptedForMerge and checkpointed. So an issue whose code was never written finished
    // as a clean green step, which is the same silence the mining fan-outs had.
    const dropped = await loadDroppedIssues(ctx);
    ctx.logger.info(
      { issues: detected.issueCount, levels: detected.levelCount, dropped: dropped.length },
      'dag execution complete',
    );
    if (dropped.length === 0) {
      return { ran: true, issues: detected.issueCount, levels: detected.levelCount };
    }
    const named = dropped
      .slice(0, DROPPED_ISSUES_NAMED)
      .map((d) => (d.reason ? `${d.issueKey} (${d.reason})` : d.issueKey));
    const elided = dropped.length - named.length;
    return {
      ran: true,
      issues: detected.issueCount,
      levels: detected.levelCount,
      dropped,
      degradedNote:
        `${dropped.length} of ${detected.issueCount} issue(s) were not implemented and their ` +
        `work is not in the branch: ${named.join('; ')}` +
        `${elided > 0 ? `, and ${elided} more` : ''}. The rest of the DAG was merged, so the ` +
        `spec is only partly delivered.`,
    };
  },
};
