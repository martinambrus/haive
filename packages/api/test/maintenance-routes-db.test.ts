import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';

const url = process.env.MAINTENANCE_API_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/maintenance_api_test'))
  throw new Error('Use a dedicated maintenance_api_test database for maintenance route tests');

const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const OWNER = '00000000-0000-4000-8000-0000000000a2';
const KEY = '11'.repeat(32);

const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxes: async () => 0 }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', ADMIN);
    await next();
  },
  requireAdmin: async (_c: unknown, next: () => unknown) => next(),
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getEncryptionKey: async () => KEY },
}));

import { Hono } from 'hono';
import { encryptEmail } from '@haive/shared';
import { BLOCKING_LIST_CAP, maintenanceRoutes } from '../src/routes/maintenance.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const TYPE = 'maintenance-route-test';
const BLIND_INDEXES = ['maintenance-route-test-admin', 'maintenance-route-test-owner'];

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/admin/maintenance', maintenanceRoutes);

interface Blocking {
  tasks: { id: string; hasLiveCli: boolean; ownerId: string | null; ownerEmail: string | null }[];
  jobs: {
    kind: string;
    id: string;
    name: string;
    status: string;
    updatedAt: string;
    ownerId: string | null;
    ownerName: string | null;
    ownerEmail: string | null;
  }[];
  viewerId: string;
  total: number;
  capped: boolean;
}

