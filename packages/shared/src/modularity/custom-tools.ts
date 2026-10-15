import { z } from 'zod';
import { collapseToLine } from '../utils/collapse-line.js';
import { HIDDEN_CHARACTER } from '../utils/hidden-characters.js';
import { TOOL_NAME_PATTERN } from './contracts.js';

export const CUSTOM_TOOLS_MAX_PER_STEP = 8;
export const CUSTOM_TOOL_PARAMS_MAX = 10;
export const CUSTOM_TOOL_NAME_MAX_LENGTH = 40;
export const CUSTOM_TOOL_RESERVED_NAMES: readonly string[] = [
  'rag_search',
  'ddev_status',
  'ddev_logs',
  'ddev_restart',
];
export const CUSTOM_TOOL_DESCRIPTION_MAX_LENGTH = 1024;
export const CUSTOM_TOOL_PARAM_DESCRIPTION_MAX_LENGTH = 300;
export const CUSTOM_TOOL_URL_MAX_LENGTH = 2048;
export const CUSTOM_TOOL_TIMEOUT_MIN_MS = 1_000;
export const CUSTOM_TOOL_TIMEOUT_MAX_MS = 30_000;
export const CUSTOM_TOOL_RESPONSE_MIN_BYTES = 1_024;
export const CUSTOM_TOOL_RESPONSE_MAX_BYTES = 65_536;
export const RAG_QUERY_TOP_K_MIN = 1;
export const RAG_QUERY_TOP_K_MAX = 20;
export const INVALID_TOOLS_SHOWN = 8;

const INVALID_TOOL_NAME_SHOWN_LENGTH = 64;
const CUSTOM_TOOL_TIMEOUT_DEFAULT_MS = 10_000;
const CUSTOM_TOOL_RESPONSE_DEFAULT_BYTES = 32_768;
const CUSTOM_TOOL_STRING_MAX_LENGTH = 512;
const CUSTOM_TOOL_STRING_DEFAULT_LENGTH = 128;
const CUSTOM_TOOL_ENUM_MAX_VALUES = 20;
const CUSTOM_TOOL_ENUM_VALUE_MAX_LENGTH = 64;
const RAG_QUERY_MAX_LENGTH = 500;
const RAG_QUERY_TOP_K_DEFAULT = 8;
const RAG_QUERY_SCOPES = ['project', 'global', 'all'] as const;

// C0 (TAB, LF and CR included), DEL and C1.
const hasControl = (text: string): boolean => {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

const isPlainText = (value: unknown, max: number): boolean =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= max &&
  !hasControl(value) &&
  !HIDDEN_CHARACTER.test(value) &&
  value.isWellFormed();

const plainText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !hasControl(text), 'must not contain control characters');

const wholeBetween = (min: number, max: number) => z.number().int().min(min).max(max);
const inRange = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

const nameSchema = z.string().regex(TOOL_NAME_PATTERN);

const paramBase = {
  name: nameSchema,
  description: plainText(CUSTOM_TOOL_PARAM_DESCRIPTION_MAX_LENGTH),
  required: z.boolean().default(false),
};

const customToolParamSchema = z.discriminatedUnion('type', [
  z.object({
    ...paramBase,
    type: z.literal('string'),
    maxLength: wholeBetween(1, CUSTOM_TOOL_STRING_MAX_LENGTH).default(
      CUSTOM_TOOL_STRING_DEFAULT_LENGTH,
    ),
  }),
  z.object({
    ...paramBase,
    type: z.literal('integer'),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  }),
  z.object({ ...paramBase, type: z.literal('boolean') }),
  z.object({
    ...paramBase,
    type: z.literal('enum'),
    values: z
      .array(plainText(CUSTOM_TOOL_ENUM_VALUE_MAX_LENGTH))
      .min(1)
      .max(CUSTOM_TOOL_ENUM_MAX_VALUES),
  }),
]);
export type CustomToolParam = z.infer<typeof customToolParamSchema>;

