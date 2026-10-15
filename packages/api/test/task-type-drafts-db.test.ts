import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.TASK_TYPE_DRAFTS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/task_type_drafts_test'))
  throw new Error('Use a dedicated task_type_drafts_test database for the task type draft tests');

type Enqueue = (name: string, data: { taskId: string; userId: string }) => Promise<void>;
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  maintenance: 'normal',
  add: undefined as unknown as Enqueue,
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/queues.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues.js')>()),
  getTaskQueue: () => ({ add: (name: string, data: never) => h.add(name, data) }),
}));
vi.mock('@haive/shared', async (importOriginal) => {
  const shared = await importOriginal<typeof import('@haive/shared')>();
  return {
    ...shared,
    configService: {
      get: async (key: string) =>
        key === shared.CONFIG_KEYS.MAINTENANCE_STATE ? h.maintenance : null,
      getBoolean: async () => false,
    },
  };
});

import { Hono } from 'hono';
import { TASK_JOB_NAMES, secretsService } from '@haive/shared';
import {
  TYPE_DRAFT_MESSAGE_EVENT,
  TYPE_DRAFT_MESSAGE_MAX_CHARS,
  TYPE_DRAFT_STATE_MAX_BYTES,
} from '@haive/shared/modularity';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createApiApp } from '../src/index.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const STEP_ID = '01-type-draft';
const AUDIT_ACTION = 'task_type_draft.start';
const BASE = '/admin/task-type-drafts';
const OPENING = 'A read-only step that lists TODO comments and rates each one';
const EDITED = 'tdr-edited';

const step = (over: Record<string, unknown> = {}) => ({
  slug: 'list-todos',
  title: 'List TODO comments',
  template: 'List every TODO comment for {{task.title}}.',
  capabilities: ['tool_use'],
  timeoutMs: 600_000,
  ...over,
});
const draftOf = (over: Record<string, unknown> = {}) => ({
  slug: 'todo-audit',
  displayName: 'TODO audit',
  requiresRepository: true,
  stepIds: ['custom.todo-audit.list-todos'],
  promptSteps: { 'list-todos': step() },
  ...over,
});

