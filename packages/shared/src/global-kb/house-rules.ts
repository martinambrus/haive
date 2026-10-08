import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FACET_FILTER_DIMENSIONS } from '../rag/search.js';
import { HOUSE_RULE_MODES } from '../step-engine/types.js';
import { collapseToLine } from '../utils/collapse-line.js';
import { normalizeFacets, type GlobalKbCategory, type GlobalKbEntry } from './schema.js';

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
  if (row.status === 'archived' && row.supersededAt != null) return { state: 'superseded' };
  if (row.enforcedHash == null) return { state: 'cleared' };
  if (row.status !== 'active') return { state: 'not_active' };
  if (houseRuleApprovalHash(row, spec) !== row.enforcedHash) return { state: 'edited' };
  // A pause promises the rule resumes, so it applies only to an approval that is otherwise valid.
  if (row.namespace !== ctx.namespace) return { state: 'other_namespace' };
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

/** Every glob the brace groups stand for (null past the cap), and the first alternative with whitespace at an end. */
function braceExpansions(glob: string): { expansions: string[] | null; padded: string | null } {
  let pending = new Set([glob]);
  let padded: string | null = null;
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
      for (const alternative of group[1]!.split(',')) {
        if (padded === null && alternative !== alternative.trim()) padded = alternative;
        next.add(`${head}${alternative}${tail}`);
      }
    }
    if (next.size > BRACE_EXPANSIONS_MAX) return { expansions: null, padded };
    if (!expanded) return { expansions: [...next], padded };
    pending = next;
  }
}

// Wildcards, classes, groups, separators and extglob marks stand for other characters; the rest name themselves.
const namesSomething = (expansion: string): boolean =>
  /[^*?[\]{}()!+@|,/]/.test(expansion.replace(/\[[^\]]*\]/g, ''));

const hasBadPathSegment = (glob: string): boolean =>
  glob.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');

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
  if (hasBadPathSegment(glob)) {
    return `glob ${shown} has an empty, "." or ".." path segment; write it relative to the repository root, with no leading, trailing or doubled "/"`;
  }
  if (glob.startsWith('!') || glob.includes('!(')) {
    return `glob ${shown} uses "!" negation, which is not supported`;
  }
  const { expansions, padded } = braceExpansions(glob);
  if (expansions === null) {
    return `glob ${shown} has more than ${BRACE_EXPANSIONS_MAX} brace expansions; split it into separate globs`;
  }
  if (padded !== null) {
    return `glob ${shown} has the brace alternative ${JSON.stringify(padded)}, which starts or ends with whitespace; the matcher keeps it`;
  }
  const badExpansion = expansions.find(hasBadPathSegment);
  if (badExpansion !== undefined) {
    return `glob ${shown} expands to ${JSON.stringify(badExpansion)}, which has an empty, "." or ".." path segment; every expansion has to be relative to the repository root, with no leading, trailing or doubled "/"`;
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

/** Closes the block these entries are injected in; the render escapes it in every field. */
export const HOUSE_RULES_END = '</haive_house_rules>';

const CATEGORY_LABELS: Record<GlobalKbCategory, string> = {
  general: 'General',
  tech_pattern: 'Tech pattern',
  anti_pattern: 'Anti-pattern',
  best_practice: 'Best practice',
  quick_reference: 'Quick reference',
};

type RenderedEntry = Pick<GlobalKbEntry, 'title' | 'category' | 'description' | 'body'>;

export interface HouseRuleRenderOptions {
  enforce: EnforceSpec;
  shortId: string;
}

function scopeLine(enforce: EnforceSpec): string {
  if (enforce.mode === 'always') return 'Applies to every change.';
  const globs = [...new Set(enforce.globs)].sort().map(collapseToLine);
  return `Applies to files matching: ${globs.join(', ')}`;
}

export function renderHouseRuleEntry(entry: RenderedEntry, opts: HouseRuleRenderOptions): string {
  const description = collapseToLine(entry.description);
  return [
    `### Rule ${opts.shortId}: ${collapseToLine(entry.title)}`,
    // A store shared with another build can hold a category this one has no label for.
    `Category: ${CATEGORY_LABELS[entry.category] ?? collapseToLine(entry.category)}`,
    ...(description === '' ? [] : [description]),
    scopeLine(opts.enforce),
    '',
    // As stored: the admin approved these bytes, and an indented code block begins with spaces.
    entry.body,
  ]
    .join('\n')
    .replaceAll(HOUSE_RULES_END, '<\\/haive_house_rules>');
}

export const houseRuleBytes = (entry: RenderedEntry, opts: HouseRuleRenderOptions): number =>
  Buffer.byteLength(renderHouseRuleEntry(entry, opts), 'utf8');

const SHORT_ID_DIGITS = 8;

const digitsOf = (id: string): string => id.replaceAll('-', '');
const sharedPrefixLength = (a: string, b: string): number => {
  let length = 0;
  while (length < a.length && a[length] === b[length]) length += 1;
  return length;
};

/** First 8 hex digits of each uuid, plus the digits that tell apart ids sharing them in the set. */
export function houseRuleShortIds(ids: readonly string[]): Map<string, string> {
  const unique = [...new Set(ids)];
  return new Map(
    unique.map((id) => {
      const digits = digitsOf(id);
      const shared = Math.max(
        0,
        ...unique
          .filter((other) => other !== id)
          .map((other) => sharedPrefixLength(digits, digitsOf(other))),
      );
      return [id, digits.slice(0, Math.max(SHORT_ID_DIGITS, shared + 1))] as const;
    }),
  );
}

const houseRulesStampSchema = z.object({
  mode: z.enum(HOUSE_RULE_MODES),
  entries: z.array(
    z.object({
      id: z.string(),
      hash: z.string(),
      title: z.string(),
      why: z.discriminatedUnion('scope', [
        z.object({ scope: z.literal('always') }),
        // A null glob: the change's file set could not be read, so the rule went in unscoped.
        z.object({ scope: z.literal('files'), glob: z.string().nullable() }),
      ]),
    }),
  ),
  omitted: z.array(
    z.object({
      id: z.string(),
      hash: z.string(),
      title: z.string(),
      why: z.enum(['budget', 'refused']),
    }),
  ),
  reason: z.enum(['switched_off', 'unavailable', 'too_large']).optional(),
  errorClass: z.enum(['timeout', 'refused', 'auth', 'other']).optional(),
});

/** What a CLI run was given of the house rules, stored in `cli_invocations.house_rules`. */
export type HouseRulesStamp = z.infer<typeof houseRulesStampSchema>;

/** A stored value as a stamp, or null for NULL and for anything that is not one. */
export function parseHouseRulesStamp(value: unknown): HouseRulesStamp | null {
  const parsed = houseRulesStampSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A title as the stamp keeps it: one line of at most 300 characters, cut between characters. */
export function houseRuleStampTitle(title: string): string {
  return collapseToLine(title)
    .slice(0, 300)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd();
}
