import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  isUniqueViolationOf,
  schema,
  type Database,
  type DbTx,
} from '@haive/database';
import {
  loadResolverContext,
  recordTaskGrants,
  resolveStepIntegrations,
  resolveTaskCategories,
  type IntegrationResolution,
} from '../src/integrations/index.js';
import type { IntegrationRequirement } from '../src/modularity/index.js';

const url = process.env.INTEGRATIONS_RESOLUTION_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/integrations_resolution_test'))
  throw new Error('Use a dedicated integrations_resolution_test database for the resolution tests');

const TASK_KEY = 'integration_grants_task_category_key_idx';
const REPOSITORY_KEY = 'integration_grants_repository_connection_key_idx';
const GITHUB_REMOTE = 'https://github.com/acme/app.git';
const FORGE: IntegrationRequirement = { id: 'code', category: 'forge', access: 'write' };

const verdict = (r: IntegrationResolution) =>
  r.status === 'resolved' ? `${r.connectionId}/${r.source}` : r.reason;

describe.skipIf(!url)('category resolution on Postgres', () => {
  let db: Database;
  let userA: string;
  let userB: string;
  let repoR: string;
  let repoNoRemote: string;
  let taskT: string;
  let taskNoRepo: string;
  let taskOfB: string;
  let cA1: string;
  let cA2: string;
  let cB: string;
  const userIds: string[] = [];

  async function createUser(): Promise<string> {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'resolution-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
      })
      .returning({ id: schema.users.id });
    userIds.push(user!.id);
    return user!.id;
  }

  async function createCredential(userId: string, provider: string | null): Promise<string> {
    const [credential] = await db
      .insert(schema.repoCredentials)
      .values({
        userId,
        label: `credential ${randomUUID()}`,
        host: 'github.com',
        provider,
        usernameEncrypted: 'x',
        secretEncrypted: 'x',
        encryptedDek: 'x',
      })
      .returning({ id: schema.repoCredentials.id });
    return credential!.id;
  }

  async function createConnection(
    ownerUserId: string,
    repoCredentialId: string | null,
  ): Promise<string> {
    const [connection] = await db
      .insert(schema.integrationConnections)
      .values({
        providerId: 'github',
        scope: 'user',
        ownerUserId,
        accountLabel: `account ${randomUUID()}`,
        authMethod: 'token',
        repoCredentialId,
      })
      .returning({ id: schema.integrationConnections.id });
    return connection!.id;
  }

  async function createRepository(userId: string, remoteUrl: string | null): Promise<string> {
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

  async function createTask(userId: string, repositoryId: string | null): Promise<string> {
    const [task] = await db
      .insert(schema.tasks)
      .values({ userId, repositoryId, type: 'workflow', title: 'resolution test' })
      .returning({ id: schema.tasks.id });
    return task!.id;
  }

  async function aloneWithOneAccount() {
    const user = await createUser();
    const repo = await createRepository(user, GITHUB_REMOTE);
    const task = await createTask(user, repo);
    const credential = await createCredential(user, 'github');
    const connection = await createConnection(user, credential);
    return { user, repo, task, credential, connection };
  }

  const choose = (
    taskId: string,
    categoryId: string,
    providerId: string,
    connectionId: string | null,
  ) =>
    db
      .insert(schema.taskIntegrationChoices)
      .values({ taskId, categoryId, providerId, connectionId });
  const prefer = (
    userId: string | null,
    categoryId: string,
    providerId: string,
    connectionId: string | null = null,
  ) =>
    db
      .insert(schema.integrationCategoryPreferences)
      .values({ userId, categoryId, providerId, connectionId });
  const grantTask = (taskId: string, categoryId: string, connectionId: string) =>
    db
      .insert(schema.integrationGrants)
      .values({ targetKind: 'task', taskId, categoryId, connectionId });
  const grantRepository = (repositoryId: string, connectionId: string) =>
    db
      .insert(schema.integrationGrants)
      .values({ targetKind: 'repository', repositoryId, connectionId });
  const restrict = (repositoryId: string, integrationsRestricted: boolean) =>
    db
      .update(schema.repositories)
      .set({ integrationsRestricted })
      .where(eq(schema.repositories.id, repositoryId));
  const taskGrants = (taskId: string) =>
    db
      .select()
      .from(schema.integrationGrants)
      .where(
        and(
          eq(schema.integrationGrants.targetKind, 'task'),
          eq(schema.integrationGrants.taskId, taskId),
        ),
      );
  const forgeOf = async (taskId: string) =>
    (await resolveStepIntegrations(db, { taskId }, [FORGE]))[0]!;
  const candidatesOf = (r: IntegrationResolution) =>
    r.status === 'unresolved' ? [...r.candidates] : [];

  async function rejection(pending: PromiseLike<unknown>): Promise<unknown> {
    try {
      await pending;
      return null;
    } catch (err) {
      return err;
    }
  }

  beforeAll(async () => {
    db = createDatabase(url as string);
    userA = await createUser();
    userB = await createUser();
    repoR = await createRepository(userA, GITHUB_REMOTE);
    repoNoRemote = await createRepository(userA, null);
    taskT = await createTask(userA, repoR);
    taskNoRepo = await createTask(userA, null);
    taskOfB = await createTask(userB, null);
    cA1 = await createConnection(userA, await createCredential(userA, 'github'));
    cA2 = await createConnection(userA, await createCredential(userA, null));
    cB = await createConnection(userB, await createCredential(userB, 'github'));
  });

  beforeEach(async () => {
    await db.delete(schema.taskIntegrationChoices);
    await db.delete(schema.integrationGrants);
    await db.delete(schema.integrationCategoryPreferences);
    await db.delete(schema.integrationProviderConfigs);
    await db
      .update(schema.repositories)
      .set({ integrationsRestricted: false })
      .where(inArray(schema.repositories.id, [repoR, repoNoRemote]));
    await db
      .update(schema.integrationConnections)
      .set({ status: 'connected' })
      .where(inArray(schema.integrationConnections.id, [cA1, cA2, cB]));
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    }
    await db.$client.end({ timeout: 5 });
  });

  describe('the loader', () => {
    it('reads the rows of the task owner and no row of another user', async () => {
      await prefer(userA, 'forge', 'github', cA2);
      await prefer(userB, 'forge', 'gitlab', cB);
      await prefer(null, 'forge', 'gitea');
      await choose(taskT, 'forge', 'github', cA1);
      await choose(taskOfB, 'forge', 'github', cB);
      await grantTask(taskT, 'forge', cA2);
      await grantTask(taskOfB, 'forge', cB);
      await restrict(repoR, true);
      await grantRepository(repoR, cA1);
      await grantRepository(repoNoRemote, cA2);

      const context = await loadResolverContext(db, { taskId: taskT });

      expect(context.ownerUserId).toBe(userA);
      expect(context.connections.map((c) => c.id).sort()).toEqual([cA1, cA2].sort());
      expect(context.connections.every((c) => c.ownerUserId === userA && c.scope === 'user')).toBe(
        true,
      );
      expect(context.preferences.get('forge')).toEqual({ providerId: 'github', connectionId: cA2 });
      expect(context.defaults.get('forge')).toBe('gitea');
      expect(context.choices.get('forge')).toEqual({ providerId: 'github', connectionId: cA1 });
      expect(context.grants.get('forge')).toBe(cA2);
      expect(context.repository).toEqual({
        remoteUrl: GITHUB_REMOTE,
        restricted: true,
        allowedConnectionIds: new Set([cA1]),
      });
    });

    it('reads the credential each connection is linked to, and none for a connection without one', async () => {
      const bare = await createConnection(userA, null);
      const context = await loadResolverContext(db, { taskId: taskT });
      const byId = new Map(context.connections.map((c) => [c.id, c]));
      expect(byId.get(cA1)?.credential).toEqual({ provider: 'github', host: 'github.com' });
      expect(byId.get(cA2)?.credential).toEqual({ provider: null, host: 'github.com' });
      expect(byId.get(bare)?.credential).toBeNull();
    });

    it('takes a task without a repository, and a draft, from what it is given', async () => {
      expect((await loadResolverContext(db, { taskId: taskNoRepo })).repository).toBeNull();
      const draft = await loadResolverContext(db, {
        draft: { userId: userA, repositoryId: repoR, choices: new Map([['forge', cA1]]) },
      });
      expect(draft.ownerUserId).toBe(userA);
      expect(draft.repository?.remoteUrl).toBe(GITHUB_REMOTE);
      expect(draft.choices.get('forge')).toEqual({ providerId: 'github', connectionId: cA1 });
      expect(draft.grants.size).toBe(0);
    });

    it('fails for a task that is not there', async () => {
      await expect(loadResolverContext(db, { taskId: randomUUID() })).rejects.toThrow(/not found/);
    });
  });

  describe('resolution over real rows', () => {
    it('walks the tiers: only, admin default, user preference, task grant, task choice', async () => {
      expect(verdict(await forgeOf(taskT))).toBe('needs-choice');

      await prefer(null, 'forge', 'github');
      expect(verdict(await forgeOf(taskT))).toBe('needs-choice');

      await prefer(userA, 'forge', 'github', cA2);
      expect(verdict(await forgeOf(taskT))).toBe(`${cA2}/user`);

      await grantTask(taskT, 'forge', cA1);
      expect(verdict(await forgeOf(taskT))).toBe(`${cA1}/grant`);

      await choose(taskT, 'forge', 'github', cA2);
      expect(verdict(await forgeOf(taskT))).toBe(`${cA2}/task`);
    });

    it('resolves the only account of the task owner and offers no account of another user', async () => {
      const own = await aloneWithOneAccount();
      expect(verdict(await forgeOf(own.task))).toBe(`${own.connection}/only`);
      expect(candidatesOf(await forgeOf(taskT))).toEqual(expect.not.arrayContaining([cB]));
    });

    it('never resolves an account of another user named in a row of this one', async () => {
      await choose(taskT, 'forge', 'github', cB);
      const choice = await forgeOf(taskT);
      expect(verdict(choice)).toBe('needs-choice');
      expect(candidatesOf(choice).sort()).toEqual([cA1, cA2].sort());
      await db.delete(schema.taskIntegrationChoices);

      await grantTask(taskT, 'forge', cB);
      await prefer(userA, 'forge', 'github', cB);
      const rest = await forgeOf(taskT);
      expect(verdict(rest)).toBe('needs-choice');
      expect(candidatesOf(rest)).not.toContain(cB);
    });

    it('follows the switch of a provider, and its default when there is no row', async () => {
      await prefer(userA, 'forge', 'github', cA1);
      expect(verdict(await forgeOf(taskT))).toBe(`${cA1}/user`);
      await db
        .insert(schema.integrationProviderConfigs)
        .values({ providerId: 'github', enabled: false });
      expect(verdict(await forgeOf(taskT))).toBe('provider-disabled');
      await db
        .update(schema.integrationProviderConfigs)
        .set({ enabled: true })
        .where(eq(schema.integrationProviderConfigs.providerId, 'github'));
      expect(verdict(await forgeOf(taskT))).toBe(`${cA1}/user`);
    });

    it('fits the forge account to the remote url of the repository, read from its row', async () => {
      expect(verdict(await forgeOf(await createTask(userA, repoNoRemote)))).toBe('no-remote');
      expect(verdict(await forgeOf(taskNoRepo))).toBe('no-repository');
      const gitlab = await createTask(
        userA,
        await createRepository(userA, 'git@gitlab.com:acme/app.git'),
      );
      expect(verdict(await forgeOf(gitlab))).toBe('no-connection');
    });

    it('checks the status of the selected connection only', async () => {
      await db
        .update(schema.integrationConnections)
        .set({ status: 'needs_reauth' })
        .where(eq(schema.integrationConnections.id, cA2));
      await prefer(userA, 'forge', 'github', cA2);
      expect(await forgeOf(taskT)).toMatchObject({
        status: 'unresolved',
        reason: 'connection-unavailable',
        connectionId: cA2,
      });
    });

    it('holds a restricted repository to its entries, and to nothing when it has none', async () => {
      await restrict(repoR, true);
      expect(verdict(await forgeOf(taskT))).toBe('not-allowed-by-repository');
      await grantRepository(repoR, cA2);
      expect(verdict(await forgeOf(taskT))).toBe(`${cA2}/only`);
      await restrict(repoR, false);
      expect(verdict(await forgeOf(taskT))).toBe('needs-choice');
    });

    it('resolves a draft with the choice the create form carries', async () => {
      const draft = async (
        choices?: ReadonlyMap<string, string>,
        repositoryId: string | null = repoR,
      ) =>
        (
          await resolveStepIntegrations(db, { draft: { userId: userA, repositoryId, choices } }, [
            FORGE,
          ])
        )[0]!;
      expect(verdict(await draft(new Map([['forge', cA1]])))).toBe(`${cA1}/task`);
      expect(verdict(await draft())).toBe('needs-choice');
      expect(verdict(await draft(undefined, null))).toBe('no-repository');
      expect(verdict(await draft(new Map([['forge', cB]])))).toBe('needs-choice');
    });

    it('answers per category for the task page, with the tier that picked', async () => {
      await prefer(userA, 'forge', 'github', cA2);
      const [forge, mail] = await resolveTaskCategories(db, {
        taskId: taskT,
        categories: ['forge', 'mail'],
      });
      expect(forge).toMatchObject({
        categoryId: 'forge',
        status: 'resolved',
        connectionId: cA2,
        source: 'user',
        skipped: [],
      });
      expect(mail).toMatchObject({
        categoryId: 'mail',
        status: 'unresolved',
        reason: 'no-provider',
      });
    });
  });

  describe('recordTaskGrants', () => {
    async function resolveAndRecord(handle: Database | DbTx, taskId: string) {
      const resolutions = await resolveStepIntegrations(handle, { taskId }, [FORGE]);
      await recordTaskGrants(handle, taskId, resolutions);
    }
    const xminOf = async (id: string) =>
      (
        await db.execute<{ x: string }>(
          sql`select xmin::text as x from integration_grants where id = ${id}`,
        )
      )[0]!.x;

    it('writes one task grant for a resolved category and nothing more when it is unchanged', async () => {
      await prefer(userA, 'forge', 'github', cA1);
      await resolveAndRecord(db, taskT);
      const [first] = await taskGrants(taskT);
      expect(first).toMatchObject({
        connectionId: cA1,
        categoryId: 'forge',
        targetKind: 'task',
        repositoryId: null,
        toolAllowList: null,
      });
      const before = await xminOf(first!.id);

      await resolveAndRecord(db, taskT);
      const rows = await taskGrants(taskT);
      expect(rows).toHaveLength(1);
      expect(await xminOf(rows[0]!.id)).toBe(before);
    });

    it('updates the same row when the category resolves to another account', async () => {
      await prefer(userA, 'forge', 'github', cA1);
      await resolveAndRecord(db, taskT);
      const [first] = await taskGrants(taskT);

      await choose(taskT, 'forge', 'github', cA2);
      await resolveAndRecord(db, taskT);
      const rows = await taskGrants(taskT);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: first!.id,
        connectionId: cA2,
        createdAt: first!.createdAt,
      });
    });

    it('is undone with the transaction it runs in', async () => {
      await prefer(userA, 'forge', 'github', cA1);
      const rollback = new Error('rolled back');
      await expect(
        db.transaction(async (tx) => {
          await resolveAndRecord(tx, taskT);
          expect(await tx.select().from(schema.integrationGrants)).toHaveLength(1);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await taskGrants(taskT)).toHaveLength(0);
    });

    it('records nothing for an unresolved category', async () => {
      await recordTaskGrants(
        db,
        taskT,
        await resolveStepIntegrations(db, { taskId: taskT }, [FORGE]),
      );
      expect(await taskGrants(taskT)).toHaveLength(0);
    });

    it('records nothing for a pinned provider, which has no category', async () => {
      const own = await aloneWithOneAccount();
      const resolutions = await resolveStepIntegrations(db, { taskId: own.task }, [
        { id: 'pin', provider: 'github', access: 'read' },
      ]);
      expect(resolutions[0]).toMatchObject({ status: 'resolved', source: 'pinned' });
      await recordTaskGrants(db, own.task, resolutions);
      expect(await taskGrants(own.task)).toHaveLength(0);
    });

    it('keeps one row when two dispatches record the same category at once', async () => {
      const resolved = (connectionId: string): IntegrationResolution => ({
        requirementId: 'code',
        status: 'resolved',
        categoryId: 'forge',
        providerId: 'github',
        connectionId,
        access: 'write',
        source: 'only',
      });
      await Promise.all([
        recordTaskGrants(db, taskT, [resolved(cA1)]),
        recordTaskGrants(db, taskT, [resolved(cA2)]),
      ]);
      const rows = await taskGrants(taskT);
      expect(rows).toHaveLength(1);
      expect([cA1, cA2]).toContain(rows[0]!.connectionId);
    });

    it('makes the grant sticky: a later change of preference no longer reaches the task', async () => {
      await prefer(userA, 'forge', 'github', cA1);
      await resolveAndRecord(db, taskT);
      await db
        .update(schema.integrationCategoryPreferences)
        .set({ connectionId: cA2 })
        .where(eq(schema.integrationCategoryPreferences.userId, userA));
      expect(verdict(await forgeOf(taskT))).toBe(`${cA1}/grant`);
    });

    it('refuses a second grant for the task and category, and a second for the repository and account', async () => {
      await grantTask(taskT, 'forge', cA1);
      expect(isUniqueViolationOf(await rejection(grantTask(taskT, 'forge', cA2)), TASK_KEY)).toBe(
        true,
      );
      await grantTask(taskT, 'mail', cA1);
      await grantTask(taskNoRepo, 'forge', cA1);
      expect(await taskGrants(taskT)).toHaveLength(2);

      await grantRepository(repoR, cA1);
      expect(
        isUniqueViolationOf(await rejection(grantRepository(repoR, cA1)), REPOSITORY_KEY),
      ).toBe(true);
      await grantRepository(repoR, cA2);
      await grantRepository(repoNoRemote, cA1);
    });
  });

  describe('a disconnect', () => {
    it.each([
      ['the connection is deleted', 'connection'],
      ['the Git credential behind it is deleted', 'credential'],
    ] as const)(
      'when %s, the choice and the preference keep their provider and the restriction holds',
      async (_how, remove) => {
        const own = await aloneWithOneAccount();
        await choose(own.task, 'forge', 'github', own.connection);
        await prefer(own.user, 'forge', 'github', own.connection);
        await grantTask(own.task, 'forge', own.connection);
        await grantRepository(own.repo, own.connection);
        await restrict(own.repo, true);
        expect(verdict(await forgeOf(own.task))).toBe(`${own.connection}/task`);

        if (remove === 'connection') {
          await db
            .delete(schema.integrationConnections)
            .where(eq(schema.integrationConnections.id, own.connection));
        } else {
          await db
            .delete(schema.repoCredentials)
            .where(eq(schema.repoCredentials.id, own.credential));
        }

        const [choice] = await db
          .select()
          .from(schema.taskIntegrationChoices)
          .where(eq(schema.taskIntegrationChoices.taskId, own.task));
        expect(choice).toMatchObject({
          categoryId: 'forge',
          providerId: 'github',
          connectionId: null,
        });
        const [preference] = await db
          .select()
          .from(schema.integrationCategoryPreferences)
          .where(eq(schema.integrationCategoryPreferences.userId, own.user));
        expect(preference).toMatchObject({ providerId: 'github', connectionId: null });
        expect(await taskGrants(own.task)).toHaveLength(0);
        const entries = await db
          .select()
          .from(schema.integrationGrants)
          .where(eq(schema.integrationGrants.repositoryId, own.repo));
        expect(entries).toHaveLength(0);
        const [repository] = await db
          .select()
          .from(schema.repositories)
          .where(eq(schema.repositories.id, own.repo));
        expect(repository!.integrationsRestricted).toBe(true);

        expect(await forgeOf(own.task)).toMatchObject({
          status: 'unresolved',
          reason: 'needs-choice',
          providerId: 'github',
        });
        await db
          .delete(schema.taskIntegrationChoices)
          .where(eq(schema.taskIntegrationChoices.taskId, own.task));
        await createConnection(own.user, await createCredential(own.user, 'github'));
        expect(verdict(await forgeOf(own.task))).toBe('not-allowed-by-repository');
      },
    );
  });
});