const toolBase = {
  name: nameSchema,
  description: plainText(CUSTOM_TOOL_DESCRIPTION_MAX_LENGTH),
  maxResponseBytes: wholeBetween(
    CUSTOM_TOOL_RESPONSE_MIN_BYTES,
    CUSTOM_TOOL_RESPONSE_MAX_BYTES,
  ).default(CUSTOM_TOOL_RESPONSE_DEFAULT_BYTES),
};

export const customToolSchema = z.discriminatedUnion('action', [
  z.object({
    ...toolBase,
    action: z.literal('http-get'),
    url: z.string().min(1).max(CUSTOM_TOOL_URL_MAX_LENGTH),
    query: z.array(nameSchema).max(CUSTOM_TOOL_PARAMS_MAX).default([]),
    params: z.array(customToolParamSchema).max(CUSTOM_TOOL_PARAMS_MAX).default([]),
    timeoutMs: wholeBetween(CUSTOM_TOOL_TIMEOUT_MIN_MS, CUSTOM_TOOL_TIMEOUT_MAX_MS).default(
      CUSTOM_TOOL_TIMEOUT_DEFAULT_MS,
    ),
  }),
  z.object({
    ...toolBase,
    action: z.literal('rag-query'),
    scope: z.enum(RAG_QUERY_SCOPES),
    topK: wholeBetween(RAG_QUERY_TOP_K_MIN, RAG_QUERY_TOP_K_MAX).default(RAG_QUERY_TOP_K_DEFAULT),
  }),
]);
export type CustomTool = z.infer<typeof customToolSchema>;
export type HttpGetTool = Extract<CustomTool, { action: 'http-get' }>;
export type RagQueryTool = Extract<CustomTool, { action: 'rag-query' }>;

export const CUSTOM_TOOL_PROBLEM_KINDS = [
  'too-many-tools',
  'tool-name-invalid',
  'tool-name-reserved',
  'tool-name-duplicate',
  'tool-description-invalid',
  'tool-url-invalid',
  'tool-url-not-https',
  'tool-url-userinfo',
  'tool-url-fragment',
  'tool-host-ip-literal',
  'tool-host-not-public',
  'tool-placeholder-outside-path',
  'tool-param-undeclared',
  'tool-param-unused',
  'tool-param-reused',
  'tool-param-duplicate',
  'tool-param-invalid',
  'tool-too-many-params',
  'tool-timeout-out-of-range',
  'tool-response-cap-out-of-range',
  'tool-top-k-out-of-range',
  'tool-scope-needs-repository',
] as const;
export type CustomToolProblemKind = (typeof CUSTOM_TOOL_PROBLEM_KINDS)[number];

/** A stored tool name that failed to parse, as a message may carry it: on one line, at most 64 characters. */
export function shownToolName(raw: string): string {
  const cut = raw.length > INVALID_TOOL_NAME_SHOWN_LENGTH;
  const head = cut ? raw.slice(0, INVALID_TOOL_NAME_SHOWN_LENGTH - 1) : raw;
  const line = collapseToLine(head.replace(/[\uD800-\uDBFF]$/, ''));
  if (line === '') return '(unnamed)';
  return cut ? `${line}…` : line;
}

function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest > 0 ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

