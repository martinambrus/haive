import { and, desc, eq, lte } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormValues } from '@haive/shared';
import {
  isCustomStepId,
  parsePromptTemplate,
  renderPromptTemplate,
  validatePromptStep,
  type IntegrationRequirement,
  type ParsedPromptStepEntry,
  type PromptStepEntry,
} from '@haive/shared/modularity';
import { DataEdgePlanError } from '@haive/shared/data-edge-plan';
import {
  isQuotableRole,
  projectRoleOutput,
  safeParseStepOutput,
  stepOutputJsonSchema,
} from '@haive/shared/step-outputs';
import { loadPromptRoleInputs, type PromptRoleRead } from '../../prompt-role-input.js';
import { parsePromptRoleOutput } from '../../prompt-role-output.js';
import type { StepDefinition } from '../../step-definition.js';
import {
  REPO_IS_DATA_ACTING_LINES,
  REPO_IS_DATA_ANSWER_LINES,
  UNTRUSTED_FENCE_LEGEND,
  fencedAgentBlock,
} from '../_untrusted-repo.js';

export const PROMPT_STEP_OUTPUT_CAP_BYTES = 16 * 1024;
/** Every quoted step output in one prompt together, however often the template repeats a token. */
export const PROMPT_STEP_OUTPUTS_BUDGET_BYTES = 64 * 1024;
/** Every field, title, description and account text in one prompt together, the same way. */
export const PROMPT_STEP_VALUES_BUDGET_BYTES = 64 * 1024;
/** Starts the failure of a step whose pinned template no longer parses. */
export const CUSTOM_TEMPLATE_INVALID_REASON = 'custom-template-invalid';
const TEMPLATE_PROBLEMS_SHOWN = 8;
const NO_STEP_OUTPUT = '(no output recorded for this step)';

export interface PromptStepDetect {
  taskTitle: string;
  taskDescription: string;
  /** Output text of each step the template names, latest done round; null when it has none. */
  stepOutputs: Record<string, string | null>;
  roleOutputs?: Record<string, PromptRoleRead>;
}

export interface PromptStepOutput {
  raw: string;
  parsed: unknown;
  roleOutput?: ReturnType<typeof parsePromptRoleOutput>;
}

function assertPromptRoles(entry: PromptStepEntry): void {
  const problems = validatePromptStep(entry, {
    typeSlug: 'runtime',
    requiresRepository: true,
    stepIdsBefore: [],
  }).filter((p) => p.kind.startsWith('role-'));
  if (problems.length) throw new DataEdgePlanError(problems.map((p) => p.message).join(' '));
}

export function capStepOutput(text: string, cap: number = PROMPT_STEP_OUTPUT_CAP_BYTES): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= cap) return text;
  const notice = (shown: number): string =>
    `\n[truncated: ${bytes.length - shown} more bytes not shown]`;
  // notice(0) holds the most digits any notice can, so the head always leaves room for its own.
  const room = Math.max(cap - Buffer.byteLength(notice(0)), 0);
  const head = bytes.subarray(0, room).toString('utf8').replace(/�+$/, '');
  return head + notice(Buffer.byteLength(head));
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
  if (parsed.ok) return parsed.tokens;
  const shown = parsed.problems.slice(0, TEMPLATE_PROBLEMS_SHOWN).map((problem) => problem.message);
  const more = parsed.problems.length - shown.length;
  const problems = `${shown.join(' ')}${more > 0 ? ` And ${more} more.` : ''}`;
  throw new Error(
    `${CUSTOM_TEMPLATE_INVALID_REASON}: this step's template no longer passes its checks: ${problems} The task pinned it when it was created; fix it in the task type and start a new task.`,
  );
}

/** The template with its values in. Quoted step output is left out when `quote` is false: it is
 *  untrusted agent text, so nothing that selects house rules may read paths from it. */
