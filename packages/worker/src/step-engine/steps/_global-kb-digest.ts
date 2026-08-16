import { and, desc, eq, isNull } from 'drizzle-orm';
import { type Database } from '@haive/database';
import { CONFIG_KEYS, configService } from '@haive/shared';
import {
  globalKbEntries,
  resolveTaskFacets,
  withGlobalKb,
  type GlobalKbFacets,
  type ProjectFacetSet,
} from '@haive/shared/global-kb';
import { FACET_FILTER_DIMENSIONS } from '@haive/shared/rag';

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
// So this lists TITLES ONLY and points at rag_search for the body. Titles are
// cheap, and they turn a blind cold start into a targeted lookup.

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

/** The stack-matching global KB titles for a task, newest first.
 *
 *  Best-effort by contract: this runs on the dispatch path, where a global KB
 *  that is off, unreachable or empty must cost nothing but the digest. Every
 *  failure returns [] — the same fail-soft the global half of rag_search already
 *  has (api/src/routes/rag.ts), for the same reason: retrieval degrading is
 *  never worth failing the work. */
export async function resolveGlobalKbDigest(
  db: Database,
  taskId: string,
): Promise<GlobalKbDigestEntry[]> {
  try {
    const [globalEnabled, digestEnabled] = await Promise.all([
      configService.getBoolean(CONFIG_KEYS.GLOBAL_KB_ENABLED, true),
      configService.getBoolean(CONFIG_KEYS.GLOBAL_KB_DIGEST_ENABLED, true),
    ]);
    if (!globalEnabled || !digestEnabled) return [];

    const projectFacets = await resolveTaskFacets(db, taskId);

    return await withGlobalKb(db, async ({ db: gdb, settings }) => {
      const rows = await gdb
        .select({
          title: globalKbEntries.title,
          category: globalKbEntries.category,
          facets: globalKbEntries.facets,
        })
        .from(globalKbEntries)
        .where(
          and(
            eq(globalKbEntries.namespace, settings.namespace),
            eq(globalKbEntries.status, 'active'),
            isNull(globalKbEntries.supersededAt),
          ),
        )
        .orderBy(desc(globalKbEntries.updatedAt))
        .limit(DIGEST_SCAN_LIMIT);

      return rows
        .filter((r) => facetsMatchProject(r.facets, projectFacets))
        .slice(0, GLOBAL_KB_DIGEST_MAX_TITLES)
        .map((r) => ({ title: r.title, category: r.category }));
    });
  } catch {
    return [];
  }
}

/** Render the digest block. Grouped by category so an agent can tell a house
 *  standard from an anti-pattern without opening either. */
export function globalKbDigestPrompt(entries: GlobalKbDigestEntry[]): string {
  const byCategory = new Map<string, string[]>();
  for (const e of entries) {
    const list = byCategory.get(e.category) ?? [];
    list.push(e.title);
    byCategory.set(e.category, list);
  }
  const lines = [
    DIGEST_MARKER,
    'House standards already on record for this stack, from work on other projects.',
    'These are TITLES ONLY. Call `rag_search` with a title to read the entry behind it —',
    'it is the only way to reach them; they are not files in this repo and grep cannot',
    'find them. Read the ones relevant to what you are about to do BEFORE you do it.',
    '',
  ];
  for (const [category, titles] of byCategory) {
    lines.push(`${category}:`);
    for (const title of titles) lines.push(`- ${title}`);
  }
  lines.push('</haive_global_kb_index>');
  return lines.join('\n');
}

/** Prepend the digest once. Marker-guarded like withMcpSurface, so nested prompt
 *  builders and retry paths cannot double-inject. An empty digest adds nothing —
 *  a heading over no titles is pure prompt cost. */
export function withGlobalKbDigest(prompt: string, entries: GlobalKbDigestEntry[]): string {
  if (entries.length === 0 || prompt.includes(DIGEST_MARKER)) return prompt;
  return `${globalKbDigestPrompt(entries)}\n\n${prompt}`;
}
