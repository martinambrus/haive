import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService } from '@haive/shared';
import { ancestryOf, loadPlanNode, loadPlanSkeletons } from '@haive/shared/plan';
import type { StepDefinition } from '../../step-definition.js';

/**
 * Research a non-code blocker.
 *
 * `research` and `external` nodes — hosting comparisons, trademark clearance,
 * domain availability, a licence question — are the parts of a plan that stall
 * it and that nothing else in Haive can hold. This step gathers the findings; it
 * deliberately does NOT decide, and does not touch the node's status. That is
 * 02-advisory-decision's job, and it belongs to the user.
 *
 * A normal CLI invocation: the sandbox has network and tool control is a
 * deny-list, so WebSearch/WebFetch are available on the claude-family adapters.
 */

interface AdvisoryDetect {
  repositoryId: string | null;
  nodeId: string | null;
  nodeTitle: string;
  nodeKind: string;
  nodeBody: string;
  ancestry: string[];
  question: string;
}

export interface AdvisoryFindings {
  /** Markdown the decision step offers to write into the node's body. */
  findings: string;
  /** Distinct courses of action the research turned up, for the decision form. */
  options: { label: string; summary: string }[];
  source: 'agent' | 'stub';
}

function buildResearchPrompt(d: AdvisoryDetect): string {
  return [
    `You are researching one open question for a project plan.`,
    '',
    `## The question`,
    d.question || `What does "${d.nodeTitle}" require, and what are the options?`,
    '',
    `## Where it sits in the plan`,
    d.ancestry.join(' / '),
    d.nodeBody ? `\nWhat the plan already says about it:\n${d.nodeBody}` : '',
    '',
    '## What to produce',
    'Research this properly — use web search where the answer depends on current prices,',
    'availability, licences or vendor terms, and say WHEN you looked, because that kind of',
    'answer goes stale.',
    '',
    'Do NOT decide. Lay out the real options with what each costs and what each rules out,',
    'and name what you could not establish. A person will choose.',
    '',
    'Reply with ONE ```json fenced block:',
    '',
    '```json',
    '{',
    '  "findings": "markdown: what you found, with the trade-offs and anything still unknown",',
    '  "options": [ { "label": "short name", "summary": "what choosing this means" } ]',
    '}',
    '```',
    '',
    'Give between 1 and 5 options. If the question has one obvious answer, give one option and',
    'say so in `findings`.',
  ]
    .filter(Boolean)
    .join('\n');
}

export const advisoryResearchStep: StepDefinition<AdvisoryDetect, AdvisoryFindings> = {
  metadata: {
    id: '01-advisory-research',
    workflowType: 'advisory',
    index: 0,
    title: 'Research',
    description:
      'Researches a non-code blocker on a plan node — hosting, licensing, a domain, a trademark — and lays out the options without choosing one.',
    requiresCli: true,
  },

  async shouldRun(): Promise<boolean> {
    return (await configService.getBoolean(CONFIG_KEYS.PLAN_CANVAS_ENABLED, true)) !== false;
  },

  async detect(ctx): Promise<AdvisoryDetect> {
    const [task] = await ctx.db
      .select({
        repositoryId: schema.tasks.repositoryId,
        description: schema.tasks.description,
        metadata: schema.tasks.metadata,
      })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    const repositoryId = task?.repositoryId ?? null;
    const nodeId = ((task?.metadata ?? {}) as { planNodeId?: string }).planNodeId ?? null;
    const empty: AdvisoryDetect = {
      repositoryId,
      nodeId,
      nodeTitle: '',
      nodeKind: 'research',
      nodeBody: '',
      ancestry: [],
      question: (task?.description ?? '').trim(),
    };
    if (!repositoryId || !nodeId) return empty;

    const node = await loadPlanNode(ctx.db, repositoryId, nodeId);
    if (!node) return empty;
    const skeletons = await loadPlanSkeletons(ctx.db, repositoryId);
    return {
      ...empty,
      nodeTitle: node.title,
      nodeKind: node.kind,
      nodeBody: node.body ?? '',
      ancestry: ancestryOf(skeletons, nodeId).map((a) => a.title),
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 20 * 60 * 1000,
    // Full MCP surface on purpose: this is the one plan step whose answer may
    // depend on the open web, so nothing is narrowed away.
    buildPrompt: ({ detected }) => buildResearchPrompt(detected as AdvisoryDetect),
    optional: true,
    bypassStub: ({ detected }) => ({
      findings: `Test bypass — no research was run for "${(detected as AdvisoryDetect).nodeTitle}".`,
      options: [{ label: 'Decide manually', summary: 'No agent output available.' }],
    }),
  },

  async apply(_ctx, args): Promise<AdvisoryFindings> {
    const raw = args.llmOutput as { findings?: unknown; options?: unknown } | null;
    const findings = typeof raw?.findings === 'string' ? raw.findings.trim() : '';
    const options = Array.isArray(raw?.options)
      ? raw.options
          .filter(
            (o): o is { label: string; summary?: string } =>
              !!o && typeof (o as { label?: unknown }).label === 'string',
          )
          .slice(0, 5)
          .map((o) => ({ label: o.label, summary: String(o.summary ?? '') }))
      : [];

    // Degrades rather than throws: research that produced nothing usable still
    // has to reach the human, who can then decide with what they already know.
    if (!findings) {
      return {
        findings: `No usable research came back for "${args.detected.nodeTitle}".`,
        options: [],
        source: 'stub',
      };
    }
    return { findings, options, source: 'agent' };
  },
};