function renderTemplate(
  entry: PromptStepEntry,
  detected: PromptStepDetect,
  formValues: FormValues,
  quote: boolean,
  integrations: Readonly<Record<string, string>> = {},
): { rendered: string; quoted: boolean } {
  // Null-prototype: a field id such as `__proto__` must land as an own key, not hit the setter.
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  const steps: Record<string, string> = Object.create(null) as Record<string, string>;
  const accounts: Record<string, string> = Object.create(null) as Record<string, string>;
  const roles: Record<string, string> = Object.create(null) as Record<string, string>;
  assertPromptRoles(entry);
  const tokens = templateTokens(entry.template);
  const quotes = tokens.filter((token) => token.kind === 'step' || token.kind === 'role').length;
  const perQuote = Math.min(
    PROMPT_STEP_OUTPUT_CAP_BYTES,
    Math.floor(PROMPT_STEP_OUTPUTS_BUDGET_BYTES / Math.max(quotes, 1)),
  );
  const values = tokens.filter(
    (token) =>
      token.kind === 'field' ||
      token.kind === 'integration' ||
      token.kind === 'task.title' ||
      token.kind === 'task.description',
  ).length;
  const perValue = Math.min(
    PROMPT_STEP_OUTPUT_CAP_BYTES,
    Math.floor(PROMPT_STEP_VALUES_BUDGET_BYTES / Math.max(values, 1)),
  );
  for (const [id, account] of Object.entries(integrations)) {
    accounts[id] = capStepOutput(account, perValue);
  }
  for (const token of tokens) {
    if (token.kind === 'field') {
      fields[token.id] = capStepOutput(fieldText(formValues[token.id]), perValue);
    }
    if (token.kind === 'step') {
      const output = detected.stepOutputs?.[token.id];
      steps[token.id] = !quote
        ? ''
        : fencedAgentBlock(
            typeof output === 'string' ? capStepOutput(output, perQuote) : NO_STEP_OUTPUT,
          );
    }
    if (token.kind === 'role') {
      if (Object.hasOwn(roles, token.id)) continue;
      const input = entry.consumesRoles?.find((i) => i.input === token.id);
      const read = detected.roleOutputs?.[token.id];
      if (!input || !isQuotableRole(input.role))
        throw new DataEdgePlanError(`${token.id}: role is not quotable`);
      if (
        read &&
        (read.role !== input.role ||
          read.contract.id !== input.contract.id ||
          read.contract.version !== input.contract.version)
      )
        throw new DataEdgePlanError(`${token.id}: role contract mismatch`);
      if (quote && !input.optional && read?.state !== 'ready')
        throw new DataEdgePlanError(`${token.id}: required input ${read?.state ?? 'absent'}`);
      const ready = read?.state === 'ready' ? safeParseStepOutput(input.contract, read.data) : null;
      if (ready && !ready.success)
        throw new DataEdgePlanError(`${token.id}: required input invalid`);
      roles[token.id] = !quote
        ? ''
        : fencedAgentBlock(
            ready?.success
              ? capStepOutput(
                  JSON.stringify(projectRoleOutput(input.role, ready.data), null, 2) ?? '',
                  perQuote,
                )
              : `(no ready output for input ${token.id}: ${read?.state ?? 'absent'})`,
          );
    }
  }
  const rendered = renderPromptTemplate(entry.template, {
    fields,
    taskTitle: capStepOutput(text(detected.taskTitle), perValue),
    taskDescription: capStepOutput(text(detected.taskDescription), perValue),
    steps,
    roles,
    integrations: accounts,
  });
  return { rendered, quoted: Object.keys(steps).length > 0 || Object.keys(roles).length > 0 };
}

function buildPrompt(
  entry: PromptStepEntry,
  detected: PromptStepDetect,
  formValues: FormValues,
  integrationAccounts?: Readonly<Record<string, string>>,
) {
  const { rendered, quoted } = renderTemplate(
    entry,
    detected,
    formValues,
    true,
    integrationAccounts,
  );
  const containment = entry.capabilities.includes('file_write')
    ? REPO_IS_DATA_ACTING_LINES
    : REPO_IS_DATA_ANSWER_LINES;
  const provided = entry.outputMode === 'structured' ? entry.providesRoles?.[0] : undefined;
  const outputInstructions = provided
    ? [
        '',
        'Return exactly one JSON object with keys "contract" and "data", without prose or code fences.',
        `The contract must be ${JSON.stringify(provided.contract)}.`,
        `The data must satisfy this host-owned JSON schema: ${JSON.stringify(stepOutputJsonSchema(provided.contract))}`,
      ]
    : [];
  return [
    ...(quoted ? [...UNTRUSTED_FENCE_LEGEND, ''] : []),
    rendered,
    ...outputInstructions,
    '',
    ...containment,
  ].join('\n');
}

const entries = new WeakMap<object, ParsedPromptStepEntry>();

/** A prompt step's tool names, and those stored tools that no longer parse; undefined for another step. */
export function promptStepTools(
  stepDef: object,
): { names: string[]; invalid: string[] } | undefined {
  const entry = entries.get(stepDef);
  if (!entry) return undefined;
  return { names: entry.tools.map((tool) => tool.name), invalid: entry.invalidTools ?? [] };
}

/** A prompt step's declared integrations, and those stored requirements that no longer parse; undefined for another step. */
export function promptStepIntegrations(
  stepDef: object,
): { requirements: IntegrationRequirement[]; invalid: string[] } | undefined {
  const entry = entries.get(stepDef);
  if (!entry) return undefined;
  return { requirements: entry.integrations ?? [], invalid: entry.invalidIntegrations ?? [] };
}

