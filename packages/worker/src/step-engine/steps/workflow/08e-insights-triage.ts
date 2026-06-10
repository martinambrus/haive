import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

// Insight collection (legacy insight-collection.md). Agents may append a
// `## INSIGHTS` block to their output noting OPTIONAL improvements out of scope
// for the current task. This step scans the run's agent outputs for those
// insights and lets the user pick which to implement now; a single fix agent
// applies the chosen ones, which the downstream gate re-verifies. Single-run
// triage — insights are NOT written to the knowledge base. Skipped when no
// insights were surfaced.

/** Appended to agent prompts that can surface optional improvements. The
 *  `## INSIGHTS` section sits AFTER the agent's fenced-JSON output (a sibling
 *  markdown block), so it never disturbs existing output parsing. 08e scans the
 *  raw agent output for these. */
export const INSIGHTS_INSTRUCTION = [
  'OPTIONAL: after your main output, you MAY add a `## INSIGHTS` section listing OUT-OF-SCOPE',
  'improvements you noticed but did NOT make, one per line as:',
  '`- INSIGHT: <title> | <file:line> | <short description>`. Omit the section entirely if none.',
].join('\n');

export interface Insight {
  id: string;
  sourceStep: string;
  title: string;
  location: string;
  description: string;
}

interface TriageDetect {
  worktreePath: string;
  sandboxWorktreePath: string;
  spec: string;
  insights: Insight[];
}

interface TriageApply {
  insightsFound: number;
  selected: Insight[];
  skipped: number;
  implemented: boolean;
  notes: string;
}

/** Parse `## INSIGHTS` blocks from a list of raw agent outputs. Each insight
 *  line is `- INSIGHT: <title> | <file:line> | <description>` (the trailing
 *  fields are optional). Deduped by title+location; capped for the form. */
export function parseInsights(outputs: { stepId: string; raw: string }[]): Insight[] {
  const seen = new Set<string>();
  const out: Insight[] = [];
  for (const { stepId, raw } of outputs) {
    if (!raw) continue;
    const m = /##\s*INSIGHTS\b([\s\S]*?)(?:\n##\s|\n```|$)/i.exec(raw);
    if (!m) continue;
    for (const line of m[1]!.split('\n')) {
      const im = /^\s*[-*]\s*INSIGHT:\s*(.+)$/i.exec(line);
      if (!im) continue;
      const parts = im[1]!.split('|').map((p) => p.trim());
      const title = parts[0] ?? '';
      if (!title) continue;
      const location = parts[1] ?? '';
      const description = parts.slice(2).join(' | ') || parts[1] || '';
      const key = `${title}::${location}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: `i-${out.length + 1}`, sourceStep: stepId, title, location, description });
      if (out.length >= 30) return out;
    }
  }
  return out;
}

async function collectInsights(ctx: StepContext): Promise<Insight[]> {
  const rows = await ctx.db
    .select({ stepId: schema.taskSteps.stepId, raw: schema.cliInvocations.rawOutput })
    .from(schema.cliInvocations)
    .innerJoin(schema.taskSteps, eq(schema.cliInvocations.taskStepId, schema.taskSteps.id))
    .where(eq(schema.cliInvocations.taskId, ctx.taskId));
  return parseInsights(rows.map((r) => ({ stepId: r.stepId, raw: r.raw ?? '' })));
}

const SEARCH_LADDER = [
  'When you need context, search in this order:',
  '1. `rag_search` FIRST, 2. `.claude/knowledge_base/`, 3. Grep / Read the codebase.',
] as const;

export const insightsTriageStep: StepDefinition<TriageDetect, TriageApply> = {
  metadata: {
    id: '08e-insights-triage',
    workflowType: 'workflow',
    index: 8.95,
    title: 'Insight triage',
    description:
      'Surfaces optional improvements agents noted during the run; you pick which to implement now.',
    requiresCli: false,
    cliRoles: undefined,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    const insights = await collectInsights(ctx);
    return insights.length > 0;
  },

  async detect(ctx: StepContext): Promise<TriageDetect> {
    const worktree = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const wt = worktree?.output as { worktreePath?: string; sandboxWorktreePath?: string } | null;
    const plan = await loadPreviousStepOutput(ctx.db, ctx.taskId, '04-phase-0b-pre-planning');
    const quality = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05-phase-0b5-spec-quality');
    const resolved = await loadPreviousStepOutput(ctx.db, ctx.taskId, '05a-resolve-spec-warnings');
    const spec =
      ((resolved?.output as { spec?: string } | null)?.spec ??
        (quality?.output as { spec?: string } | null)?.spec ??
        (plan?.output as { spec?: string } | null)?.spec) ||
      '';
    return {
      worktreePath: wt?.worktreePath ?? ctx.workspacePath,
      sandboxWorktreePath: wt?.sandboxWorktreePath ?? ctx.workspacePath,
      spec,
      insights: await collectInsights(ctx),
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Insight triage',
      description: [
        `Agents surfaced ${detected.insights.length} optional improvement(s) during this run.`,
        'Select any to implement now (leave all unchecked to skip). Selected items are applied by',
        'one agent and re-verified at the next gate.',
      ].join('\n'),
      fields: [
        {
          type: 'multi-select',
          id: 'selectedInsights',
          label: 'Improvements to implement',
          options: detected.insights.map((i) => ({
            value: i.id,
            label: i.location ? `${i.title} (${i.location})` : i.title,
            badge: i.sourceStep,
            group: i.sourceStep,
          })),
          defaults: [],
        },
      ],
      submitLabel: 'Apply selected',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use', 'file_write'],
    timeoutMs: 30 * 60 * 1000,
    skipIf: ({ formValues }) => {
      const sel = (formValues as { selectedInsights?: string[] }).selectedInsights;
      return !Array.isArray(sel) || sel.length === 0;
    },
    buildPrompt: (args) => {
      const d = args.detected as TriageDetect;
      const sel = ((args.formValues as { selectedInsights?: string[] }).selectedInsights ??
        []) as string[];
      const chosen = d.insights.filter((i) => sel.includes(i.id));
      return [
        'Implement ONLY the optional improvements selected below — out-of-scope ideas surfaced',
        'earlier in this run that the user chose to action now.',
        `Workspace: ${d.sandboxWorktreePath}`,
        'Your current working directory has the workspace mounted; work on the files there.',
        '',
        'Selected improvements:',
        ...chosen.map(
          (i, n) =>
            `${n + 1}. ${i.title}${i.location ? ` [${i.location}]` : ''} — ${i.description}`,
        ),
        '',
        'Make ONLY these changes. Do NOT add unrelated work, do NOT run git, do NOT run tests.',
        ...SEARCH_LADDER,
        '',
        'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
        '{ "implemented": ["<each change made>"], "notes": "<caveats or empty>" }',
        '',
        '=== Spec (the task context) ===',
        d.spec || '(no spec recorded)',
      ].join('\n');
    },
    bypassStub: () => ({ implemented: [], notes: 'bypass stub' }),
  },

  async apply(ctx, args): Promise<TriageApply> {
    const d = args.detected;
    const sel = ((args.formValues as { selectedInsights?: string[] }).selectedInsights ??
      []) as string[];
    const selected = d.insights.filter((i) => sel.includes(i.id));
    const implemented = selected.length > 0;
    ctx.logger.info(
      { found: d.insights.length, selected: selected.length, implemented },
      'insight triage complete',
    );
    return {
      insightsFound: d.insights.length,
      selected,
      skipped: d.insights.length - selected.length,
      implemented,
      notes: '',
    };
  },
};
