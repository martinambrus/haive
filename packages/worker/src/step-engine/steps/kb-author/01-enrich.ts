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
import { FACET_FILTER_DIMENSIONS } from '@haive/shared/rag';
import { retrievalGuidanceLines } from '../_retrieval-guidance.js';

// Global-KB authoring. The task is created by the global-kb enrich endpoint with a
// cliProviderId and metadata.globalKbEntryId pointing at a `skeleton` entry whose body is the
// author's free-text notes; the model turns those notes into a reusable house standard and
// decides whether the rule already exists (update) or is new (insert). Form-less:
// detect -> llm -> apply.
//
// A repository is OPTIONAL and is only ever a place to SEE the rule obeyed or broken. It is
// not the subject: the article is retrieved by other projects, so it must carry no file paths,
// symbols, line numbers or counts from the codebase that happened to be open. MEASURED on
// entry b15eebfb — authored against a Drupal 7 repo from notes about a Drupal 8+ rule, it came
// out as an audit of that one repo (`sites/all/themes/.../img/`, "the 122 PNG icons",
// "currently 2 hits") scoped `frameworkMajor: ["7"]`, which is precisely the set of projects
// the rule does NOT apply to.
//
// Facets describe the RULE. The author may state them up front, and what they state wins:
// asking the prompt was already tried and produced the "7" above. Every result is a DRAFT —
// the shared store is not a place for unreviewed writing.

const CATEGORIES = [
  'general',
  'tech_pattern',
  'anti_pattern',
  'best_practice',
  'quick_reference',
] as const;
type Category = (typeof CATEGORIES)[number];

/** The dimensions this step may write. The SAME list retrieval filters on — a dimension written
 *  here but absent there would scope an entry by something nothing reads. */
const FACET_DIMS = FACET_FILTER_DIMENSIONS;

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

export interface KbAuthorDetect {
  entryId: string | null;
  namespace: string;
  // User-set title — authoritative, the LLM does not derive its own.
  title: string;
  seedText: string;
  existing: ExistingEntry[];
  /** Whether a repository is checked out for this run. ANCHORED mode reads one to see the
   *  pattern in practice; repo-less writes from the notes alone. Decides which preamble the
   *  prompt gets and whether the retrieval block is spliced at all — with nothing on disk,
   *  telling the model to search a repo sends it after files that do not exist. */
  hasRepo: boolean;
  /** Scope the AUTHOR stated when creating the entry. Authoritative: these dimensions are
   *  merged over whatever the model returns, because asking a prompt nicely is exactly what
   *  produced a Drupal-8+ rule scoped to `frameworkMajor: ["7"]`. */
  authorFacets: GlobalKbFacets;
}

interface KbAuthorApply {
  entryId: string | null;
  /** Never 'active': every article is reviewed before it reaches the shared store. */
  status: 'draft' | 'skipped';
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

async function loadTaskAnchor(
  ctx: StepContext,
): Promise<{ entryId: string | null; hasRepo: boolean }> {
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { metadata: true, repositoryId: true },
  });
  const md = task?.metadata as { globalKbEntryId?: string } | null;
  // ANCHORED vs repo-less is the task's own repositoryId, not `ctx.repoPath`: a repo-less task
  // still has a repoPath — an empty scratch workspace — so the path cannot answer this.
  return { entryId: md?.globalKbEntryId ?? null, hasRepo: task?.repositoryId != null };
}