const blocking = async (): Promise<Blocking> => {
  const res = await app.request('/admin/maintenance/blocking');
  expect(res.status).toBe(200);
  return (await res.json()) as Blocking;
};
const act = (taskId: string, action: 'pause' | 'resume' | 'stop') =>
  app.request(`/admin/maintenance/tasks/${taskId}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });

describe.skipIf(!url)('maintenance routes on Postgres', () => {
  let db: Database;

  const task = async (over: Partial<typeof schema.tasks.$inferInsert> = {}) => {
    const [row] = await db
      .insert(schema.tasks)
      .values({ userId: OWNER, type: TYPE, title: 'Task', status: 'running', ...over })
      .returning();
    return row!;
  };
  const run = async (
    taskId: string,
    over: Partial<typeof schema.cliInvocations.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(schema.cliInvocations)
      .values({ taskId, mode: 'cli', prompt: 'work', ...over })
      .returning();
    return row!;
  };
  const events = (taskId: string, eventType: string) =>
    db
      .select()
      .from(schema.taskEvents)
      .where(and(eq(schema.taskEvents.taskId, taskId), eq(schema.taskEvents.eventType, eventType)));
  const audits = (taskId: string, action: string) =>
    db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.targetId, taskId), eq(schema.auditEvents.action, action)));

  const refuseAuditInserts = async () => {
    await db.execute(
      sql.raw(
        "CREATE OR REPLACE FUNCTION refuse_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit insert refused'; END $$;",
      ),
    );
    await db.execute(
      sql.raw(
        'CREATE TRIGGER refuse_audit_insert BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION refuse_audit_insert();',
      ),
    );
  };
  const allowAuditInserts = async () => {
    await db.execute(sql.raw('DROP TRIGGER IF EXISTS refuse_audit_insert ON audit_events;'));
    await db.execute(sql.raw('DROP FUNCTION IF EXISTS refuse_audit_insert();'));
  };

  const repository = async (status: 'cloning' | 'ready' | 'error', name: string, at?: Date) => {
    const [row] = await db
      .insert(schema.repositories)
      .values({
        userId: OWNER,
        name,
        source: 'local_path',
        status,
        ...(at ? { updatedAt: at } : {}),
      })
      .returning();
    return row!;
  };
  const bundle = async (
    repositoryId: string,
    status: 'active' | 'syncing' | 'failed',
    name: string,
    at?: Date,
  ) => {
    const [row] = await db
      .insert(schema.customBundles)
      .values({
        userId: OWNER,
        repositoryId,
        name,
        sourceType: 'git',
        storageRoot: '/bundles/blocking-test',
        status,
        ...(at ? { updatedAt: at } : {}),
      })
      .returning();
    return row!;
  };
  const provider = async (
    build: 'idle' | 'building' | 'ready' | 'failed',
    provision: 'idle' | 'provisioning' | 'ready' | 'failed',
    label: string,
    at?: Date,
  ) => {
    const [row] = await db
      .insert(schema.cliProviders)
      .values({
        userId: OWNER,
        name: 'claude-code',
        label,
        sandboxImageBuildStatus: build,
        modelProvisionStatus: provision,
        ...(at ? { updatedAt: at } : {}),
      })
      .returning();
    return row!;
  };

  const clean = async () => {
    await db.delete(schema.tasks).where(eq(schema.tasks.type, TYPE));
    await db.delete(schema.repositories).where(eq(schema.repositories.userId, OWNER));
    await db.delete(schema.cliProviders).where(eq(schema.cliProviders.userId, OWNER));
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorUserId, ADMIN));
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEXES[0]!));
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEXES[1]!));
    await db.insert(schema.users).values([
      {
        id: ADMIN,
        emailEncrypted: encryptEmail('admin@maintenance.test', KEY),
        emailBlindIndex: BLIND_INDEXES[0]!,
        passwordHash: 'not-real',
        role: 'admin',
      },
      {
        id: OWNER,
        emailEncrypted: encryptEmail('owner@maintenance.test', KEY),
        emailBlindIndex: BLIND_INDEXES[1]!,
        passwordHash: 'not-real',
        role: 'user',
        name: 'Owner Name',
      },
    ]);
  });

  beforeEach(async () => {
    await clean();
  });

  afterEach(async () => {
    await allowAuditInserts();
  });

  afterAll(async () => {
    await clean();
    for (const index of BLIND_INDEXES) {
      await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, index));
    }
    await db.$client.end({ timeout: 5 });
  });

  describe('GET /blocking, the live CLI', () => {
    it('counts a run that started and not a run the pause held back', async () => {
      const started = await task();
      await run(started.id, { startedAt: new Date() });
      const heldBack = await task();
      await run(heldBack.id, { startedAt: null });
      const idle = await task({ status: 'waiting_user' });

      const byId = new Map((await blocking()).tasks.map((t) => [t.id, t.hasLiveCli]));
      expect(byId.get(started.id)).toBe(true);
      expect(byId.get(heldBack.id)).toBe(false);
      expect(byId.get(idle.id)).toBe(false);
    });

    it('counts a task with one started run beside a held-back one', async () => {
      const mixed = await task();
      await run(mixed.id, { startedAt: new Date() });
      await run(mixed.id, { startedAt: null });

      expect((await blocking()).tasks.find((t) => t.id === mixed.id)?.hasLiveCli).toBe(true);
    });

    it('does not count a run that ended or was superseded', async () => {
      const ended = await task();
      await run(ended.id, { startedAt: new Date(), endedAt: new Date() });
      const superseded = await task();
      await run(superseded.id, { startedAt: new Date(), supersededAt: new Date() });

      const byId = new Map((await blocking()).tasks.map((t) => [t.id, t.hasLiveCli]));
      expect(byId.get(ended.id)).toBe(false);
      expect(byId.get(superseded.id)).toBe(false);
    });
  });

  describe('GET /blocking, a dead task', () => {
    it('leaves a dead task out of the list and the count, whatever status it died in', async () => {
      const alive = await task();
      const parked = await task({ status: 'waiting_user' });
      for (const status of [
        'created',
        'queued',
        'running',
        'waiting_user',
        'waiting_pr',
      ] as const) {
        await task({ status, deadAt: new Date() });
      }

      const body = await blocking();
      expect(body.tasks.map((t) => t.id).sort()).toEqual([alive.id, parked.id].sort());
      expect(body.total).toBe(2);
    });

    it('still lists a task whose dead_reason outlived its dead_at', async () => {
      const revived = await task({ deadAt: null, deadReason: 'a step was missing once' });

      expect((await blocking()).tasks.map((t) => t.id)).toEqual([revived.id]);
    });

    it('names the owner of a task it lists', async () => {
      const alive = await task();

      const listed = (await blocking()).tasks.find((t) => t.id === alive.id);
      expect(listed?.ownerEmail).toBe('owner@maintenance.test');
    });
  });

  describe('GET /blocking, a draft that never started', () => {
    it('leaves a created task out of the list and the count, and keeps a queued one', async () => {
      await task({ status: 'created' });
      const queued = await task({ status: 'queued' });

      const body = await blocking();
      expect(body.tasks.map((t) => t.id)).toEqual([queued.id]);
      expect(body.total).toBe(1);
    });
  });

  describe('GET /blocking, the background jobs', () => {
    const at = (second: number) => new Date(Date.UTC(2026, 9, 16, 10, 0, second));

    it('lists a repository that is cloning, a bundle that is syncing and a provider that is building or provisioning, newest first', async () => {
      const host = await repository('ready', 'host repo');
      const syncing = await bundle(host.id, 'syncing', 'syncing bundle', at(10));
      const cloning = await repository('cloning', 'cloning repo', at(20));
      const building = await provider('building', 'idle', 'building provider', at(30));
      const provisioning = await provider('idle', 'provisioning', 'provisioning provider', at(40));

      const { jobs } = await blocking();

      expect(
        jobs.map(({ kind, id, name, status, updatedAt }) => ({
          kind,
          id,
          name,
          status,
          updatedAt,
        })),
      ).toEqual([
        {
          kind: 'cli_provider',
          id: provisioning.id,
          name: 'provisioning provider',
          status: 'provisioning',
          updatedAt: at(40).toISOString(),
        },
        {
          kind: 'cli_provider',
          id: building.id,
          name: 'building provider',
          status: 'building',
          updatedAt: at(30).toISOString(),
        },
        {
          kind: 'repository',
          id: cloning.id,
          name: 'cloning repo',
          status: 'cloning',
          updatedAt: at(20).toISOString(),
        },
        {
          kind: 'bundle',
          id: syncing.id,
          name: 'syncing bundle',
          status: 'syncing',
          updatedAt: at(10).toISOString(),
        },
      ]);
    });

    it('names the owner of each, as it does for a task', async () => {
      const host = await repository('cloning', 'cloning repo');
      await bundle(host.id, 'syncing', 'syncing bundle');
      await provider('building', 'idle', 'building provider');

      const { jobs } = await blocking();

      expect(jobs).toHaveLength(3);
      for (const job of jobs) {
        expect(job).toMatchObject({
          ownerId: OWNER,
          ownerName: 'Owner Name',
          ownerEmail: 'owner@maintenance.test',
        });
      }
    });

    it('leaves out the ones that finished', async () => {
      const host = await repository('ready', 'ready repo');
      await repository('error', 'failed repo');
      await bundle(host.id, 'active', 'active bundle');
      await bundle(host.id, 'failed', 'failed bundle');
      await provider('idle', 'idle', 'idle provider');
      await provider('ready', 'ready', 'ready provider');
      await provider('failed', 'failed', 'failed provider');

      const body = await blocking();

      expect(body.jobs).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('lists a provider once when its image is building and its model is provisioning', async () => {
      const both = await provider('building', 'provisioning', 'busy provider');

      const { jobs } = await blocking();

      expect(jobs.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: both.id, status: 'building + provisioning' },
      ]);
    });

    it('counts them in the total beside the tasks, and keeps the capped flag for the tasks list', async () => {
      await task();
      await repository('cloning', 'cloning repo');
      await provider('building', 'idle', 'building provider');

      const body = await blocking();

      expect(body.tasks).toHaveLength(1);
      expect(body.jobs).toHaveLength(2);
      expect(body.total).toBe(3);
      expect(body.capped).toBe(false);
    });
  });

  describe('GET /blocking, at the cap', () => {
    it.each([
      { seeded: BLOCKING_LIST_CAP, capped: false },
      { seeded: BLOCKING_LIST_CAP + 1, capped: true },
    ])(
      'with $seeded blocking tasks, lists the cap of them and says capped is $capped',
      async ({ seeded, capped }) => {
        await db.insert(schema.tasks).values(
          Array.from({ length: seeded }, (_, i) => ({
            userId: OWNER,
            type: TYPE,
            title: `Task ${i}`,
            status: 'running' as const,
          })),
        );

        const body = await blocking();

        expect(body.tasks).toHaveLength(BLOCKING_LIST_CAP);
        expect(body.total).toBe(BLOCKING_LIST_CAP);
        expect(body.capped).toBe(capped);
      },
    );

    it.each([
      { seeded: BLOCKING_LIST_CAP, capped: false },
      { seeded: BLOCKING_LIST_CAP + 1, capped: true },
    ])(
      'with $seeded cloning repositories, lists the cap of them and says capped is $capped',
      async ({ seeded, capped }) => {
        await db.insert(schema.repositories).values(
          Array.from({ length: seeded }, (_, i) => ({
            userId: OWNER,
            name: `cloning repo ${i}`,
            source: 'local_path' as const,
            status: 'cloning' as const,
          })),
        );

        const body = await blocking();

        expect(body.jobs).toHaveLength(BLOCKING_LIST_CAP);
        expect(body.total).toBe(BLOCKING_LIST_CAP);
        expect(body.capped).toBe(capped);
      },
    );
  });

  describe('GET /blocking, the viewer and the owners', () => {
    it("names the viewer and each task's owner", async () => {
      const mine = await task({ userId: ADMIN });
      const theirs = await task();

      const body = await blocking();
      expect(body.viewerId).toBe(ADMIN);
      const ownerOf = new Map(body.tasks.map((t) => [t.id, t.ownerId]));
      expect(ownerOf.get(mine.id)).toBe(ADMIN);
      expect(ownerOf.get(theirs.id)).toBe(OWNER);
    });
  });

  describe('POST /tasks/:id/action stop', () => {
    it('records no event and no audit row when it stopped nothing', async () => {
      const idle = await task({ status: 'waiting_user' });

      const res = await act(idle.id, 'stop');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        killed: 0,
        cancelled: 0,
        stopped: 0,
        failedAt: null,
      });
      expect(await events(idle.id, 'task.stopped')).toEqual([]);
      expect(await audits(idle.id, 'task.admin_stop')).toEqual([]);
      const after = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, idle.id) });
      expect(after?.status).toBe('waiting_user');
    });

    it('records the event and the audit row when it ended a run', async () => {
      const busy = await task();
      const live = await run(busy.id, { startedAt: new Date() });

      const res = await act(busy.id, 'stop');

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, cancelled: 1 });
      const stopped = await events(busy.id, 'task.stopped');
      expect(stopped).toHaveLength(1);
      expect(stopped[0]?.payload).toMatchObject({ by: ADMIN, byAdmin: true, cancelled: 1 });
      expect(await audits(busy.id, 'task.admin_stop')).toHaveLength(1);
      const ended = await db.query.cliInvocations.findFirst({
        where: eq(schema.cliInvocations.id, live.id),
      });
      expect(ended?.supersededAt).toBeInstanceOf(Date);
      const after = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, busy.id) });
      expect(after?.status).toBe('failed');
    });

    it('records them when it ended a run the pause held back', async () => {
      const held = await task();
      await run(held.id, { startedAt: null });

      expect(await (await act(held.id, 'stop')).json()).toMatchObject({ cancelled: 1 });
      expect(await events(held.id, 'task.stopped')).toHaveLength(1);
      expect(await audits(held.id, 'task.admin_stop')).toHaveLength(1);
    });

    it('records them when it failed a stuck step that had no run', async () => {
      const stuck = await task();
      await db.insert(schema.taskSteps).values({
        taskId: stuck.id,
        stepId: '07-phase-2-implement',
        stepIndex: 7,
        round: 0,
        title: 'Implement',
        status: 'running',
      });

      expect(await (await act(stuck.id, 'stop')).json()).toMatchObject({
        cancelled: 0,
        stopped: 1,
      });
      expect(await events(stuck.id, 'task.stopped')).toHaveLength(1);
      expect(await audits(stuck.id, 'task.admin_stop')).toHaveLength(1);
    });

    it('records nothing a second time once the first stop ended everything', async () => {
      const busy = await task();
      await run(busy.id, { startedAt: new Date() });
      await act(busy.id, 'stop');

      expect(await (await act(busy.id, 'stop')).json()).toMatchObject({
        cancelled: 0,
        stopped: 0,
      });
      expect(await events(busy.id, 'task.stopped')).toHaveLength(1);
      expect(await audits(busy.id, 'task.admin_stop')).toHaveLength(1);
    });
  });

  describe('POST /tasks/:id/action pause and resume', () => {
    it('pauses a task with one audit row and one event', async () => {
      const busy = await task();

      const res = await act(busy.id, 'pause');

      expect(res.status).toBe(200);
      expect(await events(busy.id, 'task.paused')).toHaveLength(1);
      expect(await audits(busy.id, 'task.admin_pause')).toHaveLength(1);
    });

    it('refuses a pause whose audit row cannot be written, and changes nothing', async () => {
      const busy = await task();
      await refuseAuditInserts();

      const res = await act(busy.id, 'pause');

      expect(res.status).toBe(500);
      const after = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, busy.id) });
      expect(after?.pausedAt).toBeNull();
      expect(await events(busy.id, 'task.paused')).toEqual([]);
      await allowAuditInserts();
      expect(await audits(busy.id, 'task.admin_pause')).toEqual([]);
    });

    it('resumes a paused task with one audit row', async () => {
      const paused = await task({ pausedAt: new Date() });

      const res = await act(paused.id, 'resume');

      expect(res.status).toBe(200);
      expect(await audits(paused.id, 'task.admin_resume')).toHaveLength(1);
    });

    it('refuses a resume whose audit row cannot be written, and changes nothing', async () => {
      const paused = await task({ pausedAt: new Date() });
      await refuseAuditInserts();

      const res = await act(paused.id, 'resume');

      expect(res.status).toBe(500);
      const after = await db.query.tasks.findFirst({ where: eq(schema.tasks.id, paused.id) });
      expect(after?.pausedAt).toBeInstanceOf(Date);
      expect(await events(paused.id, 'task.resumed')).toEqual([]);
      await allowAuditInserts();
      expect(await audits(paused.id, 'task.admin_resume')).toEqual([]);
    });
  });
});
