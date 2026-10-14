import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormValues } from '@haive/shared';
import {
  isCustomStepId,
  parsePromptTemplate,
  renderPromptTemplate,
  TEMPLATE_PERSONA_MARKER_PATTERN,
  type PromptStepEntry,
} from '@haive/shared/modularity';
import type { StepDefinition } from '../../step-definition.js';
import {
  REPO_IS_DATA_ACTING_LINES,
  REPO_IS_DATA_ANSWER_LINES,
  UNTRUSTED_FENCE_LEGEND,
  fencedAgentBlock,
} from '../_untrusted-repo.js';

export const PROMPT_STEP_OUTPUT_CAP_BYTES = 16 * 1024;
export const PROMPT_STEP_PERSONAS_UNSUPPORTED = 'Prompt step personas are not supported yet';
const NO_STEP_OUTPUT = '(no output recorded for this step)';

export interface PromptStepDetect {
  taskTitle: string;
  taskDescription: string;
  /** Output text of each step the template names, latest done round; null when it has none. */
  stepOutputs: Record<string, string | null>;
}

export interface PromptStepOutput {
  raw: string;
  parsed: unknown;
}

export function capStepOutput(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= PROMPT_STEP_OUTPUT_CAP_BYTES) return text;
  const head = bytes.subarray(0, PROMPT_STEP_OUTPUT_CAP_BYTES).toString('utf8').replace(/�+$/, '');
  return `${head}\n[truncated: ${bytes.length - PROMPT_STEP_OUTPUT_CAP_BYTES} more bytes not shown]`;
}

function stepOutputText(output: unknown, stepId: string): string {
  if (typeof output === 'string') return output;
  if (isCustomStepId(stepId) && typeof output === 'object' && output !== null) {
    const { raw, parsed } = output as { raw?: unknown; parsed?: unknown };
    if (typeof raw === 'string' && parsed !== undefined) return raw;
  }
  return JSON.stringify(output, null, 2) ?? '';
}

function fieldText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(fieldText).join(', ');
  if (value === null || value === undefined) return '';
  return JSON.stringify(value) ?? '';
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function templateTokens(template: string) {
  const parsed = parsePromptTemplate(template);
  return parsed.ok ? parsed.tokens : [];
}

function buildPrompt(entry: PromptStepEntry, detected: PromptStepDetect, formValues: FormValues) {
  const fields: Record<string, string> = {};
  const steps: Record<string, string> = {};
  for (const token of templateTokens(entry.template)) {
    if (token.kind === 'field') fields[token.id] = fieldText(formValues[token.id]);
    if (token.kind === 'step') {
      const output = detected.stepOutputs?.[token.id];
      steps[token.id] = fencedAgentBlock(typeof output === 'string' ? output : NO_STEP_OUTPUT);
    }
  }
  const rendered = renderPromptTemplate(entry.template, {
    fields,
    taskTitle: text(detected.taskTitle),
    taskDescription: text(detected.taskDescription),
    steps,
  });
  if (rendered.search(TEMPLATE_PERSONA_MARKER_PATTERN) !== -1) {
    throw new Error(PROMPT_STEP_PERSONAS_UNSUPPORTED);
  }
  const containment = entry.capabilities.includes('file_write')
    ? REPO_IS_DATA_ACTING_LINES
    : REPO_IS_DATA_ANSWER_LINES;
  return [
    ...(Object.keys(steps).length > 0 ? [...UNTRUSTED_FENCE_LEGEND, ''] : []),
    rendered,
    '',
    ...containment,
  ].join('\n');
}

/** The step a task runs for a prompt step it pinned; see resolveTaskStep. */
export function buildPromptStep(
  stepId: string,
  entry: PromptStepEntry,
  index: number,
): StepDefinition<PromptStepDetect, PromptStepOutput> {
  return {
    metadata: {
      id: stepId,
      workflowType: 'custom',
      index,
      title: entry.title,
      description: entry.description ?? entry.title,
      requiresCli: true,
      requiredCapabilities: entry.capabilities,
    },

    async detect(ctx): Promise<PromptStepDetect> {
      const [task] = await ctx.db
        .select({ title: schema.tasks.title, description: schema.tasks.description })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, ctx.taskId))
        .limit(1);
      const stepOutputs: Record<string, string | null> = {};
      for (const token of templateTokens(entry.template)) {
        if (token.kind !== 'step' || token.id in stepOutputs) continue;
        const [row] = await ctx.db
          .select({ output: schema.taskSteps.output })
          .from(schema.taskSteps)
          .where(
            and(
              eq(schema.taskSteps.taskId, ctx.taskId),
              eq(schema.taskSteps.stepId, token.id),
              eq(schema.taskSteps.status, 'done'),
            ),
          )
          .orderBy(desc(schema.taskSteps.round))
          .limit(1);
        stepOutputs[token.id] =
          row && row.output !== null && row.output !== undefined
            ? capStepOutput(stepOutputText(row.output, token.id))
            : null;
      }
      return {
        taskTitle: task?.title ?? '',
        taskDescription: task?.description ?? '',
        stepOutputs,
      };
    },

    form: () => entry.paramFormSchema ?? null,

    llm: {
      requiredCapabilities: entry.capabilities,
      timeoutMs: entry.timeoutMs,
      ...(entry.agentPool ? { agentPool: entry.agentPool } : {}),
      buildPrompt: ({ detected, formValues }) =>
        buildPrompt(entry, detected as PromptStepDetect, formValues),
      bypassStub: () => `Test bypass: prompt step ${stepId} ran no agent.`,
    },

    async apply(_ctx, args): Promise<PromptStepOutput> {
      const out = args.llmOutput;
      if (typeof out === 'string') {
        try {
          return { raw: out, parsed: JSON.parse(out) as unknown };
        } catch {
          return { raw: out, parsed: null };
        }
      }
      if (out === null || out === undefined) return { raw: '', parsed: null };
      return { raw: JSON.stringify(out) ?? '', parsed: out };
    },
  };
}
