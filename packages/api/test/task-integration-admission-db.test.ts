import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.TASK_INTEGRATION_ADMISSION_TEST_URL;
if (url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '45553' ||
    !parsed.pathname.startsWith('/ti_admission_')
  )
    throw new Error('Use owned scratch PostgreSQL 45553 /ti_admission_*');
}
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  userId: '',
  add: vi.fn(),
  afterDefinition: undefined as undefined | (() => Promise<void>),
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { getFresh: async () => 'normal', getBoolean: async () => true },
}));
vi.mock('../src/lib/task-type-definition.js', async (original) => {
  const real = await original<typeof import('../src/lib/task-type-definition.js')>();
  return {
    ...real,
    definitionForCreate: async (...args: Parameters<typeof real.definitionForCreate>) => {
      const result = await real.definitionForCreate(...args);
      const hook = h.afterDefinition;
      h.afterDefinition = undefined;
      if (hook) await hook();
      return result;
    },
  };
});
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (
    c: {
      set: (key: string, value: string) => void;
      req: { header: (key: string) => string | undefined };
      json: (body: unknown, code: number) => unknown;
    },
    next: () => Promise<void>,
  ) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('userId', h.userId);
    await next();
  },
}));
import { Hono } from 'hono';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/tasks', taskRoutes);
app.onError(errorHandler);
const TYPE = 'integration-admission';
const STEP = `custom.${TYPE}.review`;
const requirement = (category = 'forge', optional = false) => ({
  id: 'account',
  category,
  access: 'read',
  optional,
});
const prompt = (integrations: unknown[]) => ({
  slug: 'review',
  title: 'Review',
  template: 'Review this',
  timeoutMs: 300000,
  capabilities: [],
  tools: [],
  integrations,
});

