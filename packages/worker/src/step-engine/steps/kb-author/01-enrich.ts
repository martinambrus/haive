import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { schema } from '@haive/database';
import { globalKbEntries, withGlobalKb, type GlobalKbFacets } from '@haive/shared/global-kb';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { extractFencedJson } from '../_fenced-json.js';
import { syncGlobalKbEntry } from '../../../queues/global-kb-sync-queue.js';

// Repo-anchored global-KB authoring (plan serialized-crunching-aurora). The task
// is created by the global-kb enrich endpoint with a repositoryId + cliProviderId
// and metadata.globalKbEntryId pointing at a `skeleton` entry whose body is the
// author's free-text notes. The generic task machinery mounts the repo and
// dispatches the chosen CLI when this step's llm phase runs, so the model READS
// the repo's code to derive EVERYTHING itself — title, category, version facets
// and the article body — and decides whether the rule already exists (update) or
// is new (insert). The result is auto-activated and embedded immediately (no
// review step). Form-less: detect -> llm -> apply, hands-free.

const CATEGORIES = [
  'general',
  'tech_pattern',
  'anti_pattern',
  'best_practice',
  'quick_reference',
] as const;
type Category = (typeof CATEGORIES)[number];

const FACET_DIMS = [
  'framework',
  'frameworkMajor',
  'language',
  'phpMajor',
  'nodeMajor',
  'database',
  'dbMajor',
  'packages',
  'tags',
] as const;

/** Cap on existing entries fed to the model for de-dup. House standards are a
 *  small corpus; if it ever grows past this we log rather than silently drop. */
const EXISTING_LIMIT = 200;

interface ExistingEntry {
  id: string;
  title: string;
  category: string;
  facets: GlobalKbFacets;
  excerpt: string;
}

interface KbAuthorDetect {
  entryId: string | null;
  namespace: string;
  seedText: string;
  existing: ExistingEntry[];
}

interface KbAuthorApply {
  entryId: string | null;
  status: 'active' | 'skipped';
  mode: 'new' | 'update';
  sections: number;
}

interface Enrichment {
  mode?: string;
  targetId?: string;
  title?: string;
  category?: string;
  facets?: GlobalKbFacets;
  body?: string;
}

async function loadEntryId(ctx: StepContext): Promise<string | null> {
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { metadata: true },
  });
  const md = task?.metadata as { globalKbEntryId?: string } | null;
  return md?.globalKbEntryId ?? null;
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((s) => s.trim())
      .find(Boolean) ?? ''
  );
}

