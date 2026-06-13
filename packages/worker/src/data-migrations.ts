import { and, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';

/**
 * Idempotent data fixes applied on every worker boot. Each helper must be
 * narrow, fast, and a no-op on a clean DB so that re-running on every restart
 * costs nothing.
 */
export async function runDataMigrations(db: Database): Promise<void> {
  await supersedeRemovedRtkArtifacts(db);
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
