import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  hasPgCode,
  lockRepositoryRow,
  lockRepositoryTasksKey,
  schema,
  type Database,
} from '@haive/database';
import { applyPlanPatch, PlanPatchError } from '@haive/shared/plan';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';
import { answerPlanQuestion } from '../src/plan/answer.js';
import { lockPlanMirror } from '../src/plan/mirror.js';

const url = process.env.PLAN_DELETE_CYCLE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/plan_delete_cycle_test'))
  throw new Error('Use a dedicated plan_delete_cycle_test database');
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Method = (...args: unknown[]) => unknown;
const settle = <T>(p: Promise<T>) =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

// Gate the real query builder just before it executes, retaining SQL, parameters and transaction.
function gateBuilder(builder: object, hook: (text: string) => Promise<void>): object {
  return new Proxy(builder, {
    get(target, prop) {
      const member: unknown = Reflect.get(target, prop, target);
      if (typeof member !== 'function') return member;
      if (prop === 'then')
        return (resolve: Method, reject: Method) => {
          void hook((target as { toSQL(): { sql: string } }).toSQL().sql)
            .then(() => (member as Method).call(target, resolve, reject))
            .catch(reject);
        };
      return (...args: unknown[]) => {
        const out = (member as Method).apply(target, args);
        return typeof out === 'object' && out !== null ? gateBuilder(out, hook) : out;
      };
    },
  });
}
function gateTx(tx: Tx, hook: (text: string) => Promise<void>): Tx {
  return new Proxy(tx, {
    get(target, prop) {
      const member: unknown = Reflect.get(target, prop, target);
      if (typeof member !== 'function') return member;
      if (prop === 'transaction')
        return (callback: (nested: Tx) => Promise<unknown>) =>
          target.transaction((nested) => callback(gateTx(nested, hook)));
      if (['select', 'insert', 'update', 'delete'].includes(String(prop)))
        return (...args: unknown[]) =>
          gateBuilder((member as Method).apply(target, args) as object, hook);
      return (member as Method).bind(target);
    },
  });
}

