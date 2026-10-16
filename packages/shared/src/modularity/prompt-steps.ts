import { z } from 'zod';
import { formSchemaSchema } from '../schemas/form.js';
import { collapseToLine } from '../utils/collapse-line.js';
import {
  INTEGRATION_ID_MAX_LENGTH,
  INTEGRATION_ID_PATTERN,
  integrationRequirementSchema,
  isCustomStepId,
  isPersonaId,
  parseStepId,
  PERSONA_ID_PATTERN_SOURCE,
  REPOSITORY_BOUND_CATEGORIES,
  REPOSITORY_TOKEN,
  type ComposableStepEntry,
  type IntegrationRequirement,
} from './contracts.js';
import {
  CUSTOM_TOOL_PROBLEM_KINDS,
  CUSTOM_TOOLS_MAX_PER_STEP,
  INVALID_TOOLS_SHOWN,
  customToolSchema,
  describeInvalidTools,
  shownToolName,
  validateCustomTools,
  type CustomTool,
} from './custom-tools.js';

export const PROMPT_STEP_TEMPLATE_MAX_BYTES = 16 * 1024;
export const PROMPT_STEP_TITLE_MAX_LENGTH = 512;
export const PROMPT_STEP_TIMEOUT_MIN_MS = 60_000;
export const PROMPT_STEP_TIMEOUT_MAX_MS = 30 * 60_000;
export const PROMPT_STEP_CAPABILITIES = ['tool_use', 'file_write', 'vision'] as const;
export type PromptStepCapability = (typeof PROMPT_STEP_CAPABILITIES)[number];
export const INTEGRATIONS_MAX_PER_STEP = 8;

const RESERVED_MARKER_OPEN = '[[HAIVE_';
const PREAMBLE_OPEN = '<haive_';

export const TEMPLATE_PERSONA_MARKER_PATTERN = new RegExp(
  `\\[\\[HAIVE_TEMPLATE_PERSONA:(${PERSONA_ID_PATTERN_SOURCE})\\]\\]`,
  'g',
);

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

export const promptStepEntrySchema = z.object({
  slug: z.string().refine((slug) => isCustomStepId(`custom.t.${slug}`), 'invalid step slug'),
  title: z.string().min(1).max(PROMPT_STEP_TITLE_MAX_LENGTH),
  description: z.string().optional(),
  template: z
    .string()
    .min(1)
    .refine((t) => utf8Bytes(t) <= PROMPT_STEP_TEMPLATE_MAX_BYTES, 'template is too large'),
  paramFormSchema: formSchemaSchema.optional(),
  capabilities: z.array(z.enum(PROMPT_STEP_CAPABILITIES)).default([]),
  tools: z.array(customToolSchema).max(CUSTOM_TOOLS_MAX_PER_STEP).default([]),
  integrations: z.array(integrationRequirementSchema).optional(),
  timeoutMs: z.number().int().min(PROMPT_STEP_TIMEOUT_MIN_MS).max(PROMPT_STEP_TIMEOUT_MAX_MS),
  agentPool: z.literal('*').optional(),
});
export type PromptStepEntry = z.infer<typeof promptStepEntrySchema>;

/** What a read of a stored entry returns; `invalidTools` and `invalidIntegrations` are derived on every read and never stored. */
export type ParsedPromptStepEntry = PromptStepEntry & {
  invalidTools?: string[];
  invalidIntegrations?: string[];
};

const toolLabel = (tool: unknown, index: number): string => {
  const name = typeof tool === 'object' && tool !== null ? (tool as { name?: unknown }).name : null;
  return typeof name === 'string' ? name : `#${index}`;
};

const integrationLabel = (requirement: unknown, index: number): string => {
  const id =
    typeof requirement === 'object' && requirement !== null
      ? (requirement as { id?: unknown }).id
      : null;
  return typeof id === 'string' ? id : `#${index}`;
};

// A named tool keeps the detailed checks the tool editor shows, whatever else it breaks; anything else cannot be judged.
const hasToolName = (tool: unknown): tool is CustomTool =>
  typeof tool === 'object' &&
  tool !== null &&
  typeof (tool as { name?: unknown }).name === 'string';

