import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { IntegrationBinding, IntegrationResolution } from '@haive/shared/integrations';
import type { IntegrationRequirement } from '@haive/shared/modularity';
import type { CliProviderRecord } from '../../src/cli-adapters/types.js';

export const GITHUB_REMOTE = 'https://github.com/acme/widgets.git';
export const ACCOUNT_LABEL = 'acme-bot-7731';
export const SIGNING_KEY = 'ab'.repeat(32);

export const FORGE_READ: IntegrationRequirement = {
  id: 'pull-requests',
  category: 'forge',
  access: 'read',
};
export const FORGE_WRITE: IntegrationRequirement = { ...FORGE_READ, access: 'write' };
export const FORGE_OPTIONAL: IntegrationRequirement = { ...FORGE_READ, optional: true };
export const PINNED_GITHUB: IntegrationRequirement = {
  id: 'pull-requests',
  provider: 'github',
  access: 'read',
};

export async function seedUser(db: Database): Promise<string> {
  const [user] = await db
    .insert(schema.users)
    .values({
      emailEncrypted: 'step-integrations-test@test.local',
      emailBlindIndex: randomBytes(16).toString('hex'),
      passwordHash: 'not-a-real-hash',
    })
    .returning({ id: schema.users.id });
  return user!.id;
}

export async function seedConnection(
  db: Database,
  userId: string,
  over: {
    provider?: string;
    host?: string;
    label?: string;
    status?: 'connected' | 'needs_reauth';
  } = {},
): Promise<string> {
  const {
    provider = 'github',
    host = 'github.com',
    label = ACCOUNT_LABEL,
    status = 'connected',
  } = over;
  const [credential] = await db
    .insert(schema.repoCredentials)
    .values({
      userId,
      label: `credential ${randomUUID()}`,
      host,
      provider,
      usernameEncrypted: 'x',
      secretEncrypted: 'x',
      encryptedDek: 'x',
    })
    .returning({ id: schema.repoCredentials.id });
  const [connection] = await db
    .insert(schema.integrationConnections)
    .values({
      providerId: provider,
      scope: 'user',
      ownerUserId: userId,
      accountLabel: label,
      authMethod: 'token',
      repoCredentialId: credential!.id,
      status,
    })
    .returning({ id: schema.integrationConnections.id });
  return connection!.id;
}

export async function seedRepository(
  db: Database,
  userId: string,
  remoteUrl: string | null = GITHUB_REMOTE,
): Promise<string> {
  const [repository] = await db
    .insert(schema.repositories)
    .values({
      userId,
      name: `repo ${randomUUID()}`,
      source: remoteUrl === null ? 'local_path' : 'git_https',
      remoteUrl,
    })
    .returning({ id: schema.repositories.id });
  return repository!.id;
}

export async function seedTask(
  db: Database,
  userId: string,
  repositoryId: string | null,
): Promise<string> {
  const [task] = await db
    .insert(schema.tasks)
    .values({
      userId,
      repositoryId,
      type: 'workflow',
      title: 'step integrations test',
      status: 'running',
    })
    .returning({ id: schema.tasks.id });
  return task!.id;
}

export async function seedStepRow(
  db: Database,
  taskId: string,
  over: Partial<typeof schema.taskSteps.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.taskSteps)
    .values({
      taskId,
      stepId: 'ix-seeded-step',
      stepIndex: 100,
      runSeq: 0,
      round: 0,
      title: 'seeded step',
      status: 'running',
      ...over,
    })
    .returning();
  return row!;
}

export async function seedProvider(
  db: Database,
  userId: string,
  name: CliProviderRecord['name'],
): Promise<CliProviderRecord> {
  const [provider] = await db
    .insert(schema.cliProviders)
    .values({
      userId,
      name,
      label: name,
      executablePath: name === 'claude-code' ? '/usr/bin/claude' : `/usr/bin/${name}`,
      supportsSubagents: name === 'claude-code',
      authMode: 'subscription',
      enabled: true,
    })
    .returning();
  return provider!;
}

export interface BareWorld {
  userId: string;
  repositoryId: string;
  taskId: string;
}

export interface World extends BareWorld {
  connectionId: string;
}

/** A user, a repository with a GitHub remote and a task, and no account connected. */
export async function seedBareWorld(db: Database): Promise<BareWorld> {
  const userId = await seedUser(db);
  const repositoryId = await seedRepository(db, userId);
  const taskId = await seedTask(db, userId, repositoryId);
  return { userId, repositoryId, taskId };
}

/** The bare world plus one GitHub account the remote can use. */
export async function seedWorld(db: Database): Promise<World> {
  const bare = await seedBareWorld(db);
  return { ...bare, connectionId: await seedConnection(db, bare.userId) };
}

export async function deleteUsers(db: Database, userIds: readonly string[]): Promise<void> {
  if (userIds.length > 0)
    await db.delete(schema.users).where(inArray(schema.users.id, [...userIds]));
}

export const runsOf = (db: Database, taskId: string) =>
  db
    .select()
    .from(schema.cliInvocations)
    .where(eq(schema.cliInvocations.taskId, taskId))
    .orderBy(asc(schema.cliInvocations.createdAt));

export async function grantsOf(db: Database, taskId: string) {
  const rows = await db
    .select({
      categoryId: schema.integrationGrants.categoryId,
      connectionId: schema.integrationGrants.connectionId,
    })
    .from(schema.integrationGrants)
    .where(
      and(
        eq(schema.integrationGrants.targetKind, 'task'),
        eq(schema.integrationGrants.taskId, taskId),
      ),
    );
  return rows.sort((x, y) => String(x.categoryId).localeCompare(String(y.categoryId)));
}

/** Whether the stamp of a run is SQL NULL, which the drizzle value null cannot tell from JSON null. */
export async function stampIsSqlNull(db: Database, runId: string): Promise<boolean> {
  const rows = await db.execute<{ is_null: boolean }>(
    sql`select integrations is null as is_null from cli_invocations where id = ${runId}`,
  );
  return rows[0]!.is_null;
}

export function bindingsOf(resolutions: readonly IntegrationResolution[]): IntegrationBinding[] {
  return resolutions.flatMap((resolution) =>
    resolution.status === 'resolved'
      ? [
          {
            requirementId: resolution.requirementId,
            categoryId: resolution.categoryId,
            providerId: resolution.providerId,
            connectionId: resolution.connectionId,
            access: resolution.access,
          },
        ]
      : [],
  );
}

export function runValues(
  taskId: string,
  stepRowId: string,
  over: Partial<typeof schema.cliInvocations.$inferInsert> = {},
): typeof schema.cliInvocations.$inferInsert {
  return { taskId, taskStepId: stepRowId, mode: 'cli', prompt: 'a prompt', ...over };
}

/** Waits on the database itself: how many backends wait for an advisory lock of this database right now. */
export async function advisoryWaiters(db: Database): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`,
  );
  return rows[0]!.n;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
