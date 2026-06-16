import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  sprintPlanSchema,
  type DagIssue,
  type FormSchema,
  type InfoSection,
  type SprintPlan,
} from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { extractFencedJson } from '../_fenced-json.js';

// Phase 2c — Sprint planning (the DAG decision). An agent reads the spec
// approved at gate 1 and decides mode 'single' (one implementation agent, the
// fast path) or 'dag' (decompose into issues that run in parallel across
// dependency levels). DAG requires user confirmation at a gate; single is the
// no-gate fast path. On 'proceed' the plan + issue + level rows are persisted so
// the 06c-dag-execute step can drive them; on single, 07-phase-2-implement runs
// as before. Re-planning = Retry this step (re-runs the planner).

interface SprintPlanningDetect {
  specSummary: string;
  spec: string;
  gateFeedback: string;
}

interface SprintPlanningApply {
  mode: 'single' | 'dag';
  planId: string | null;
  issueCount: number;
  levelCount: number;
}

interface PrePlanningOutput {
  summary?: string;
  spec?: string;
}

interface Gate1Output {
  decision?: string;
  feedback?: string;
}

/** Parse the planner's fenced JSON into a SprintPlan; falls back to single-agent
 *  on any parse/validation failure so the pipeline always has a usable plan. */
export function parseSprintPlan(raw: unknown): SprintPlan {
  const fallback: SprintPlan = {
    mode: 'single',
    rationale: 'planner output unparseable — defaulting to single-agent',
    max_parallel: 1,
    issues: [],
    levels: [],
  };
  if (!raw) return fallback;
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    const body = extractFencedJson(raw);
    if (!body) return fallback;
    try {
      candidate = JSON.parse(body);
    } catch {
      return fallback;
    }
  }
  const result = sprintPlanSchema.safeParse(candidate);
  return result.success ? result.data : fallback;
}

/** Group issue ids into dependency waves by their `level` when the planner
 *  didn't supply an explicit `levels` array. */
function deriveLevels(issues: DagIssue[]): string[][] {
  const byLevel = new Map<number, string[]>();
  for (const it of issues) {
    const arr = byLevel.get(it.level) ?? [];
    arr.push(it.id);
    byLevel.set(it.level, arr);
  }
  return Array.from(byLevel.keys())
    .sort((a, b) => a - b)
    .map((lvl) => byLevel.get(lvl)!);
}

function planSummaryBody(plan: SprintPlan): string {
  const lines: string[] = [`**Mode:** ${plan.mode}`];
  if (plan.rationale) {
    lines.push('', plan.rationale);
  }
  lines.push('', `**Max parallel:** ${plan.max_parallel}`);
  lines.push(`**Issues:** ${plan.issues.length} across ${plan.levels.length} level(s)`);
  plan.levels.forEach((wave, i) => {
    lines.push('', `### Level ${i}`);
    for (const key of wave) {
      const issue = plan.issues.find((it) => it.id === key);
      const deps =
        issue && issue.depends_on.length ? ` — depends on ${issue.depends_on.join(', ')}` : '';
      lines.push(`- **${key}** ${issue?.title ?? ''}${deps}`);
    }
  });
  return lines.join('\n');
}

const PLANNER_RULES = [
  'You are the sprint-planner. Analyze the APPROVED technical specification below and decide how',
  'it should be implemented:',
  '- mode "single": one agent implements the whole spec (the fast path). Prefer this by DEFAULT.',
  '- mode "dag": decompose into independent issues that run in PARALLEL across dependency levels.',
  '',
  'Choose SINGLE when (prefer unless DAG clearly wins):',
  '- the change touches <= 3 files in one functional area,',
  '- the acceptance criteria are tightly coupled,',
  '- there are no independent sub-tasks that could run in parallel,',
  '- complexity is simple to moderate.',
  '',
  'Choose DAG when:',
  '- multiple independent functional areas,',
  '- >= 4 acceptance criteria spanning different concerns,',
  '- clear parallelization opportunities,',
  '- high complexity.',
  'When in doubt, choose single.',
  '',
  'If mode=dag, decompose into issues. Each issue is a VERTICAL slice (implementation + its tests',
  'together), completable by one agent in one session, scoped to specific spec sections. Use',
  '`depends_on` for ordering and `level` for the dependency wave (0 = no dependencies). Set',
  '`max_parallel` to the widest level size (no hard cap — the runner bounds live parallelism).',
  'Search the repo with your tools to size issues and list the files each will touch.',
  '',
  'Emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
  '{',
  '  "mode": "single" | "dag",',
  '  "rationale": "<one or two sentences on why>",',
  '  "max_parallel": <integer >= 1>,',
  '  "issues": [',
  '    {',
  '      "id": "ISSUE-001",',
  '      "title": "<short title>",',
  '      "description": "<2-3 sentences: WHAT to implement, not HOW>",',
  '      "spec_sections": ["<section refs this issue implements>"],',
  '      "acceptance_criteria": ["<criteria from the spec this issue covers>"],',
  '      "depends_on": ["<issue ids this depends on>"],',
  '      "level": <integer dependency wave, 0 = no deps>,',
  '      "estimated_files": ["path/one", "path/two"],',
  '      "provides": "<the deliverable>",',
  '      "guidance": { "needs_deeper_qa": false, "estimated_scope": "small|medium|large", "risk_rationale": "", "testing_guidance": "", "review_focus": "" }',
  '    }',
  '  ],',
  '  "levels": [ ["ISSUE-001", "ISSUE-002"], ["ISSUE-003"] ]',
  '}',
  'For mode=single return empty "issues" and "levels" and max_parallel 1. "levels" is an array of',
  'waves; each wave lists the issue ids that run in parallel at that dependency level. Every issue',
  'id MUST appear in exactly one wave, ordered by dependency.',
] as const;

