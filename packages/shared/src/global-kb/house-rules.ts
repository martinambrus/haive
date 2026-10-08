import { createHash } from 'node:crypto';
import { FACET_FILTER_DIMENSIONS } from '../rag/search.js';
import { collapseToLine } from '../utils/collapse-line.js';
import { normalizeFacets, type GlobalKbEntry } from './schema.js';

export type EnforceSpec = { mode: 'always' } | { mode: 'files'; globs: string[] };

export type HouseRuleContent = Pick<
  GlobalKbEntry,
  'title' | 'category' | 'description' | 'body' | 'facets'
>;

export type HouseRuleRow = HouseRuleContent &
  Pick<GlobalKbEntry, 'namespace' | 'status' | 'supersededAt' | 'enforcedHash'> & {
    enforce: unknown;
  };

export type HouseRuleStateName =
  | 'none'
  | 'other_namespace'
  | 'superseded'
  | 'cleared'
  | 'not_active'
  | 'edited'
  | 'switched_off'
  | 'enforced';

/** `mode` and `globs` are set only when `state` is 'enforced', so a lapsed approval cannot be acted on by mistake. */
export interface HouseRuleEnforcement {
  state: HouseRuleStateName;
  mode?: EnforceSpec['mode'];
  globs?: string[];
}

/** UTF-8 bytes of the always-on entries one prompt carries, as `houseRuleBytes` counts them. */
export const HOUSE_RULES_ALWAYS_CAP_BYTES = 8000;

const VERSION = 'hr1';
const GLOBS_MAX = 20;
const GLOB_MAX_LENGTH = 200;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const scopeOf = (facets: HouseRuleContent['facets']): Array<[string, string[]]> => {
  const normal = normalizeFacets(facets);
  return FACET_FILTER_DIMENSIONS.map((dim) => [dim, [...(normal[dim] ?? [])].sort()]);
};

const contentOf = (row: HouseRuleContent): unknown[] => [
  VERSION,
  row.title,
  row.category,
  row.description ?? null,
  row.body,
  scopeOf(row.facets),
];

const settingsOf = (spec: EnforceSpec): unknown[] =>
  spec.mode === 'always' ? ['always'] : ['files', [...new Set(spec.globs)].sort()];

/** From the row as stored, never from a request body: postgres.js stores a lone surrogate as U+FFFD. */
export const houseRuleContentToken = (row: HouseRuleContent): string =>
  `${VERSION}:${sha256(JSON.stringify(contentOf(row)))}`;

export const houseRuleApprovalHash = (row: HouseRuleContent, spec: EnforceSpec): string =>
  `${VERSION}:${sha256(JSON.stringify([...contentOf(row), settingsOf(spec)]))}`;

export function parseEnforceSpec(value: unknown): EnforceSpec | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { mode, globs } = value as { mode?: unknown; globs?: unknown };
  if (mode === 'always') return { mode };
  if (
    mode === 'files' &&
    Array.isArray(globs) &&
    globs.length > 0 &&
    globs.every((glob) => typeof glob === 'string')
  ) {
    return { mode, globs: [...globs] };
  }
  return null;
}

/** Most specific first: leaving `active` clears the hash, so `superseded` is read before `cleared`. */
export function enforcementState(
  row: HouseRuleRow,
  ctx: { namespace: string; houseRulesEnabled: boolean },
): HouseRuleEnforcement {
  const spec = parseEnforceSpec(row.enforce);
  if (spec === null) return { state: 'none' };
  if (row.namespace !== ctx.namespace) return { state: 'other_namespace' };
  if (row.status === 'archived' && row.supersededAt != null) return { state: 'superseded' };
  if (row.enforcedHash == null) return { state: 'cleared' };
  if (row.status !== 'active') return { state: 'not_active' };
  if (houseRuleApprovalHash(row, spec) !== row.enforcedHash) return { state: 'edited' };
  if (!ctx.houseRulesEnabled) return { state: 'switched_off' };
  return spec.mode === 'always'
    ? { state: 'enforced', mode: 'always' }
    : { state: 'enforced', mode: 'files', globs: spec.globs };
}

// TAB and LF stay allowed; the rest is every character a model reads and a person does not see.
const HIDDEN_CHARACTER =
  /[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}-\u{9F}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Zl}\p{Zp}]/u;
