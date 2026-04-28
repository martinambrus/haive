import { eq } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import {
  agentSpecSchema,
  getCliProviderMetadata,
  skillEntrySchema,
  type CliProviderName,
} from '@haive/shared';
import type { BundleForExpansion, BundleItemForExpansion } from './template-manifest.js';

/** Lightweight pino-compatible shape so callers can pass any logger child
 *  without dragging the concrete type into shared. */
export interface LoaderLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface BundleWithMeta extends BundleForExpansion {
  name: string;
  sourceType: 'zip' | 'git';
  lastSyncCommit: string | null;
}

/** Load every active bundle bound to `repositoryId`, decode every item's
 *  `normalized_spec` via the canonical zod schema, and shape it for both the
 *  template-manifest expansion and the install.json bundle summary. Items
 *  whose spec fails validation are skipped with a warning rather than
 *  throwing — a corrupt row should never block the rest of the onboarding
 *  / upgrade. */
export async function loadBundlesForExpansion(
  db: Database,
  repositoryId: string,
  logger: LoaderLogger,
): Promise<BundleWithMeta[]> {
  const bundles = await db
    .select({
      id: schema.customBundles.id,
      name: schema.customBundles.name,
      sourceType: schema.customBundles.sourceType,
      lastSyncCommit: schema.customBundles.lastSyncCommit,
    })
    .from(schema.customBundles)
    .where(eq(schema.customBundles.repositoryId, repositoryId));
  if (bundles.length === 0) return [];

  const result: BundleWithMeta[] = [];
  for (const b of bundles) {
    const items = await db
      .select({
        id: schema.customBundleItems.id,
        kind: schema.customBundleItems.kind,
        contentHash: schema.customBundleItems.contentHash,
        schemaVersion: schema.customBundleItems.schemaVersion,
        normalizedSpec: schema.customBundleItems.normalizedSpec,
        sourcePath: schema.customBundleItems.sourcePath,
      })
      .from(schema.customBundleItems)
      .where(eq(schema.customBundleItems.bundleId, b.id));

    const decoded: BundleItemForExpansion[] = [];
    for (const item of items) {
      if (item.kind === 'agent') {
        const parsed = agentSpecSchema.safeParse(item.normalizedSpec);
        if (!parsed.success) {
          logger.warn(
            { bundleId: b.id, sourcePath: item.sourcePath },
            'bundle-loader: agent IR failed schema validation, skipping',
          );
          continue;
        }
        decoded.push({
          id: item.id,
          kind: 'agent',
          schemaVersion: item.schemaVersion,
          contentHash: item.contentHash,
          spec: parsed.data,
        });
      } else if (item.kind === 'skill') {
        const parsed = skillEntrySchema.safeParse(item.normalizedSpec);
        if (!parsed.success) {
          logger.warn(
            { bundleId: b.id, sourcePath: item.sourcePath },
            'bundle-loader: skill IR failed schema validation, skipping',
          );
          continue;
        }
        decoded.push({
          id: item.id,
          kind: 'skill',
          schemaVersion: item.schemaVersion,
          contentHash: item.contentHash,
          spec: parsed.data,
        });
      }
    }
    result.push({
      id: b.id,
      name: b.name,
      sourceType: b.sourceType as 'zip' | 'git',
      lastSyncCommit: b.lastSyncCommit ?? null,
      items: decoded,
    });
  }
  return result;
}

/** Resolve unique `projectSkillsDir` entries for the user's enabled CLIs.
 *  Same logic as `resolveSkillTargetDirs` in 09_5 — extracted so 01-upgrade-
 *  plan / 02-upgrade-apply / 12-post-onboarding all hit identical fan-out. */
export async function resolveSkillTargets(db: Database, userId: string): Promise<string[]> {
  const rows = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.userId, userId),
    columns: { name: true, enabled: true },
  });
  const dirs = new Set<string>();
  for (const row of rows) {
    if (!row.enabled) continue;
    const meta = getCliProviderMetadata(row.name as CliProviderName);
    if (meta.projectSkillsDir) dirs.add(meta.projectSkillsDir);
  }
  return Array.from(dirs);
}

/** Pluck the `custom_bundle_items.id` out of a custom template id of the form
 *  `custom.<bundleId>.<itemId>`. Returns null for non-custom template ids so
 *  Haive-template rows leave `bundle_item_id` NULL. */
export function extractBundleItemId(templateId: string): string | null {
  if (!templateId.startsWith('custom.')) return null;
  const parts = templateId.split('.');
  if (parts.length < 3) return null;
  return parts.slice(2).join('.');
}
