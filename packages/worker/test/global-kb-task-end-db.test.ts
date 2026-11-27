import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createGlobalKbDb, type GlobalKbDb } from '@haive/shared/global-kb';

const url = process.env.WORKER_KB_SETTLEMENT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/worker_kb_settlement_test'))
  throw new Error('Use a dedicated worker_kb_settlement_test database');

// Store discovery is replaced and the settlement deadline can be shortened. The task fence
// and KB mutation use real Postgres on separate pools, as with a separately hosted KB.
const h = vi.hoisted(() => ({
  gdb: undefined as unknown as GlobalKbDb,
  settings: undefined as (() => Promise<void>) | undefined,
  store: undefined as (() => Promise<void>) | undefined,
  timeoutMs: undefined as number | undefined,
  signal: undefined as AbortSignal | undefined,
  work: undefined as Promise<void> | undefined,
}));
vi.mock('@haive/shared', async (original) => {
  const shared = await original<typeof import('@haive/shared')>();
  return {
    ...shared,
    setTaskSettlementTimeout: (tx: Parameters<typeof shared.setTaskSettlementTimeout>[0]) =>
      shared.setTaskSettlementTimeout(tx, h.timeoutMs),
  };
});
vi.mock('@haive/shared/global-kb', async (original) => ({
  ...(await original<object>()),
  resolveGlobalKbSettings: async () => {
    await h.settings?.();
    return { enabled: true };
  },
  withGlobalKb: (
    _db: unknown,
    fn: (ctx: { db: GlobalKbDb }) => Promise<void>,
    opts?: { signal?: AbortSignal },
  ) => {
    h.signal = opts?.signal;
    h.work = (async () => {
      await h.store?.();
      return fn({ db: h.gdb });
    })();
    return h.work;
  },
}));
import { reconcileKbAuthorEntryOnTaskEnd } from '../src/step-engine/steps/_global-kb-promote.js';

function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => (release = resolve));
  return { wait, release };
}

describe.skipIf(!url)('kb_author settlement versus Retry, on Postgres', () => {
  let db: Database;
  let retry: ReturnType<typeof postgres>;
  let kb: ReturnType<typeof postgres>;
  let userId: string;
  let taskId: string;
  const log = { info: vi.fn(), warn: vi.fn() };
  const reconcile = () => reconcileKbAuthorEntryOnTaskEnd(db, taskId, 'failed', log);
  const revive = () => retry`update tasks set status = 'running',
    orchestration_epoch = orchestration_epoch + 1 where id = ${taskId}`;
  const entryStatus = async () =>
    (await kb`select status from global_kb_entries where source_task_id = ${taskId}`)[0]?.status;

  beforeAll(async () => {
    db = drizzle(postgres(url!, { max: 3 }), { schema });
    retry = postgres(url!, { max: 1 });
    kb = postgres(url!, { max: 1 });
    h.gdb = createGlobalKbDb(kb);
    // This isolated store needs only the columns reconciliation reads/writes. It has no FK
    // to tasks: the production global store is separate from the orchestration database.
    await kb`create table if not exists global_kb_entries (
      id uuid primary key, source_task_id uuid, user_id uuid, status text,
      enforced_hash text, updated_at timestamp default now())`;
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'kb-settlement@test.local',
        emailBlindIndex: randomUUID(),
        passwordHash: 'not-real',
        role: 'user',
        status: 'active',
      })
      .returning({ id: schema.users.id });
    userId = user!.id;
  });
  beforeEach(async () => {
    h.settings = undefined;
    h.store = undefined;
    h.timeoutMs = undefined;
    h.signal = undefined;
    h.work = undefined;
    vi.clearAllMocks();
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'kb_author',
        title: 'settlement race',
        status: 'failed',
        orchestrationEpoch: 1,
      })
      .returning({ id: schema.tasks.id });
    taskId = task!.id;
    await kb`insert into global_kb_entries (id, source_task_id, user_id, status)
      values (${randomUUID()}, ${taskId}, ${userId}, 'enriching')`;
  });
  afterAll(async () => {
    await kb`delete from global_kb_entries where user_id = ${userId}`;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await Promise.all([
      db.$client.end({ timeout: 5 }),
      retry.end({ timeout: 5 }),
      kb.end({ timeout: 5 }),
    ]);
  });

  it('keeps the enriching entry when Retry commits during failed settlement', async () => {
    const entered = barrier();
    const resume = barrier();
    h.settings = async () => {
      entered.release();
      await resume.wait;
    };
    const settling = reconcile();
    try {
      await entered.wait;
      await revive();
    } finally {
      resume.release();
      await settling;
    }
    expect(await entryStatus()).toBe('enriching');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('holds Retry until the KB write finishes when settlement takes the fence first', async () => {
    const entered = barrier();
    const resume = barrier();
    h.store = async () => {
      entered.release();
      await resume.wait;
    };
    const [backend] = await retry`select pg_backend_pid() as pid`;
    const pid = backend!.pid;
    const settling = reconcile();
    await entered.wait;
    const reviving = revive().then(() => undefined);
    try {
      // Observe an actual PostgreSQL lock wait, rather than assuming an uncompleted promise
      // is blocked. SQL/connection deadlines bound this external-process control.
      await expect
        .poll(
          async () => {
            const [row] = await db.execute(sql`select cardinality(pg_blocking_pids(${pid})) as n`);
            return Number(row?.n);
          },
          { timeout: 2000, interval: 10 },
        )
        .toBe(1);
      expect(await entryStatus()).toBe('enriching');
    } finally {
      resume.release();
      await Promise.all([settling, reviving]);
    }
    expect(await entryStatus()).toBe('failed');
    expect((await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) }))?.status).toBe(
      'running',
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('releases the task lock on timeout and refuses a late store mutation after Retry', async () => {
    const entered = barrier();
    const resume = barrier();
    // This is a server-side connection expiry, so it needs a real short deadline.
    // Store discovery deliberately ignores the abort to exercise the mutation's own guard.
    h.timeoutMs = 100;
    h.store = async () => {
      entered.release();
      await resume.wait;
    };
    const settling = reconcile();
    try {
      await entered.wait;
      await settling;
      expect(log.warn).toHaveBeenCalledOnce();
      expect(h.signal?.aborted).toBe(true);
      // A separate pool can update only after PostgreSQL released the task row lock.
      await retry.begin(async (tx) => {
        await tx`set local lock_timeout = '1s'`;
        await tx`update tasks set status = 'running', orchestration_epoch = orchestration_epoch + 1
          where id = ${taskId}`;
      });
    } finally {
      resume.release();
      await settling;
      await h.work?.catch(() => {});
    }
    expect(await entryStatus()).toBe('enriching');
    expect((await db.query.tasks.findFirst({ where: eq(schema.tasks.id, taskId) }))?.status).toBe(
      'running',
    );
  });
});