export function buildEnrichPrompt(detected: KbAuthorDetect): string {
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
  const scope = Object.entries(detected.authorFacets)
    .filter(([, v]) => Array.isArray(v) && v.length > 0)
    .map(([dim, v]) => `- ${dim}: ${(v as string[]).join(', ')}`);
  return [
    'You document reusable house standards for a global, cross-project knowledge base.',
    'The article you write is retrieved by OTHER projects — different frameworks, different',
    'layouts, different file names from anything you can see from here.',
    '',
    ...(detected.hasRepo
      ? [
          'A repository is checked out at the working directory. It is where you can SEE this rule',
          'obeyed or broken — it is NOT the subject of the article. Read it to understand how the',
          'pattern is used, then write a rule that holds for a project sharing none of its files.',
          'Web access only if network egress is permitted; if a fetch fails, do not assume it.',
        ]
      : [
          'NO repository is checked out, because this rule is not about any one codebase. Write it',
          "from the author's notes below. Web access only if network egress is permitted.",
        ]),
    '',
    '## The title (user-set — write the article under THIS exact title; do not change it)',
    detected.title || '(untitled)',
    '',
    "## The author's notes (free text — the house rule to capture)",
    detected.seedText || '(empty)',
    '',
    ...(scope.length
      ? [
          '## The scope the author set (AUTHORITATIVE — do not narrow or widen it)',
          ...scope,
          'These dimensions are already decided. Fill in only the ones missing below.',
          '',
        ]
      : []),
    '## Existing house rules (for de-duplication)',
    existing,
    '',
    ...(detected.hasRepo
      ? ['## How to find the code — follow this order', ...retrievalGuidanceLines(), '']
      : []),
    '## What the article must look like',
    '- A reader who cannot see any repository must be able to apply it.',
    '- NEVER cite a file path, a file name, a symbol from a real codebase, a line number or a',
    '  count of occurrences. Those belong to ONE project at ONE moment: they mean nothing in the',
    '  next project and they are wrong in this one as soon as a file is renamed.',
    '- Show the pattern with SHORT, self-contained code examples, abstracted or invented. An',
    '  example carries HOW the pattern looks, never WHERE it was seen.',
    '- Give both sides, in this order: a `## The wrong way` section, then `## The right way`.',
    '  The wrong way is what a reader must recognise in their own code before the rule means',
    '  anything, so put a `// ANTI-PATTERN — do not copy` comment INSIDE its code fence.',
    '  Ending on the right way leaves the correct form as the last thing read.',
    '',
    '## Your task',
    ...(detected.hasRepo
      ? [
          '1. Read the code the notes point at — to understand the pattern and how it is misused,',
          '   not to quote it. Nothing you read gets cited in the article.',
        ]
      : ['1. Work the rule out from the notes and from what you know of the technology.']),
    '2. Decide the SCOPE: which technologies does this rule actually apply to? Name the base',
    '   technology (e.g. "drupal", "postgresql", "php"). Add a MAJOR version ONLY when the rule',
    '   is genuinely specific to it — a rule that holds across majors must NOT name one, because',
    '   naming a dimension RESTRICTS the entry to it and an omitted dimension applies to all.',
    ...(detected.hasRepo
      ? [
          '   Do NOT read the scope off the repository in front of you. What it happens to have',
          '   installed is not what the rule applies to — a rule about Drupal 8+ seen in a Drupal 7',
          '   codebase is still a Drupal 8+ rule.',
        ]
      : []),
    '3. If web access is available, consult official docs to fill gaps.',
    '4. Decide whether this rule already exists above. If it is the SAME rule (same topic / module /',
    '   scope) as one listed, set mode="update" and targetId to that id — you will REPLACE it with a',
    '   complete, improved article that incorporates the new notes. Otherwise set mode="new".',
    `5. Pick the best CATEGORY (one of: ${CATEGORIES.join(', ')}) and the FACETS, then`,
    '   write the full, self-contained markdown article BODY under the user-set title above.',
    '',
    '## Output — emit EXACTLY ONE fenced ```json block and nothing else:',
    '```json',
    '{',
    '  "mode": "new" | "update",',
    '  "targetId": "<the existing id when mode=update; omit otherwise>",',
    '  "category": "<one of the categories listed above>",',
    '  "facets": {',
    '    "framework": ["<e.g. drupal — omit the major unless the rule needs it>"],',
    '    "frameworkMajor": ["<e.g. 11 — ONLY for a rule that is specific to that major>"],',
    '    "language": ["<e.g. php>"],',
    '    "phpMajor": ["<e.g. 8 — only for a rule specific to it>"],',
    '    "nodeMajor": ["<e.g. 22 — only for a rule specific to it>"],',
    '    "database": ["<e.g. mysql or mariadb — for datastore-only rules>"],',
    '    "dbMajor": ["<e.g. 10 — only for a rule specific to it>"],',
    '    "packages": ["<name@major, e.g. drupal/paragraphs@8>"],',
    '    "tags": ["<free-form, e.g. performance>"]',
    '  },',
    '  "body": "<the full markdown article>"',
    '}',
    '```',
    'Facets describe the RULE, not any codebase. Omit every dimension the rule does not depend',
    'on — an omitted dimension means it applies to all values of that dimension, which is what',
    'makes an entry reachable from the projects that need it. Major versions only.',
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
/** The author's stated scope overlaid on the model's, dimension by dimension.
 *
 *  A REPLACE per dimension, not a union: the author saying "drupal" and the model saying
 *  "drupal 7" must not become "drupal, 7" — that is the over-scoping this exists to stop, and
 *  naming a dimension RESTRICTS the entry to it. Dimensions the author left blank are the
 *  model's to fill, which is the whole point of asking it.
 *
 *  Enforced HERE rather than in the prompt because the prompt already asked, politely, and got
 *  `frameworkMajor: ["7"]` on a rule the author wrote for Drupal 8+. */
export function mergeAuthorFacets(
  authorFacets: GlobalKbFacets,
  modelFacets: GlobalKbFacets,
): GlobalKbFacets {
  const merged: GlobalKbFacets = { ...modelFacets };
  for (const dim of FACET_DIMS) {
    const stated = authorFacets[dim];
    if (Array.isArray(stated) && stated.length > 0) merged[dim] = [...stated];
  }
  return merged;
}

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
    const { entryId, hasRepo } = await loadTaskAnchor(ctx);
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
        hasRepo,
        // Whatever the author stated when creating the entry. The skeleton is inserted with
        // `facets: {}` when they state nothing, so this is empty in that case and the model
        // decides every dimension.
        authorFacets: entry.facets ?? {},
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
    const facets = mergeAuthorFacets(
      cleanFacets(detected.authorFacets),
      cleanFacets(parsed?.facets),
    );
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
    // decide identity: a confirmed same-article match (>=0.72) records what it supersedes so
    // review can show the diff (the target is left untouched until the user activates);
    // anything else — or ollama unavailable — is simply a new entry, so a wrong match can
    // never overwrite a good article. topicKey is the lock key ONLY, never stored on
    // the entry, so enrich stays isolated from the promote path's topicKey dedup.
    const lockTopic = globalKbTopicKey(category, facets) ?? `kbauthor:${category}`;
    const { confirmedUpdate } = await withGlobalKb(ctx.db, async ({ db }) =>
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
        // The SKELETON row carries the article either way. A confirmed match additionally
        // records what it supersedes, so review can show the diff; the target itself is left
        // untouched until the user activates.
        await tx
          .update(globalKbEntries)
          .set({
            title,
            category,
            facets,
            body,
            // ALWAYS a draft. A brand-new article is the riskiest thing that enters a store
            // shared by every project, and it used to be the one case that skipped review
            // while an UPDATE — a change to something already reviewed — was held. That is
            // backwards, and it is what the endpoint's own contract says ("the user reviews +
            // activates the draft"). Activation embeds it, through the API's enqueueSync.
            status: 'draft',
            supersedesEntryId: matchId,
            embedStatus: 'pending',
            updatedAt: new Date(),
          })
          .where(eq(globalKbEntries.id, skeletonId));
        return { confirmedUpdate: isUpdate };
      }),
    );

    if (intent.isUpdate && !confirmedUpdate) {
      ctx.logger.info(
        { skeletonId, proposedTargetId: intent.targetId },
        'kb enrich: update target not similarity-confirmed → writing as a new entry',
      );
    }

    // No embed here any more. Drafts hold no vectors (the sync job deletes chunks for anything
    // not `active`), so embedding on write was only ever reachable on the auto-activate path
    // this commit removes; activation re-embeds through the API's enqueueSync.
    ctx.logger.info(
      { entryId: skeletonId, mode: confirmedUpdate ? 'update' : 'new', enriched: !!parsed?.body },
      'kb enrichment complete → draft (awaiting review)',
    );
    return {
      entryId: skeletonId,
      status: 'draft',
      mode: confirmedUpdate ? 'update' : 'new',
      sections: (body.match(/^##\s/gm) ?? []).length,
    };
  },
};
