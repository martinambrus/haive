import { z } from 'zod';
import type { FormSchema, InfoSection } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';
import { extractFencedJson } from '../_fenced-json.js';

// Phase 1 — Business requirements (legacy phase1-business-requirements). Between
// discovery (03) and the technical spec (04), a business-requirements-writer
// agent turns the task + discovery into a stakeholder-facing, non-technical
// requirements doc IN THE INPUT'S OWN LANGUAGE. The draft is presented for
// human sign-off in the same step (preForm llm → approval form). Reject halts;
// re-run (optionally retry-with-AI) to revise. The doc is an additive artifact
// the technical-spec step can use as upstream context.

interface BizReqDetect {
  taskTitle: string;
  taskDescription: string;
  discoverySummary: string;
}

interface BizReqApply {
  requirements: string;
  summary: string;
  decision: 'approve' | 'reject';
  feedback: string;
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
      'Optional. A business-requirements-writer agent drafts a stakeholder-facing requirements doc from the task and discovery; approve to feed it into the technical spec, reject to revise, or Skip when only a technical spec is needed.',
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
    // Draft BEFORE the form so the form can present it for sign-off.
    preForm: true,
    buildPrompt: (args) => {
      const d = args.detected as BizReqDetect;
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
        '',
        'When finished emit ONE JSON object inside a ```json fenced code block with EXACTLY this shape:',
        '{ "requirements": "<the full requirements document as markdown>", "summary": "<one-line summary>" }',
      ].join('\n');
    },
    bypassStub: () => ({ requirements: '# Requirements\n\n(bypass stub)', summary: 'bypass stub' }),
  },

  form(_ctx, detected, llmOutput): FormSchema {
    const parsed = parseBizReqOutput(llmOutput ?? null);
    const requirements = parsed?.requirements ?? '(no requirements drafted — review and reject)';
    const infoSections: InfoSection[] = [
      {
        title: 'Drafted business requirements',
        preview: parsed?.summary ?? `${requirements.length} chars`,
        body: requirements,
        defaultOpen: true,
      },
    ];
    return {
      title: 'Phase 1: Business requirements',
      description: [
        `Task: ${detected.taskTitle || '(untitled)'}`,
        '',
        'Review the drafted requirements below and approve to proceed to the technical spec, or',
        'reject with feedback to halt (re-run, or Retry with AI using your feedback, to revise).',
      ].join('\n'),
      infoSections,
      fields: [
        {
          type: 'radio',
          id: 'decision',
          label: 'Approve these business requirements?',
          options: [
            { value: 'approve', label: 'Approve — proceed to the technical spec' },
            { value: 'reject', label: 'Reject — request changes and halt' },
          ],
          default: 'approve',
          required: true,
        },
        {
          type: 'textarea',
          id: 'feedback',
          label: 'Feedback / refinements (optional)',
          rows: 4,
          placeholder: 'What to add, remove, or clarify in the requirements.',
        },
      ],
      submitLabel: 'Record decision',
    };
  },

  async apply(ctx, args): Promise<BizReqApply> {
    const values = args.formValues as { decision?: string; feedback?: string };
    const decision: 'approve' | 'reject' = values.decision === 'reject' ? 'reject' : 'approve';
    const parsed = parseBizReqOutput(args.llmOutput ?? null);
    const feedback = values.feedback ?? '';

    if (decision === 'reject') {
      ctx.logger.info('business requirements rejected');
      throw new Error(`business requirements rejected: ${feedback || 'no feedback supplied'}`);
    }

    ctx.logger.info({ source: parsed ? 'llm' : 'stub' }, 'business requirements approved');
    return {
      requirements: parsed?.requirements ?? '',
      summary: parsed?.summary ?? '',
      decision,
      feedback,
      source: parsed ? 'llm' : 'stub',
    };
  },
};
