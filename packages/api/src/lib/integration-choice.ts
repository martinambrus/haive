import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type DbTx } from '@haive/database';
import { credentialUsableForPr } from '@haive/shared/forge';
import {
  getIntegrationProvider,
  isProviderEnabled,
  listIntegrationCategories,
} from '@haive/shared/integrations';
import { HttpError } from '../context.js';
import type { Database } from '../db.js';

const FORGE_CATEGORY = 'forge';

export interface OwnConnection {
  id: string;
  providerId: string;
  credential: { provider: string | null; host: string } | null;
}

interface PreferenceRow {
  userId: string | null;
  categoryId: string;
  providerId: string;
  connectionId: string | null;
}

/** The admin's default provider per category: the preference rows that belong to no user. */
export function listAdminDefaults(db: Database) {
  return db
    .select({
      categoryId: schema.integrationCategoryPreferences.categoryId,
      providerId: schema.integrationCategoryPreferences.providerId,
    })
    .from(schema.integrationCategoryPreferences)
    .where(isNull(schema.integrationCategoryPreferences.userId))
    .orderBy(asc(schema.integrationCategoryPreferences.categoryId));
}

/** The caller's own connections, else 404: a missing connection and someone else's answer alike. */
export async function requireOwnConnections(
  db: Database,
  userId: string,
  connectionIds: readonly string[],
): Promise<OwnConnection[]> {
  const wanted = [...new Set(connectionIds)];
  if (wanted.length === 0) return [];
  const rows = await db
    .select({
      id: schema.integrationConnections.id,
      providerId: schema.integrationConnections.providerId,
      credentialProvider: schema.repoCredentials.provider,
      credentialHost: schema.repoCredentials.host,
    })
    .from(schema.integrationConnections)
    .leftJoin(
      schema.repoCredentials,
      eq(schema.repoCredentials.id, schema.integrationConnections.repoCredentialId),
    )
    .where(
      and(
        inArray(schema.integrationConnections.id, wanted),
        eq(schema.integrationConnections.scope, 'user'),
        eq(schema.integrationConnections.ownerUserId, userId),
      ),
    );
  if (rows.length !== wanted.length) throw new HttpError(404, 'Connection not found');
  return rows.map((row) => ({
    id: row.id,
    providerId: row.providerId,
    credential:
      row.credentialHost === null
        ? null
        : { provider: row.credentialProvider, host: row.credentialHost },
  }));
}

/** Refuses what no row may hold; the shared resolver folds most of it into needs-choice instead. */
export async function requireValidChoice(
  db: Database,
  userId: string,
  pick: { categoryId: string; providerId: string; connectionId: string | null },
): Promise<OwnConnection | null> {
  if (!listIntegrationCategories().some((category) => category.id === pick.categoryId)) {
    throw new HttpError(400, 'Unknown integration category');
  }
  const spec = getIntegrationProvider(pick.providerId);
  if (!spec) throw new HttpError(400, 'Unknown integration provider');
  if (!spec.categories.includes(pick.categoryId)) {
    throw new HttpError(400, `${spec.displayName} does not serve this category`);
  }
  if (!(await isProviderEnabled(db, spec.id))) {
    throw new HttpError(409, `${spec.displayName} is not enabled on this server`);
  }
  if (pick.connectionId === null) return null;
  const [connection] = await requireOwnConnections(db, userId, [pick.connectionId]);
  if (connection!.providerId !== spec.id) {
    throw new HttpError(400, 'That account belongs to another provider');
  }
  return connection!;
}

/** A forge account must be one the task's repository remote can use, by the rule that opens its pull requests. */
export async function requireFitsRepository(
  db: Database,
  categoryId: string,
  connection: OwnConnection | null,
  repositoryId: string | null,
): Promise<void> {
  if (categoryId !== FORGE_CATEGORY || connection === null) return;
  const [repository] =
    repositoryId === null
      ? []
      : await db
          .select({ remoteUrl: schema.repositories.remoteUrl })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, repositoryId));
  if (
    connection.credential === null ||
    !credentialUsableForPr(connection.credential, repository?.remoteUrl ?? null)
  ) {
    throw new HttpError(400, "That account does not fit this task's repository");
  }
}

/** A null user is the admin default; the row is replaced whole, so an omitted account becomes none. */
export function upsertPreference(db: Database | DbTx, row: PreferenceRow) {
  return db
    .insert(schema.integrationCategoryPreferences)
    .values(row)
    .onConflictDoUpdate({
      target: [
        schema.integrationCategoryPreferences.userId,
        schema.integrationCategoryPreferences.categoryId,
      ],
      set: { providerId: row.providerId, connectionId: row.connectionId, updatedAt: new Date() },
    });
}

export function removePreference(db: Database | DbTx, userId: string | null, categoryId: string) {
  return db
    .delete(schema.integrationCategoryPreferences)
    .where(
      and(
        userId === null
          ? isNull(schema.integrationCategoryPreferences.userId)
          : eq(schema.integrationCategoryPreferences.userId, userId),
        eq(schema.integrationCategoryPreferences.categoryId, categoryId),
      ),
    );
}
