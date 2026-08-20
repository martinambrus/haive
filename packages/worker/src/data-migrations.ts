import { and, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CONFIG_KEYS, configService, logger } from '@haive/shared';
import { withGlobalKb } from '@haive/shared/global-kb';
import { isHeadingOnlyChunk } from './step-engine/steps/onboarding/_rag-chunkers.js';

const log = logger.child({ module: 'data-migrations' });

/**
 * Idempotent data fixes applied on every worker boot. Each helper must be
 * narrow, fast, and a no-op on a clean DB so that re-running on every restart
 * costs nothing.
 */
export async function runDataMigrations(db: Database): Promise<void> {
  await supersedeRemovedRtkArtifacts(db);
  await skipRemovedSteps(db);
  await supersedePhantomAgentArtifacts(db);
  await dropHeadingOnlyGlobalKbChunks(db);
}

/** Template ids removed when the RTK awareness markdown was consolidated into
 *  the (non-manifest) AGENTS.md block. Already-onboarded repos still have live
 *  onboarding_artifacts rows for these. For the `*-md-ref` ids the diskPath is
 *  a shared rules file (CLAUDE.md / GEMINI.md / AGENTS.md); the upgrade path's
 *  whole-file `obsolete → rm` would otherwise offer to delete that entire file.
 *  syncTemplateManifestCache already prunes these ids from
 *  template_manifest_cache; this clears the per-repo install rows. */
const REMOVED_RTK_TEMPLATE_IDS = [
  'rtk.claude-rtk-md',
  'rtk.claude-md-ref',
  'rtk.gemini-rtk-md',
  'rtk.gemini-md-ref',
  'rtk.agents-rtk-md',
  'rtk.agents-md-ref',
];

/** Soft-delete (supersede) live onboarding_artifacts rows for the removed RTK
 *  template items so they never surface as removable `obsolete` entries on the
 *  next upgrade. Idempotent: the `superseded_at IS NULL` guard makes a second
 *  run a no-op. The stale on-disk blocks they pointed at are cosmetic and are
 *  cleared on re-onboard. */