/** The names of tools that no longer parse, for a message: at most 8 as inline code, then how many more. */
export function describeInvalidTools(names: readonly string[]): string {
  const shown = names.slice(0, INVALID_TOOLS_SHOWN).map((name) => inlineCode(shownToolName(name)));
  const more = names.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

export interface CustomToolProblem {
  kind: CustomToolProblemKind;
  /** The name of the tool it is about, as written; empty for a problem of the whole list. */
  tool: string;
  message: string;
}

export interface CustomToolValidationContext {
  requiresRepository: boolean;
}

type Add = (kind: CustomToolProblemKind, message: string) => void;

const PLACEHOLDER = /\{([^{}]*)\}/g;
const URL_PARTS = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const INTERNAL_SUFFIX = /\.(?:local|internal|localhost)$/;

interface UrlParts {
  scheme: string;
  authority: string;
  path: string;
  query: string | undefined;
  fragment: string | undefined;
}

function splitUrl(url: string): UrlParts | null {
  const match = URL_PARTS.exec(url);
  if (!match) return null;
  return {
    scheme: match[1]!,
    authority: match[2]!,
    path: match[3]!,
    query: match[4],
    fragment: match[5],
  };
}

const placeholdersIn = (text: string): string[] =>
  Array.from(text.matchAll(PLACEHOLDER), (match) => match[1]!);

const pathPlaceholders = (url: string): string[] => placeholdersIn(splitUrl(url)?.path ?? '');

// A path placeholder cannot be left out of a call, so its param is required whatever its flag says.
function requiredNames(tool: HttpGetTool): string[] {
  const inPath = new Set(pathPlaceholders(tool.url));
  return tool.params.filter((p) => p.required || inPath.has(p.name)).map((p) => p.name);
}

// The URL parser canonicalizes the host: 127.1, 0x7f.0.0.1 and 2130706433 all read as 127.0.0.1.
function checkHost(authority: string, add: Add): void {
  let host: string;
  try {
    host = new URL(`https://${authority}/`).hostname;
  } catch {
    add('tool-url-invalid', 'The URL host is not valid.');
    return;
  }
  const bare = host.replace(/\.+$/, '');
  if (bare.startsWith('[') || IPV4.test(bare)) {
    add('tool-host-ip-literal', `The URL host ${host} is an IP address; use a DNS name.`);
  } else if (!bare.includes('.') || INTERNAL_SUFFIX.test(bare)) {
    add(
      'tool-host-not-public',
      `The URL host ${host} is not a public DNS name: not localhost, not a single-label name, and not a .local, .internal or .localhost name.`,
    );
  } else if (host.replace(/\.$/, '').split('.').includes('')) {
    add('tool-url-invalid', 'The URL host is not valid.');
  }
}

/** Reports the problems of the url and returns the names it uses, or null when it cannot be read. */
function checkUrl(url: string, add: Add): string[] | null {
  if (
    url === '' ||
    url.length > CUSTOM_TOOL_URL_MAX_LENGTH ||
    hasControl(url) ||
    /[\s\\]/.test(url)
  ) {
    add(
      'tool-url-invalid',
      `The URL must be one https:// address of at most ${CUSTOM_TOOL_URL_MAX_LENGTH} characters, with no spaces, control characters or backslashes.`,
    );
    return null;
  }
  const parts = splitUrl(url);
  if (!parts) {
    add('tool-url-not-https', 'The URL must start with https://.');
    return null;
  }
  if (parts.scheme !== 'https') add('tool-url-not-https', 'The URL must start with https://.');
  if (parts.authority.includes('@')) {
    add('tool-url-userinfo', 'The URL must not carry a user name or password.');
  }
  if (parts.fragment !== undefined)
    add('tool-url-fragment', 'The URL must not carry a # fragment.');

  const regions = [parts.authority, parts.path, parts.query ?? '', parts.fragment ?? ''];
  if (regions.some((region) => /[{}]/.test(region.replace(PLACEHOLDER, '')))) {
    add('tool-url-invalid', 'Every brace in the URL must belong to a {name} placeholder.');
    return null;
  }
  const outside = [parts.authority, parts.query ?? '', parts.fragment ?? ''].flatMap(
    placeholdersIn,
  );
  if (outside.length > 0) {
    add('tool-placeholder-outside-path', 'A {placeholder} may only stand in the path of the URL.');
  }
  if (!parts.authority.includes('@') && !/[{}]/.test(parts.authority)) {
    checkHost(parts.authority, add);
  }
  return [...placeholdersIn(parts.path), ...outside];
}

function paramProblem(param: CustomToolParam, inPath: boolean): string | null {
  if (!TOOL_NAME_PATTERN.test(param.name)) {
    return `its name must start with a lowercase letter and use only lowercase letters, digits and underscores, up to ${CUSTOM_TOOL_NAME_MAX_LENGTH} characters`;
  }
  if (!isPlainText(param.description, CUSTOM_TOOL_PARAM_DESCRIPTION_MAX_LENGTH)) {
    return `its description must be 1 to ${CUSTOM_TOOL_PARAM_DESCRIPTION_MAX_LENGTH} characters with no control or invisible characters`;
  }
  switch (param.type) {
    case 'string':
      return inRange(param.maxLength, 1, CUSTOM_TOOL_STRING_MAX_LENGTH)
        ? null
        : `maxLength must be a whole number from 1 to ${CUSTOM_TOOL_STRING_MAX_LENGTH}`;
    case 'integer':
      if (
        (param.min !== undefined && !Number.isInteger(param.min)) ||
        (param.max !== undefined && !Number.isInteger(param.max))
      ) {
        return 'min and max must be whole numbers';
      }
      return param.min !== undefined && param.max !== undefined && param.min > param.max
        ? 'min must not be above max'
        : null;
    case 'enum':
      if (
        !Array.isArray(param.values) ||
        param.values.length < 1 ||
        param.values.length > CUSTOM_TOOL_ENUM_MAX_VALUES
      ) {
        return `values must list 1 to ${CUSTOM_TOOL_ENUM_MAX_VALUES} choices`;
      }
      if (!param.values.every((v) => isPlainText(v, CUSTOM_TOOL_ENUM_VALUE_MAX_LENGTH))) {
        return `each value must be 1 to ${CUSTOM_TOOL_ENUM_VALUE_MAX_LENGTH} characters with no control or invisible characters`;
      }
      if (inPath && param.values.some(refusedInPath)) {
        return 'a value used in the URL path must not be . or .., and must not contain / or \\';
      }
      return new Set(param.values).size === param.values.length ? null : 'values must not repeat';
    default:
      return null;
  }
}

function checkParams(
  params: readonly CustomToolParam[],
  inPath: ReadonlySet<string>,
  add: Add,
): void {
  if (params.length > CUSTOM_TOOL_PARAMS_MAX) {
    add('tool-too-many-params', `A tool can have at most ${CUSTOM_TOOL_PARAMS_MAX} parameters.`);
  }
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const param of params) {
    if (seen.has(param.name)) repeated.add(param.name);
    seen.add(param.name);
    const problem = paramProblem(param, inPath.has(param.name));
    if (problem !== null) {
      add(
        'tool-param-invalid',
        `The parameter ${JSON.stringify(param.name)} is not valid: ${problem}.`,
      );
    }
  }
  for (const name of repeated) add('tool-param-duplicate', `Two parameters are named ${name}.`);
}

