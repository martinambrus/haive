import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { loadTaskMeta } from './_task-meta.js';

interface PrePlanningDetect {
  taskTitle: string;
  taskDescription: string;
  discoverySummary: string;
  relevantKbIds: string[];
}

interface PrePlanningApply {
  summary: string;
  spec: string;
  source: 'llm' | 'stub';
}

interface DiscoveryOutput {
  summary?: string;
  relevantKbIds?: string[];
}

export function parsePrePlanningOutput(raw: unknown): {
  summary: string;
  spec: string;
} | null {
  if (!raw) return null;
  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else if (typeof raw === 'object') {
    const asObj = raw as Record<string, unknown>;
    if (typeof asObj.summary === 'string' && typeof asObj.spec === 'string') {
      return { summary: asObj.summary, spec: asObj.spec };
    }
    return null;
  } else {
    return null;
  }
  const fenceMatch = /```json\s*([\s\S]*?)```/.exec(text);
  const body = fenceMatch?.[1];
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).summary === 'string' &&
      typeof (parsed as Record<string, unknown>).spec === 'string'
    ) {
      const obj = parsed as Record<string, unknown>;
      return { summary: obj.summary as string, spec: obj.spec as string };
    }
  } catch {
    return null;
  }
  return null;
}

function stubPrePlanning(detect: PrePlanningDetect): { summary: string; spec: string } {
  const title = detect.taskTitle || '(untitled task)';
  const description = detect.taskDescription || '(no description provided)';
  const summary = [
    `Pre-planning draft for: ${title}`,
    '',
    description,
    '',
    detect.discoverySummary ? 'Discovery context incorporated.' : 'Discovery context unavailable.',
  ].join('\n');
  const specLines = [
    `# Spec: ${title}`,
    '',
    '## Goal',
    description,
    '',
    '## Discovery context',
    detect.discoverySummary || '(none)',
    '',
    '## Relevant knowledge base',
    detect.relevantKbIds.length > 0
      ? detect.relevantKbIds.map((id) => `- ${id}`).join('\n')
      : '- (none)',
    '',
    '## Approach',
    '- (to be filled in during implementation phase)',
    '',
    '## Risks',
    '- (none identified)',
    '',
    '## Acceptance criteria',
    '- (to be filled in before gate 1)',
  ];
  return { summary, spec: specLines.join('\n') };
}

export const phase0bPrePlanningStep: StepDefinition<PrePlanningDetect, PrePlanningApply> = {
  metadata: {
    id: '04-phase-0b-pre-planning',
    workflowType: 'workflow',
    index: 4,
    title: 'Phase 0b: Pre-planning',
    description:
      'Produces a draft specification for the task using the discovery summary as context.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<PrePlanningDetect> {
    const meta = await loadTaskMeta(ctx.db, ctx.taskId);
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '03-phase-0a-discovery');
    const output = (prev?.output as DiscoveryOutput | null) ?? {};
    return {
      taskTitle: meta.title,
      taskDescription: meta.description,
      discoverySummary: output.summary ?? '',
      relevantKbIds: Array.isArray(output.relevantKbIds) ? output.relevantKbIds : [],
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Phase 0b: Pre-planning',
      description: [
        `Task: ${detected.taskTitle || '(untitled)'}`,
        '',
        detected.taskDescription || '(no description)',
        '',
        detected.discoverySummary
          ? `Discovery summary available (${detected.discoverySummary.length} chars).`
          : 'Discovery summary not available.',
        `Relevant KB IDs: ${detected.relevantKbIds.length}`,
      ].join('\n'),
      fields: [
        {
          type: 'textarea',
          id: 'scope',
          label: 'Scope / constraints (optional)',
          rows: 4,
          placeholder: 'Explicit boundaries, out-of-scope items, hard constraints.',
        },
      ],
      submitLabel: 'Draft spec',
    };
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    optional: true,
    buildPrompt: (args) => {
      const detected = args.detected as PrePlanningDetect;
      const values = args.formValues as { scope?: string };
      return [
        'You are the pre-planning phase of an engineering workflow.',
        'Produce a concise draft specification for the task below.',
        'Emit ONE JSON object inside a ```json fenced code block with the shape:',
        '{ "summary": "<short rationale>", "spec": "<markdown spec body>" }',
        'The spec body must include sections: Goal, Approach, Risks, Acceptance criteria.',
        'Ground every claim in the discovery summary — do not invent details.',
        '',
        `Task title: ${detected.taskTitle || '(untitled)'}`,
        `Task description: ${detected.taskDescription || '(none)'}`,
        `Scope guidance: ${values.scope ?? '(none)'}`,
        '',
        '=== Discovery summary ===',
        detected.discoverySummary || '(none)',
        '',
        `Relevant KB ids: ${detected.relevantKbIds.join(', ') || '(none)'}`,
      ].join('\n');
    },
  },

  async apply(ctx, args): Promise<PrePlanningApply> {
    const parsed = parsePrePlanningOutput(args.llmOutput ?? null);
    if (parsed) {
      ctx.logger.info({ source: 'llm' }, 'pre-planning spec parsed');
      return { summary: parsed.summary, spec: parsed.spec, source: 'llm' };
    }
    const stub = stubPrePlanning(args.detected);
    ctx.logger.info({ source: 'stub' }, 'pre-planning spec stubbed');
    return { summary: stub.summary, spec: stub.spec, source: 'stub' };
  },
};
