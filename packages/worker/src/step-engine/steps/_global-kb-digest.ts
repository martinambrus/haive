import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  globalKbEntries,
  normalizeGlobalKbDescription,
  type GlobalKbDb,
  type GlobalKbFacets,
  type ProjectFacetSet,
} from '@haive/shared/global-kb';
import { FACET_FILTER_DIMENSIONS } from '@haive/shared/rag';
import { hasLeadingHaiveBlock } from '../../repo/ddev-generated-boundary.js';
import { omissionCount } from '../omission-count.js';
import { collapseToLine } from './_untrusted-repo.js';

// Prompt-side counterpart to rag_search.
//
// The global KB has exactly one door: the `rag_search` MCP tool. `Bash grep`
// cannot see it, so whatever an agent finds by shelling out is per-repo by
// construction. Measured over 58 `Add DDEV` tasks, that door is barely used —
// rag_search is 1.3% of claude-code's tool calls (26 of 1930 on task 92afc67b)
// and 0% of muse's (0 of ~958 on fcf03ead, with the server connected,
// permissions bypassed and 85 prompts naming the tool).
//
// The failure is a COLD START, not unwillingness: agents that know a title
// reliably fetch its body — the 08-13 runs queried `DDEV post-start hooks cannot
// inject settings into installer-generated config` and
// `Installing a PHP extension in a DDEV web image: use webimage_extra_packages`
// near-verbatim, weeks after those entries were written. An agent that does not
// know an entry exists greps instead.
//
// So this lists titles, each with its one-line description when it has one, and points
// at rag_search for the body. Titles are cheap, and they turn a blind cold start into
// a targeted lookup.

/** Upper bound on titles in one digest. A cap, not a target: the block rides
 *  every rag-wired dispatch, so it is bounded prompt cost. Not a config key —
 *  the kill switch is, the size is a tuning constant. */
export const GLOBAL_KB_DIGEST_MAX_TITLES = 40;

/** Rows scanned before facet filtering. Bounded so a large corpus cannot turn a
 *  dispatch into a long scan; ordered newest-first, so the overflow that gets
 *  dropped is the stalest. */
const DIGEST_SCAN_LIMIT = 400;

const DIGEST_MARKER = '<haive_global_kb_index>';

export interface GlobalKbDigestEntry {
  title: string;
  category: string;
  /** Normalised once, in `selectDigest`: the render and the isolation scan both read this value. */
  description?: string;
}

export interface GlobalKbDigest {
  entries: GlobalKbDigestEntry[];
  omitted: number;
  scanSaturated: boolean;
}

/** Does an entry apply to this project?
 *
 *  Mirrors the SQL predicate retrieval uses (`buildFacetClause`,
 *  shared/src/rag/search.ts): for each dimension the ENTRY is compatible when it
 *  does not constrain that dimension at all (absent or empty = a universal house
 *  standard) or when it shares at least one value with the project. A project
 *  with no value for a dimension therefore excludes entries that DO constrain
 *  it, which is the conservative direction.
 *
 *  Kept as a predicate over the same FACET_FILTER_DIMENSIONS list retrieval
 *  imports, so a digest can never advertise a title that a following rag_search
 *  would filter out. */
export function facetsMatchProject(
  entryFacets: GlobalKbFacets | null | undefined,
  projectFacets: ProjectFacetSet,
): boolean {
  const entry = (entryFacets ?? {}) as Record<string, string[] | undefined>;
  for (const dim of FACET_FILTER_DIMENSIONS) {
    const constrained = entry[dim];
    if (!constrained || constrained.length === 0) continue;
    const projectValues = projectFacets[dim] ?? [];
    if (projectValues.length === 0) return false;
    const wanted = new Set(projectValues.map((v) => v.toLowerCase()));
    if (!constrained.some((v) => wanted.has(String(v).toLowerCase()))) return false;
  }
  return true;
}

