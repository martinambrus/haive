// Bundled by the web: no node: import, no house-rules.ts, and only types from the schema.
import { collapseToLine } from '../utils/collapse-line.js';
import type { GlobalKbCategory, GlobalKbEntry } from './schema.js';

export type EnforceSpec = { mode: 'always' } | { mode: 'files'; globs: string[] };

/** Closes the block these entries are injected in; the render escapes it in every field. */
export const HOUSE_RULES_END = '</haive_house_rules>';

const CATEGORY_LABELS: Record<GlobalKbCategory, string> = {
  general: 'General',
  tech_pattern: 'Tech pattern',
  anti_pattern: 'Anti-pattern',
  best_practice: 'Best practice',
  quick_reference: 'Quick reference',
};

export type RenderedEntry = Pick<GlobalKbEntry, 'title' | 'category' | 'description' | 'body'>;

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
