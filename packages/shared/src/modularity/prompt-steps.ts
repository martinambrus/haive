import { z } from 'zod';
import { formSchemaSchema } from '../schemas/form.js';
import { collapseToLine } from '../utils/collapse-line.js';
import {
  isCustomStepId,
  isPersonaId,
  parseStepId,
  PERSONA_ID_PATTERN_SOURCE,
  REPOSITORY_TOKEN,
  type ComposableStepEntry,
} from './contracts.js';
import {
  CUSTOM_TOOL_PROBLEM_KINDS,
  CUSTOM_TOOLS_MAX_PER_STEP,
  customToolSchema,
  validateCustomTools,
  type CustomTool,
} from './custom-tools.js';

export const PROMPT_STEP_TEMPLATE_MAX_BYTES = 16 * 1024;
export const PROMPT_STEP_TITLE_MAX_LENGTH = 512;
export const PROMPT_STEP_TIMEOUT_MIN_MS = 60_000;
export const PROMPT_STEP_TIMEOUT_MAX_MS = 30 * 60_000;
export const PROMPT_STEP_CAPABILITIES = ['tool_use', 'file_write', 'vision'] as const;
export type PromptStepCapability = (typeof PROMPT_STEP_CAPABILITIES)[number];

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
  timeoutMs: z.number().int().min(PROMPT_STEP_TIMEOUT_MIN_MS).max(PROMPT_STEP_TIMEOUT_MAX_MS),
  agentPool: z.literal('*').optional(),
});
export type PromptStepEntry = z.infer<typeof promptStepEntrySchema>;

/** A task's pinned prompt steps by id; an entry that does not parse or fit its key is dropped. */
export function parsePinnedCustomSteps(raw: unknown): Record<string, PromptStepEntry> {
  const out: Record<string, PromptStepEntry> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [id, value] of Object.entries(raw)) {
    const parsedId = parseStepId(id);
    const parsed = promptStepEntrySchema.safeParse(value);
    if (parsedId?.kind === 'custom' && parsed.success && parsed.data.slug === parsedId.stepSlug) {
      out[id] = parsed.data;
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
    const text = token.kind === 'step' || token.ownLine ? value : collapseToLine(value);
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
  'integration-token',
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
  'tools-not-supported-yet',
] as const;
export type PromptStepProblemKind = (typeof PROMPT_STEP_PROBLEM_KINDS)[number];

export interface PromptStepProblem extends PromptTemplateProblem {
  kind: PromptStepProblemKind;
}

export type PromptStepValidationInput = Pick<
  PromptStepEntry,
  'template' | 'paramFormSchema' | 'timeoutMs'
> & { capabilities: readonly string[]; slug?: string; tools?: readonly CustomTool[] };

/** The width of every step_id column a custom step id is stored in (task_steps, task_step_cli_choices). */
export const STEP_ID_MAX_LENGTH = 128;

export interface PromptStepValidationContext {
  typeSlug: string;
  requiresRepository: boolean;
  stepIdsBefore: readonly string[];
  /** When given, a quoted step must be in it: the steps whose stored output is purely agent-authored. */
  quotableStepIds?: ReadonlySet<string>;
}

const NO_TOKEN = { raw: '', start: 0 } as const;

export function validatePromptStep(
  entry: PromptStepValidationInput,
  ctx: PromptStepValidationContext,
): PromptStepProblem[] {
  const problems: PromptStepProblem[] = [];
  const add = (
    kind: PromptStepProblemKind,
    message: string,
    at: { raw: string; start: number } = NO_TOKEN,
  ) => problems.push({ kind, message, raw: at.raw, start: at.start });

  const { tokens, unknown } = scanTemplate(entry.template);
  for (const u of unknown) add('unknown-token', u.message, u);

  const declared = new Set(
    (entry.paramFormSchema?.fields ?? [])
      .flatMap((f) => (f.type === 'accordion' ? f.items.flatMap((item) => item.fields) : [f]))
      .filter((f) => !DISPLAY_ONLY_FIELD_TYPES.has(f.type))
      .map((f) => f.id),
  );
  const earlier = new Set(ctx.stepIdsBefore);
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
      case 'integration':
        add('integration-token', `${token.raw} is not supported yet.`, token);
        break;
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
  const tools = entry.tools ?? [];
  for (const problem of validateCustomTools(tools, ctx)) {
    add(problem.kind, problem.message, { raw: problem.tool, start: 0 });
  }
  if (tools.length > 0)
    add('tools-not-supported-yet', 'Tools on a prompt step are not supported yet.');
  return problems;
}

export function derivePromptStepComposable(
  entry: Pick<PromptStepEntry, 'slug' | 'title' | 'capabilities' | 'paramFormSchema'>,
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
  };
}