// These test promises synchronize on held locks and pg_blocking_pids, never elapsed sleeps.
// The 10s statement timeout is a cleanup backstop, not the race scheduler.
describe.skipIf(!url)('update-only plan writers beside repository deletion', () => {
  let db: Database;
  let writerDb: Database;
  let deleteDb: Database;
  const userId = randomUUID();
  beforeAll(async () => {
    db = createDatabase(url!);
    writerDb = createDatabase(url!);
    deleteDb = createDatabase(url!);
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
  });
  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await Promise.all([db, writerDb, deleteDb].map((d) => d.$client.end({ timeout: 5 })));
  });
  async function seed() {
    const repositoryId = randomUUID();
    await db
      .insert(schema.repositories)
      .values({ id: repositoryId, userId, name: 'delete-cycle', source: 'blank' });
    const built = await applyPlanPatch(
      db,
      {
        ops: [
          { op: 'upsert', nodeRef: 'root', parentRef: null, title: 'root' },
          { op: 'upsert', nodeRef: 'a', parentRef: 'root', title: 'A' },
          { op: 'upsert', nodeRef: 'b', parentRef: 'root', title: 'B' },
        ],
      },
      { repositoryId, origin: 'user' },
    );
    const nodeId = built.refs.a!;
    const [conflict] = await db
      .insert(schema.projectStateConflicts)
      .values({
        repositoryId,
        unit: `plan/${nodeId}#title`,
        base: { v: 'base' },
        local: { v: 'A' },
        incoming: { v: 'theirs' },
      })
      .returning();
    return { repositoryId, nodeId, conflictId: conflict!.id, otherId: built.refs.b! };
  }
  type Ids = Awaited<ReturnType<typeof seed>>;
  async function pid(tx: Tx) {
    const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    return row!.pid;
  }
  async function untilBlocked(waiter: number, holder: number, ended: () => boolean) {
    const deadline = Date.now() + 8_000;
    for (;;) {
      const [row] = await db.execute<{ blocked: boolean }>(
        sql`select ${holder}::int = any(pg_blocking_pids(${waiter}::int)) as blocked`,
      );
      if (row?.blocked) return;
      if (ended() || Date.now() > deadline) throw new Error('peer did not reach the held lock');
      await setImmediate();
    }
  }
  const write = async (kind: string, tx: Tx, ids: Ids) =>
    kind === 'patch'
      ? applyPlanPatch(
          tx,
          {
            ops: [
              { op: 'upsert', nodeRef: ids.nodeId, title: 'edited' },
              { op: 'upsert', nodeRef: ids.otherId, title: 'also edited' },
            ],
          },
          { repositoryId: ids.repositoryId, origin: 'user' },
        )
      : answerPlanQuestion(tx, { ...ids, userId, answer: 'take_theirs' });

  it.each(['patch', 'answer'])(
    '%s first: delete waits before its cascade, both commit',
    async (kind) => {
      const ids = await seed();
      const paused = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const peerStarted = Promise.withResolvers<number>();
      let writerPid = 0;
      let phase = '';
      let deleteEnded = false;
      let blockedAt = '';
      const writer = settle(
        writerDb.transaction(async (tx) => {
          await tx.execute(sql`set local statement_timeout = '10s'`);
          writerPid = await pid(tx);
          if (kind === 'answer') await lockPlanMirror(tx, ids.repositoryId);
          return write(
            kind,
            gateTx(tx, async (text) => {
              if (!/^(insert into|update) "plan_mirror_state"/.test(text)) return;
              paused.resolve();
              await release.promise;
            }),
            ids,
          );
        }),
      );
      let deletion: ReturnType<typeof settle> | undefined;
      try {
        await Promise.race([
          paused.promise,
          writer.then(() => {
            throw new Error('writer missed its gate');
          }),
        ]);
        deletion = settle(
          deleteDb.transaction(async (tx) => {
            await tx.execute(sql`set local statement_timeout = '10s'`);
            peerStarted.resolve(await pid(tx));
            await lockRepositoryTasksKey(tx, ids.repositoryId);
            phase = 'repository';
            await tx
              .select()
              .from(schema.repositories)
              .where(eq(schema.repositories.id, ids.repositoryId))
              .for('update');
            phase = 'cascade';
            await tx
              .delete(schema.repositories)
              .where(eq(schema.repositories.id, ids.repositoryId));
          }),
        );
        void deletion.then(() => {
          deleteEnded = true;
        });
        await untilBlocked(await peerStarted.promise, writerPid, () => deleteEnded);
        blockedAt = phase;
      } finally {
        release.resolve();
      }
      const results = await Promise.all([writer, deletion]);
      const failures = results.flatMap((r) =>
        r && !r.ok ? [hasPgCode(r.error, '40P01') ? '40P01' : r.error] : [],
      );
      expect(failures, `delete blocked at ${phase}`).toEqual([]);
      expect(blockedAt).toBe('repository');
      expect(phase).toBe('cascade');
      expect(
        await db
          .select()
          .from(schema.repositories)
          .where(eq(schema.repositories.id, ids.repositoryId)),
      ).toEqual([]);
      for (const table of [schema.planNodes, schema.planMirrorState, schema.projectStateConflicts])
        expect(
          await db.select().from(table).where(eq(table.repositoryId, ids.repositoryId)),
        ).toEqual([]);
    },
  );
  it.each(['patch', 'answer'])(
    '%s: a delete holding R causes bounded busy, then a named gone outcome',
    async (kind) => {
      const ids = await seed();
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const deletion = deleteDb.transaction(async (tx) => {
        await lockRepositoryTasksKey(tx, ids.repositoryId);
        await tx
          .select()
          .from(schema.repositories)
          .where(eq(schema.repositories.id, ids.repositoryId))
          .for('update');
        held.resolve();
        await release.promise;
        await tx.delete(schema.repositories).where(eq(schema.repositories.id, ids.repositoryId));
      });
      try {
        await held.promise;
        const result = await settle(writerDb.transaction((tx) => write(kind, tx, ids)));
        expect(result).toMatchObject({ ok: false, error: { kind: 'busy' } });
        if (!result.ok) expect(result.error).toBeInstanceOf(PlanPatchError);
        // Refusal happens with the delete STILL holding R. No partial write survives it.
        const [node] = await db
          .select()
          .from(schema.planNodes)
          .where(eq(schema.planNodes.id, ids.nodeId));
        const [question] = await db
          .select()
          .from(schema.projectStateConflicts)
          .where(eq(schema.projectStateConflicts.id, ids.conflictId));
        const [mirror] = await db
          .select()
          .from(schema.planMirrorState)
          .where(eq(schema.planMirrorState.repositoryId, ids.repositoryId));
        expect(node).toMatchObject({ title: 'A', version: 1 });
        expect(question).toMatchObject({ resolution: null, resolvedAt: null });
        expect(mirror?.revision).toBe(1);
      } finally {
        release.resolve();
        await deletion;
      }
      const gone = await settle(writerDb.transaction((tx) => write(kind, tx, ids)));
      if (kind === 'patch')
        expect(gone).toMatchObject({ ok: false, error: { kind: 'repository_gone' } });
      else expect(gone).toMatchObject({ ok: true, value: { kind: 'not_found' } });
    },
  );

  it('bounds the mining-claim -> repository inversion against onboarding Retry and rolls the claim back', async () => {
    const ids = await seed();
    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        repositoryId: ids.repositoryId,
        type: 'onboarding',
        title: 'retry',
        status: 'failed',
      })
      .returning();
    const [step] = await db
      .insert(schema.taskSteps)
      .values({ taskId: task!.id, stepId: '10_8-plan-build', stepIndex: 14.5, title: 'plan' })
      .returning();
    const [mining] = await db
      .insert(schema.taskStepAgentMinings)
      .values({ taskStepId: step!.id, agentId: 'planner', status: 'done' })
      .returning();
    const claimed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const peerStarted = Promise.withResolvers<number>();
    let writerPid = 0;
    let peerEnded = false;
    const writer = settle(
      writerDb.transaction(async (tx) => {
        writerPid = await pid(tx);
        await tx
          .update(schema.taskStepAgentMinings)
          .set({ consumedAt: new Date() })
          .where(eq(schema.taskStepAgentMinings.id, mining!.id));
        claimed.resolve();
        await release.promise;
        return write('patch', tx, ids);
      }),
    );
    await claimed.promise;
    const rollback = new Error('test-only Retry rollback');
    const peer = settle(
      deleteDb.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '10s'`);
        await lockRepositoryRow(tx, ids.repositoryId);
        peerStarted.resolve(await pid(tx));
        await tx
          .delete(schema.taskStepAgentMinings)
          .where(eq(schema.taskStepAgentMinings.id, mining!.id));
        throw rollback;
      }),
    );
    void peer.then(() => {
      peerEnded = true;
    });
    try {
      await untilBlocked(await peerStarted.promise, writerPid, () => peerEnded);
    } finally {
      release.resolve();
    }
    const [result, retried] = await Promise.all([writer, peer]);
    expect(result).toMatchObject({ ok: false, error: { kind: 'busy' } });
    expect(retried).toMatchObject({ ok: false, error: rollback });
    const [row] = await db
      .select()
      .from(schema.taskStepAgentMinings)
      .where(eq(schema.taskStepAgentMinings.id, mining!.id));
    expect(row?.consumedAt).toBeNull();
    const [node] = await db
      .select()
      .from(schema.planNodes)
      .where(eq(schema.planNodes.id, ids.nodeId));
    expect(node).toMatchObject({ title: 'A', version: 1 });
  });
  it('the production answer caller returns coded busy after rolling back its bounded wait', async () => {
    const ids = await seed();
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = deleteDb.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.repositories)
        .where(eq(schema.repositories.id, ids.repositoryId))
        .for('update');
      held.resolve();
      await release.promise;
    });
    try {
      await held.promise;
      expect(
        await resolveProjectStateConflict(writerDb, { ...ids, userId, answer: 'take_theirs' }),
      ).toEqual({ kind: 'busy' });
      const [question] = await db
        .select()
        .from(schema.projectStateConflicts)
        .where(eq(schema.projectStateConflicts.id, ids.conflictId));
      expect(question?.resolvedAt).toBeNull();
    } finally {
      release.resolve();
      await holder;
    }
  });
});