/** Reads the entry with its tools and integrations set aside: a tool that fails (or sits past the eighth) is named in `invalidTools`, a requirement that fails in `invalidIntegrations`; any other failure is null. */
export function parsePromptStepEntry(value: unknown): ParsedPromptStepEntry | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const {
    tools = [],
    integrations,
    ...rest
  } = value as { tools?: unknown; integrations?: unknown };
  if (!Array.isArray(tools) || (integrations !== undefined && !Array.isArray(integrations))) {
    return null;
  }
  const head = promptStepEntrySchema.safeParse({ ...rest, tools: [] });
  if (!head.success) return null;
  const kept: CustomTool[] = [];
  const invalid: string[] = [];
  tools.forEach((tool: unknown, index) => {
    const parsed = index < CUSTOM_TOOLS_MAX_PER_STEP ? customToolSchema.safeParse(tool) : null;
    if (parsed?.success) kept.push(parsed.data);
    else invalid.push(toolLabel(tool, index));
  });
  const declared: IntegrationRequirement[] = [];
  const invalidIntegrations: string[] = [];
  integrations?.forEach((requirement: unknown, index) => {
    const parsed = integrationRequirementSchema.safeParse(requirement);
    if (parsed.success) declared.push(parsed.data);
    else invalidIntegrations.push(integrationLabel(requirement, index));
  });
  return {
    ...head.data,
    tools: kept,
    ...(integrations === undefined ? {} : { integrations: declared }),
    ...(invalid.length > 0 ? { invalidTools: invalid } : {}),
    ...(invalidIntegrations.length > 0 ? { invalidIntegrations } : {}),
  };
}

/** A task's pinned prompt steps by id; an entry that does not fit its key, or whose fields other than its tools do not parse, is dropped. */
export function parsePinnedCustomSteps(raw: unknown): Record<string, ParsedPromptStepEntry> {
  const out: Record<string, ParsedPromptStepEntry> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [id, value] of Object.entries(raw)) {
    const parsedId = parseStepId(id);
    const parsed = parsePromptStepEntry(value);
    if (parsedId?.kind === 'custom' && parsed !== null && parsed.slug === parsedId.stepSlug) {
      out[id] = parsed;
    }
  }
  return out;
}

/** Fields the form shows but never submits (validateFormValues drops them), so a template cannot read them. */
const DISPLAY_ONLY_FIELD_TYPES: ReadonlySet<string> = new Set(['note', 'global-kb-status']);

export function promptStepId(typeSlug: string, stepSlug: string): string {
  return `custom.${typeSlug}.${stepSlug}`;
}

interface TokenPosition {
  raw: string;
  start: number;
  end: number;
  /** The token is the only thing on its line. */
  ownLine: boolean;
}

type PromptTokenBody =
  | { kind: 'field' | 'agent' | 'step' | 'integration'; id: string }
  | { kind: 'task.title' | 'task.description' };

export type PromptTemplateToken = TokenPosition & PromptTokenBody;

export interface PromptTemplateProblem {
  kind: string;
  raw: string;
  start: number;
  message: string;
}

export type ParsedPromptTemplate =
  { ok: true; tokens: PromptTemplateToken[] } | { ok: false; problems: PromptTemplateProblem[] };

const TOKEN_PATTERN = /\{\{([^{}\n]*)\}\}/g;

function classifyToken(body: string): PromptTokenBody | null {
  if (body === 'task.title' || body === 'task.description') return { kind: body };
  const colon = body.indexOf(':');
  if (colon < 0) return null;
  const head = body.slice(0, colon);
  const id = body.slice(colon + 1);
  if (head === 'field' && id !== '') return { kind: 'field', id };
  if (head === 'agent' || head === 'step' || head === 'integration') return { kind: head, id };
  return null;
}

function scanTemplate(template: string): {
  tokens: PromptTemplateToken[];
  unknown: PromptTemplateProblem[];
} {
  const tokens: PromptTemplateToken[] = [];
  const unknown: PromptTemplateProblem[] = [];
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    const start = match.index;
    const end = start + raw.length;
    const body = classifyToken(match[1]!);
    if (body === null) {
      unknown.push({
        kind: 'unknown-token',
        raw,
        start,
        message: `${raw} is not a template token.`,
      });
      continue;
    }
    const ownLine =
      (start === 0 || template[start - 1] === '\n') &&
      (end === template.length || template[end] === '\n' || template.startsWith('\r\n', end));
    tokens.push({ ...body, raw, start, end, ownLine });
  }
  return { tokens, unknown };
}