async function supersedeRemovedRtkArtifacts(db: Database): Promise<void> {
  await db
    .update(schema.onboardingArtifacts)
    .set({ supersededAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        inArray(schema.onboardingArtifacts.templateId, REMOVED_RTK_TEMPLATE_IDS),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    );
}

/** Step ids removed from the onboarding registry. Their task_steps rows are
 *  pre-created at task start, so a task created before the removal can still
 *  hold a non-terminal row for one — and the runner throws on an unknown step
 *  id when it reaches it. */
const REMOVED_STEP_IDS = ['06-workflow-prefs'];

/** Mark any non-terminal task_steps row for a removed step as skipped so the
 *  orchestrator advances past it instead of stranding on a missing definition.
 *  Idempotent: terminal rows (done/failed/skipped) are excluded, so a second
 *  run is a no-op. */
async function skipRemovedSteps(db: Database): Promise<void> {
  await db
    .update(schema.taskSteps)
    .set({ status: 'skipped', endedAt: new Date() })
    .where(
      and(
        inArray(schema.taskSteps.stepId, REMOVED_STEP_IDS),
        notInArray(schema.taskSteps.status, ['done', 'failed', 'skipped']),
      ),
    );
}

/** Soft-delete phantom Haive-agent onboarding_artifacts rows. Before the
 *  expandManifestFor `applies` gate, 12-post-onboarding recorded a row for every
 *  baseline + framework agent regardless of stack (the manifest was
 *  framework-blind), while 07-generate-files only wrote the accepted agents to
 *  disk. So repos carry rows for agents they never accepted and that were never
 *  written (e.g. django/node/react in a PHP repo); the upgrade plan then
 *  mislabels them `user_deleted` ("reinstate deleted files").
 *
 *  A row is phantom when its agent id is absent from its own
 *  `form_values_snapshot.acceptedAgentIds`. The non-empty guard skips
 *  legacy/snapshotless rows (acceptedAgentIds defaults to [] there) so a repo's
 *  whole agent set is never mass-superseded — same conservative rule as the
 *  `applies` gate. A genuinely user-deleted *accepted* agent keeps its id in the
 *  snapshot, so the predicate is false and the row is preserved.
 *
 *  Relies on the `applies` gate shipping together: once gated, the manifest no
 *  longer renders these agents, so a superseded phantom stays absent instead of
 *  resurfacing as `new_artifact`. Idempotent via the `superseded_at IS NULL`
 *  guard. Step 1 (applicable-ids cleanup) runs first because it reads the
 *  still-live phantom rows; step 2 then supersedes them. */
async function supersedePhantomAgentArtifacts(db: Database): Promise<void> {
  // 1. Remove phantom agent template_ids from each affected repo's
  //    applicable_template_ids. The upgrade-status API reads only
  //    template_manifest_cache + applicable_template_ids (it never expands), so
  //    without this a superseded phantom would resurface there as "new".
  await db.execute(sql`
    UPDATE repositories r
    SET applicable_template_ids = (
          SELECT COALESCE(array_agg(t ORDER BY t), '{}')
          FROM unnest(r.applicable_template_ids) AS t
          WHERE NOT EXISTS (
            SELECT 1 FROM onboarding_artifacts oa
            WHERE oa.repository_id = r.id
              AND oa.template_id = t
              AND oa.template_kind = 'agent'
              AND oa.template_id LIKE 'agent.%'
              AND oa.superseded_at IS NULL
              AND jsonb_typeof(oa.form_values_snapshot -> 'acceptedAgentIds') = 'array'
              AND jsonb_array_length(oa.form_values_snapshot -> 'acceptedAgentIds') > 0
              AND NOT jsonb_exists(oa.form_values_snapshot -> 'acceptedAgentIds', replace(oa.template_id, 'agent.', ''))
          )
        ),
        updated_at = now()
    WHERE r.applicable_template_ids IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM onboarding_artifacts oa
        WHERE oa.repository_id = r.id
          AND oa.template_kind = 'agent'
          AND oa.template_id LIKE 'agent.%'
          AND oa.superseded_at IS NULL
          AND jsonb_typeof(oa.form_values_snapshot -> 'acceptedAgentIds') = 'array'
          AND jsonb_array_length(oa.form_values_snapshot -> 'acceptedAgentIds') > 0
          AND NOT jsonb_exists(oa.form_values_snapshot -> 'acceptedAgentIds', replace(oa.template_id, 'agent.', ''))
      )
  `);

  // 2. Soft-delete the phantom rows themselves.
  await db.execute(sql`
    UPDATE onboarding_artifacts
    SET superseded_at = now(), updated_at = now()
    WHERE template_kind = 'agent'
      AND template_id LIKE 'agent.%'
      AND superseded_at IS NULL
      AND jsonb_typeof(form_values_snapshot -> 'acceptedAgentIds') = 'array'
      AND jsonb_array_length(form_values_snapshot -> 'acceptedAgentIds') > 0
      AND NOT jsonb_exists(form_values_snapshot -> 'acceptedAgentIds', replace(template_id, 'agent.', ''))
  `);
}

/** Cheap SQL prefilter before the real predicate runs in TS. A heading-only
 *  chunk is one context-header line plus one heading line; a 300-char title and
 *  its breadcrumb still fit well inside this. Nothing is decided by it — it only
 *  bounds how many rows are read. */
const HEADING_ONLY_PREFILTER_CHARS = 1024;

/** Delete global KB chunks that hold nothing but a heading.
 *
 *  `extractMarkdownSections` used to emit a section for a heading with no prose
 *  of its own (an H1 whose first child is an H2). Those chunks are pure title
 *  text: they outrank the entry's real body chunks on exactly the title-shaped
 *  query the digest tells agents to make, and then spend the entry's single
 *  global merge slot on zero information. The chunker no longer emits them, but
 *  entries embedded before that keep theirs — a global entry is re-chunked only
 *  when it is written, and a chunker change writes no entry.
 *
 *  Deleting the rows IS what re-chunking would produce: dropping a section
 *  changes no other section's id, chunk index or content, and no global entry is
 *  near the per-entry chunk cap that could otherwise let a dropped tail back in.
 *  The per-repo indexes need no equivalent — `_rag-index.ts` re-extracts every
 *  file on each run and sweeps section keys it no longer produces.
 *
 *  Idempotent: a second run matches nothing. Best-effort and flag-gated — a
 *  global KB that is disabled or unreachable must never fail worker boot, and a
 *  disabled one must not be connected to (that would create its database). */
async function dropHeadingOnlyGlobalKbChunks(db: Database): Promise<void> {
  try {
    if (!(await configService.getBoolean(CONFIG_KEYS.GLOBAL_KB_ENABLED, false))) return;
    await withGlobalKb(db, async ({ conn, settings }) => {
      const rows = (await conn.pg.unsafe(
        `SELECT id, content FROM ai_rag_embeddings WHERE namespace = $1 AND length(content) < $2`,
        [settings.namespace, HEADING_ONLY_PREFILTER_CHARS],
      )) as unknown as Array<{ id: number; content: string }>;
      const stale = rows.filter((r) => isHeadingOnlyChunk(r.content)).map((r) => r.id);
      if (stale.length === 0) return;
      const placeholders = stale.map((_, i) => `$${i + 1}`).join(', ');
      await conn.pg.unsafe(`DELETE FROM ai_rag_embeddings WHERE id IN (${placeholders})`, stale);
      log.info({ deleted: stale.length }, 'removed heading-only global KB chunks');
    });
  } catch (err) {
    log.warn({ err }, 'heading-only global KB chunk cleanup skipped');
  }
}