describe.skipIf(!url)('task integration preview and atomic admission on Postgres', () => {
  let db: Database;
  let repoId: string;
  let own: string;
  let foreign: string;
  const send = (method: string, path: string, body?: unknown, auth = true) =>
    app.request(path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: 'fixture' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const create = (over: Record<string, unknown> = {}) =>
    send('POST', '/tasks', { type: TYPE, title: 'Review', repositoryId: repoId, ...over });
  const preview = (choices: unknown[] = [], extra = '') =>
    send(
      'GET',
      `/tasks/integration-preview?${new URLSearchParams({ type: TYPE, repositoryId: repoId, choices: JSON.stringify(choices) })}${extra}`,
    );
  const setRequirements = (items: unknown[]) =>
    db
      .update(schema.taskTypeDefinitions)
      .set({ promptSteps: { review: prompt(items) } })
      .where(eq(schema.taskTypeDefinitions.slug, TYPE));
  const pick = (connectionId: string, categoryId = 'forge') => ({ categoryId, connectionId });
  const connection = async (
    ownerUserId = h.userId,
    over: Partial<typeof schema.integrationConnections.$inferInsert> = {},
  ) => {
    const [credential] = await db
      .insert(schema.repoCredentials)
      .values({
        userId: ownerUserId,
        label: 'fixture',
        host: 'github.com',
        provider: 'github',
        usernameEncrypted: 'unused',
        secretEncrypted: 'unused',
        encryptedDek: 'unused',
      })
      .returning();
    const [row] = await db
      .insert(schema.integrationConnections)
      .values({
        providerId: 'github',
        scope: 'user',
        ownerUserId,
        accountLabel: 'Fixture account',
        authMethod: 'token',
        repoCredentialId: credential!.id,
        ...over,
      })
      .returning();
    return row!.id;
  };
  const counts = async () => {
    const [row] = await db.execute(
      sql`select (select count(*)::int from tasks) as tasks, (select count(*)::int from task_events) as events, (select count(*)::int from task_integration_choices) as choices, (select count(*)::int from integration_grants where target_kind='task') as grants`,
    );
    return row;
  };
  beforeAll(async () => {
    db = createDatabase(url!);
    h.db = db;
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    h.add.mockReset();
    h.afterDefinition = undefined;
    await db.execute(
      sql`truncate tasks, task_type_definitions, step_catalog, users, repositories, integration_provider_configs, modules cascade`,
    );
    const users = await db
      .insert(schema.users)
      .values(
        [0, 1].map((n) => ({
          emailEncrypted: 'fixture',
          emailBlindIndex: `fixture-${n}`,
          passwordHash: 'unused',
          status: 'active' as const,
        })),
      )
      .returning();
    h.userId = users[0]!.id;
    foreign = users[1]!.id;
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId: h.userId,
        name: 'Fixture',
        source: 'git_https',
        remoteUrl: 'https://github.com/acme/widgets.git',
        status: 'ready',
      })
      .returning();
    repoId = repo!.id;
    await db
      .insert(schema.stepCatalog)
      .values({
        stepId: '00-model-health-workflow',
        source: 'core',
        title: 'Health',
        workflowType: 'workflow',
        dispatchesCli: true,
        allowSkip: false,
        providerSensitive: false,
        composable: false,
      });
    await db
      .insert(schema.taskTypeDefinitions)
      .values({
        slug: TYPE,
        displayName: 'Review',
        source: 'admin',
        runListStrategy: 'static',
        stepIds: [STEP],
        promptSteps: { review: prompt([requirement()]) },
        requiresRepository: true,
      });
    own = await connection();
  });
  it('authenticates and validates the literal preview route', async () => {
    expect((await send('GET', '/tasks/integration-preview', undefined, false)).status).toBe(401);
    for (const query of [
      'type=x&repositoryId=nope',
      `type=${TYPE}&choices={}`,
      `type=${TYPE}&choices=${encodeURIComponent(JSON.stringify([{ categoryId: 'forge', connectionId: 3 }]))}`,
      `type=${TYPE}&unexpected=1`,
    ])
      expect((await send('GET', `/tasks/integration-preview?${query}`)).status).toBe(400);
  });
  it('returns step context and safe account candidates, with no writes or enqueue', async () => {
    const before = await counts();
    const res = await preview();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      admitted: true,
      scope: 'static',
      categories: [
        {
          categoryId: 'forge',
          required: true,
          status: 'resolved',
          selected: { connectionId: own, providerId: 'github', accountLabel: 'Fixture account' },
          steps: [{ stepId: STEP, requirementId: 'account', access: 'read', optional: false }],
        },
      ],
    });
    expect(await counts()).toEqual(before);
    expect(h.add).not.toHaveBeenCalled();
    expect(await (await preview()).text()).not.toMatch(
      /tokenEncrypted|token_encrypted|unused|password|emailBlind/,
    );
  });
  it('requires a choice for ambiguity and persists explicit choices/events atomically', async () => {
    const second = await connection();
    expect(await (await preview()).json()).toMatchObject({
      admitted: false,
      categories: [
        {
          reason: 'needs-choice',
          candidates: expect.arrayContaining([
            {
              connectionId: own,
              providerId: 'github',
              providerLabel: 'GitHub',
              accountLabel: 'Fixture account',
              status: 'connected',
            },
            {
              connectionId: second,
              providerId: 'github',
              providerLabel: 'GitHub',
              accountLabel: 'Fixture account',
              status: 'connected',
            },
          ]),
        },
      ],
    });
    expect((await create()).status).toBe(409);
    expect(await counts()).toMatchObject({ tasks: 0, events: 0, choices: 0 });
    expect(h.add).not.toHaveBeenCalled();
    expect(await (await preview([pick(second)])).json()).toMatchObject({ admitted: true });
    const res = await create({ integrationChoices: [pick(second)] });
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: { id: string; status: string } };
    expect(task.status).toBe('queued');
    expect(await db.select().from(schema.taskIntegrationChoices)).toMatchObject([
      { taskId: task.id, categoryId: 'forge', providerId: 'github', connectionId: second },
    ]);
    expect(
      await db
        .select()
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.eventType, 'task.integration_choice_changed')),
    ).toMatchObject([
      {
        taskId: task.id,
        payload: { categoryId: 'forge', connectionId: second, remembered: false },
      },
    ]);
    expect(await counts()).toMatchObject({ tasks: 1, choices: 1, grants: 0 });
    expect(h.add).toHaveBeenCalledTimes(1);
    expect(await db.select().from(schema.integrationCategoryPreferences)).toEqual([]);
  });
  it('blocks missing required categories but leaves optional categories nonblocking', async () => {
    await setRequirements([requirement('mail')]);
    expect((await create()).status).toBe(409);
    expect(await (await create()).json()).toMatchObject({
      code: 'integration-admission-required',
      integrationPreview: {
        admitted: false,
        categories: [{ categoryId: 'mail', reason: 'no-provider' }],
      },
    });
    expect(await counts()).toMatchObject({ tasks: 0, events: 0, choices: 0 });
    await setRequirements([requirement('mail', true)]);
    expect((await create()).status).toBe(201);
  });
  it.each([
    'foreign',
    'shared',
    'removed',
    'unavailable',
    'disabled',
    'wrong-category',
    'not-fitting',
    'not-allowed',
  ] as const)('refuses an explicit %s account with no task/event/job/choice', async (kind) => {
    let id = own;
    if (kind === 'foreign') id = await connection(foreign);
    if (kind === 'shared')
      await db
        .update(schema.integrationConnections)
        .set({ scope: 'shared' })
        .where(eq(schema.integrationConnections.id, own));
    if (kind === 'removed') id = randomUUID();
    if (kind === 'unavailable')
      await db
        .update(schema.integrationConnections)
        .set({ status: 'needs_reauth' })
        .where(eq(schema.integrationConnections.id, own));
    if (kind === 'disabled')
      await db
        .insert(schema.integrationProviderConfigs)
        .values({ providerId: 'github', enabled: false });
    if (kind === 'not-fitting')
      await db
        .update(schema.repositories)
        .set({ remoteUrl: 'https://gitlab.com/a/b' })
        .where(eq(schema.repositories.id, repoId));
    if (kind === 'not-allowed')
      await db
        .update(schema.repositories)
        .set({ integrationsRestricted: true })
        .where(eq(schema.repositories.id, repoId));
    const res = await create({
      integrationChoices: [pick(id, kind === 'wrong-category' ? 'mail' : 'forge')],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await counts()).toMatchObject({ tasks: 0, events: 0, choices: 0 });
    expect(h.add).not.toHaveBeenCalled();
  });
  it('rechecks the current locked prompt requirements after a successful preview', async () => {
    expect(await (await preview()).json()).toMatchObject({ admitted: true });
    h.afterDefinition = async () => {
      await setRequirements([requirement('mail')]);
    };
    expect((await create({ integrationChoices: [pick(own)] })).status).toBe(409);
    expect(await counts()).toMatchObject({ tasks: 0, events: 0, choices: 0 });
    expect(h.add).not.toHaveBeenCalled();
  });
  it('aggregates catalog/module and pinned prompt requirements for one category with all step contexts', async () => {
    const stepId = 'module.fixture.review';
    await db
      .insert(schema.modules)
      .values({
        moduleId: 'fixture',
        packageName: '@haive/module-fixture',
        name: 'Fixture module',
        installedVersion: '1.0.0',
      });
    await db
      .insert(schema.stepCatalog)
      .values({
        stepId,
        source: 'module:fixture',
        title: 'Module review',
        workflowType: 'module.fixture',
        dispatchesCli: true,
        allowSkip: false,
        providerSensitive: false,
        composable: true,
        entry: {
          stepId,
          label: 'Module review',
          group: 'build',
          dispatchesCli: true,
          requires: [],
          provides: [],
          integrations: [{ id: 'forge', category: 'forge', access: 'write' }],
        },
      });
    await db
      .update(schema.taskTypeDefinitions)
      .set({ stepIds: [stepId, STEP] })
      .where(eq(schema.taskTypeDefinitions.slug, TYPE));
    await setRequirements([requirement('forge', true)]);
    const res = await preview();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      admitted: true,
      categories: [
        {
          categoryId: 'forge',
          required: true,
          steps: [
            { stepId, title: 'Module review', access: 'write', optional: false },
            { stepId: STEP, title: 'Review', access: 'read', optional: true },
          ],
        },
      ],
    });
    expect((await create()).status).toBe(201);
  });
  it.each([{ items: [{ id: 'docs', provider: 'github', access: 'read' }] }, { items: [null] }])(
    'refuses unsupported pins and invalid stored requirements %#',
    async ({ items }) => {
      await setRequirements(items);
      const res = await preview();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ admitted: false, issues: [{ stepId: STEP }] });
      expect((await create()).status).toBe(409);
      expect(await counts()).toMatchObject({ tasks: 0, events: 0, choices: 0 });
      expect(h.add).not.toHaveBeenCalled();
    },
  );
  it('checks catalog requirements changed since preview inside admission', async () => {
    const stepId = 'catalog-review';
    const catalogEntry = {
      stepId,
      label: 'Catalog review',
      group: 'build',
      dispatchesCli: true,
      requires: [],
      provides: [],
      integrations: [requirement()],
    };
    await db
      .insert(schema.stepCatalog)
      .values({
        stepId,
        source: 'core',
        title: 'Catalog review',
        workflowType: 'workflow',
        dispatchesCli: true,
        allowSkip: false,
        providerSensitive: false,
        composable: true,
        entry: catalogEntry,
      });
    await db
      .update(schema.taskTypeDefinitions)
      .set({ stepIds: [stepId, STEP] })
      .where(eq(schema.taskTypeDefinitions.slug, TYPE));
    expect(await (await preview()).json()).toMatchObject({ admitted: true });
    await db
      .update(schema.stepCatalog)
      .set({ entry: { ...catalogEntry, integrations: [requirement('mail')] } })
      .where(eq(schema.stepCatalog.stepId, stepId));
    expect((await create()).status).toBe(409);
    expect(await counts()).toMatchObject({ tasks: 0, events: 0, choices: 0 });
    expect(h.add).not.toHaveBeenCalled();
  });
  it('preserves unseeded and dynamic built-in previews without guessing a worker path', async () => {
    for (const type of ['workflow', 'run_app', 'onboarding']) {
      const res = await send('GET', `/tasks/integration-preview?type=${type}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        admitted: true,
        scope: 'dispatch-time',
        categories: [],
        issues: [],
      });
    }
  });
  it('rolls back task, choice, events and queued state when a choice event insert fails', async () => {
    await db.execute(
      sql`create function refuse_admission_event() returns trigger language plpgsql as $$ begin if new.event_type='task.integration_choice_changed' then raise exception 'fixture refusal'; end if; return new; end $$`,
    );
    await db.execute(
      sql`create trigger refuse_admission_event before insert on task_events for each row execute function refuse_admission_event()`,
    );
    try {
      expect((await create({ integrationChoices: [pick(own)] })).status).toBe(500);
      expect(await counts()).toMatchObject({ tasks: 0, events: 0, choices: 0 });
      expect(h.add).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`drop trigger refuse_admission_event on task_events`);
      await db.execute(sql`drop function refuse_admission_event()`);
    }
  });
});