function checkUsage(declared: readonly string[], used: readonly string[], add: Add): void {
  const known = new Set(declared);
  for (const name of new Set(used)) {
    if (!known.has(name)) {
      add(
        'tool-param-undeclared',
        `The URL or query list uses ${JSON.stringify(name)}, which is not a declared parameter.`,
      );
    }
  }
  for (const name of known) {
    const times = used.filter((u) => u === name).length;
    if (times === 0) {
      add(
        'tool-param-unused',
        `The parameter ${name} is not used in the URL path or the query list.`,
      );
    } else if (times > 1) {
      add(
        'tool-param-reused',
        `The parameter ${name} is used ${times} times; use each parameter once, in the URL path or the query list.`,
      );
    }
  }
}

export function validateCustomTool(
  tool: CustomTool,
  ctx: CustomToolValidationContext,
): CustomToolProblem[] {
  const problems: CustomToolProblem[] = [];
  const add: Add = (kind, message) => problems.push({ kind, tool: tool.name, message });

  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    add(
      'tool-name-invalid',
      `The tool name ${JSON.stringify(tool.name)} must start with a lowercase letter and use only lowercase letters, digits and underscores, up to ${CUSTOM_TOOL_NAME_MAX_LENGTH} characters.`,
    );
  } else if (CUSTOM_TOOL_RESERVED_NAMES.includes(tool.name)) {
    add(
      'tool-name-reserved',
      `The tool name ${tool.name} is kept for Haive's own tools (${CUSTOM_TOOL_RESERVED_NAMES.join(', ')}).`,
    );
  }
  if (!isPlainText(tool.description, CUSTOM_TOOL_DESCRIPTION_MAX_LENGTH)) {
    add(
      'tool-description-invalid',
      `The tool description must be 1 to ${CUSTOM_TOOL_DESCRIPTION_MAX_LENGTH} characters with no control or invisible characters.`,
    );
  }

  if (tool.action === 'http-get') {
    const used = checkUrl(tool.url, add);
    checkParams(tool.params, new Set(pathPlaceholders(tool.url)), add);
    if (used !== null) {
      checkUsage(
        tool.params.map((p) => p.name),
        [...used, ...tool.query],
        add,
      );
    }
    if (!inRange(tool.timeoutMs, CUSTOM_TOOL_TIMEOUT_MIN_MS, CUSTOM_TOOL_TIMEOUT_MAX_MS)) {
      add(
        'tool-timeout-out-of-range',
        `The timeout must be a whole number of milliseconds from ${CUSTOM_TOOL_TIMEOUT_MIN_MS} to ${CUSTOM_TOOL_TIMEOUT_MAX_MS}.`,
      );
    }
  } else if (tool.action === 'rag-query') {
    if (tool.scope !== 'global' && !ctx.requiresRepository) {
      add(
        'tool-scope-needs-repository',
        `The ${tool.scope} scope searches the project, which needs a repository; use the global scope on a task type with no repository.`,
      );
    }
    if (!inRange(tool.topK, RAG_QUERY_TOP_K_MIN, RAG_QUERY_TOP_K_MAX)) {
      add(
        'tool-top-k-out-of-range',
        `topK must be a whole number from ${RAG_QUERY_TOP_K_MIN} to ${RAG_QUERY_TOP_K_MAX}.`,
      );
    }
  }
  if (
    !inRange(tool.maxResponseBytes, CUSTOM_TOOL_RESPONSE_MIN_BYTES, CUSTOM_TOOL_RESPONSE_MAX_BYTES)
  ) {
    add(
      'tool-response-cap-out-of-range',
      `The response cap must be a whole number of bytes from ${CUSTOM_TOOL_RESPONSE_MIN_BYTES} to ${CUSTOM_TOOL_RESPONSE_MAX_BYTES}.`,
    );
  }
  return problems;
}

