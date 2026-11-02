import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { hasPgCode, schema, type Database } from '@haive/database';
import { logger } from '@haive/shared';
import { moduleDatabaseName } from '@haive/shared/module-db';
import { moduleSettingsPattern } from '@haive/shared/module-host';
import { insertAuditEvent, logAuditEvent } from '../lib/audit.js';
import {
  deleteModuleIntegrations,
  emptyModuleIntegrationCounts,
  moduleIntegrationDependents,
  moduleIntegrationPredicates,
  moduleIntegrationTaskPredicate,
  type ModuleIntegrationCounts,
} from './purge-integrations.js';

const log = logger.child({ module: 'module-purge' });

const OBJECT_IN_USE = '55006';
const RETRY_AFTER_MS = 500;

/** `came-back`: the module loaded again before its row went, so the row and its types were kept. */
export type ModulePurge =
  | {
      kind: 'purged' | 'came-back';
      database: string;
      configKeysDeleted: number;
      taskTypesDeleted: string[];
      taskTypesKept: string[];
      integrationsDeleted: ModuleIntegrationCounts;
    }
  | { kind: 'in-use'; database: string }
  | { kind: 'gone' };

class NotPurged extends Error {
  constructor(readonly reason: 'came-back' | 'gone') {
    super(reason);
  }
}

/** The database is already dropped and a later step failed; running the purge again finishes it. */
export class PurgeIncompleteError extends Error {
  constructor(
    readonly database: string,
    options?: ErrorOptions,
  ) {
    super(`module database ${database} was dropped but the purge did not finish`, options);
    this.name = 'PurgeIncompleteError';
  }
}

/** No FORCE: a backend still connected is somebody's, so it is reported rather than terminated. */
async function dropModuleDatabase(db: Database, name: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await db.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}"`));
      return true;
    } catch (err) {
      if (!hasPgCode(err, OBJECT_IN_USE)) throw err;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
    }
  }
  return false;
}

async function deleteModuleSettings(redis: Redis, moduleId: string): Promise<number> {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      moduleSettingsPattern(moduleId),
      'COUNT',
      200,
    );
    cursor = next;
    if (keys.length > 0) deleted += await redis.unlink(...keys);
  } while (cursor !== '0');
  return deleted;
}

/** Each step is safe to repeat, so a purge that stopped part way is finished by the next one. */
export async function purgeModule(
  db: Database,
  redis: Redis,
  moduleId: string,
  actorUserId: string,
): Promise<ModulePurge> {
  const database = moduleDatabaseName(moduleId);
  if (!(await dropModuleDatabase(db, database))) return { kind: 'in-use', database };
  log.info({ moduleId, database }, 'module database dropped');
  try {
    return await purgeAfterDrop(db, redis, moduleId, database, actorUserId);
  } catch (err) {
    log.error({ err, moduleId, database }, 'module purge stopped after the database was dropped');
    throw new PurgeIncompleteError(database, { cause: err });
  }
}

async function purgeAfterDrop(
  db: Database,
  redis: Redis,
  moduleId: string,
  database: string,
  actorUserId: string,
): Promise<ModulePurge> {
  const configKeysDeleted = await deleteModuleSettings(redis, moduleId);
  log.info({ moduleId, configKeysDeleted }, 'module settings deleted');

  try {
    // Type rows are locked before the module row, the order the task create path takes them in.
    const taskTypes = await db.transaction(async (tx) => {
      const slugs = (
        await tx
          .select({ slug: schema.taskTypeDefinitions.slug })
          .from(schema.taskTypeDefinitions)
          .where(eq(schema.taskTypeDefinitions.source, `module:${moduleId}`))
          .orderBy(asc(schema.taskTypeDefinitions.slug))
          .for('update')
      ).map((row) => row.slug);
      // Do not wait while holding type rows for a writer that may itself need them.
      // These brief table locks prevent new bindings between the live-task check and deletion.
      await tx.execute(
        sql`LOCK TABLE ${schema.integrationProviderConfigs}, ${schema.integrationConnections}, ${schema.integrationUserSettings}, ${schema.integrationCategoryPreferences}, ${schema.taskIntegrationChoices}, ${schema.integrationGrants} IN SHARE ROW EXCLUSIVE MODE NOWAIT`,
      );
      // A disconnect's SELECT FOR UPDATE holds compatible ROW SHARE before DELETE.
      // Refuse its owned row now, so neither request waits on the other's later lock.
      await tx
        .select({ id: schema.integrationConnections.id })
        .from(schema.integrationConnections)
        .where(moduleIntegrationPredicates(moduleId).connections)
        .orderBy(asc(schema.integrationConnections.id))
        .for('update', { noWait: true });
      // Stabilize status changes for every task whose direct binding we would remove.
      await tx
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(moduleIntegrationTaskPredicate(moduleId))
        .orderBy(asc(schema.tasks.id))
        .for('no key update', { noWait: true });
      if ((await moduleIntegrationDependents(tx, moduleId)).tasks.length > 0) {
        throw new Error(
          'Live tasks still hold module integration bindings; cancel them before retrying',
        );
      }
      const used = new Set(
        slugs.length === 0
          ? []
          : (
              await tx
                .selectDistinct({ type: schema.tasks.type })
                .from(schema.tasks)
                .where(inArray(schema.tasks.type, slugs))
            ).map((row) => row.type),
      );
      const unused = slugs.filter((slug) => !used.has(slug));
      if (unused.length > 0) {
        await tx
          .delete(schema.taskTypeDefinitions)
          .where(inArray(schema.taskTypeDefinitions.slug, unused));
      }
      const removed = await tx
        .delete(schema.modules)
        .where(and(eq(schema.modules.moduleId, moduleId), isNotNull(schema.modules.missingAt)))
        .returning({ moduleId: schema.modules.moduleId });
      if (removed.length === 0) {
        const [row] = await tx
          .select({ moduleId: schema.modules.moduleId })
          .from(schema.modules)
          .where(eq(schema.modules.moduleId, moduleId));
        throw new NotPurged(row === undefined ? 'gone' : 'came-back');
      }
      const integrationsDeleted = await deleteModuleIntegrations(tx, moduleId);
      const result = {
        deleted: unused,
        kept: slugs.filter((slug) => used.has(slug)),
        integrationsDeleted,
      };
      await insertAuditEvent(tx, {
        actorUserId,
        action: 'module.purge',
        targetType: 'module',
        metadata: {
          moduleId,
          database,
          configKeysDeleted,
          taskTypesDeleted: result.deleted,
          taskTypesKept: result.kept,
          integrationsDeleted,
        },
      });
      return result;
    });
    logAuditEvent({
      actorUserId,
      action: 'module.purge',
      targetType: 'module',
      metadata: {
        moduleId,
        database,
        configKeysDeleted,
        taskTypesDeleted: taskTypes.deleted,
        taskTypesKept: taskTypes.kept,
        integrationsDeleted: taskTypes.integrationsDeleted,
      },
    });
    return {
      kind: 'purged',
      database,
      configKeysDeleted,
      taskTypesDeleted: taskTypes.deleted,
      taskTypesKept: taskTypes.kept,
      integrationsDeleted: taskTypes.integrationsDeleted,
    };
  } catch (err) {
    if (!(err instanceof NotPurged)) throw err;
    if (err.reason === 'gone') return { kind: 'gone' };
    return {
      kind: 'came-back',
      database,
      configKeysDeleted,
      taskTypesDeleted: [],
      taskTypesKept: [],
      integrationsDeleted: emptyModuleIntegrationCounts(),
    };
  }
}