/** The template with each `{{step:<id>}}` token whose id `rename` maps to a new id rewritten. */
export function rewriteStepTokens(template: string, rename: (id: string) => string | null): string {
  let out = '';
  let at = 0;
  for (const token of scanTemplate(template).tokens) {
    if (token.kind !== 'step') continue;
    const next = rename(token.id);
    if (next === null || next === token.id) continue;
    out += `${template.slice(at, token.start)}{{step:${next}}}`;
    at = token.end;
  }
  return at === 0 ? template : out + template.slice(at);
}

export function parsePromptTemplate(template: string): ParsedPromptTemplate {
  const { tokens, unknown } = scanTemplate(template);
  return unknown.length > 0 ? { ok: false, problems: unknown } : { ok: true, tokens };
}

export interface PromptTemplateValues {
  fields: Readonly<Record<string, string>>;
  taskTitle: string;
  taskDescription: string;
  /** Each value arrives already fenced; it is inserted as it is. */
  steps: Readonly<Record<string, string>>;
  /** The account each requirement id stands for, as text; the renderer keeps it to one line. */
  integrations: Readonly<Record<string, string>>;
}

export class PromptTemplateRenderError extends Error {
  constructor(
    readonly kind: 'step-token-not-own-line' | 'persona-id-invalid',
    readonly token: string,
  ) {
    super(`${kind}: ${token}`);
    this.name = 'PromptTemplateRenderError';
  }
}

const own = (record: Readonly<Record<string, string>>, key: string): string =>
  Object.hasOwn(record, key) ? record[key]! : '';

const ACCOUNT_SUFFIX = '.account';

/** The requirement id of an `{{integration:<id>.account}}` token, from what follows `integration:`; null for any other shape. */
function accountRequirementId(body: string): string | null {
  if (!body.endsWith(ACCOUNT_SUFFIX)) return null;
  const id = body.slice(0, -ACCOUNT_SUFFIX.length);
  return id !== '' && !id.includes('.') ? id : null;
}

function tokenValue(token: PromptTemplateToken, values: PromptTemplateValues): string | null {
  switch (token.kind) {
    case 'field':
      return own(values.fields, token.id);
    case 'task.title':
      return values.taskTitle;
    case 'task.description':
      return values.taskDescription;
    case 'step':
      return own(values.steps, token.id);
    case 'integration': {
      const requirementId = accountRequirementId(token.id);
      return requirementId === null ? null : own(values.integrations, requirementId);
    }
    default:
      return null;
  }
}

/** One space after the opening bracket(s) breaks a marker or a block tag; the same break
 *  is used for both so a value is neutralised one way wherever it lands. */