/** The ids of the requirements whose account a prompt step's template names with `{{integration:<id>.account}}`; none for any other step. */
export function promptStepAccountIds(stepDef: object): string[] {
  const entry = entries.get(stepDef);
  if (!entry) return [];
  return (entry.integrations ?? [])
    .map(({ id }) => id)
    .filter((id) => entry.template.includes(`{{integration:${id}.account}}`));
}

/** The text a file-writing prompt step's house rules read paths from: its template with the task's
 *  and the form's values, without any quoted step output. Undefined for any other step. */
export function promptStepNamedText(
  stepDef: object,
  detected: unknown,
  formValues: FormValues,
): string | undefined {
  const entry = entries.get(stepDef);
  if (!entry) return undefined;
  try {
    return renderTemplate(entry, (detected ?? {}) as PromptStepDetect, formValues, false).rendered;
  } catch {
    return undefined;
  }
}

/** The step a task runs for a prompt step it pinned; see resolveTaskStep. */
export function buildPromptStep(
  stepId: string,
  entry: ParsedPromptStepEntry,
  index: number,
): StepDefinition<PromptStepDetect, PromptStepOutput> {
  const def: StepDefinition<PromptStepDetect, PromptStepOutput> = {
    ...(entry.consumesRoles ? { consumesRoles: entry.consumesRoles } : {}),
    ...(entry.outputMode === 'structured' && entry.providesRoles
      ? { providesRoles: entry.providesRoles }
      : {}),
    editsCodeOrTests: entry.capabilities.includes('file_write'),
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
      assertPromptRoles(entry);
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
              lte(schema.taskSteps.round, ctx.round),
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
        ...(entry.consumesRoles?.length || entry.template.includes('{{role:')
          ? { roleOutputs: await loadPromptRoleInputs(ctx, stepId, entry) }
          : {}),
      };
    },

    form: () => entry.paramFormSchema ?? null,

    llm: {
      ...(entry.consumesRoles?.length || entry.template.includes('{{role:')
        ? {
            prepare: async ({
              ctx,
              detected,
            }: {
              ctx: import('../../step-definition.js').StepContext;
              detected: unknown;
            }) => {
              assertPromptRoles(entry);
              (detected as PromptStepDetect).roleOutputs = await loadPromptRoleInputs(
                ctx,
                stepId,
                entry,
              );
            },
          }
        : {}),
      requiredCapabilities: entry.capabilities,
      timeoutMs: entry.timeoutMs,
      ...(entry.agentPool ? { agentPool: entry.agentPool } : {}),
      buildPrompt: ({ detected, formValues, integrationAccounts }) =>
        buildPrompt(entry, detected as PromptStepDetect, formValues, integrationAccounts),
      bypassStub: () => `Test bypass: prompt step ${stepId} ran no agent.`,
    },

    async apply(ctx, args): Promise<PromptStepOutput> {
      assertPromptRoles(entry);
      const finish = (output: PromptStepOutput): PromptStepOutput => {
        const provided = entry.outputMode === 'structured' ? entry.providesRoles?.[0] : undefined;
        return provided
          ? { ...output, roleOutput: parsePromptRoleOutput(output.raw, provided, stepId) }
          : output;
      };
      // The runner hands apply the parsed value when the reply was JSON; the stored reply is
      // what a later {{step:}} quotes, so it is read back exactly as the CLI sent it.
      if (args.llmInvocationId) {
        const [invocation] = await ctx.db
          .select({
            rawOutput: schema.cliInvocations.rawOutput,
            parsedOutput: schema.cliInvocations.parsedOutput,
          })
          .from(schema.cliInvocations)
          .where(eq(schema.cliInvocations.id, args.llmInvocationId))
          .limit(1);
        if (invocation?.rawOutput !== null && invocation?.rawOutput !== undefined) {
          return finish({ raw: invocation.rawOutput, parsed: invocation.parsedOutput ?? null });
        }
      }
      if (entry.outputMode === 'structured' && args.llmInvocationId) {
        const provided = entry.providesRoles![0]!;
        // Missing recorded text must not fall back to a repaired CLI parse.
        return { raw: '', parsed: null, roleOutput: parsePromptRoleOutput('', provided, stepId) };
      }
      const out = args.llmOutput;
      if (typeof out === 'string') {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(out) as unknown;
        } catch {
          /* Raw mode permits prose; structured mode rejects it in finish. */
        }
        return finish({ raw: out, parsed });
      }
      if (out === null || out === undefined) return finish({ raw: '', parsed: null });
      return finish({ raw: JSON.stringify(out) ?? '', parsed: out });
    },
  };
  entries.set(def, entry);
  return def;
}