function buildEnrichPrompt(detected: KbAuthorDetect): string {
  const existing = detected.existing.length
    ? detected.existing
        .map((e) => {
          const stack = [...(e.facets.framework ?? []), ...(e.facets.frameworkMajor ?? [])].join(
            ' ',
          );
          return [
            `- id: ${e.id}`,
            `  title: ${e.title}`,
            `  category: ${e.category}`,
            stack ? `  stack: ${stack}` : '',
            `  excerpt: ${e.excerpt.replace(/\s+/g, ' ').trim()}`,
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n')
    : '(none yet)';
  return [
    'You document reusable house standards for a global, cross-project knowledge base.',
    "You run inside a sandbox with THIS project's repository checked out at the working",
    'directory. You have file tools to read it, and — only if network egress is permitted —',
    'web access. Do not assume internet access; if a fetch fails, rely on the repository alone.',
    '',
    "## The author's notes (free text — the house rule to capture)",
    detected.seedText || '(empty)',
    '',
    '## Existing house rules (for de-duplication)',
    existing,
    '',
    '## Your task',
    '1. READ the relevant module / library / code in THIS repository that the notes refer to.',
    '   Cite real file paths and copy concrete, working examples from the repo, not generic advice.',
    '2. From the repo manifests (composer.json drupal/core, package.json, lockfiles) determine the',
    '   framework and its MAJOR version + any relevant packages. MAJOR only (e.g. 11, not 11.2).',
    '3. If web access is available, consult official docs / module READMEs (including any URLs the',
    '   author wrote) to fill gaps. Otherwise rely on the repository.',
    '4. Decide whether this rule already exists above. If it is the SAME rule (same topic / module /',
    '   scope) as one listed, set mode="update" and targetId to that id — you will REPLACE it with a',
    '   complete, improved article that incorporates the new notes. Otherwise set mode="new".',
    `5. Derive a concise TITLE, the best CATEGORY (one of: ${CATEGORIES.join(', ')}), the version`,
    '   FACETS, and write the full, self-contained markdown article BODY.',
    '',
    '## Output — emit EXACTLY ONE fenced ```json block and nothing else:',
    '```json',
    '{',
    '  "mode": "new" | "update",',
    '  "targetId": "<the existing id when mode=update; omit otherwise>",',
    '  "title": "<concise title>",',
    '  "category": "<one of the categories listed above>",',
    '  "facets": {',
    '    "framework": ["<e.g. drupal>"],',
    '    "frameworkMajor": ["<e.g. 11>"],',
    '    "language": ["<e.g. php>"],',
    '    "database": ["<e.g. mysql or mariadb — for datastore-only rules>"],',
    '    "dbMajor": ["<e.g. 10 — the datastore major>"],',
    '    "packages": ["<name@major, e.g. drupal/paragraphs@8>"]',
    '  },',
    '  "body": "<the full markdown article>"',
    '}',
    '```',
    'Set facets to the versions you actually found in the repository; omit a dimension that does not',
    'apply (an omitted dimension means the rule applies to all values). Major versions only.',
  ].join('\n');
}

export function parseEnrichment(raw: unknown): Enrichment | null {
  let text: string | null = null;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    // Already-structured output (e.g. the bypass stub) — take it as-is.
    if (typeof o.body === 'string') return o as Enrichment;
    if (typeof o.result === 'string') text = o.result;
    else if (typeof o.text === 'string') text = o.text;
    else text = JSON.stringify(o);
  }
  if (!text) return null;
  const json = extractFencedJson(text) ?? text;
  try {
    return JSON.parse(json) as Enrichment;
  } catch {
    return null;
  }
}

/** Sanitize the LLM's facets to clean string sets per known dimension. */
export function cleanFacets(llm?: GlobalKbFacets): GlobalKbFacets {
  const out: GlobalKbFacets = {};
  for (const d of FACET_DIMS) {
    const v = llm?.[d];
    if (Array.isArray(v) && v.length) {
      out[d] = [...new Set(v.filter((x) => typeof x === 'string' && x).map(String))];
    }
  }
  return out;
}

export function normCategory(c?: string): Category {
  return (CATEGORIES as readonly string[]).includes(c ?? '') ? (c as Category) : 'general';
}

/** Decide where the article is written: an existing entry the model matched
 *  (honored only when its targetId is one we actually showed it) or the fresh
 *  skeleton. */
export function resolveWriteTarget(
  parsed: Enrichment | null,
  skeletonId: string,
  existingIds: ReadonlySet<string>,
): { isUpdate: boolean; targetId: string } {
  const isUpdate =
    parsed?.mode === 'update' && !!parsed.targetId && existingIds.has(parsed.targetId);
  return { isUpdate, targetId: isUpdate ? parsed!.targetId! : skeletonId };
}

export const kbAuthorEnrichStep: StepDefinition<KbAuthorDetect, KbAuthorApply> = {
  metadata: {
    id: '01-kb-enrich',
    workflowType: 'kb_author',
    index: 0,
    title: 'Knowledge base enrichment',
    description:
      'Reads the chosen repository to turn free-text house-rule notes into a version-scoped global KB entry — deriving the title, category and facets, then inserting a new entry or updating a matching one and activating it.',
    requiresCli: true,
  },

  async detect(ctx): Promise<KbAuthorDetect> {
    const entryId = await loadEntryId(ctx);
    if (!entryId) throw new Error('kb_author task is missing metadata.globalKbEntryId');
    return withGlobalKb(ctx.db, async ({ db }) => {
      const entry = await db.query.globalKbEntries.findFirst({
        where: eq(globalKbEntries.id, entryId),
      });
      if (!entry) throw new Error(`global KB entry ${entryId} not found`);
      await db
        .update(globalKbEntries)
        .set({ status: 'enriching', updatedAt: new Date() })
        .where(eq(globalKbEntries.id, entryId));
      const rows = await db
        .select({
          id: globalKbEntries.id,
          title: globalKbEntries.title,
          category: globalKbEntries.category,
          facets: globalKbEntries.facets,
          body: globalKbEntries.body,
        })
        .from(globalKbEntries)
        .where(
          and(
            inArray(globalKbEntries.status, ['active', 'draft']),
            ne(globalKbEntries.id, entryId),
          ),
        )
        .orderBy(desc(globalKbEntries.updatedAt))
        .limit(EXISTING_LIMIT + 1);
      if (rows.length > EXISTING_LIMIT) {
        ctx.logger.warn(
          { count: rows.length },
          `global KB de-dup context capped at ${EXISTING_LIMIT} entries`,
        );
      }
      const existing: ExistingEntry[] = rows.slice(0, EXISTING_LIMIT).map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        facets: r.facets ?? {},
        excerpt: (r.body ?? '').slice(0, 400),
      }));
      return {
        entryId,
        namespace: entry.namespace,
        seedText: entry.seedText ?? entry.body,
        existing,
      };
    });
  },

  llm: {
    requiredCapabilities: ['tool_use'],
    buildPrompt: (args) => buildEnrichPrompt(args.detected as KbAuthorDetect),
    timeoutMs: 30 * 60 * 1000,
    bypassStub: (args) => {
      const d = args.detected as KbAuthorDetect;
      const title = firstLine(d.seedText).slice(0, 80) || 'Untitled house rule';
      return {
        mode: 'new',
        title,
        category: 'general',
        facets: {},
        body: `# ${title}\n\n${d.seedText}`,
      };
    },
  },

  async apply(ctx, args): Promise<KbAuthorApply> {
    const detected = args.detected as KbAuthorDetect;
    if (!detected.entryId) return { entryId: null, status: 'skipped', mode: 'new', sections: 0 };
    const skeletonId = detected.entryId;

    const parsed = parseEnrichment(args.llmOutput ?? null);
    const title =
      parsed?.title?.trim() || firstLine(detected.seedText).slice(0, 80) || 'Untitled house rule';
    const category = normCategory(parsed?.category);
    const facets = cleanFacets(parsed?.facets);
    const body =
      parsed?.body && parsed.body.trim().length > 0
        ? parsed.body
        : `# ${title}\n\n${detected.seedText}`;

    // The model may flag this as an update of an existing rule; only honor a
    // targetId we actually showed it (else fall back to inserting the skeleton).
    const existingIds = new Set(detected.existing.map((e) => e.id));
    const { isUpdate, targetId } = resolveWriteTarget(parsed, skeletonId, existingIds);

    const namespace = await withGlobalKb(ctx.db, async ({ db }) => {
      const now = new Date();
      if (isUpdate) {
        // Fold the new article into the matched entry; drop the transient skeleton
        // (just the user's seed text — the real content goes onto the target).
        await db.delete(globalKbEntries).where(eq(globalKbEntries.id, skeletonId));
      }
      const [row] = await db
        .update(globalKbEntries)
        .set({
          title,
          category,
          facets,
          body,
          status: 'active',
          embedStatus: 'pending',
          updatedAt: now,
        })
        .where(eq(globalKbEntries.id, targetId))
        .returning({ namespace: globalKbEntries.namespace });
      return row?.namespace ?? detected.namespace;
    });

    // Auto-activate: embed now (no manual Activate step) so the entry is
    // retrievable immediately. Mirrors the API's enqueueSync, run inline.
    try {
      await syncGlobalKbEntry({ entryId: targetId, namespace, reason: 'upsert' });
    } catch (err) {
      ctx.logger.warn(
        { err, entryId: targetId },
        'global KB embed after enrich failed; entry is active but unembedded',
      );
    }

    ctx.logger.info(
      { entryId: targetId, mode: isUpdate ? 'update' : 'new', enriched: !!parsed?.body },
      'kb enrichment complete → active',
    );
    return {
      entryId: targetId,
      status: 'active',
      mode: isUpdate ? 'update' : 'new',
      sections: (body.match(/^##\s/gm) ?? []).length,
    };
  },
};