export function validateCustomTools(
  tools: readonly CustomTool[],
  ctx: CustomToolValidationContext,
): CustomToolProblem[] {
  const problems: CustomToolProblem[] = [];
  if (tools.length > CUSTOM_TOOLS_MAX_PER_STEP) {
    problems.push({
      kind: 'too-many-tools',
      tool: '',
      message: `A step can have at most ${CUSTOM_TOOLS_MAX_PER_STEP} tools.`,
    });
  }
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) repeated.add(tool.name);
    seen.add(tool.name);
  }
  for (const name of repeated) {
    problems.push({
      kind: 'tool-name-duplicate',
      tool: name,
      message: `Two tools in this step are named ${name}.`,
    });
  }
  for (const tool of tools) problems.push(...validateCustomTool(tool, ctx));
  return problems;
}

export interface CustomToolPropertySchema {
  type: 'string' | 'integer' | 'boolean';
  description: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
}

export interface CustomToolInputSchema {
  type: 'object';
  properties: Record<string, CustomToolPropertySchema>;
  required?: string[];
}

function propertyOf(param: CustomToolParam): CustomToolPropertySchema {
  switch (param.type) {
    case 'string':
      return { type: 'string', description: param.description, maxLength: param.maxLength };
    case 'integer':
      return {
        type: 'integer',
        description: param.description,
        ...(param.min === undefined ? {} : { minimum: param.min }),
        ...(param.max === undefined ? {} : { maximum: param.max }),
      };
    case 'boolean':
      return { type: 'boolean', description: param.description };
    case 'enum':
      return { type: 'string', description: param.description, enum: [...param.values] };
  }
}