/** Replace any prior plan for this step (retry/re-run) and insert a fresh row.
 *  The cascade FK clears the old issue/level rows. */
async function persistPlan(
  ctx: StepContext,
  plan: SprintPlan,
  mode: 'single' | 'dag',
  autoResolve: boolean,
  reviewEnabled: boolean,
): Promise<string> {
  await ctx.db
    .delete(schema.taskDagPlans)
    .where(eq(schema.taskDagPlans.taskStepId, ctx.taskStepId));
  const inserted = await ctx.db
    .insert(schema.taskDagPlans)
    .values({
      taskId: ctx.taskId,
      taskStepId: ctx.taskStepId,
      mode,
      rationale: plan.rationale,
      maxParallel: plan.max_parallel,
      levels: plan.levels,
      planJson: plan,
      autoResolveConflicts: autoResolve,
      reviewEnabled,
    })
    .returning({ id: schema.taskDagPlans.id });
  const row = inserted[0];
  if (!row) throw new Error('06b-sprint-planning: failed to insert task_dag_plans row');
  return row.id;
}

/** Fan out one task_dag_levels row per wave + one task_dag_issues row per issue.
 *  Each issue's level is taken from the wave that contains it (authoritative over
 *  the issue's own `level` field). */
async function fanOutDag(
  ctx: StepContext,
  planId: string,
  plan: SprintPlan,
): Promise<{ issueCount: number; levelCount: number }> {
  const levels = plan.levels.length > 0 ? plan.levels : deriveLevels(plan.issues);
  const levelByKey = new Map<string, number>();
  levels.forEach((wave, i) => wave.forEach((key) => levelByKey.set(key, i)));

  for (let i = 0; i < levels.length; i += 1) {
    await ctx.db.insert(schema.taskDagLevels).values({
      dagPlanId: planId,
      level: i,
      issueKeys: levels[i] ?? [],
      phase: 'pending',
    });
  }

  for (const issue of plan.issues) {
    await ctx.db.insert(schema.taskDagIssues).values({
      dagPlanId: planId,
      taskId: ctx.taskId,
      issueKey: issue.id,
      level: levelByKey.get(issue.id) ?? issue.level,
      title: issue.title,
      description: issue.description,
      specSections: issue.spec_sections,
      acceptanceCriteria: issue.acceptance_criteria,
      dependsOn: issue.depends_on,
      estimatedFiles: issue.estimated_files,
      provides: issue.provides,
      guidance: issue.guidance ?? null,
      outcome: 'pending',
    });
  }

  return { issueCount: plan.issues.length, levelCount: levels.length };
}

