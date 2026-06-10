import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { DagCoderContext, StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

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
}

function buildCoderPrompt(issue: DagCoderContext, upstreamDebt: string): string {
  return [
    `You are implementing ${issue.issueKey}: ${issue.title}`,
    '',
    'Your working directory is already set to your isolated git worktree:',
    `  ${issue.sandboxWorktreePath}`,
    'Implement ONLY this issue (a vertical slice: implementation + its tests together).',
    'Match the existing code style and conventions. Do not invent requirements.',
    '',
    'Before implementing, search for the existing patterns this issue touches, in this order:',
    '1. `rag_search` FIRST — query the haive-rag tool for the symbols/components/patterns involved',
    '   (semantic + lexical search over the indexed code AND knowledge base); prefer it over blind grepping.',
    '2. If rag_search is unavailable or returns nothing useful, READ the relevant `.claude/knowledge_base/` files.',
    '3. If still not enough, Grep / Read the codebase directly for the symbols you need.',
    '',
    issue.description ? `Description: ${issue.description}` : '',
    issue.provides ? `Deliverable: ${issue.provides}` : '',
    issue.specSections.length > 0
      ? `Spec sections to implement:\n- ${issue.specSections.join('\n- ')}`
      : '',
    issue.acceptanceCriteria.length > 0
      ? `Acceptance criteria (for this issue only):\n- ${issue.acceptanceCriteria.join('\n- ')}`
      : '',
    upstreamDebt ? `\n${upstreamDebt}` : '',
    '',
    'When finished, COMMIT your changes to the current branch (git add -A && git commit -m ...).',
    'Then emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
    `{ "issue_id": "${issue.issueKey}", "outcome": "completed|completed_with_debt|failed_unrecoverable", "files_modified": ["path/one"], "debt_items": [], "concerns": "<notes or empty>" }`,
  ]
    .filter(Boolean)
    .join('\n');
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
    ctx.logger.info(
      { issues: detected.issueCount, levels: detected.levelCount },
      'dag execution complete',
    );
    return { ran: true, issues: detected.issueCount, levels: detected.levelCount };
  },
};
