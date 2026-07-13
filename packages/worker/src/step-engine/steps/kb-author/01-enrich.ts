import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  globalKbEntries,
  resolveGlobalKbSettings,
  withGlobalKb,
  type GlobalKbFacets,
} from '@haive/shared/global-kb';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { RetryableParseError } from '../../step-definition.js';
import { parseJsonLoose } from '../_fenced-json.js';
import {
  confirmSupersedeByEmbedding,
  SUPERSEDE_CANDIDATE_LIMIT,
} from '../_global-kb-similarity.js';
import { globalKbTopicKey } from '../_global-kb-promote.js';
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
  // User-set title — authoritative, the LLM does not derive its own.
  title: string;
  seedText: string;
  existing: ExistingEntry[];
}

interface KbAuthorApply {
  entryId: string | null;
  status: 'active' | 'draft' | 'skipped';
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
    '## The title (user-set — write the article under THIS exact title; do not change it)',
    detected.title || '(untitled)',
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
    `5. Pick the best CATEGORY (one of: ${CATEGORIES.join(', ')}) and the version FACETS, then`,
    '   write the full, self-contained markdown article BODY under the user-set title above.',
    '',
    '## Output — emit EXACTLY ONE fenced ```json block and nothing else:',
    '```json',
    '{',
    '  "mode": "new" | "update",',
    '  "targetId": "<the existing id when mode=update; omit otherwise>",',
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
  const parsed = parseJsonLoose(text);
  if (parsed == null) return null;
  return parsed as Enrichment;
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
        title: entry.title,
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
      const title = d.title.trim() || 'Untitled house rule';
      return {
        mode: 'new',
        title,
        category: 'general',
        facets: {},
        body: `# ${title}\n\n${d.seedText}`,
      };
    },
    retry: { maxAttempts: 3, retryOn: (e) => e instanceof RetryableParseError },
  },

  async apply(ctx, args): Promise<KbAuthorApply> {
    const detected = args.detected as KbAuthorDetect;
    if (!detected.entryId) return { entryId: null, status: 'skipped', mode: 'new', sections: 0 };
    const skeletonId = detected.entryId;

    const parsed = parseEnrichment(args.llmOutput ?? null);
    if (!parsed && !args.isFinalLlmAttempt) {
      throw new RetryableParseError('kb enrichment output unparseable — retrying');
    }
    const title = detected.title.trim() || 'Untitled house rule';
    const category = normCategory(parsed?.category);
    const facets = cleanFacets(parsed?.facets);
    const body =
      parsed?.body && parsed.body.trim().length > 0
        ? parsed.body
        : `# ${title}\n\n${detected.seedText}`;

    // The model may flag this as an update of an existing rule; only honor a
    // targetId we actually showed it (else treat it as a new entry).
    const existingIds = new Set(detected.existing.map((e) => e.id));
    const intent = resolveWriteTarget(parsed, skeletonId, existingIds);
    const settings = await resolveGlobalKbSettings();

    // Decide supersede-vs-new under one transaction + a topic-scoped advisory lock
    // (mirrors promoteToGlobalKbDraft) so concurrent enriches for the same topic
    // serialize instead of each writing a blind duplicate. The dedup candidate set is
    // the model's proposed update target PLUS any entry that APPEARED SINCE this task's
    // detect snapshot (created by a concurrent enrich) — so the second of two racing
    // tasks sees the first's committed entry. Real embeddings (not the coarse lock key)
    // decide identity: a confirmed same-article match (>=0.72) becomes a review-gated
    // DRAFT superseding it (target left untouched until the user activates); anything
    // else — or ollama unavailable — is a brand-new active, so a wrong match can never
    // silently overwrite a good article. topicKey is the lock key ONLY, never stored on
    // the entry, so enrich stays isolated from the promote path's topicKey dedup.
    const lockTopic = globalKbTopicKey(category, facets) ?? `kbauthor:${category}`;
    const { confirmedUpdate, namespace } = await withGlobalKb(ctx.db, async ({ db }) =>
      db.transaction(async (tx) => {
        const lockKey = `${detected.namespace}:${lockTopic}`;
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('gkb_enrich'), hashtext(${lockKey}))`,
        );
        // Live entries newer than this task's detect snapshot (not already shown to the
        // model); capped for the embed batch. These catch a concurrent enrich's result.
        const appeared = await tx
          .select({
            id: globalKbEntries.id,
            status: globalKbEntries.status,
            title: globalKbEntries.title,
            body: globalKbEntries.body,
          })
          .from(globalKbEntries)
          .where(
            and(
              eq(globalKbEntries.namespace, detected.namespace),
              inArray(globalKbEntries.status, ['active', 'draft']),
              ne(globalKbEntries.id, skeletonId),
            ),
          )
          .orderBy(desc(globalKbEntries.updatedAt))
          .limit(SUPERSEDE_CANDIDATE_LIMIT);
        const candidates = appeared.filter((c) => !existingIds.has(c.id));
        // Keep the model's proposed target in the running even if it's an older entry
        // outside the recent-window query above.
        if (intent.isUpdate && !candidates.some((c) => c.id === intent.targetId)) {
          const [tgt] = await tx
            .select({
              id: globalKbEntries.id,
              status: globalKbEntries.status,
              title: globalKbEntries.title,
              body: globalKbEntries.body,
            })
            .from(globalKbEntries)
            .where(eq(globalKbEntries.id, intent.targetId))
            .limit(1);
          if (tgt) candidates.push(tgt);
        }
        // Confirm identity with real embeddings BEFORE letting anything supersede: the
        // coarse lock key groups a whole tech, so it can't decide the SAME article.
        const matchId =
          candidates.length > 0
            ? await confirmSupersedeByEmbedding(
                { ollamaUrl: settings.ollamaUrl, embedModel: settings.embedModel },
                `${title}\n\n${body}`,
                candidates.map((c) => ({
                  id: c.id,
                  status: c.status,
                  text: `${c.title}\n\n${c.body}`,
                })),
              )
            : null;
        const isUpdate = matchId != null;
        // The SKELETON row carries the article either way: a confirmed match becomes a
        // draft superseding it; otherwise it goes live immediately as a new entry.
        const [row] = await tx
          .update(globalKbEntries)
          .set({
            title,
            category,
            facets,
            body,
            status: isUpdate ? 'draft' : 'active',
            supersedesEntryId: matchId,
            embedStatus: 'pending',
            updatedAt: new Date(),
          })
          .where(eq(globalKbEntries.id, skeletonId))
          .returning({ namespace: globalKbEntries.namespace });
        return { confirmedUpdate: isUpdate, namespace: row?.namespace ?? detected.namespace };
      }),
    );

    if (intent.isUpdate && !confirmedUpdate) {
      ctx.logger.info(
        { skeletonId, proposedTargetId: intent.targetId },
        'kb enrich: update target not similarity-confirmed → writing as a new entry',
      );
    }

    // Auto-activate ONLY the new path: embed now so it's retrievable immediately.
    // A confirmed update is a draft (drafts hold no vectors) until the user reviews
    // and activates it — activation re-embeds via the API's enqueueSync.
    if (!confirmedUpdate) {
      try {
        await syncGlobalKbEntry({ entryId: skeletonId, namespace, reason: 'upsert' });
      } catch (err) {
        ctx.logger.warn(
          { err, entryId: skeletonId },
          'global KB embed after enrich failed; entry is active but unembedded',
        );
      }
    }

    ctx.logger.info(
      { entryId: skeletonId, mode: confirmedUpdate ? 'update' : 'new', enriched: !!parsed?.body },
      confirmedUpdate
        ? 'kb enrichment complete → draft (awaiting review)'
        : 'kb enrichment complete → active',
    );
    return {
      entryId: skeletonId,
      status: confirmedUpdate ? 'draft' : 'active',
      mode: confirmedUpdate ? 'update' : 'new',
      sections: (body.match(/^##\s/gm) ?? []).length,
    };
  },
};