export const sprintPlanningStep: StepDefinition<SprintPlanningDetect, SprintPlanningApply> = {
  metadata: {
    id: '06b-sprint-planning',
    workflowType: 'workflow',
    index: 6.2,
    title: 'Phase 2c: Sprint planning',
    description:
      'An agent decides whether to implement with one agent or decompose the spec into a parallel DAG of issues; you confirm a DAG decomposition before it runs.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<SprintPlanningDetect> {
    // Load the spec approved at gate 1, same precedence as 07-phase-2-implement.
    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const gate = await loadPreviousStepOutput(ctx.db, ctx.taskId, '06-gate-1-spec-approval');
    const planOutput = (plan?.output as PrePlanningOutput | null) ?? {};
    const qualityOutput = (quality?.output as { spec?: string } | null) ?? {};
    const resolvedOutput = (resolved?.output as { spec?: string } | null) ?? {};
    const gateOutput = (gate?.output as Gate1Output | null) ?? {};
    return {
      specSummary: planOutput.summary ?? '',
      spec: resolvedOutput.spec ?? qualityOutput.spec ?? planOutput.spec ?? '',
      gateFeedback: gateOutput.feedback ?? '',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    preForm: true,
    timeoutMs: 30 * 60 * 1000,
    buildPrompt: (args) => {
      const d = args.detected as SprintPlanningDetect;
      return [
        ...PLANNER_RULES,
        '',
        `Gate 1 feedback: ${d.gateFeedback || '(none)'}`,
        '',
        '=== Approved spec ===',
        d.spec || '(empty spec — default to single-agent)',
      ].join('\n');
    },
    parseOutput: (raw) => parseSprintPlan(raw),
    bypassStub: () => ({
      mode: 'single',
      rationale: 'bypass stub',
      max_parallel: 1,
      issues: [],
      levels: [],
    }),
  },

  form(_ctx, _detected, llmOutput): FormSchema | null {
    const plan = parseSprintPlan(llmOutput);
    // Single-agent: the fast path — there's no decomposition to confirm. But still
    // SHOW the agent's decision + rationale (rather than letting the runner fall back
    // to a bare "Continue" confirm with the generic step description) so the user can
    // see WHAT was decided and WHY. Zero fields → auto-passes under auto-continue;
    // parks for review otherwise. Retry this step to re-plan.
    if (plan.mode !== 'dag' || plan.issues.length === 0) {
      return {
        title: 'Phase 2c: Sprint planning',
        description:
          'The planning agent chose a single implementation agent — no parallel decomposition is needed for this spec. Implementation runs next; Retry this step to re-plan.',
        infoSections: plan.rationale
          ? [
              {
                title: 'Planner decision: single agent',
                preview: 'rationale',
                body: plan.rationale,
                defaultOpen: true,
              },
            ]
          : undefined,
        fields: [],
        submitLabel: 'Continue',
        // Nothing to decide — the agent chose single-agent. Flow through without
        // pausing even in manual mode; the rationale stays on the done card.
        autoSubmit: true,
      };
    }
    const infoSections: InfoSection[] = [
      {
        title: 'Sprint plan',
        preview: `${plan.issues.length} issue(s) • ${plan.levels.length} level(s)`,
        body: planSummaryBody(plan),
        defaultOpen: true,
      },
    ];
    return {
      title: 'Phase 2c: Sprint planning',
      description:
        'An agent decomposed the spec into a parallel DAG of issues. Proceed to run them in parallel, or override to a single implementation agent. To change the decomposition, Retry this step.',
      infoSections,
      fields: [
        {
          type: 'radio',
          id: 'decision',
          label: 'How should implementation run?',
          options: [
            { value: 'proceed', label: `Proceed — parallel DAG (${plan.issues.length} issues)` },
            { value: 'use_single_agent', label: 'Use a single implementation agent instead' },
          ],
          default: 'proceed',
          required: true,
        },
        {
          type: 'checkbox',
          id: 'autoResolveConflicts',
          label:
            'Auto-resolve merge conflicts with AI — run uninterrupted, do not pause for manual resolution',
          default: true,
        },
        {
          type: 'checkbox',
          id: 'reviewEnabled',
          label: 'Review each issue with an AI reviewer before merge (coder ↔ reviewer loop)',
          default: true,
        },
      ],
      submitLabel: 'Confirm plan',
    };
  },

  async apply(ctx, args): Promise<SprintPlanningApply> {
    const plan = parseSprintPlan(args.llmOutput ?? null);
    const values = (args.formValues ?? {}) as {
      decision?: string;
      autoResolveConflicts?: boolean;
      reviewEnabled?: boolean;
    };
    const overrideSingle = values.decision === 'use_single_agent';
    const autoResolve = values.autoResolveConflicts === true;
    const reviewEnabled = values.reviewEnabled !== false; // default on for dag
    const mode: 'single' | 'dag' =
      plan.mode === 'dag' && !overrideSingle && plan.issues.length > 0 ? 'dag' : 'single';

    // Single mode writes no task_dag_* rows — routing reads mode from this step's
    // output and 07-phase-2-implement runs. Only dag mode persists the plan.
    let planId: string | null = null;
    let issueCount = 0;
    let levelCount = 0;
    if (mode === 'dag') {
      planId = await persistPlan(ctx, plan, mode, autoResolve, reviewEnabled);
      const counts = await fanOutDag(ctx, planId, plan);
      issueCount = counts.issueCount;
      levelCount = counts.levelCount;
    }

    ctx.logger.info({ mode, planId, issueCount, levelCount }, 'sprint plan recorded');
    return { mode, planId, issueCount, levelCount };
  },
};