function neutralise(text: string, dynamic: ReadonlyArray<readonly [number, number]>): string {
  const cuts: number[] = [];
  for (const match of text.matchAll(/\[\[HAIVE_/g)) {
    const from = match.index;
    const to = from + RESERVED_MARKER_OPEN.length;
    if (dynamic.some(([s, e]) => from < e && to > s)) cuts.push(from + 2);
  }
  const lead = /^\s*</.exec(text);
  if (lead && text.startsWith(PREAMBLE_OPEN, lead[0].length - 1)) cuts.push(lead[0].length);
  let out = text;
  for (const at of cuts.sort((a, b) => b - a)) out = `${out.slice(0, at)} ${out.slice(at)}`;
  return out;
}

export function renderPromptTemplate(template: string, values: PromptTemplateValues): string {
  const { tokens } = scanTemplate(template);
  const dynamic: Array<[number, number]> = [];
  let out = '';
  let cursor = 0;
  for (const token of tokens) {
    out += template.slice(cursor, token.start);
    cursor = token.end;
    if (token.kind === 'agent') {
      if (!isPersonaId(token.id))
        throw new PromptTemplateRenderError('persona-id-invalid', token.raw);
      out += `[[HAIVE_TEMPLATE_PERSONA:${token.id}]]`;
      continue;
    }
    const value = tokenValue(token, values);
    if (value === null) {
      out += token.raw;
      continue;
    }
    if (token.kind === 'step' && !token.ownLine) {
      throw new PromptTemplateRenderError('step-token-not-own-line', token.raw);
    }
    const keepsLines = token.kind === 'step' || (token.ownLine && token.kind !== 'integration');
    const text = keepsLines ? value : collapseToLine(value);
    dynamic.push([out.length, out.length + text.length]);
    out += text;
  }
  out += template.slice(cursor);
  return neutralise(out, dynamic);
}

export const PROMPT_STEP_PROBLEM_KINDS = [
  'unknown-token',
  'field-not-declared',
  'persona-id-invalid',
  'reserved-marker-in-template',
  'template-too-large',
  'timeout-out-of-range',
  'capability-not-allowed',
  'persona-without-repository',
  'file-write-without-repository',
  'step-id-too-long',
  'step-token-not-earlier',
  'step-token-not-quotable',
  'step-token-not-own-line',
  ...CUSTOM_TOOL_PROBLEM_KINDS,
  'tool-no-longer-valid',
  'too-many-integrations',
  'integration-provider-pinned',
  'integration-category-duplicate',
  'integration-id-duplicate',
  'integration-id-invalid',
  'integration-category-unknown',
  'integration-without-repository',
  'integration-no-longer-valid',
  'integration-not-declared',
  'integration-property-unknown',
] as const;
export type PromptStepProblemKind = (typeof PROMPT_STEP_PROBLEM_KINDS)[number];

export interface PromptStepProblem extends PromptTemplateProblem {
  kind: PromptStepProblemKind;
  param?: string;
}

export type PromptStepValidationInput = Pick<
  PromptStepEntry,
  'template' | 'paramFormSchema' | 'timeoutMs'
> & {
  capabilities: readonly string[];
  slug?: string;
  tools?: readonly CustomTool[];
  invalidTools?: readonly string[];
  integrations?: readonly IntegrationRequirement[];
  invalidIntegrations?: readonly string[];
};

/** The width of every step_id column a custom step id is stored in (task_steps, task_step_cli_choices). */
export const STEP_ID_MAX_LENGTH = 128;

export interface PromptStepValidationContext {
  typeSlug: string;
  requiresRepository: boolean;
  stepIdsBefore: readonly string[];
  /** When given, a quoted step must be in it: the steps whose stored output is purely agent-authored. */
  quotableStepIds?: ReadonlySet<string>;
  /** When given, a requirement's category must be in it: the categories this install registers. */
  integrationCategoryIds?: ReadonlySet<string>;
}

const NO_TOKEN = { raw: '', start: 0 } as const;

function integrationProblems(
  entry: PromptStepValidationInput,
  ctx: PromptStepValidationContext,
): PromptStepProblem[] {
  const problems: PromptStepProblem[] = [];
  const add = (kind: PromptStepProblemKind, message: string, raw = '') =>
    problems.push({ kind, message, raw, start: 0 });
  // The web editor checks the stored entry as it was read, so an item can be anything; one the schema cannot read is named, not judged.
  const requirements: IntegrationRequirement[] = [];
  const unreadable: string[] = [];
  (entry.integrations ?? []).forEach((item: unknown, index) => {
    const parsed = integrationRequirementSchema.safeParse(item);
    if (parsed.success) requirements.push(parsed.data);
    else unreadable.push(integrationLabel(item, index));
  });
  if (requirements.length > INTEGRATIONS_MAX_PER_STEP) {
    add(
      'too-many-integrations',
      `A step can declare at most ${INTEGRATIONS_MAX_PER_STEP} integrations.`,
    );
  }
  const ids = new Set<string>();
  const repeatedIds = new Set<string>();
  const categories = new Set<string>();
  for (const { id, category, provider } of requirements) {
    const name = shownToolName(id);
    if (provider !== undefined) {
      add(
        'integration-provider-pinned',
        `The integration ${name} pins the provider ${shownToolName(provider)}; a prompt step names a category and Haive resolves the account.`,
        name,
      );
    }
    if (!INTEGRATION_ID_PATTERN.test(id)) {
      add(
        'integration-id-invalid',
        `The integration id ${name} must start with a lowercase letter and use only lowercase letters, digits and hyphens, up to ${INTEGRATION_ID_MAX_LENGTH} characters.`,
        name,
      );
    }
    if (ids.has(id) && !repeatedIds.has(id)) {
      repeatedIds.add(id);
      add(
        'integration-id-duplicate',
        `Two integrations of this step have the id ${name}; give each its own id.`,
        name,
      );
    }
    ids.add(id);
    if (category === undefined) continue;
    const shown = shownToolName(category);
    if (categories.has(category)) {
      add(
        'integration-category-duplicate',
        `The integration ${name} asks for the category ${shown}, which another integration of this step already asks for; a step gets one account per category.`,
        name,
      );
    }
    categories.add(category);
    if (ctx.integrationCategoryIds && !ctx.integrationCategoryIds.has(category)) {
      add(
        'integration-category-unknown',
        `The integration ${name} asks for the category ${shown}, which this install does not have.`,
        name,
      );
    }
    if (!ctx.requiresRepository && REPOSITORY_BOUND_CATEGORIES.has(category)) {
      add(
        'integration-without-repository',
        `The integration ${name} asks for the category ${shown}, which works on a repository, and this task type has none.`,
        name,
      );
    }
  }
  const invalid = [...unreadable, ...(entry.invalidIntegrations ?? [])];
  for (const name of invalid.slice(0, INVALID_TOOLS_SHOWN)) {
    add(
      'integration-no-longer-valid',
      `The integration ${describeInvalidTools([name])} no longer passes its checks; fix it or remove it.`,
      shownToolName(name),
    );
  }
  if (invalid.length > INVALID_TOOLS_SHOWN) {
    add(
      'integration-no-longer-valid',
      `${invalid.length - INVALID_TOOLS_SHOWN} more integrations no longer pass their checks.`,
    );
  }
  return problems;
}

export function validatePromptStep(
  entry: PromptStepValidationInput,
  ctx: PromptStepValidationContext,
): PromptStepProblem[] {
  const problems: PromptStepProblem[] = [];
  const add = (
    kind: PromptStepProblemKind,
    message: string,
    at: { raw: string; start: number; param?: string } = NO_TOKEN,
  ) =>
    problems.push({
      kind,
      message,
      raw: at.raw,
      start: at.start,
      ...(at.param === undefined ? {} : { param: at.param }),
    });

  const { tokens, unknown } = scanTemplate(entry.template);
  for (const u of unknown) add('unknown-token', u.message, u);

  const declared = new Set(
    (entry.paramFormSchema?.fields ?? [])
      .flatMap((f) => (f.type === 'accordion' ? f.items.flatMap((item) => item.fields) : [f]))
      .filter((f) => !DISPLAY_ONLY_FIELD_TYPES.has(f.type))
      .map((f) => f.id),
  );
  const earlier = new Set(ctx.stepIdsBefore);
  const requirementIds = new Set(
    (entry.integrations ?? []).flatMap((item: unknown) => {
      const parsed = integrationRequirementSchema.safeParse(item);
      return parsed.success ? [parsed.data.id] : [];
    }),
  );
  for (const token of tokens) {
    switch (token.kind) {
      case 'field':
        if (!declared.has(token.id)) {
          add(
            'field-not-declared',
            `${token.raw} names a field the step's form does not declare.`,
            token,
          );
        }
        break;
      case 'agent':
        if (!isPersonaId(token.id)) {
          add('persona-id-invalid', `${token.raw} is not a persona id.`, token);
        }
        if (!ctx.requiresRepository) {
          add(
            'persona-without-repository',
            `${token.raw} needs a repository to read the persona from.`,
            token,
          );
        }
        break;
      case 'integration': {
        const requirementId = accountRequirementId(token.id);
        if (requirementId === null) {
          add(
            'integration-property-unknown',
            `${token.raw} must be written {{integration:<id>.account}}; account is the only property an integration has.`,
            token,
          );
        } else if (!requirementIds.has(requirementId)) {
          add(
            'integration-not-declared',
            `${token.raw} names an integration the step does not declare.`,
            token,
          );
        }
        break;
      }
      case 'step':
        if (!earlier.has(token.id)) {
          add(
            'step-token-not-earlier',
            `${token.raw} is not a step that runs before this one.`,
            token,
          );
        } else if (ctx.quotableStepIds && !ctx.quotableStepIds.has(token.id)) {
          add(
            'step-token-not-quotable',
            `${token.raw} names ${token.id}, whose output can carry a person's words; a step can quote only a step whose output an agent wrote.`,
            token,
          );
        }
        if (!token.ownLine) {
          add('step-token-not-own-line', `${token.raw} must be alone on its line.`, token);
        }
        break;
      default:
        break;
    }
  }

  const staticText = entry.template.replace(TOKEN_PATTERN, '');
  if (
    entry.template.includes(RESERVED_MARKER_OPEN) ||
    staticText.includes(RESERVED_MARKER_OPEN) ||
    staticText.trimStart().startsWith(PREAMBLE_OPEN)
  ) {
    add(
      'reserved-marker-in-template',
      `The template may not carry ${RESERVED_MARKER_OPEN} or open with ${PREAMBLE_OPEN}.`,
    );
  }

  if (utf8Bytes(entry.template) > PROMPT_STEP_TEMPLATE_MAX_BYTES) {
    add('template-too-large', `The template is over ${PROMPT_STEP_TEMPLATE_MAX_BYTES} bytes.`);
  }
  if (!(
    entry.timeoutMs >= PROMPT_STEP_TIMEOUT_MIN_MS && entry.timeoutMs <= PROMPT_STEP_TIMEOUT_MAX_MS
  )) {
    add(
      'timeout-out-of-range',
      `The timeout must be between ${PROMPT_STEP_TIMEOUT_MIN_MS} and ${PROMPT_STEP_TIMEOUT_MAX_MS} ms.`,
    );
  }
  for (const capability of entry.capabilities) {
    if (!(PROMPT_STEP_CAPABILITIES as readonly string[]).includes(capability)) {
      add(
        'capability-not-allowed',
        `The capability ${capability} is not allowed on a prompt step.`,
      );
    }
  }
  if (
    entry.slug !== undefined &&
    promptStepId(ctx.typeSlug, entry.slug).length > STEP_ID_MAX_LENGTH
  ) {
    add(
      'step-id-too-long',
      `The step id ${promptStepId(ctx.typeSlug, entry.slug)} is longer than ${STEP_ID_MAX_LENGTH} characters; use a shorter slug.`,
    );
  }
  if (!ctx.requiresRepository && entry.capabilities.includes('file_write')) {
    add(
      'file-write-without-repository',
      'A prompt step can write files only in a task type that requires a repository.',
    );
  }
  const tools: CustomTool[] = [];
  const untyped: string[] = [];
  (entry.tools ?? []).forEach((tool: unknown, index) => {
    if (hasToolName(tool)) tools.push(tool);
    else untyped.push(toolLabel(tool, index));
  });
  for (const problem of validateCustomTools(tools, ctx)) {
    add(problem.kind, problem.message, { raw: problem.tool, start: 0, param: problem.param });
  }
  const invalid = [...untyped, ...(entry.invalidTools ?? [])];
  for (const name of invalid.slice(0, INVALID_TOOLS_SHOWN)) {
    add(
      'tool-no-longer-valid',
      `The tool ${describeInvalidTools([name])} no longer passes its checks; fix it or remove it.`,
      { raw: shownToolName(name), start: 0 },
    );
  }
  if (invalid.length > INVALID_TOOLS_SHOWN) {
    add(
      'tool-no-longer-valid',
      `${invalid.length - INVALID_TOOLS_SHOWN} more tools no longer pass their checks.`,
    );
  }
  problems.push(...integrationProblems(entry, ctx));
  return problems;
}

export function derivePromptStepComposable(
  entry: Pick<
    PromptStepEntry,
    'slug' | 'title' | 'capabilities' | 'paramFormSchema' | 'integrations'
  >,
  typeSlug: string,
  requiresRepository: boolean,
): ComposableStepEntry {
  const writesFiles = entry.capabilities.includes('file_write');
  let requires: ComposableStepEntry['requires'] = [];
  if (writesFiles) {
    requires = [{ needs: 'worktree', reason: 'Works inside the task worktree.' }];
  } else if (requiresRepository) {
    requires = [{ needs: REPOSITORY_TOKEN, reason: 'Reads the repository.' }];
  }
  return {
    stepId: promptStepId(typeSlug, entry.slug),
    label: entry.title,
    group: 'build',
    dispatchesCli: true,
    requires,
    provides: [],
    ...(writesFiles ? { removes: ['clean-tree'] } : {}),
    ...(entry.paramFormSchema ? { paramFormSchema: entry.paramFormSchema } : {}),
    ...(entry.integrations && entry.integrations.length > 0
      ? { integrations: entry.integrations }
      : {}),
  };
}