/** The schema an MCP client is told: only type, properties, description, enum, minimum, maximum, maxLength and required. */
export function customToolInputSchema(tool: CustomTool): CustomToolInputSchema {
  if (tool.action === 'rag-query') {
    return {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to search for.',
          maxLength: RAG_QUERY_MAX_LENGTH,
        },
      },
      required: ['query'],
    };
  }
  const required = requiredNames(tool);
  return {
    type: 'object',
    properties: Object.fromEntries(tool.params.map((p) => [p.name, propertyOf(p)])),
    ...(required.length > 0 ? { required } : {}),
  };
}

export type CustomToolArgs = Record<string, string | number | boolean>;

function argOf(param: CustomToolParam): z.ZodType {
  switch (param.type) {
    case 'string':
      return z
        .string()
        .min(1)
        .max(param.maxLength)
        .refine((text) => text.isWellFormed(), 'must be valid Unicode text');
    case 'integer': {
      let whole = z.number().int();
      if (param.min !== undefined) whole = whole.min(param.min);
      if (param.max !== undefined) whole = whole.max(param.max);
      return whole;
    }
    case 'boolean':
      return z.boolean();
    case 'enum':
      return z.enum(param.values);
  }
}

/** Accepts exactly the arguments `customToolInputSchema` advertises; an unknown key is an error. */
export function customToolArgsSchema(tool: CustomTool): z.ZodType<CustomToolArgs> {
  if (tool.action === 'rag-query') {
    return z.strictObject({
      query: z.string().min(1).max(RAG_QUERY_MAX_LENGTH),
    }) as z.ZodType<CustomToolArgs>;
  }
  const required = new Set(requiredNames(tool));
  const shape = Object.fromEntries(
    tool.params.map((p) => [p.name, required.has(p.name) ? argOf(p) : argOf(p).optional()]),
  );
  return z.strictObject(shape) as z.ZodType<CustomToolArgs>;
}

export type CustomToolUrl = { ok: true; url: URL } | { ok: false; message: string };

const DOT_SEGMENTS: ReadonlySet<string> = new Set(['.', '..']);
const PATH_SEPARATOR = /[/\\]/;

function refusedInPath(text: string): boolean {
  return PATH_SEPARATOR.test(text) || DOT_SEGMENTS.has(text.normalize('NFKC'));
}

/** The URL a call fetches: the tool's template with each value percent-encoded into its slot.
 *  Assumes `args` passed `customToolArgsSchema` and the tool passed `validateCustomTool`. */
export function customToolUrl(tool: HttpGetTool, args: CustomToolArgs): CustomToolUrl {
  const fail = (message: string): CustomToolUrl => ({ ok: false, message });
  const parts = splitUrl(tool.url);
  if (!parts) return fail('the tool URL cannot be read');

  const encoded = new Map<string, string>();
  for (const name of placeholdersIn(parts.path)) {
    const value = args[name];
    if (value === undefined) return fail(`${name} is missing`);
    const text = String(value);
    if (refusedInPath(text)) {
      return fail(`${name} must not contain / or \\, and must not be . or ..`);
    }
    encoded.set(name, encodeURIComponent(text));
  }
  const path = parts.path.replace(PLACEHOLDER, (_match, name: string) => encoded.get(name) ?? '');
  const appended = tool.query.flatMap((name) =>
    args[name] === undefined ? [] : [`${name}=${encodeURIComponent(String(args[name]))}`],
  );
  const query = [parts.query ?? '', ...appended].filter((pair) => pair !== '').join('&');
  const href = `${parts.scheme}://${parts.authority}${path}${query === '' ? '' : `?${query}`}`;
  if (href.length > CUSTOM_TOOL_URL_MAX_LENGTH) {
    return fail(`the URL would be longer than ${CUSTOM_TOOL_URL_MAX_LENGTH} characters`);
  }

  try {
    const url = new URL(href);
    const origin = new URL(`${parts.scheme}://${parts.authority}/`).origin;
    const prefix = new URL(parts.path.split('{', 1)[0] || '/', origin).pathname;
    if (url.origin !== origin || !url.pathname.startsWith(prefix)) {
      return fail('the URL would leave the address the tool is pinned to');
    }
    return { ok: true, url };
  } catch {
    return fail('the URL cannot be built from these arguments');
  }
}