const LONE_SURROGATE = /\p{Cs}/u;
// Prompt blocks skip themselves when their marker appears anywhere, so a quoted marker switches one off.
const PROMPT_DELIMITER = /<\/?haive[_:-]|\[\[HAIVE_|<!--\s*\/?haive:|={4,}/i;

const codePointLabel = (char: string): string =>
  `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

export function refusedHouseRuleText(text: string): string | null {
  const hidden = HIDDEN_CHARACTER.exec(text);
  if (hidden) {
    return `contains the invisible or control character ${codePointLabel(hidden[0])} on line ${lineAt(text, hidden.index)}`;
  }
  if (!text.isWellFormed()) {
    const lone = LONE_SURROGATE.exec(text);
    return lone
      ? `contains the unpaired surrogate ${codePointLabel(lone[0])} on line ${lineAt(text, lone.index)}`
      : 'contains an unpaired surrogate';
  }
  const marker = PROMPT_DELIMITER.exec(text);
  if (marker) {
    const line = lineAt(text, marker.index);
    if (marker[0].startsWith('=')) {
      return `contains a run of "=" signs on line ${line}; use a "#" heading instead of an underline`;
    }
    const shown = text.slice(marker.index, marker.index + 40).split('\n')[0];
    return `contains "${shown}", a delimiter Haive prompts use, on line ${line}`;
  }
  return null;
}

const BRACE_EXPANSIONS_MAX = 64;
const BRACE_GROUP = /\{([^{}]*)\}/;
// picomatch reads a ".." in any brace group as a range, whether or not a comma sits beside it.
const BRACE_RANGE = /\{[^{}]*\.\.[^{}]*\}/;

/** Every glob the brace groups stand for, nested ones included; null once there are more than the cap. */
function braceExpansions(glob: string): string[] | null {
  let pending = new Set([glob]);
  for (;;) {
    const next = new Set<string>();
    let expanded = false;
    for (const text of pending) {
      const group = BRACE_GROUP.exec(text);
      if (group === null) {
        next.add(text);
        continue;
      }
      expanded = true;
      const head = text.slice(0, group.index);
      const tail = text.slice(group.index + group[0].length);
      for (const alternative of group[1]!.split(',')) next.add(`${head}${alternative}${tail}`);
    }
    if (next.size > BRACE_EXPANSIONS_MAX) return null;
    if (!expanded) return [...next];
    pending = next;
  }
}

// Wildcards, classes, groups, separators and extglob marks stand for other characters; the rest name themselves.
const namesSomething = (expansion: string): boolean =>
  /[^*?[\]{}()!+@|,/]/.test(expansion.replace(/\[[^\]]*\]/g, ''));

function globProblem(glob: string): string | null {
  const shown = JSON.stringify(glob.length > GLOB_MAX_LENGTH ? `${glob.slice(0, 40)}...` : glob);
  if (glob === '') return `glob ${shown} is empty`;
  if (glob.length > GLOB_MAX_LENGTH) {
    return `glob ${shown} is longer than ${GLOB_MAX_LENGTH} characters`;
  }
  if (glob !== glob.trim()) return `glob ${shown} has leading or trailing whitespace`;
  const refused = refusedHouseRuleText(glob);
  if (refused !== null) return `glob ${shown} ${refused}`;
  if (/[\t\n]/.test(glob)) return `glob ${shown} contains a tab or line break`;
  if (glob.includes('\\')) {
    return `glob ${shown} contains a backslash; "/" is the only path separator`;
  }
  if (glob.includes('"')) {
    return `glob ${shown} contains a double quote, which the matcher reads as quoting and drops`;
  }
  if (glob.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `glob ${shown} has an empty, "." or ".." path segment; write it relative to the repository root, with no leading, trailing or doubled "/"`;
  }
  if (glob.startsWith('!') || glob.includes('!(')) {
    return `glob ${shown} uses "!" negation, which is not supported`;
  }
  const expansions = braceExpansions(glob);
  if (expansions === null) {
    return `glob ${shown} has more than ${BRACE_EXPANSIONS_MAX} brace expansions; split it into separate globs`;
  }
  if (!expansions.every(namesSomething)) {
    return `glob ${shown} would match every file; a files rule has to name something, and mode "always" is for every file`;
  }
  if (/[@+*?!]\(/.test(glob)) {
    return `glob ${shown} uses extglob syntax, which is not supported; its alternatives are not checked, so write brace alternatives`;
  }
  const grouping = /[()|]/.exec(glob);
  if (grouping !== null) {
    return `glob ${shown} uses "${grouping[0]}", which is not supported; write alternatives in braces, like {a,b}`;
  }
  if (BRACE_RANGE.test(glob)) {
    return `glob ${shown} uses a brace range, which is not supported; list the alternatives with commas, like {a,b,c}`;
  }
  return null;
}

export function validateHouseRuleGlobs(globs: readonly string[]): string | null {
  if (globs.length === 0) return 'at least one glob is required';
  if (globs.length > GLOBS_MAX) {
    return `at most ${GLOBS_MAX} globs are allowed, got ${globs.length}`;
  }
  for (const glob of globs) {
    const problem = globProblem(glob);
    if (problem !== null) return problem;
  }
  return null;
}

export function renderHouseRuleEntry(
  entry: Pick<GlobalKbEntry, 'title' | 'category' | 'description' | 'body'>,
): string {
  const title = collapseToLine(entry.title);
  const description = collapseToLine(entry.description);
  return [
    `### ${entry.category === 'anti_pattern' ? `Anti-pattern — avoid: ${title}` : title}`,
    ...(description === '' ? [] : [description]),
    '',
    entry.body.trim(),
  ].join('\n');
}

export const houseRuleBytes = (
  entry: Pick<GlobalKbEntry, 'title' | 'category' | 'description' | 'body'>,
): number => Buffer.byteLength(renderHouseRuleEntry(entry), 'utf8');
