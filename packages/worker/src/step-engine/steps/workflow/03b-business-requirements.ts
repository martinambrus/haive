import { z } from 'zod';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';
import { extractFencedJson } from '../_fenced-json.js';

// Phase 1 — Business requirements (legacy phase1-business-requirements). Between
// discovery (03) and the technical spec (04), a business-requirements-writer
// agent turns the task + discovery into a stakeholder-facing, non-technical
// requirements doc IN THE INPUT'S OWN LANGUAGE. OPTIONAL + gated: the step parks
// at a confirm form FIRST and the agent mines only after the user submits (or
// never, if they Skip the whole step) — nothing is generated before the user opts
// in. The doc is an additive artifact the technical-spec step uses when present.

interface BizReqDetect {
  taskTitle: string;
  taskDescription: string;
  discoverySummary: string;
}

interface BizReqApply {
  requirements: string;
  summary: string;
  source: 'llm' | 'stub';
}

interface DiscoveryOutput {
  summary?: string;
}

const bizReqSchema = z.object({
  requirements: z.string().default(''),
  summary: z.string().default(''),
});

/** Parse the business-requirements JSON; null when unparseable. */
export function parseBizReqOutput(raw: unknown): { requirements: string; summary: string } | null {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    const body = extractFencedJson(raw);
    if (!body) return null;
    try {
      candidate = JSON.parse(body);
    } catch {
      return null;
    }
  }
  const parsed = bizReqSchema.safeParse(candidate);
  if (!parsed.success || !parsed.data.requirements.trim()) return null;
  return { requirements: parsed.data.requirements, summary: parsed.data.summary };
}

const PERSONA = [
  'You are the Business Requirements Writer. Turn the task and discovery findings into a clear,',
  'NON-TECHNICAL requirements document a stakeholder can read and approve: the problem and why it',
  'matters, the current state and pain points, the proposed change in business terms (a before/after',
  'user journey), and measurable acceptance criteria with who is affected. Keep ALL implementation',
  'detail out (no code, files, schema, or jargon). Detect the input language and write the ENTIRE',
  'document in it — never auto-translate. Use `rag_search` / `.claude/knowledge_base/` (especially',
  'BUSINESS_LOGIC.md) for current-state context. Do NOT edit code and do NOT run git.',
] as const;

export const businessRequirementsStep: StepDefinition<BizReqDetect, BizReqApply> = {
  metadata: {
    id: '03b-business-requirements',
    workflowType: 'workflow',
    index: 3.5,
    title: 'Phase 1: Business requirements',
    description:
      'Optional. Submit to run a business-requirements-writer agent that drafts a stakeholder-facing requirements doc (which grounds the technical spec), or Skip when only a technical spec is needed. The agent runs only after you submit — nothing is mined before then.',
    requiresCli: false,
    // Optional step: a task that needs only a technical spec (no stakeholder-facing
    // requirements doc) can Skip it. 04-pre-planning treats the requirements as
    // upstream context "when present", so a skip degrades cleanly. Keep in sync
    // with SKIPPABLE_STEP_IDS in @haive/shared.
    allowSkip: true,
  },

  async detect(ctx: StepContext): Promise<BizReqDetect> {
    const meta = await loadTaskMeta(ctx.db, ctx.taskId);
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '03-phase-0a-discovery');
    const output = (prev?.output as DiscoveryOutput | null) ?? {};
    return {
      taskTitle: meta.title,
      taskDescription: meta.description,
      discoverySummary: output.summary ?? '',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    timeoutMs: 30 * 60 * 1000,
    // postForm (no preForm): the agent mines ONLY after the user submits the gate
    // form — or never, if they Skip the whole step. Nothing is generated up front.
    buildPrompt: (args) => {
      const d = args.detected as BizReqDetect;
      const guidance = ((args.formValues as { guidance?: string }).guidance ?? '').trim();
      return [
        'If a `.claude/agents/business-requirements-writer.md` agent definition exists in the repo,',
        'follow it; otherwise follow the protocol below.',
        ...PERSONA,
        '',
        `Task title: ${d.taskTitle || '(untitled)'}`,
        `Task description: ${d.taskDescription || '(none)'}`,
        '',
        '=== Discovery summary ===',
        d.discoverySummary || '(none)',
        ...(guidance ? ['', '=== User guidance for this document ===', guidance] : []),
        '',
        'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
        '{ "requirements": "<the full requirements document as markdown>", "summary": "<one-line summary>" }',
      ].join('\n');
    },
    bypassStub: () => ({ requirements: '# Requirements\n\n(bypass stub)', summary: 'bypass stub' }),
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Phase 1: Business requirements (optional)',
      description: [
        `Task: ${detected.taskTitle || '(untitled)'}`,
        '',
        'A business-requirements-writer agent can draft a stakeholder-facing requirements',
        'doc (no code or jargon) to ground the technical spec. It runs only when you submit —',
        'nothing is mined before then. Skip this step if you only need a technical spec.',
      ].join('\n'),
      fields: [
        {
          type: 'textarea',
          id: 'guidance',
          label: 'Guidance for the agent (optional)',
          rows: 4,
          placeholder: 'Anything to emphasise, include, or avoid in the requirements doc.',
        },
      ],
      submitLabel: 'Run the business-requirements agent',
    };
  },

  async apply(ctx, args): Promise<BizReqApply> {
    // Reached only when the user SUBMITTED the gate (Skip short-circuits the whole
    // step), so the agent ran. Store its mined requirements for the technical spec.
    const parsed = parseBizReqOutput(args.llmOutput ?? null);
    ctx.logger.info({ source: parsed ? 'llm' : 'stub' }, 'business requirements drafted');
    return {
      requirements: parsed?.requirements ?? '',
      summary: parsed?.summary ?? '',
      source: parsed ? 'llm' : 'stub',
    };
  },
};
