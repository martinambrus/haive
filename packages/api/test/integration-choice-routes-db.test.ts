import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.INTEGRATION_CHOICE_ROUTES_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/integration_choice_routes_test'))
  throw new Error(
    'Use a dedicated integration_choice_routes_test database for the integration choice route tests',
  );

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
  return { db: undefined as unknown };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getBoolean: async (_key: string, fallback: boolean) => fallback,
  },
}));

import { secretsService } from '@haive/shared';
import { listIntegrationProviders } from '@haive/shared/integrations';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createApiApp } from '../src/index.js';

const WEB_ORIGIN = 'http://localhost:3000';
const FOREIGN_ORIGINS = ['https://evil.example', 'null'];
const FORGE = 'forge';
const GITHUB_REMOTE = 'https://github.com/acme/widgets.git';
const OTHER_REMOTE = 'https://github.com/other/gadgets.git';
const CHOICE_EVENT = 'task.integration_choice_changed';

const PATHS = {
  preferences: '/integrations/preferences',
  preference: (categoryId: string) => `/integrations/preferences/${categoryId}`,
  defaults: '/admin/integrations/defaults',
  default: (categoryId: string) => `/admin/integrations/defaults/${categoryId}`,
  repository: (id: string) => `/repositories/${id}/integrations`,
  task: (id: string) => `/tasks/${id}/integrations`,
  taskChoice: (id: string, categoryId: string) => `/tasks/${id}/integrations/${categoryId}`,
};

interface Reply {
  method: string;
  path: string;
  status: number;
  json: unknown;
  text: string;
}
interface Actor {
  id: string;
  cookie: string;
}
interface Hit {
  actor: Actor;
  method: string;
  path: string;
  body?: unknown;
}
type Entry = Record<string, unknown>;
type Call = [label: string, run: () => Promise<Reply>];

const note = (reply: Reply, label?: string) =>
  `${label === undefined ? '' : `${label}: `}${reply.method} ${reply.path} -> ${reply.status} ${reply.text.slice(0, 240)}`;
const expectOk = (reply: Reply, label?: string) =>
  expect(reply.status >= 200 && reply.status < 300, note(reply, label)).toBe(true);
const expectStatus = (reply: Reply, status: number, label?: string) =>
  expect(reply.status, note(reply, label)).toBe(status);

// A list route may answer a bare array or one array under a single key; the entries are what is pinned.
function entriesOf(reply: Reply): Entry[] {
  const body = reply.json;
  if (Array.isArray(body)) return body as Entry[];
  const lists =
    body !== null && typeof body === 'object' ? Object.values(body).filter(Array.isArray) : [];
  if (lists.length === 1) return lists[0] as Entry[];
  throw new Error(`not a list: ${note(reply)}`);
}

const byCategory = (x: { categoryId: string }, y: { categoryId: string }) =>
  x.categoryId.localeCompare(y.categoryId);