describe.skipIf(!url)('task type draft routes on Postgres', () => {
  let db: Database;
  let adminId: string;
  let otherAdminId: string;
  let memberId: string;
  let providerId: string;
  let disabledProviderId: string;
  let foreignProviderId: string;
  const userIds: string[] = [];
  let seen: { name: string; taskId: string; userId: string; events: number; status: string }[] = [];

  async function createUser(role: 'admin' | 'user'): Promise<string> {
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'type-draft-routes-test@test.local',
        emailBlindIndex: randomBytes(16).toString('hex'),
        passwordHash: 'not-a-real-hash',
        role,
      })
      .returning({ id: schema.users.id });
    userIds.push(user!.id);
    return user!.id;
  }

  async function createProvider(userId: string, enabled = true): Promise<string> {
    const [provider] = await db
      .insert(schema.cliProviders)
      .values({ userId, name: 'claude-code', label: 'test provider', enabled })
      .returning({ id: schema.cliProviders.id });
    return provider!.id;
  }

  const app = createApiApp('http://localhost:3000');
  const sessionOf = async (id: string, role: 'admin' | 'user') =>
    `${ACCESS_COOKIE}=${await signAccessToken({ sub: id, role, tv: 0 })}`;

  const send = async (
    client: Pick<Hono<AppEnv>, 'request'>,
    cookie: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> =>
    client.request(path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const asAdmin = async (method: string, path: string, body?: unknown) =>
    send(app, await sessionOf(adminId, 'admin'), method, path, body);
  const start = (body: unknown) => asAdmin('POST', BASE, body);
  const read = async (taskId: string, as = adminId) =>
    send(app, await sessionOf(as, as === memberId ? 'user' : 'admin'), 'GET', `${BASE}/${taskId}`);

  const drafts = () =>
    db
      .select()
      .from(schema.tasks)
      .where(and(inArray(schema.tasks.userId, userIds), eq(schema.tasks.type, 'type_draft')))
      .orderBy(asc(schema.tasks.createdAt));
  const eventsOf = (taskId: string) =>
    db
      .select()
      .from(schema.taskEvents)
      .where(eq(schema.taskEvents.taskId, taskId))
      .orderBy(asc(schema.taskEvents.createdAt));
  const auditRows = () =>
    db.select().from(schema.auditEvents).where(eq(schema.auditEvents.action, AUDIT_ACTION));
  const started = async (body: unknown = { message: OPENING }) => {
    const res = await start(body);
    expect(res.status).toBe(201);
    return ((await res.json()) as { taskId: string }).taskId;
  };
  const nothingCreated = async () => {
    expect(await drafts()).toEqual([]);
    expect(seen).toEqual([]);
  };

  const clean = async () => {
    await db.delete(schema.tasks).where(inArray(schema.tasks.userId, userIds));
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.action, AUDIT_ACTION));
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    adminId = await createUser('admin');
    otherAdminId = await createUser('admin');
    memberId = await createUser('user');
    providerId = await createProvider(adminId);
    disabledProviderId = await createProvider(adminId, false);
    foreignProviderId = await createProvider(otherAdminId);
    await db.insert(schema.stepCatalog).values({
      stepId: STEP_ID,
      source: 'core',
      title: 'Draft a task type',
      workflowType: 'type_draft',
      dispatchesCli: true,
      allowSkip: false,
      providerSensitive: false,
    });
    await db.insert(schema.taskTypeDefinitions).values({
      slug: 'type_draft',
      displayName: 'Task type draft',
      runListStrategy: 'static',
      stepIds: [STEP_ID],
      source: 'builtin',
      selectable: false,
      requiresRepository: false,
    });
    await db.insert(schema.taskTypeDefinitions).values({
      slug: EDITED,
      displayName: 'Edited type',
      runListStrategy: 'static',
      stepIds: [],
      source: 'admin',
    });
  });

  beforeEach(async () => {
    vi.spyOn(secretsService, 'getJwtSecret').mockResolvedValue('cd'.repeat(32));
    h.maintenance = 'normal';
    seen = [];
    h.add = async (name, data) => {
      const events = await db
        .select({ id: schema.taskEvents.id })
        .from(schema.taskEvents)
        .where(eq(schema.taskEvents.taskId, data.taskId));
      const [task] = await db
        .select({ status: schema.tasks.status })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, data.taskId));
      seen.push({ name, ...data, events: events.length, status: task?.status ?? 'missing' });
    };
    await clean();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await clean();
    await db
      .delete(schema.taskTypeDefinitions)
      .where(inArray(schema.taskTypeDefinitions.slug, ['type_draft', EDITED]));
    await db.delete(schema.stepCatalog).where(eq(schema.stepCatalog.stepId, STEP_ID));
    await db.delete(schema.users).where(inArray(schema.users.id, userIds));
    await db.$client.end({ timeout: 5 });
  });

  describe('who may call it', () => {
    it('refuses a caller with no session and a non-admin, on both routes, and creates nothing', async () => {
      const taskId = randomUUID();
      const member = await sessionOf(memberId, 'user');
      expect((await send(app, null, 'POST', BASE, { message: OPENING })).status).toBe(401);
      expect((await send(app, null, 'GET', `${BASE}/${taskId}`)).status).toBe(401);
      expect((await send(app, member, 'POST', BASE, { message: OPENING })).status).toBe(403);
      expect((await send(app, member, 'GET', `${BASE}/${taskId}`)).status).toBe(403);
      await nothingCreated();
      expect(await auditRows()).toEqual([]);
    });

    it('guards its own router, not only through the guard the app puts on /admin', async () => {
      const { taskTypeDraftRoutes } = await import('../src/routes/task-type-drafts.js');
      const bare = new Hono<AppEnv>();
      bare.use(async (c, next) => {
        c.set('maintenanceState', 'normal');
        await next();
      });
      bare.route(BASE, taskTypeDraftRoutes);
      bare.onError(errorHandler);
      const member = await sessionOf(memberId, 'user');
      const admin = await sessionOf(adminId, 'admin');
      expect((await send(bare, null, 'POST', BASE, { message: OPENING })).status).toBe(401);
      expect((await send(bare, member, 'POST', BASE, { message: OPENING })).status).toBe(403);
      expect((await send(bare, member, 'GET', `${BASE}/${randomUUID()}`)).status).toBe(403);
      await nothingCreated();
      expect((await send(bare, admin, 'POST', BASE, { message: OPENING })).status).toBe(201);
    });
  });

  describe(`POST ${BASE}`, () => {
    it('creates the task the worker expects', async () => {
      const taskId = await started();
      const [task] = await drafts();
      expect(task).toMatchObject({
        id: taskId,
        userId: adminId,
        type: 'type_draft',
        repositoryId: null,
        cliProviderId: null,
        ignoreSavedStepClis: false,
        autoContinue: true,
        runListSnapshot: [STEP_ID],
        customSteps: null,
        status: 'queued',
      });
      expect(Object.hasOwn(task!.metadata ?? {}, 'anchorRepositoryId')).toBe(true);
      expect(task!.metadata).toEqual({
        anchorRepositoryId: null,
        egress: { mode: 'none', domains: [], ips: [] },
      });
    });

    it('writes exactly one opening event and enqueues the start only after it', async () => {
      const taskId = await started();
      const events = await eventsOf(taskId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventType: TYPE_DRAFT_MESSAGE_EVENT,
        taskStepId: null,
        payload: { role: 'user', body: OPENING },
      });
      expect(events[0]!.payload).not.toHaveProperty('draft');
      expect(seen).toEqual([
        { name: TASK_JOB_NAMES.START, taskId, userId: adminId, events: 1, status: 'queued' },
      ]);
    });

    it('queues the conversation in the transaction that creates it, so a failed queueing leaves nothing', async () => {
      try {
        await db.execute(sql`
          create or replace function refuse_queued_draft() returns trigger language plpgsql as $$
          begin
            if new.type = 'type_draft' and new.status = 'queued' then
              raise exception 'queueing refused';
            end if;
            return new;
          end $$`);
        await db.execute(sql`
          create or replace trigger refuse_queued_draft before update on tasks
          for each row execute function refuse_queued_draft()`);
        expect((await start({ message: OPENING })).status).toBe(500);
        await nothingCreated();
        expect(
          await db
            .select()
            .from(schema.taskEvents)
            .where(eq(schema.taskEvents.eventType, TYPE_DRAFT_MESSAGE_EVENT)),
        ).toEqual([]);
        expect(await auditRows()).toEqual([]);
      } finally {
        await db.execute(sql`drop function if exists refuse_queued_draft() cascade`);
      }
      const taskId = await started();
      expect((await drafts()).map((task) => [task.id, task.status])).toEqual([[taskId, 'queued']]);
      expect(seen.map((job) => job.taskId)).toEqual([taskId]);
    });

    it('keeps the message as the administrator wrote it, minus the outer blanks', async () => {
      const taskId = await started({ message: `  \n${OPENING}\n\n  ` });
      expect((await eventsOf(taskId))[0]!.payload).toMatchObject({ body: OPENING });
    });

    it('records the audit event without the message', async () => {
      const taskId = await started({ message: OPENING, cliProviderId: providerId });
      const [row] = await auditRows();
      expect(row).toMatchObject({ actorUserId: adminId, targetType: 'task', targetId: taskId });
      expect(row!.metadata).toEqual({ cliProviderId: providerId, withEditorState: false });
      expect(JSON.stringify(row)).not.toContain(OPENING);
      expect(JSON.stringify(row)).not.toContain('TODO');
    });

    it('accepts a message of exactly the cap and refuses one past it, creating nothing', async () => {
      const over = await start({ message: 'm'.repeat(TYPE_DRAFT_MESSAGE_MAX_CHARS + 1) });
      expect(over.status).toBe(400);
      expect(((await over.json()) as { issues: { path: string }[] }).issues[0]!.path).toBe(
        'message',
      );
      await nothingCreated();
      const taskId = await started({ message: 'm'.repeat(TYPE_DRAFT_MESSAGE_MAX_CHARS) });
      expect((await eventsOf(taskId))[0]!.payload).toMatchObject({
        body: 'm'.repeat(TYPE_DRAFT_MESSAGE_MAX_CHARS),
      });
    });

    it.each([{}, { message: '' }, { message: ' \n ' }, { message: 7 }])(
      'refuses %j as the opening message, creating nothing',
      async (body) => {
        expect((await start(body)).status).toBe(400);
        await nothingCreated();
      },
    );

    it('stores the editor state cut to the keys the editor can show', async () => {
      const current = {
        ...draftOf({
          promptSteps: { 'list-todos': step({ tools: [{ name: 't' }], agentPool: '*' }) },
        }),
        enabled: true,
      };
      const taskId = await started({ message: OPENING, current });
      const [event] = await eventsOf(taskId);
      expect(event!.payload).toEqual({ role: 'user', body: OPENING, draft: draftOf() });
    });

    it('leaves the editor state out when none of it is a draftable key', async () => {
      const taskId = await started({ message: OPENING, current: { enabled: true } });
      expect((await eventsOf(taskId))[0]!.payload).toEqual({ role: 'user', body: OPENING });
    });

    it('refuses an editor state past the cap, creating nothing', async () => {
      const current = draftOf({ description: 'x'.repeat(TYPE_DRAFT_STATE_MAX_BYTES) });
      expect((await start({ message: OPENING, current })).status).toBe(400);
      await nothingCreated();
    });

    it('runs on the CLI the administrator picked, over a saved per-step choice', async () => {
      const taskId = await started({ message: OPENING, cliProviderId: providerId });
      const [task] = await drafts();
      expect(task).toMatchObject({
        id: taskId,
        cliProviderId: providerId,
        ignoreSavedStepClis: true,
      });
    });

    it('refuses a CLI that is not theirs, is disabled or does not exist, creating nothing', async () => {
      const refusals: [string, number][] = [
        [foreignProviderId, 404],
        [randomUUID(), 404],
        [disabledProviderId, 409],
        ['not-a-uuid', 400],
      ];
      for (const [cliProviderId, status] of refusals) {
        expect((await start({ message: OPENING, cliProviderId })).status, cliProviderId).toBe(
          status,
        );
      }
      await nothingCreated();
    });

    it('stores the type being edited in the task metadata, beside what the worker already reads', async () => {
      const taskId = await started({ message: OPENING, editingSlug: EDITED });
      const [task] = await drafts();
      expect(task).toMatchObject({ id: taskId });
      expect(task!.metadata).toEqual({
        anchorRepositoryId: null,
        egress: { mode: 'none', domains: [], ips: [] },
        editingSlug: EDITED,
      });
    });

    it('refuses a type that does not exist, creating nothing', async () => {
      const res = await start({ message: OPENING, editingSlug: 'no-such-type' });
      expect(res.status).toBe(400);
      await nothingCreated();
      expect(await auditRows()).toEqual([]);
    });

    it('refuses an editingSlug that is not a string, creating nothing', async () => {
      expect((await start({ message: OPENING, editingSlug: 7 })).status).toBe(400);
      await nothingCreated();
    });

    it.each(['draining', 'maintenance'])(
      'refuses while the system is %s, as POST /tasks does, creating nothing',
      async (state) => {
        h.maintenance = state;
        const res = await start({ message: OPENING });
        expect(res.status).toBe(503);
        expect(((await res.json()) as { error: string }).error).toMatch(/maintenance/);
        await nothingCreated();
        expect(await auditRows()).toEqual([]);
        h.maintenance = 'normal';
        await started();
      },
    );
  });

  describe(`GET ${BASE}/:taskId`, () => {
    const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second));
    const event = (taskId: string, eventType: string, payload: object, second: number) =>
      db.insert(schema.taskEvents).values({
        taskId,
        eventType,
        payload: payload as Record<string, unknown>,
        createdAt: at(second),
      });
    const assistant = (body: string, over: Record<string, unknown> = {}) => ({
      role: 'assistant',
      body,
      draft: null,
      issues: [],
      warnings: [],
      dropped: [],
      ...over,
    });
    const taskOf = async (userId = adminId, type = 'type_draft') => {
      const [task] = await db
        .insert(schema.tasks)
        .values({ userId, type, title: 'Draft a task type', status: 'waiting_user' })
        .returning({ id: schema.tasks.id });
      return task!.id;
    };

    it('returns the opening turn of a conversation just started, and its status', async () => {
      const taskId = await started();
      const res = await read(taskId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'queued',
        awaitingMessage: false,
        turns: [{ role: 'user', body: OPENING }],
        latestDraft: null,
      });
    });

    it('returns the turns in event order, whatever order they were written in, and no repair record', async () => {
      const taskId = await taskOf();
      const first = draftOf();
      const second = draftOf({ displayName: 'TODO audit, rated' });
      await event(
        taskId,
        TYPE_DRAFT_MESSAGE_EVENT,
        { role: 'user', body: 'third', draft: first },
        5,
      );
      await event(taskId, TYPE_DRAFT_MESSAGE_EVENT, assistant('first answer', { draft: first }), 2);
      await event(taskId, 'type_draft.repair', { reply: 'repair', draft: second, issues: [] }, 4);
      await event(taskId, TYPE_DRAFT_MESSAGE_EVENT, { role: 'user', body: 'first' }, 1);
      await event(
        taskId,
        TYPE_DRAFT_MESSAGE_EVENT,
        assistant('second answer', {
          draft: second,
          issues: [{ path: 'displayName', message: 'x' }],
          warnings: [
            { kind: 'persona-not-in-catalog', stepId: 's', raw: 'r', start: 0, message: 'm' },
          ],
          dropped: ['promptSteps.list-todos.tools'],
          repaired: true,
        }),
        6,
      );
      await event(taskId, 'plan_merge.message', { role: 'user', body: 'not mine' }, 3);
      await event(taskId, TYPE_DRAFT_MESSAGE_EVENT, assistant('a question'), 7);
      const res = await read(taskId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        status: 'waiting_user',
        awaitingMessage: false,
        turns: [
          { role: 'user', body: 'first' },
          assistant('first answer', { draft: first }),
          { role: 'user', body: 'third', draft: first },
          assistant('second answer', {
            draft: second,
            issues: [{ path: 'displayName', message: 'x' }],
            warnings: [
              { kind: 'persona-not-in-catalog', stepId: 's', raw: 'r', start: 0, message: 'm' },
            ],
            dropped: ['promptSteps.list-todos.tools'],
            repaired: true,
          }),
          assistant('a question'),
        ],
        latestDraft: second,
      });
    });

    it('has no latest draft until an agent turn carries one', async () => {
      const taskId = await taskOf();
      await event(
        taskId,
        TYPE_DRAFT_MESSAGE_EVENT,
        { role: 'user', body: 'hi', draft: draftOf() },
        1,
      );
      await event(taskId, TYPE_DRAFT_MESSAGE_EVENT, assistant('Which repository?'), 2);
      expect(
        ((await (await read(taskId)).json()) as { latestDraft: unknown }).latestDraft,
      ).toBeNull();
    });

    it('skips an event with no readable turn in it', async () => {
      const taskId = await taskOf();
      await event(taskId, TYPE_DRAFT_MESSAGE_EVENT, { role: 'system', body: 'x' }, 1);
      await db
        .insert(schema.taskEvents)
        .values({ taskId, eventType: TYPE_DRAFT_MESSAGE_EVENT, payload: null, createdAt: at(2) });
      await event(taskId, TYPE_DRAFT_MESSAGE_EVENT, { role: 'user', body: 'real' }, 3);
      expect(((await (await read(taskId)).json()) as { turns: unknown[] }).turns).toEqual([
        { role: 'user', body: 'real' },
      ]);
    });

    it('carries what the worker recorded about a turn, and no such key on a turn without it', async () => {
      const taskId = await taskOf();
      const log = (payload: object, second: number) =>
        event(taskId, TYPE_DRAFT_MESSAGE_EVENT, payload, second);
      await log({ role: 'user', body: 'one', draftIgnored: 'not-json' }, 1);
      await log({ role: 'user', body: 'two', draftIgnored: 'too-large' }, 2);
      await log(assistant('cut off', { error: 'unreadable-reply' }), 3);
      await log(assistant('fixed', { repaired: true }), 4);
      await log({ role: 'user', body: 'plain' }, 5);
      await log(assistant('plain answer'), 6);
      const { turns } = (await (await read(taskId)).json()) as { turns: object[] };
      expect(turns).toEqual([
        { role: 'user', body: 'one', draftIgnored: 'not-json' },
        { role: 'user', body: 'two', draftIgnored: 'too-large' },
        assistant('cut off', { error: 'unreadable-reply' }),
        assistant('fixed', { repaired: true }),
        { role: 'user', body: 'plain' },
        assistant('plain answer'),
      ]);
      for (const plain of turns.slice(4)) {
        for (const key of ['draftIgnored', 'error', 'repaired']) {
          expect(plain).not.toHaveProperty(key);
        }
      }
    });

    it('leaves out a recorded field that has the wrong type', async () => {
      const taskId = await taskOf();
      await event(
        taskId,
        TYPE_DRAFT_MESSAGE_EVENT,
        { role: 'user', body: 'a', draftIgnored: 7 },
        1,
      );
      await event(
        taskId,
        TYPE_DRAFT_MESSAGE_EVENT,
        assistant('b', { error: { code: 1 }, repaired: 'yes' }),
        2,
      );
      expect(((await (await read(taskId)).json()) as { turns: unknown[] }).turns).toEqual([
        { role: 'user', body: 'a' },
        assistant('b'),
      ]);
    });

    describe('awaitingMessage', () => {
      const stepOf = (
        taskId: string,
        status: (typeof schema.taskSteps.$inferInsert)['status'],
        waitingStartedAt: Date | null,
        round = 0,
      ) =>
        db.insert(schema.taskSteps).values({
          taskId,
          stepId: STEP_ID,
          stepIndex: 0,
          round,
          title: 'Draft a task type',
          status,
          waitingStartedAt,
        });
      const awaiting = async (taskId: string) =>
        ((await (await read(taskId)).json()) as { awaitingMessage: unknown }).awaitingMessage;

      it.each([
        { step: 'parked on its form', status: 'waiting_form', stamped: true, expected: true },
        {
          step: 'on its form, a turn just submitted and the worker not back yet',
          status: 'waiting_form',
          stamped: false,
          expected: false,
        },
        { step: 'running', status: 'running', stamped: false, expected: false },
        {
          step: 'waiting for a slot, which stamps the same column',
          status: 'pending',
          stamped: true,
          expected: false,
        },
        {
          step: 'waiting on its agent, the stamp left behind',
          status: 'waiting_cli',
          stamped: true,
          expected: false,
        },
        { step: 'done', status: 'done', stamped: false, expected: false },
      ] as const)('is $expected for a step $step', async ({ status, stamped, expected }) => {
        const taskId = await taskOf();
        await stepOf(taskId, status, stamped ? at(0) : null);
        expect(await awaiting(taskId)).toBe(expected);
      });

      it('is false before the task has a step row', async () => {
        expect(await awaiting(await taskOf())).toBe(false);
      });

      it('reads the newest round, whichever round was written first', async () => {
        const parkedNow = await taskOf();
        await stepOf(parkedNow, 'done', null, 0);
        await stepOf(parkedNow, 'waiting_form', at(0), 1);
        expect(await awaiting(parkedNow)).toBe(true);
        const parkedBefore = await taskOf();
        await stepOf(parkedBefore, 'waiting_form', at(0), 0);
        await stepOf(parkedBefore, 'running', null, 1);
        expect(await awaiting(parkedBefore)).toBe(false);
      });
    });

    it('answers 404 for another administrator, an unknown id, a malformed id and a task of another type', async () => {
      const mine = await started();
      const other = await taskOf(adminId, 'workflow');
      expect((await read(mine, otherAdminId)).status).toBe(404);
      expect((await read(randomUUID())).status).toBe(404);
      expect((await read('not-a-uuid')).status).toBe(404);
      expect((await read(other)).status).toBe(404);
      expect((await read(mine)).status).toBe(200);
    });

    it('answers 403 for a non-admin, even for an id that exists', async () => {
      const mine = await started();
      expect((await read(mine, memberId)).status).toBe(403);
    });
  });

  describe('GET /tasks', () => {
    it.each(['', '?includeChats=1'])(
      'GET /tasks%s lists a draft conversation beside an ordinary task',
      async (query) => {
        const draftId = await started();
        const [ordinary] = await db
          .insert(schema.tasks)
          .values({ userId: adminId, type: 'workflow', title: 'Ordinary task', status: 'running' })
          .returning({ id: schema.tasks.id });
        const res = await send(app, await sessionOf(adminId, 'admin'), 'GET', `/tasks${query}`);
        expect(res.status).toBe(200);
        const listed = (await res.json()) as { tasks: { id: string }[]; total: number };
        expect(listed.tasks.map((task) => task.id).sort()).toEqual([draftId, ordinary!.id].sort());
        expect(listed.total).toBe(2);
      },
    );
  });
});
