import { isNotNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { STEP_MINING_SEATS, type CliRoleDescriptor } from '@haive/shared';
import type { ModuleManifest } from '@haive/shared/modularity';

export type MiningSeatMap = Readonly<Record<string, readonly CliRoleDescriptor[]>>;

let declarations: { moduleId: string; stepId: string; seats: readonly CliRoleDescriptor[] }[] = [];

/** Replace the boot registry only after every installed manifest has been validated. */
export function registerModuleMiningSeats(loaded: readonly { manifest: ModuleManifest }[]): void {
  declarations = loaded.flatMap(({ manifest }) =>
    Object.entries(manifest.miningSeats ?? {}).map(([localId, seats]) => ({
      moduleId: manifest.id,
      stepId: `module.${manifest.id}.${localId}`,
      seats,
    })),
  );
}

/** One live union for all API seat readers. Availability never mutates saved choices. */
export async function resolveMiningSeats(db: Pick<Database, 'select'>): Promise<MiningSeatMap> {
  if (declarations.length === 0) return STEP_MINING_SEATS;
  const off = new Set(
    (
      await db
        .select({ moduleId: schema.modules.moduleId })
        .from(schema.modules)
        .where(isNotNull(schema.modules.deactivatedAt))
    ).map((row) => row.moduleId),
  );
  return {
    ...STEP_MINING_SEATS,
    ...Object.fromEntries(
      declarations
        .filter(({ moduleId }) => !off.has(moduleId))
        .map(({ stepId, seats }) => [stepId, seats]),
    ),
  };
}