export function selectDigest(
  rows: Array<
    Pick<GlobalKbDigestEntry, 'title' | 'category'> & {
      description?: string | null;
      facets: GlobalKbFacets | null | undefined;
    }
  >,
  projectFacets: ProjectFacetSet,
): GlobalKbDigest {
  const matches = rows.filter((r) => facetsMatchProject(r.facets, projectFacets));
  const entries = matches.slice(0, GLOBAL_KB_DIGEST_MAX_TITLES).map((r): GlobalKbDigestEntry => {
    const description = normalizeGlobalKbDescription(r.description);
    return description === null
      ? { title: r.title, category: r.category }
      : { title: r.title, category: r.category, description };
  });
  return {
    entries,
    omitted: matches.length - entries.length,
    scanSaturated: rows.length >= DIGEST_SCAN_LIMIT,
  };
}

export const emptyDigest = (): GlobalKbDigest => ({
  entries: [],
  omitted: 0,
  scanSaturated: false,
});

/** The newest active entries of the namespace, as many as a digest scans. `gdb` is the store's
 *  database or a transaction on it; `selectDigest` does the rest, the scope filter included. */
export function readDigestRows(
  gdb: Pick<GlobalKbDb, 'select'>,
  namespace: string,
): Promise<Parameters<typeof selectDigest>[0]> {
  return gdb
    .select({
      title: globalKbEntries.title,
      category: globalKbEntries.category,
      facets: globalKbEntries.facets,
      description: globalKbEntries.description,
    })
    .from(globalKbEntries)
    .where(
      and(
        eq(globalKbEntries.namespace, namespace),
        eq(globalKbEntries.status, 'active'),
        isNull(globalKbEntries.supersededAt),
      ),
    )
    .orderBy(desc(globalKbEntries.updatedAt))
    .limit(DIGEST_SCAN_LIMIT);
}

/** Render the digest block. Grouped by category so an agent can tell a house
 *  standard from an anti-pattern without opening either. */
export function globalKbDigestPrompt(
  entries: GlobalKbDigestEntry[],
  omission?: Pick<GlobalKbDigest, 'omitted' | 'scanSaturated'>,
): string {
  const byCategory = new Map<string, string[]>();
  for (const e of entries) {
    const category = collapseToLine(e.category);
    const list = byCategory.get(category) ?? [];
    const title = collapseToLine(e.title);
    const description = collapseToLine(e.description);
    list.push(description ? `${title} — ${description}` : title);
    byCategory.set(category, list);
  }
  const lines = [
    DIGEST_MARKER,
    'House standards already on record for this stack, from work on other projects.',
    'These are TITLES, some with a one-line description — not the entries. Call `rag_search` with a title to read the entry behind it —',
    'it is the only way to reach them; they are not files in this repo and grep cannot',
    'find them. Read the ones relevant to what you are about to do BEFORE you do it.',
    '',
  ];
  for (const [category, items] of byCategory) {
    lines.push(`${category}:`);
    for (const item of items) lines.push(`- ${item}`);
  }
  const omitted = omission?.omitted ?? 0;
  const count = omissionCount(omitted, omission?.scanSaturated ?? false);
  if (count !== null) {
    // Not a bullet: every "- " line in this block is one title.
    const plural = omitted === 1 ? '' : 's';
    lines.push(
      `(${count} more house standard${plural} for this stack not listed — the most recently updated are; rag_search searches all of them)`,
    );
  }
  lines.push('</haive_global_kb_index>');
  return lines.join('\n');
}

/** Prepend the digest once. Marker-guarded like withMcpSurface, so nested prompt
 *  builders and retry paths cannot double-inject. An empty digest adds nothing —
 *  a heading over no titles is pure prompt cost. */
export function withGlobalKbDigest(prompt: string, digest: GlobalKbDigest): string {
  if (digest.entries.length === 0 || hasLeadingHaiveBlock(prompt, DIGEST_MARKER)) return prompt;
  return `${globalKbDigestPrompt(digest.entries, digest)}\n\n${prompt}`;
}
