import { and, isNull, notInArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { LoadedWorkerModule } from './loader.js';

export async function syncModuleIntent(
  db: Database,
  loaded: readonly LoadedWorkerModule[],
): Promise<void> {
  const now = new Date();
  const ids = loaded.map((m) => m.manifest.id);

  await db.transaction(async (tx) => {
    for (const m of loaded) {
      const row = {
        packageName: m.packageName,
        source: m.source,
        name: m.manifest.name,
        installedVersion: m.manifest.version,
        entitlementId: m.manifest.entitlementId ?? null,
        lastLoadedAt: now,
        missingAt: null,
        updatedAt: now,
      };
      await tx
        .insert(schema.modules)
        .values({ moduleId: m.manifest.id, firstLoadedAt: now, ...row })
        .onConflictDoUpdate({ target: schema.modules.moduleId, set: row });
    }
    const notLoaded = ids.length === 0 ? undefined : notInArray(schema.modules.moduleId, ids);
    await tx
      .update(schema.modules)
      .set({ missingAt: now, updatedAt: now })
      .where(and(isNull(schema.modules.missingAt), notLoaded));
  });
}
