import { eq, isNotNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { parseStepId } from '@haive/shared/modularity';
import { moduleSchemaFailed, moduleSchemaUnready, moduleTeardownRunning } from './schema-ready.js';

/** `lock` reads under KEY SHARE, which waits out a deactivation holding the row FOR UPDATE. */
export async function moduleDeactivationMessage(
  db: Database,
  stepId: string,
  opts: { lock?: boolean } = {},
): Promise<string | null> {
  const parsed = parseStepId(stepId);
  if (parsed?.kind !== 'module') return null;
  const read = db
    .select({ deactivatedAt: schema.modules.deactivatedAt })
    .from(schema.modules)
    .where(eq(schema.modules.moduleId, parsed.moduleId));
  const [row] = opts.lock ? await read.for('key share') : await read.limit(1);
  if (!row?.deactivatedAt) return null;
  return (
    `Module ${parsed.moduleId} is deactivated, so step ${stepId} cannot run. ` +
    `Reactivate the module (Admin > Modules), then Retry the step.`
  );
}

export function moduleSchemaFailedMessage(stepId: string): string | null {
  const parsed = parseStepId(stepId);
  if (parsed?.kind !== 'module') return null;
  const id = parsed.moduleId;
  if (!moduleSchemaFailed(id) || moduleTeardownRunning(id)) return null;
  return (
    `Module ${id}'s schema setup failed on this worker and is no longer being retried (the worker log has the error), so step ${stepId} cannot run. ` +
    `Deactivating and reactivating the module (Admin > Modules) runs the setup again; then Retry the step.`
  );
}

export function moduleSchemaNotReady(stepId: string): boolean {
  const parsed = parseStepId(stepId);
  return parsed?.kind === 'module' && moduleSchemaUnready(parsed.moduleId);
}

export async function moduleSchemaWaitMessage(
  db: Database,
  stepId: string,
): Promise<string | null> {
  const parsed = parseStepId(stepId);
  if (parsed?.kind !== 'module') return null;
  const id = parsed.moduleId;
  if (!moduleSchemaUnready(id)) return null;
  if (moduleSchemaFailedMessage(stepId) !== null) return null;
  if ((await moduleDeactivationMessage(db, stepId)) !== null) return null;
  if (moduleTeardownRunning(id)) {
    return (
      `Module ${id}'s teardown hook is still running on this worker, so step ${stepId} starts after it has ended and the module's schema setup, if it has one, has run again. ` +
      `Only a worker restart frees a hook that never ends.`
    );
  }
  return (
    `Module ${id}'s schema is being set up on this worker, so step ${stepId} starts when it is done. ` +
    `If this stays here, the worker log has the setup error; deactivating and reactivating the module (Admin > Modules) runs the setup again.`
  );
}

export async function deactivatedModuleIds(db: Database): Promise<Set<string>> {
  const rows = await db
    .select({ moduleId: schema.modules.moduleId })
    .from(schema.modules)
    .where(isNotNull(schema.modules.deactivatedAt));
  return new Set(rows.map((row) => row.moduleId));
}

/** One read, so a module's stamp and its deactivation are of the same moment. */
export async function moduleActivationState(
  db: Database,
): Promise<{ deactivated: Set<string>; stamps: Map<string, number> }> {
  const rows = await db
    .select({
      moduleId: schema.modules.moduleId,
      deactivatedAt: schema.modules.deactivatedAt,
      updatedAt: schema.modules.updatedAt,
    })
    .from(schema.modules);
  return {
    deactivated: new Set(
      rows.filter((row) => row.deactivatedAt !== null).map((row) => row.moduleId),
    ),
    stamps: new Map(rows.map((row) => [row.moduleId, row.updatedAt.getTime()])),
  };
}