describe.skipIf(!url)('integration choice routes on Postgres', () => {
  const app = createApiApp(WEB_ORIGIN);
  let db: Database;
  let admin: Actor;
  let a: Actor;
  let b: Actor;
  let repoA: string;
  let repoB: string;
  let taskA: string;
  let taskB: string;
  let ghA: string;
  let ghB: string;
  const userIds: string[] = [];

  async function send(
    actor: Actor | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const res = await app.request(path, {
      method,
      headers: {
        host: 'localhost:3001',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(actor === null ? {} : { cookie: actor.cookie }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { method, path, status: res.status, json, text };
  }

  const as = (actor: Actor | null, headers: Record<string, string> = {}) => ({
    get: (path: string) => send(actor, 'GET', path, undefined, headers),
    put: (path: string, body?: unknown) => send(actor, 'PUT', path, body, headers),
    del: (path: string) => send(actor, 'DELETE', path, undefined, headers),
  });
  const hitAs = (hit: Hit, actor: Actor | null = hit.actor) =>
    send(actor, hit.method, hit.path, hit.body);

  const putChoice = (body: Record<string, unknown>, taskId = taskA, actor = a) =>
    as(actor).put(PATHS.taskChoice(taskId, FORGE), body);
  const delChoice = (suffix = '', taskId = taskA, actor = a) =>
    as(actor).del(`${PATHS.taskChoice(taskId, FORGE)}${suffix}`);
  const putAllowList = (restricted: boolean, connectionIds: string[], repoId = repoA, actor = a) =>
    as(actor).put(PATHS.repository(repoId), { restricted, connectionIds });

  const everyRoute = (): Hit[] => [
    { actor: a, method: 'GET', path: PATHS.preferences },
    {
      actor: a,
      method: 'PUT',
      path: PATHS.preference(FORGE),
      body: { providerId: 'github', connectionId: ghA },
    },
    { actor: a, method: 'DELETE', path: PATHS.preference(FORGE) },
    { actor: admin, method: 'GET', path: PATHS.defaults },
    {
      actor: admin,
      method: 'PUT',
      path: PATHS.default(FORGE),
      body: { providerId: 'github' },
    },
    { actor: a, method: 'GET', path: PATHS.repository(repoA) },
    {
      actor: a,
      method: 'PUT',
      path: PATHS.repository(repoA),
      body: { restricted: true, connectionIds: [ghA] },
    },
    { actor: a, method: 'GET', path: PATHS.task(taskA) },
    {
      actor: a,
      method: 'PUT',
      path: PATHS.taskChoice(taskA, FORGE),
      body: { providerId: 'github', connectionId: ghA },
    },
    { actor: a, method: 'DELETE', path: PATHS.taskChoice(taskA, FORGE) },
  ];

  async function createUser(role: 'admin' | 'user'): Promise<Actor> {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'integration-choice-routes-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
        role,
      })
      .returning({ id: schema.users.id });
    userIds.push(user!.id);
    const token = await signAccessToken({ sub: user!.id, role, tv: 0 });
    return { id: user!.id, cookie: `${ACCESS_COOKIE}=${token}` };
  }

  async function createAccount(
    userId: string,
    over: { host?: string; provider?: string; status?: 'connected' | 'needs_reauth' } = {},
  ): Promise<string> {
    const { host = 'github.com', provider = 'github', status = 'connected' } = over;
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
        accountLabel: `account ${randomUUID()}`,
        authMethod: 'token',
        repoCredentialId: credential!.id,
        status,
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
      .values({
        userId,
        repositoryId,
        type: 'workflow',
        title: 'integration choice routes test',
        status: 'running',
      })
      .returning({ id: schema.tasks.id });
    return task!.id;
  }

  const setTask = (taskId: string, set: Partial<typeof schema.tasks.$inferInsert>) =>
    db.update(schema.tasks).set(set).where(eq(schema.tasks.id, taskId));
  const choose = (
    taskId: string,
    categoryId: string,
    providerId: string,
    connectionId: string | null = null,
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

  const prefsOf = async (userId: string | null) =>
    (
      await db
        .select()
        .from(schema.integrationCategoryPreferences)
        .where(
          userId === null
            ? isNull(schema.integrationCategoryPreferences.userId)
            : eq(schema.integrationCategoryPreferences.userId, userId),
        )
    )
      .map(({ categoryId, providerId, connectionId }) => ({ categoryId, providerId, connectionId }))
      .sort(byCategory);
  const choicesOf = async (taskId: string) =>
    (
      await db
        .select()
        .from(schema.taskIntegrationChoices)
        .where(eq(schema.taskIntegrationChoices.taskId, taskId))
    )
      .map(({ categoryId, providerId, connectionId }) => ({ categoryId, providerId, connectionId }))
      .sort(byCategory);
  const taskGrantsOf = async (taskId: string) =>
    (
      await db
        .select()
        .from(schema.integrationGrants)
        .where(
          and(
            eq(schema.integrationGrants.targetKind, 'task'),
            eq(schema.integrationGrants.taskId, taskId),
          ),
        )
    )
      .map(({ categoryId, connectionId }) => ({ categoryId: categoryId!, connectionId }))
      .sort(byCategory);
  const repoGrantsOf = async (repositoryId: string) =>
    (
      await db
        .select()
        .from(schema.integrationGrants)
        .where(
          and(
            eq(schema.integrationGrants.targetKind, 'repository'),
            eq(schema.integrationGrants.repositoryId, repositoryId),
          ),
        )
    )
      .map(({ connectionId, categoryId }) => ({ connectionId, categoryId }))
      .sort((x, y) => x.connectionId.localeCompare(y.connectionId));
  const allowed = (...connectionIds: string[]) =>
    [...connectionIds].sort().map((connectionId) => ({ connectionId, categoryId: null }));
  const restrictedOf = async (repositoryId: string) =>
    (
      await db
        .select({ restricted: schema.repositories.integrationsRestricted })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, repositoryId))
    )[0]?.restricted;
  const eventsOf = async (taskId: string) =>
    (
      await db
        .select({ payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(
          and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, CHOICE_EVENT)),
        )
        .orderBy(asc(schema.taskEvents.createdAt), asc(schema.taskEvents.id))
    ).map((row) => row.payload);
  const auditsBy = (actorUserId: string) =>
    db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.actorUserId, actorUserId))
      .orderBy(asc(schema.auditEvents.createdAt));
  async function snapshot() {
    const json = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).sort();
    const [preferences, choices, grants, repositories, events, audits] = await Promise.all([
      db.select().from(schema.integrationCategoryPreferences),
      db.select().from(schema.taskIntegrationChoices),
      db.select().from(schema.integrationGrants),
      db
        .select({
          id: schema.repositories.id,
          restricted: schema.repositories.integrationsRestricted,
        })
        .from(schema.repositories),
      db
        .select({ taskId: schema.taskEvents.taskId, payload: schema.taskEvents.payload })
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.eventType, CHOICE_EVENT)),
      db.select().from(schema.auditEvents),
    ]);
    return {
      preferences: json(preferences),
      choices: json(choices),
      grants: json(grants),
      repositories: json(repositories),
      events: json(events),
      audits: json(audits),
    };
  }

  async function unchanged<T>(run: () => Promise<T>): Promise<T> {
    const before = await snapshot();
    const result = await run();
    expect(await snapshot()).toEqual(before);
    return result;
  }

  async function listOf(actor: Actor, path: string): Promise<Entry[]> {
    const reply = await as(actor).get(path);
    expectOk(reply);
    return entriesOf(reply).sort((x, y) =>
      String(x.categoryId).localeCompare(String(y.categoryId)),
    );
  }

  async function allowListOf(actor: Actor, repositoryId: string) {
    const reply = await as(actor).get(PATHS.repository(repositoryId));
    expectOk(reply);
    const body = (reply.json ?? {}) as { restricted?: unknown; connectionIds?: unknown };
    return {
      restricted: body.restricted,
      connectionIds: Array.isArray(body.connectionIds)
        ? [...(body.connectionIds as string[])].sort()
        : body.connectionIds,
    };
  }

  async function forgeEntry(taskId: string): Promise<Entry> {
    const entry = (await listOf(a, PATHS.task(taskId))).find((e) => e.categoryId === FORGE);
    expect(entry, 'a forge entry').toBeDefined();
    return entry!;
  }

  async function clean() {
    if (userIds.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    userIds.length = 0;
    await db.delete(schema.integrationCategoryPreferences);
    await db.delete(schema.integrationProviderConfigs);
    await db.delete(schema.auditEvents);
  }

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await clean();
  });

  beforeEach(async () => {
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    await clean();
    admin = await createUser('admin');
    a = await createUser('user');
    b = await createUser('user');
    repoA = await createRepository(a.id, GITHUB_REMOTE);
    repoB = await createRepository(b.id, OTHER_REMOTE);
    taskA = await createTask(a.id, repoA);
    taskB = await createTask(b.id, repoB);
    ghA = await createAccount(a.id);
    ghB = await createAccount(b.id);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clean();
  });

  afterAll(async () => {
    await clean();
    await db.$client.end({ timeout: 5 });
  });

  describe('C0 what each route does for the caller who may use it', () => {
    it("C0a lists, upserts and deletes only the caller's own preference rows", async () => {
      await prefer(a.id, 'issues', 'ghost');
      await prefer(b.id, FORGE, 'gitlab');
      await prefer(null, FORGE, 'gitea');
      const othersIn = (entries: Entry[]) =>
        entries.filter((e) => e.providerId === 'gitlab' || e.providerId === 'gitea');
      expect(othersIn(await listOf(a, PATHS.preferences))).toEqual([]);

      expectOk(
        await as(a).put(PATHS.preference(FORGE), { providerId: 'github', connectionId: ghA }),
      );
      expect(await prefsOf(a.id)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: ghA },
        { categoryId: 'issues', providerId: 'ghost', connectionId: null },
      ]);
      const listed = await listOf(a, PATHS.preferences);
      expect(listed.find((e) => e.categoryId === FORGE)).toMatchObject({
        providerId: 'github',
        connectionId: ghA,
      });
      expect(othersIn(listed)).toEqual([]);

      expectOk(await as(a).put(PATHS.preference(FORGE), { providerId: 'github' }));
      expect(await prefsOf(a.id)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: null },
        { categoryId: 'issues', providerId: 'ghost', connectionId: null },
      ]);

      expectOk(await as(a).del(PATHS.preference(FORGE)));
      expect(await prefsOf(a.id)).toEqual([
        { categoryId: 'issues', providerId: 'ghost', connectionId: null },
      ]);
      expect(await prefsOf(b.id)).toEqual([
        { categoryId: FORGE, providerId: 'gitlab', connectionId: null },
      ]);
      expect(await prefsOf(null)).toEqual([
        { categoryId: FORGE, providerId: 'gitea', connectionId: null },
      ]);
    });

    it('C0b lists, upserts and deletes only the admin default rows, and an empty body deletes nothing', async () => {
      await prefer(a.id, FORGE, 'github', ghA);
      expect(await listOf(admin, PATHS.defaults)).toEqual([]);

      expectOk(await as(admin).put(PATHS.default(FORGE), { providerId: 'github' }));
      expect(await prefsOf(null)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: null },
      ]);
      expect(await listOf(admin, PATHS.defaults)).toMatchObject([
        { categoryId: FORGE, providerId: 'github' },
      ]);

      expectOk(await as(admin).put(PATHS.default(FORGE), { providerId: 'gitlab' }));
      expect(await prefsOf(null)).toEqual([
        { categoryId: FORGE, providerId: 'gitlab', connectionId: null },
      ]);

      expectStatus(await as(admin).put(PATHS.default(FORGE), {}), 400);
      expect(await prefsOf(null)).toEqual([
        { categoryId: FORGE, providerId: 'gitlab', connectionId: null },
      ]);

      expectOk(await as(admin).put(PATHS.default(FORGE), { providerId: null }));
      expect(await prefsOf(null)).toEqual([]);
      expect(await listOf(admin, PATHS.defaults)).toEqual([]);
      expect(await prefsOf(a.id)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: ghA },
      ]);
    });

    it('C0c reads and replaces the repository allow-list, and restricted with no accounts stays restricted', async () => {
      const ghA2 = await createAccount(a.id);
      await grantRepository(repoB, ghB);
      expect(await allowListOf(a, repoA)).toEqual({ restricted: false, connectionIds: [] });

      expectOk(await putAllowList(true, [ghA, ghA2]));
      expect(await restrictedOf(repoA)).toBe(true);
      expect(await repoGrantsOf(repoA)).toEqual(allowed(ghA, ghA2));
      expect(await allowListOf(a, repoA)).toEqual({
        restricted: true,
        connectionIds: [ghA, ghA2].sort(),
      });
      expectOk(await putAllowList(true, [ghA, ghA2]), 'the same PUT again');
      expect(await repoGrantsOf(repoA)).toEqual(allowed(ghA, ghA2));

      expectOk(await putAllowList(true, [ghA2]));
      expect(await repoGrantsOf(repoA)).toEqual(allowed(ghA2));

      expectOk(await putAllowList(true, []));
      expect(await restrictedOf(repoA)).toBe(true);
      expect(await repoGrantsOf(repoA)).toEqual([]);
      expect(await allowListOf(a, repoA)).toEqual({ restricted: true, connectionIds: [] });

      expectStatus(
        await as(a).put(PATHS.repository(repoA), { restricted: 'yes', connectionIds: [] }),
        400,
      );
      expect(await restrictedOf(repoA)).toBe(true);

      expectOk(await putAllowList(false, []));
      expect(await restrictedOf(repoA)).toBe(false);
      expect(await repoGrantsOf(repoA)).toEqual([]);
      expect(await restrictedOf(repoB)).toBe(false);
      expect(await repoGrantsOf(repoB)).toEqual(allowed(ghB));
    });
  });

  describe('C1 who may call what', () => {
    const outsiderCalls = (caller: Actor, connectionId: string): Call[] => [
      ['GET task', () => as(caller).get(PATHS.task(taskA))],
      [
        'PUT task choice',
        () => putChoice({ providerId: 'github', connectionId, remember: true }, taskA, caller),
      ],
      ['DELETE task choice', () => delChoice('?remember=1', taskA, caller)],
      ['GET repository', () => as(caller).get(PATHS.repository(repoA))],
      ['PUT repository', () => putAllowList(false, [], repoA, caller)],
    ];

    it('C1a answers 401 to a caller with no session on every route and writes nothing', async () => {
      const routes = everyRoute();
      for (const hit of routes.filter((route) => route.method !== 'DELETE')) {
        expectOk(await hitAs(hit));
      }
      await unchanged(async () => {
        for (const hit of routes) {
          expectStatus(await hitAs(hit, null), 401);
        }
      });
      for (const hit of routes.filter((route) => route.method === 'DELETE')) {
        expectOk(await hitAs(hit));
      }
    });

    it('C1b answers 403 to a user on the admin defaults and writes nothing', async () => {
      expectOk(await as(admin).put(PATHS.default(FORGE), { providerId: 'github' }));
      expectOk(await as(admin).get(PATHS.defaults));
      await unchanged(async () => {
        expectStatus(await as(a).get(PATHS.defaults), 403, 'GET');
        expectStatus(await as(a).put(PATHS.default(FORGE), { providerId: 'gitlab' }), 403, 'PUT');
        expectStatus(await as(a).put(PATHS.default(FORGE), { providerId: null }), 403, 'PUT null');
      });
    });

    it("C1c answers 404 to user B on user A's task and repository and writes nothing", async () => {
      expectOk(await putChoice({ providerId: 'github', connectionId: ghA }));
      expectOk(await putAllowList(true, [ghA]));
      expectOk(await as(a).get(PATHS.task(taskA)));
      expectOk(await as(a).get(PATHS.repository(repoA)));
      await unchanged(async () => {
        for (const [label, run] of outsiderCalls(b, ghB)) expectStatus(await run(), 404, label);
      });
    });

    it("C1d gives an admin no override on another user's task, repository or preferences", async () => {
      await prefer(a.id, FORGE, 'github', ghA);
      expectOk(await putChoice({ providerId: 'github', connectionId: ghA }));
      expectOk(await putAllowList(true, [ghA]));
      await unchanged(async () => {
        for (const [label, run] of outsiderCalls(admin, ghA)) expectStatus(await run(), 404, label);
      });

      expectOk(await as(admin).put(PATHS.preference(FORGE), { providerId: 'gitea' }));
      expect(await listOf(admin, PATHS.preferences)).toMatchObject([
        { categoryId: FORGE, providerId: 'gitea', connectionId: null },
      ]);
      await unchanged(async () => {
        const reply = await as(admin).put(PATHS.preference(FORGE), {
          providerId: 'github',
          connectionId: ghA,
        });
        expectStatus(reply, 404);
      });

      const theirs = await prefsOf(a.id);
      const attempts = [
        await as(admin).put(`${PATHS.preference(FORGE)}?userId=${a.id}`, {
          providerId: 'gitlab',
          userId: a.id,
        }),
        await as(admin).del(`${PATHS.preference(FORGE)}?userId=${a.id}`),
      ];
      for (const reply of attempts) expect(reply.status, note(reply)).toBeLessThan(500);
      expect(await prefsOf(a.id)).toEqual(theirs);
    });
  });

  describe("C2 a connection id that is not the caller's", () => {
    const putListWith = (connectionId: string) =>
      putAllowList(true, [...new Set([ghB, connectionId])], repoB, b);
    const withConnection = (connectionId: string): Call[] => [
      [
        'preference',
        () => as(b).put(PATHS.preference(FORGE), { providerId: 'github', connectionId }),
      ],
      [
        'task choice',
        () => putChoice({ providerId: 'github', connectionId, remember: true }, taskB, b),
      ],
    ];
    const everywhere = (connectionId: string): Call[] => [
      ...withConnection(connectionId),
      ['allow-list', () => putListWith(connectionId)],
    ];

    it("C2a answers 404 to user A's connection in B's preference, task choice and allow-list and stores it nowhere", async () => {
      for (const [label, run] of everywhere(ghA)) expectStatus(await run(), 404, label);
      expect(await prefsOf(b.id)).toEqual([]);
      expect(await choicesOf(taskB)).toEqual([]);
      expect(await restrictedOf(repoB)).toBe(false);
      expect(await repoGrantsOf(repoB)).toEqual([]);

      for (const [label, run] of withConnection(ghB)) expectOk(await run(), label);
      await unchanged(async () => {
        for (const [label, run] of withConnection(ghA)) expectStatus(await run(), 404, label);
      });
      expectOk(await putListWith(ghB), 'allow-list');
      await unchanged(async () => expectStatus(await putListWith(ghA), 404, 'allow-list'));
      expect(JSON.stringify(await snapshot())).not.toContain(ghA);
    });

    it('C2b answers 404 to a connection that does not exist and never 5xx to an id that is not a uuid', async () => {
      for (const [label, run] of withConnection(ghB)) expectOk(await run(), label);
      await unchanged(async () => {
        for (const [label, run] of everywhere(randomUUID())) {
          expectStatus(await run(), 404, label);
        }
        for (const [label, run] of everywhere('not-a-uuid')) {
          const reply = await run();
          expect([400, 404], note(reply, label)).toContain(reply.status);
        }
      });
      expectOk(await putListWith(ghB), 'allow-list');
    });
  });

  describe('C3 what a PUT accepts', () => {
    const putEverywhere = (categoryId: string, providerId: string): Call[] => [
      [
        'preference',
        () => as(a).put(PATHS.preference(categoryId), { providerId, connectionId: ghA }),
      ],
      ['admin default', () => as(admin).put(PATHS.default(categoryId), { providerId })],
      [
        'task choice',
        () => as(a).put(PATHS.taskChoice(taskA, categoryId), { providerId, connectionId: ghA }),
      ],
    ];

    it('C3a answers 400 to an unknown category on every PUT and writes nothing', async () => {
      await unchanged(async () => {
        for (const [label, run] of putEverywhere('no-such-category', 'github')) {
          expectStatus(await run(), 400, label);
        }
      });
      for (const [label, run] of putEverywhere(FORGE, 'github')) expectOk(await run(), label);
    });

    it('C3b answers 400 to a provider that does not serve the category on every PUT and writes nothing', async () => {
      await unchanged(async () => {
        for (const [label, run] of putEverywhere('mail', 'github')) {
          expectStatus(await run(), 400, label);
        }
      });
      for (const [label, run] of putEverywhere(FORGE, 'github')) expectOk(await run(), label);
    });

    it('C3c answers 409 to a disabled provider on every PUT and writes nothing', async () => {
      await db.insert(schema.integrationProviderConfigs).values({
        providerId: 'github',
        enabled: false,
      });
      const refused: Call[] = [
        ...putEverywhere(FORGE, 'github'),
        [
          'preference without account',
          () => as(a).put(PATHS.preference(FORGE), { providerId: 'github' }),
        ],
        ['task choice without account', () => putChoice({ providerId: 'github', remember: true })],
      ];
      await unchanged(async () => {
        for (const [label, run] of refused) expectStatus(await run(), 409, label);
      });

      await db
        .update(schema.integrationProviderConfigs)
        .set({ enabled: true })
        .where(eq(schema.integrationProviderConfigs.providerId, 'github'));
      for (const [label, run] of putEverywhere(FORGE, 'github')) expectOk(await run(), label);
    });

    it("C3d answers 400 to a forge account whose host does not fit the task's repository remote and writes nothing", async () => {
      const glA = await createAccount(a.id, { host: 'gitlab.com', provider: 'gitlab' });
      await unchanged(async () => {
        expectStatus(
          await putChoice({ providerId: 'gitlab', connectionId: glA, remember: true }),
          400,
        );
      });
      expectOk(await putChoice({ providerId: 'github', connectionId: ghA, remember: true }));

      const selfHosted = await createTask(
        a.id,
        await createRepository(a.id, 'https://git.example.com/acme/app.git'),
      );
      const here = await createAccount(a.id, { host: 'git.example.com', provider: 'gitea' });
      const elsewhere = await createAccount(a.id, { host: 'git.other.com', provider: 'gitea' });
      await unchanged(async () => {
        const reply = await putChoice({ providerId: 'gitea', connectionId: elsewhere }, selfHosted);
        expectStatus(reply, 400);
      });
      expectOk(await putChoice({ providerId: 'gitea', connectionId: here }, selfHosted));
    });

    it('C3e accepts an account in needs_reauth, and GET then names it connection-unavailable', async () => {
      const ghA2 = await createAccount(a.id, { status: 'needs_reauth' });
      expectOk(await putChoice({ providerId: 'github', connectionId: ghA2 }));
      expect(await choicesOf(taskA)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: ghA2 },
      ]);
      expect(await forgeEntry(taskA)).toMatchObject({
        categoryId: FORGE,
        status: 'unresolved',
        reason: 'connection-unavailable',
        providerId: 'github',
        connectionId: ghA2,
      });
    });

    it('C3f refuses a provider that is not registered on every PUT and writes nothing', async () => {
      await unchanged(async () => {
        for (const [label, run] of putEverywhere(FORGE, 'dropbox')) {
          const reply = await run();
          expect([400, 404, 409], note(reply, label)).toContain(reply.status);
        }
      });
      for (const [label, run] of putEverywhere(FORGE, 'github')) expectOk(await run(), label);
    });
  });

  describe('C4 remember, and what a DELETE takes back', () => {
    it('C4a writes the task choice and nothing else when remember is off or absent', async () => {
      const ghA2 = await createAccount(a.id);
      await grantTask(taskA, FORGE, ghA);
      await choose(taskB, FORGE, 'github', ghB);
      await prefer(a.id, FORGE, 'gitlab');

      expectOk(await putChoice({ providerId: 'github', connectionId: ghA }));
      expect(await choicesOf(taskA)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: ghA },
      ]);
      expectOk(await putChoice({ providerId: 'github', connectionId: ghA2, remember: false }));
      expect(await choicesOf(taskA)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: ghA2 },
      ]);
      expectOk(await putChoice({ providerId: 'github' }));
      expect(await choicesOf(taskA)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: null },
      ]);

      expect(await prefsOf(a.id)).toEqual([
        { categoryId: FORGE, providerId: 'gitlab', connectionId: null },
      ]);
      expect(await taskGrantsOf(taskA)).toEqual([{ categoryId: FORGE, connectionId: ghA }]);
      expect(await choicesOf(taskB)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: ghB },
      ]);
    });

    it("C4b writes the task choice and the user's preference when remember is on, and no one else's", async () => {
      const ghA2 = await createAccount(a.id);
      await prefer(b.id, FORGE, 'gitlab');
      await prefer(null, FORGE, 'gitea');

      expectOk(await putChoice({ providerId: 'github', connectionId: ghA, remember: true }));
      expect(await choicesOf(taskA)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: ghA },
      ]);
      expect(await prefsOf(a.id)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: ghA },
      ]);

      expectOk(await putChoice({ providerId: 'github', connectionId: ghA2, remember: true }));
      expect(await prefsOf(a.id)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: ghA2 },
      ]);

      expectOk(await putChoice({ providerId: 'github', remember: true }));
      expect(await choicesOf(taskA)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: null },
      ]);
      expect(await prefsOf(a.id)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: null },
      ]);

      expect(await prefsOf(b.id)).toEqual([
        { categoryId: FORGE, providerId: 'gitlab', connectionId: null },
      ]);
      expect(await prefsOf(null)).toEqual([
        { categoryId: FORGE, providerId: 'gitea', connectionId: null },
      ]);
    });

    it('C4c removes the task choice and the preference the user remembered on DELETE with remember=1, and nothing else', async () => {
      await prefer(a.id, 'issues', 'ghost');
      await prefer(b.id, FORGE, 'gitlab');
      await prefer(null, FORGE, 'gitea');
      expectOk(await putChoice({ providerId: 'github', connectionId: ghA, remember: true }));
      expect(await prefsOf(a.id)).toHaveLength(2);

      expectOk(await delChoice('?remember=1'));
      expect(await choicesOf(taskA)).toEqual([]);
      expect(await prefsOf(a.id)).toEqual([
        { categoryId: 'issues', providerId: 'ghost', connectionId: null },
      ]);
      expect(await prefsOf(b.id)).toEqual([
        { categoryId: FORGE, providerId: 'gitlab', connectionId: null },
      ]);
      expect(await prefsOf(null)).toEqual([
        { categoryId: FORGE, providerId: 'gitea', connectionId: null },
      ]);
    });

    it.each([
      ['no remember flag', ''],
      ['remember=0', '?remember=0'],
    ])('C4d removes only the task choice on DELETE with %s', async (_name, suffix) => {
      expectOk(await putChoice({ providerId: 'github', connectionId: ghA, remember: true }));

      expectOk(await delChoice(suffix));
      expect(await choicesOf(taskA)).toEqual([]);
      expect(await prefsOf(a.id)).toEqual([
        { categoryId: FORGE, providerId: 'github', connectionId: ghA },
      ]);
    });

    it.each([
      ['no remember flag', ''],
      ['remember=0', '?remember=0'],
      ['remember=1', '?remember=1'],
    ])(
      "C4e removes that category's task grant, and no other grant, on DELETE with %s",
      async (_name, suffix) => {
        await grantTask(taskA, FORGE, ghA);
        await grantTask(taskA, 'mail', ghA);
        await grantTask(taskB, FORGE, ghB);
        await grantRepository(repoA, ghA);
        expectOk(await putChoice({ providerId: 'github', connectionId: ghA }));

        expectOk(await delChoice(suffix));
        expect(await choicesOf(taskA)).toEqual([]);
        expect(await taskGrantsOf(taskA)).toEqual([{ categoryId: 'mail', connectionId: ghA }]);
        expect(await taskGrantsOf(taskB)).toEqual([{ categoryId: FORGE, connectionId: ghB }]);
        expect(await repoGrantsOf(repoA)).toEqual(allowed(ghA));
      },
    );
  });

  describe('C5 the state of the task', () => {
    it.each(['completed', 'cancelled'] as const)(
      'C5a answers 409 to a %s task on PUT and DELETE and writes nothing',
      async (status) => {
        const ghA2 = await createAccount(a.id);
        expectOk(await putChoice({ providerId: 'github', connectionId: ghA, remember: true }));
        await grantTask(taskA, FORGE, ghA);
        await setTask(taskA, { status });

        await unchanged(async () => {
          const put = await putChoice({ providerId: 'github', connectionId: ghA2, remember: true });
          expectStatus(put, 409, 'PUT');
          expectStatus(await delChoice('?remember=1'), 409, 'DELETE');
        });

        await setTask(taskA, { status: 'running' });
        expectOk(
          await putChoice({ providerId: 'github', connectionId: ghA2, remember: true }),
          'PUT on a running task',
        );
        expectOk(await delChoice('?remember=1'), 'DELETE on a running task');
      },
    );

    it('C5b answers 409 task_dead to a dead task on PUT and DELETE and writes nothing', async () => {
      const ghA2 = await createAccount(a.id);
      expectOk(await putChoice({ providerId: 'github', connectionId: ghA, remember: true }));
      await grantTask(taskA, FORGE, ghA);
      await setTask(taskA, { deadAt: new Date(), deadReason: 'a step this install does not have' });

      await unchanged(async () => {
        const replies: Array<[string, Reply]> = [
          ['PUT', await putChoice({ providerId: 'github', connectionId: ghA2, remember: true })],
          ['DELETE', await delChoice('?remember=1')],
        ];
        for (const [label, reply] of replies) {
          expectStatus(reply, 409, label);
          const code = (reply.json as { code?: unknown } | null)?.code;
          expect(code, note(reply, label)).toBe('task_dead');
        }
      });

      await setTask(taskA, { deadAt: null, deadReason: null });
      expectOk(
        await putChoice({ providerId: 'github', connectionId: ghA2, remember: true }),
        'PUT on a task that is not dead',
      );
    });
  });

  describe('C6 where the request comes from', () => {
    it('C6 answers 403 to a state-changing request from another page on every route and writes nothing', async () => {
      const writes = everyRoute().filter((hit) => hit.method !== 'GET');
      const clearDefault: Hit = {
        actor: admin,
        method: 'PUT',
        path: PATHS.default(FORGE),
        body: { providerId: null },
      };
      const attempts = [...writes.slice(0, 3), clearDefault, ...writes.slice(3)];

      for (const hit of attempts) {
        await unchanged(async () => {
          for (const origin of FOREIGN_ORIGINS) {
            const reply = await send(hit.actor, hit.method, hit.path, hit.body, { origin });
            expectStatus(reply, 403, `from ${origin}`);
          }
        });
        const own = await send(hit.actor, hit.method, hit.path, hit.body, { origin: WEB_ORIGIN });
        expectOk(own, 'from the app');
      }
    });
  });

  describe('C7 what GET /tasks/:id/integrations shows', () => {
    it("C7a resolves one usable account as only, asks to choose between two, and resolves to the task's pick after a PUT", async () => {
      await createAccount(a.id, { host: 'gitlab.com', provider: 'gitlab' });
      const alone = await unchanged(() => forgeEntry(taskA));
      expect(alone).toMatchObject({
        categoryId: FORGE,
        status: 'resolved',
        providerId: 'github',
        connectionId: ghA,
        source: 'only',
      });

      const ghA2 = await createAccount(a.id);
      const asked = await unchanged(() => forgeEntry(taskA));
      expect(asked).toMatchObject({
        status: 'unresolved',
        reason: 'needs-choice',
        providerId: 'github',
        connectionId: null,
      });
      expect([...(asked.candidates as string[])].sort()).toEqual([ghA, ghA2].sort());

      expectOk(await putChoice({ providerId: 'github', connectionId: ghA2 }));
      expect(await forgeEntry(taskA)).toMatchObject({
        status: 'resolved',
        providerId: 'github',
        connectionId: ghA2,
        source: 'task',
      });
    });

    it('C7b lists every category a registered provider serves and every category the task has a choice for', async () => {
      const served = [...new Set(listIntegrationProviders().flatMap((p) => p.categories))].sort();
      const idsOf = async () => (await listOf(a, PATHS.task(taskA))).map((e) => e.categoryId);
      expect(await idsOf()).toEqual(served);

      await choose(taskA, 'mail', 'ghost');
      expect(await idsOf()).toEqual([...served, 'mail'].sort());
      const mail = (await listOf(a, PATHS.task(taskA))).find((e) => e.categoryId === 'mail');
      expect(mail).toMatchObject({ status: 'unresolved', reason: 'no-provider' });
    });

    it("C7c passes the resolver's reason through for a task with no repository and for a repository with no remote", async () => {
      const noRepository = await createTask(a.id, null);
      const noRemote = await createTask(a.id, await createRepository(a.id, null));
      expect(await forgeEntry(noRepository)).toMatchObject({
        status: 'unresolved',
        reason: 'no-repository',
      });
      expect(await forgeEntry(noRemote)).toMatchObject({
        status: 'unresolved',
        reason: 'no-remote',
      });
    });
  });

  describe('C8 what a change leaves behind', () => {
    it('C8a appends task.integration_choice_changed for every task choice change and for nothing refused', async () => {
      const ghA2 = await createAccount(a.id);
      const expected: Array<Record<string, unknown>> = [];
      const changed = async (reply: Reply, payload: Record<string, unknown>) => {
        expectOk(reply);
        expected.push({ categoryId: FORGE, by: a.id, ...payload });
        expect(await eventsOf(taskA)).toMatchObject(expected);
      };

      await changed(await putChoice({ providerId: 'github', connectionId: ghA }), {
        providerId: 'github',
        connectionId: ghA,
        remembered: false,
      });
      await changed(await putChoice({ providerId: 'github', connectionId: ghA2, remember: true }), {
        providerId: 'github',
        connectionId: ghA2,
        remembered: true,
      });
      await changed(await delChoice('?remember=1'), {
        providerId: null,
        connectionId: null,
        remembered: true,
      });
      await changed(await putChoice({ providerId: 'github', connectionId: ghA }), {
        providerId: 'github',
        connectionId: ghA,
        remembered: false,
      });
      await changed(await delChoice(), {
        providerId: null,
        connectionId: null,
        remembered: false,
      });

      await unchanged(async () => {
        const unknown = await as(a).put(PATHS.taskChoice(taskA, 'no-such-category'), {
          providerId: 'github',
        });
        expectStatus(unknown, 400, 'unknown category');
        expectStatus(await putChoice({ providerId: 'github', connectionId: ghA }, taskA, b), 404);
        expectStatus(await putChoice({ providerId: 'github', connectionId: ghB }), 404);
        await setTask(taskA, { status: 'cancelled' });
        expectStatus(await putChoice({ providerId: 'github', connectionId: ghA }), 409);
      });
      expect(await eventsOf(taskA)).toHaveLength(expected.length);
    });

    it('C8b writes one audit row for each admin default change and none for a refused one', async () => {
      const setDefault = (providerId: string | null) =>
        as(admin).put(PATHS.default(FORGE), { providerId });
      expect(await auditsBy(admin.id)).toHaveLength(0);

      expectOk(await setDefault('github'));
      expect(await auditsBy(admin.id)).toHaveLength(1);
      expectOk(await setDefault('gitlab'));
      expect(await auditsBy(admin.id)).toHaveLength(2);
      expectOk(await setDefault(null));
      const audits = await auditsBy(admin.id);
      expect(audits).toHaveLength(3);
      for (const row of audits) expect(JSON.stringify(row)).toContain(FORGE);
      expect(await prefsOf(null)).toEqual([]);

      expectStatus(
        await as(admin).put(PATHS.default('no-such-category'), { providerId: 'github' }),
        400,
      );
      expectStatus(await as(admin).put(PATHS.default('mail'), { providerId: 'github' }), 400);
      expectStatus(await as(a).put(PATHS.default(FORGE), { providerId: 'github' }), 403);
      await db
        .insert(schema.integrationProviderConfigs)
        .values({ providerId: 'github', enabled: false });
      expectStatus(await setDefault('github'), 409);
      expect(await auditsBy(admin.id)).toHaveLength(3);
      expect(await auditsBy(a.id)).toHaveLength(0);
      expect(await prefsOf(null)).toEqual([]);
    });
  });
});
