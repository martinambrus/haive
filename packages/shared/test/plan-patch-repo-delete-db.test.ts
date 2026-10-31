import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  hasPgCode,
  isLockNotAvailable,
  lockRepositoryTasksKey,
  schema,
  type Database,
} from '@haive/database';
import {
  applyPlanPatch,
  type ApplyPlanPatchOptions,
  type ApplyPlanPatchResult,
} from '../src/plan/apply-patch.js';
import { PlanPatchError } from '../src/plan/errors.js';
import { planNodePath } from '../src/plan/paths.js';

const url = process.env.PLAN_PATCH_REPO_DELETE_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/plan_patch_repo_delete_test'))
  throw new Error(
    'Use a dedicated plan_patch_repo_delete_test database for the plan patch repository delete tests',
  );

// DELETE /repositories/:id takes the repository's creation key, then the repositories row FOR UPDATE, then
// `DELETE FROM repositories`, whose cascade waits for any plan row another transaction holds. A plan patch
// that already holds a node row (an UPDATE or a DELETE of one) and then INSERTs a child (a node, an edge, a
// code link, or a NEW plan_mirror_state row) takes KEY SHARE on the repositories row for that insert's
// foreign key, behind the delete's FOR UPDATE: the delete waits for the patch's row, the patch waits for the
// delete's row (40P01). A patch that inserts first holds KEY SHARE before the delete's FOR UPDATE, so the
// delete waits for it and nothing cycles. An UPDATE of a node or of an existing mirror row takes no KEY SHARE.
//
// The race cases run the real applyPlanPatch with a Proxy over its transaction that awaits a promise before
// the statement named, then runs the untouched builder. The patch runs its writes up to that statement and
// stops. The racer (the delete's lock-relevant statements) then runs until it is blocked by the patch, and the
// stop is lifted. A patch that holds the repositories row before it writes makes the racer wait at its
// FOR UPDATE and both finish; one that does not makes the racer's cascade wait for the patch's row while the
// patch's next insert waits for the racer's row.
//
//   S1     sanity: a test-local writer in each order, so a setup that cannot produce the cycle fails here
//   P1-P3  the patch holds a plan row (update, delete, or none with the mirror row missing) and then needs
//          the repositories row: the delete must wait for the patch, never cycle with it
//   P4     the patch inserts first: the delete waits for it
//   P5     an update-only patch beside a long holder of the repositories row must not wait for it
//   P6     a patch that inserts beside the same holder waits for it and then lands
//   P7     a patch that starts after the delete ends as PlanPatchError repository_gone
const BLIND_INDEX = 'plan-patch-repo-delete-test-user';
const BLOCKED_WITHIN_MS = 10_000;
const GUARD_MS = 20_000;
const TEST_TIMEOUT = 40_000;
const HOLD_MS = 1_500;
const NO_WAIT_MS = 400;
const FOR_UPDATE = 'repositories row FOR UPDATE';
const CASCADE = 'DELETE FROM repositories (cascade)';
const NO_ROWS = {
  repositories: 0,
  planNodes: 0,
  planNodeEdges: 0,
  planNodeCodeLinks: 0,
  planMirrorState: 0,
};

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Hook = (statement: string) => Promise<void>;
type Method = (...args: unknown[]) => unknown;

interface Seeded {
  repositoryId: string;
  root: string;
  a: string;
  aPath: string;
  b: string;
  c: string;
}

interface Race {
  failures: string[];
  /** Whether either side ended with a deadlock (40P01), and Postgres' account of the cycle. */
  deadlocked: boolean;
  cycle: string;
  /** Whether anything held the repositories row while the patch was stopped (the racer had not started). */
  heldAtPause: boolean;
  patchPid: number;
  racerPid: number;
  /** What the racer was doing when it was seen blocked by the patch. */
  racerWaitedIn: string;
  rows: typeof NO_ROWS;
}

const settle = <T>(run: Promise<T>): Promise<Outcome<T>> =>
  run.then(
    (value): Outcome<T> => ({ ok: true, value }),
    (error: unknown): Outcome<T> => ({ ok: false, error }),
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The SQLSTATE of an error or of anything it wraps, with the constraint it names. */
const sqlState = (error: unknown): string | undefined => {
  for (let e: unknown = error, depth = 0; e != null && depth < 5; depth++) {
    const { code, constraint_name: constraint } = e as {
      code?: unknown;
      constraint_name?: unknown;
    };
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      return typeof constraint === 'string' ? `${code} [${constraint}]` : code;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
};

const describeError = (error: unknown): string => {
  if (hasPgCode(error, '40P01')) return 'deadlock detected (40P01)';
  if (error instanceof PlanPatchError) return `PlanPatchError ${error.kind}: ${error.message}`;
  const state = sqlState(error);
  return state ? `pg ${state}` : String(error);
};

/** Postgres' account of the cycle (who waits for whom), from the error or anything it wraps. */
const deadlockDetail = (error: unknown): string | undefined => {
  for (let e: unknown = error, depth = 0; e != null && depth < 5; depth++) {
    const { code, detail } = e as { code?: unknown; detail?: unknown };
    if (code === '40P01' && typeof detail === 'string') return detail.replaceAll('\n', ' | ');
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
};

const describeOutcome = (outcome: Outcome<ApplyPlanPatchResult>): string =>
  outcome.ok
    ? `ok (created ${outcome.value.created.length}, updated ${outcome.value.updated.length}, ` +
      `dropped ${outcome.value.dropped.length})`
    : describeError(outcome.error);

const backendPid = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
  return row!.pid;
};

// ---- the statement gate: a Proxy over the drizzle transaction ------------------------------------------------
const STATEMENT_KINDS = new Set(['select', 'selectDistinct', 'insert', 'update', 'delete']);

/** A query builder that awaits `hook` with its SQL before running, untouched, when it is awaited. */
const gateBuilder = (builder: object, hook: Hook): object =>
  new Proxy(builder, {
    get(target, prop) {
      const member: unknown = Reflect.get(target, prop, target);
      if (typeof member !== 'function') return member;
      if (prop === 'then') {
        return (resolve: Method, reject: Method) => {
          void Promise.resolve()
            .then(() => hook((target as { toSQL(): { sql: string } }).toSQL().sql))
            .then(() => (member as Method).call(target, resolve, reject))
            .catch(reject);
        };
      }
      return (...args: unknown[]) => {
        const out = (member as Method).apply(target, args);
        return typeof out === 'object' && out !== null ? gateBuilder(out, hook) : out;
      };
    },
  });

const gateTx = (tx: Tx, hook: Hook): Tx =>
  new Proxy(tx, {
    get(target, prop) {
      const member: unknown = Reflect.get(target, prop, target);
      if (typeof member !== 'function') return member;
      if (typeof prop === 'string' && STATEMENT_KINDS.has(prop)) {
        return (...args: unknown[]) =>
          gateBuilder((member as Method).apply(target, args) as object, hook);
      }
      return (member as Method).bind(target);
    },
  });

/** The statement of `verb` ("insert into", "update", "delete from") on `table`, as drizzle renders it. */
const statement = (verb: string, table: string) => new RegExp(`^${verb} "?${table}"?(?!\\w)`, 'i');
const insertsNode = statement('insert into', 'plan_nodes');
const updatesNode = statement('update', 'plan_nodes');
const insertsMirror = statement('insert into', 'plan_mirror_state');

const userOptions = (repositoryId: string): ApplyPlanPatchOptions => ({
  repositoryId,
  origin: 'user',
});
// What applyAgentPatch passes: a plan agent's patch drops an op naming a node that is not there.
const agentOptions = (repositoryId: string): ApplyPlanPatchOptions => ({
  repositoryId,
  origin: 'llm',
  onUnresolvableRef: 'drop',
  requireExpectedVersion: true,
  marksReviewed: true,
});

describe.skipIf(!url)('a plan patch beside a repository delete, on Postgres', () => {
  let db: Database;
  let patchDb: Database;
  let peerDb: Database;
  let userId: string;
  let sequence = 0;

  beforeAll(async () => {
    db = createDatabase(url as string);
    patchDb = createDatabase(url as string);
    peerDb = createDatabase(url as string);
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    const [user] = await db
      .insert(schema.users)
      .values({
        emailEncrypted: 'plan-patch-repo-delete-test@test.local',
        emailBlindIndex: BLIND_INDEX,
        passwordHash: randomBytes(16).toString('hex'),
        role: 'user',
      })
      .returning({ id: schema.users.id });
    userId = user!.id;
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.emailBlindIndex, BLIND_INDEX));
    await Promise.all([db, patchDb, peerDb].map((handle) => handle.$client.end({ timeout: 5 })));
  });

  /** A repository with a plan (root with children a, b, c; a carries a code link; an edge a to b) and its
   *  mirror row, written through the patch itself. */
  const seedRepository = async (): Promise<Seeded> => {
    const [repo] = await db
      .insert(schema.repositories)
      .values({ userId, name: `plan-patch-repo-delete-${++sequence}`, source: 'local_path' })
      .returning({ id: schema.repositories.id });
    const repositoryId = repo!.id;
    const built = await applyPlanPatch(
      db,
      {
        ops: [
          { op: 'upsert', nodeRef: 'root', parentRef: null, title: 'root' },
          {
            op: 'upsert',
            nodeRef: 'a',
            parentRef: 'root',
            title: 'A',
            codeLinks: [{ repoPath: 'src/a.ts' }],
          },
          { op: 'upsert', nodeRef: 'b', parentRef: 'root', title: 'B' },
          { op: 'upsert', nodeRef: 'c', parentRef: 'root', title: 'C' },
          { op: 'link', fromRef: 'a', toRef: 'b', kind: 'affects' },
        ],
      },
      userOptions(repositoryId),
    );
    const ref = (name: string) => built.refs[name]!;
    return {
      repositoryId,
      root: ref('root'),
      a: ref('a'),
      aPath: planNodePath(planNodePath(null, ref('root')), ref('a')),
      b: ref('b'),
      c: ref('c'),
    };
  };

  const dropMirrorRow = (repositoryId: string) =>
    db.execute(sql`delete from plan_mirror_state where repository_id = ${repositoryId}`);

  const rowsOf = async (repositoryId: string): Promise<typeof NO_ROWS> => {
    const [row] = await db.execute<typeof NO_ROWS>(sql`
      select (select count(*) from repositories where id = ${repositoryId})::int as "repositories",
             (select count(*) from plan_nodes where repository_id = ${repositoryId})::int as "planNodes",
             (select count(*) from plan_node_edges where repository_id = ${repositoryId})::int as "planNodeEdges",
             (select count(*) from plan_node_code_links where repository_id = ${repositoryId})::int as "planNodeCodeLinks",
             (select count(*) from plan_mirror_state where repository_id = ${repositoryId})::int as "planMirrorState"`);
    return row!;
  };

  /** The delete route's lock-relevant statements: the creation key, the repositories row FOR UPDATE, then the
   *  DELETE whose cascade runs into every plan table. */
  const deleteRepository = async (
    tx: Tx,
    repositoryId: string,
    track: (phase: string) => void = () => undefined,
  ) => {
    const owned = and(
      eq(schema.repositories.id, repositoryId),
      eq(schema.repositories.userId, userId),
    );
    track('creation key');
    await lockRepositoryTasksKey(tx, repositoryId);
    track(FOR_UPDATE);
    await tx
      .select({ id: schema.repositories.id })
      .from(schema.repositories)
      .where(owned)
      .for('update');
    track(CASCADE);
    await tx.delete(schema.repositories).where(owned);
  };

  /** True when some other transaction holds any lock on the repositories row (NOWAIT refuses a KEY SHARE too). */
  const repositoryRowHeld = async (repositoryId: string): Promise<boolean> => {
    try {
      await db.transaction((tx) =>
        tx
          .select({ id: schema.repositories.id })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, repositoryId))
          .for('update', { noWait: true }),
      );
      return false;
    } catch (error) {
      if (isLockNotAvailable(error)) return true;
      throw error;
    }
  };

  /** Returns once `waiter` is blocked by `holder` on a lock; throws when it ended first or never blocked. */
  const untilBlocked = async (
    who: string,
    waiter: () => number,
    holder: () => number,
    endedAs: () => string | undefined,
  ) => {
    const deadline = Date.now() + BLOCKED_WITHIN_MS;
    for (;;) {
      const ended = endedAs();
      if (ended !== undefined) throw new Error(`${who} ended without waiting: ${ended}`);
      const [row] = await db.execute<{ blocked: boolean }>(sql`
        select exists (
          select 1 from pg_stat_activity
          where pid = ${waiter()}::int and wait_event_type = 'Lock'
            and ${holder()}::int = any (pg_blocking_pids(pid))
        ) as blocked`);
      if (row?.blocked) return;
      if (Date.now() > deadline)
        throw new Error(`${who} was not blocked within ${BLOCKED_WITHIN_MS} ms`);
      await sleep(20);
    }
  };

  /** Ends the backends of a race that neither side finished, so a hung case cannot hold locks into the next. */
  const terminate = async (...pids: number[]) => {
    for (const pid of pids) {
      if (pid !== 0) await db.execute(sql`select pg_terminate_backend(${pid}::int)`);
    }
  };

  /**
   * `run` is handed a database whose transaction is gated: its statements run until one matches `pauseBefore`,
   * which waits. The racer then runs until the patch blocks it, and the wait is lifted.
   */
  async function raceDelete(
    ids: Seeded,
    pauseBefore: RegExp,
    run: (gated: Database) => Promise<unknown>,
  ): Promise<Race> {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ran: string[] = [];
    let paused = false;
    let patchPid = 0;
    let racerPid = 0;
    let phase = 'not started';
    let racerWaitedIn = phase;
    let heldAtPause = false;
    let racer: Promise<Outcome<void>> | undefined;
    let racerOutcome: Outcome<void> | undefined;

    const hook: Hook = async (text) => {
      ran.push(text.slice(0, 48));
      if (paused || !pauseBefore.test(text)) return;
      paused = true;
      reached.resolve();
      await release.promise;
    };
    const gated = {
      transaction: (callback: (tx: Tx) => Promise<unknown>) =>
        patchDb.transaction(async (tx) => {
          patchPid = await backendPid(tx);
          return callback(gateTx(tx, hook));
        }),
    } as unknown as Database;

    const patch = settle(run(gated));

    const finish = async () => {
      release.resolve();
      const both = Promise.all([patch, racer ?? Promise.resolve(undefined)]);
      const ended = await Promise.race([both, sleep(GUARD_MS).then(() => undefined)]);
      if (ended) return ended;
      await terminate(patchPid, racerPid);
      await both;
      throw new Error(`neither side finished within ${GUARD_MS} ms; both were ended`);
    };

    try {
      await Promise.race([reached.promise, patch]);
      if (!paused) {
        const early = await patch;
        throw new Error(
          `the patch ended without reaching ${pauseBefore}: ` +
            `${early.ok ? 'no error' : describeError(early.error)}; it ran: ${ran.join(' | ')}`,
        );
      }
      heldAtPause = await repositoryRowHeld(ids.repositoryId);
      racer = settle(
        peerDb.transaction(async (tx) => {
          racerPid = await backendPid(tx);
          await deleteRepository(tx, ids.repositoryId, (next) => (phase = next));
        }),
      );
      void racer.then((outcome) => (racerOutcome = outcome));
      await untilBlocked(
        'the racer',
        () => racerPid,
        () => patchPid,
        () =>
          racerOutcome === undefined
            ? undefined
            : racerOutcome.ok
              ? 'no error'
              : describeError(racerOutcome.error),
      );
      racerWaitedIn = phase;
    } catch (error) {
      await finish().catch(() => undefined);
      throw error;
    }

    const [patchSettled, racerSettled] = await finish();
    return {
      failures: [
        ...(patchSettled.ok ? [] : [`patch: ${describeError(patchSettled.error)}`]),
        ...(racerSettled?.ok === false ? [`racer: ${describeError(racerSettled.error)}`] : []),
      ],
      deadlocked: [patchSettled, racerSettled].some(
        (outcome) => outcome?.ok === false && hasPgCode(outcome.error, '40P01'),
      ),
      cycle:
        [patchSettled, racerSettled]
          .map((outcome) => (outcome?.ok === false ? deadlockDetail(outcome.error) : undefined))
          .find((detail) => detail !== undefined) ?? 'no deadlock',
      patchPid,
      racerPid,
      heldAtPause,
      racerWaitedIn,
      rows: await rowsOf(ids.repositoryId),
    };
  }

  const expectClean = (race: Race) => {
    expect(
      race.failures,
      `while it was stopped the patch ${race.heldAtPause ? 'held' : 'held nothing of'} the repositories row; ` +
        `the racer was waiting in "${race.racerWaitedIn}"; ${race.failures.join('; ') || 'nothing failed'}; ` +
        `patch backend ${race.patchPid}, racer backend ${race.racerPid}: ${race.cycle}`,
    ).toEqual([]);
    expect(race.rows, 'rows left after the delete').toEqual(NO_ROWS);
  };

  /** raceDelete over the real applyPlanPatch with a user's options. */
  const racePatch = (ids: Seeded, pauseBefore: RegExp, patchInput: unknown) =>
    raceDelete(ids, pauseBefore, (gated) =>
      applyPlanPatch(gated, patchInput, userOptions(ids.repositoryId)),
    );

  /** A transaction that holds the repositories row FOR UPDATE until `release`, as a project-state write does. */
  const holdRepositoryRow = (repositoryId: string) => {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const state = { pid: 0, released: false };
    const ended = settle(
      peerDb.transaction(async (tx) => {
        state.pid = await backendPid(tx);
        await tx
          .select({ id: schema.repositories.id })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, repositoryId))
          .for('update');
        held.resolve();
        await release.promise;
        state.released = true;
      }),
    );
    const holding = Promise.race([
      held.promise,
      ended.then((outcome) => {
        throw new Error(
          `the holder ended before it held the row: ${outcome.ok ? 'no error' : describeError(outcome.error)}`,
        );
      }),
    ]);
    return { state, holding, release: release.resolve, ended };
  };

  /** A patch run on the patch connection, whose backend pid is known to the caller. */
  const patchOnOwnConnection = (
    patchInput: unknown,
    options: ApplyPlanPatchOptions,
    pid: { value: number },
  ) =>
    applyPlanPatch(
      {
        transaction: (callback: (tx: Tx) => Promise<ApplyPlanPatchResult>) =>
          patchDb.transaction(async (tx) => {
            pid.value = await backendPid(tx);
            return callback(tx);
          }),
      } as unknown as Database,
      patchInput,
      options,
    );

  describe('S1: the interleave can produce the cycle without applyPlanPatch', () => {
    // A test-local writer: update node a, stop, insert a child of a. With `keyShareFirst` it takes the
    // repositories row KEY SHARE before anything else, as the fix does.
    const localWriter = (ids: Seeded, keyShareFirst: boolean) => (gated: Database) =>
      gated.transaction(async (tx) => {
        if (keyShareFirst) {
          await tx
            .select({ id: schema.repositories.id })
            .from(schema.repositories)
            .where(eq(schema.repositories.id, ids.repositoryId))
            .for('key share');
        }
        await tx
          .update(schema.planNodes)
          .set({ title: 'S1' })
          .where(eq(schema.planNodes.id, ids.a));
        const id = randomUUID();
        await tx.insert(schema.planNodes).values({
          id,
          repositoryId: ids.repositoryId,
          parentId: ids.a,
          path: planNodePath(ids.aPath, id),
          title: 'S1 child',
        });
      });

    it(
      'S1a: a writer that takes the repositories row KEY SHARE first finishes clean beside the delete',
      async () => {
        const ids = await seedRepository();

        const race = await raceDelete(ids, insertsNode, localWriter(ids, true));

        expectClean(race);
        expect(race.racerWaitedIn).toBe(FOR_UPDATE);
      },
      TEST_TIMEOUT,
    );

    it(
      'S1b: a writer that updates a node and only then inserts a child deadlocks with the delete',
      async () => {
        const ids = await seedRepository();

        const race = await raceDelete(ids, insertsNode, localWriter(ids, false));

        expect(race.heldAtPause, 'the writer must hold nothing of the repositories row').toBe(
          false,
        );
        expect(race.racerWaitedIn).toBe(CASCADE);
        expect(
          race.deadlocked,
          `one side must be chosen as the deadlock victim; ${race.failures.join('; ') || 'nothing failed'}`,
        ).toBe(true);
      },
      TEST_TIMEOUT,
    );
  });

  describe('P1-P3: the patch holds a plan row and then needs the repositories row', () => {
    it(
      'P1: updating a node and then creating a child of it, the delete waits for the patch and both finish',
      async () => {
        const ids = await seedRepository();

        const race = await racePatch(ids, insertsNode, {
          ops: [
            { op: 'upsert', nodeRef: ids.a, title: 'A (edited)' },
            { op: 'upsert', nodeRef: 'child', parentRef: ids.a, title: 'A child' },
          ],
        });

        expectClean(race);
      },
      TEST_TIMEOUT,
    );

    it(
      'P2: deleting a leaf and then creating a node, the delete waits for the patch and both finish',
      async () => {
        const ids = await seedRepository();

        const race = await racePatch(ids, insertsNode, {
          ops: [
            { op: 'delete', nodeRef: ids.c },
            { op: 'upsert', nodeRef: 'sibling', parentRef: ids.root, title: 'A sibling' },
          ],
        });

        expectClean(race);
      },
      TEST_TIMEOUT,
    );

    it(
      'P3: updating a node of a plan that has no mirror row, the delete waits for the patch and both finish',
      async () => {
        const ids = await seedRepository();
        await dropMirrorRow(ids.repositoryId);

        const race = await racePatch(ids, insertsMirror, {
          ops: [{ op: 'upsert', nodeRef: ids.a, title: 'A (edited)' }],
        });

        expectClean(race);
      },
      TEST_TIMEOUT,
    );
  });

  describe('P4-P6: orders and waits that are right today and must stay so', () => {
    it(
      'P4: creating a node before updating one, the patch holds the repositories row first and the delete waits for it',
      async () => {
        const ids = await seedRepository();

        const race = await racePatch(ids, updatesNode, {
          ops: [
            { op: 'upsert', nodeRef: 'first', parentRef: ids.root, title: 'Inserted first' },
            { op: 'upsert', nodeRef: ids.a, title: 'A (edited)' },
          ],
        });

        expectClean(race);
        expect(race.racerWaitedIn).toBe(FOR_UPDATE);
      },
      TEST_TIMEOUT,
    );

    it(
      'P5: an update-only patch of a plan with a mirror row does not wait for a holder of the repositories row',
      async () => {
        const ids = await seedRepository();
        const edit = { ops: [{ op: 'upsert', nodeRef: ids.a, title: 'A (edited)' }] };
        // The first run pays for the connection and the first parse; the measured one does not.
        await applyPlanPatch(patchDb, edit, userOptions(ids.repositoryId));
        const holder = holdRepositoryRow(ids.repositoryId);
        const releaseLater = setTimeout(holder.release, HOLD_MS);

        try {
          await holder.holding;
          const startedAt = performance.now();
          const outcome = await settle(
            applyPlanPatch(
              patchDb,
              { ops: [{ op: 'upsert', nodeRef: ids.a, title: 'A (edited twice)' }] },
              userOptions(ids.repositoryId),
            ),
          );
          const tookMs = performance.now() - startedAt;

          expect(describeOutcome(outcome)).toMatch(/^ok /);
          expect(
            holder.state.released,
            'the patch must finish while the holder still holds the row; true means it waited for the holder',
          ).toBe(false);
          expect(tookMs, 'ms the patch took beside a holder of the row').toBeLessThan(NO_WAIT_MS);
        } finally {
          clearTimeout(releaseLater);
          holder.release();
          await holder.ended;
        }

        const node = await db.query.planNodes.findFirst({ where: eq(schema.planNodes.id, ids.a) });
        expect(node?.title).toBe('A (edited twice)');
      },
      TEST_TIMEOUT,
    );

    it(
      'P6: a patch that creates a node waits for a holder of the repositories row and lands when it commits',
      async () => {
        const ids = await seedRepository();
        const holder = holdRepositoryRow(ids.repositoryId);
        const patchPid = { value: 0 };
        let patchEnded: string | undefined;

        try {
          await holder.holding;
          const patch = settle(
            patchOnOwnConnection(
              { ops: [{ op: 'upsert', nodeRef: 'late', parentRef: ids.root, title: 'Late node' }] },
              userOptions(ids.repositoryId),
              patchPid,
            ),
          );
          void patch.then((outcome) => (patchEnded = describeOutcome(outcome)));
          await untilBlocked(
            'the patch',
            () => patchPid.value,
            () => holder.state.pid,
            () => patchEnded,
          );
          holder.release();

          expect(describeOutcome(await patch)).toMatch(/^ok /);
        } finally {
          holder.release();
          const held = await holder.ended;
          expect(held.ok, 'the holder committed').toBe(true);
        }

        const landed = await db.query.planNodes.findMany({
          where: and(
            eq(schema.planNodes.repositoryId, ids.repositoryId),
            eq(schema.planNodes.title, 'Late node'),
          ),
        });
        expect(landed).toHaveLength(1);
        expect((await rowsOf(ids.repositoryId)).repositories).toBe(1);
      },
      TEST_TIMEOUT,
    );
  });

  describe('P7: a patch that starts after the repository was deleted', () => {
    const rootAgain = {
      ops: [{ op: 'upsert', nodeRef: 'again', parentRef: null, title: 'again' }],
    };
    const cases: [string, (ids: Seeded) => unknown, typeof userOptions][] = [
      ['P7a: creating the plan root of a deleted repository', () => rootAgain, userOptions],
      [
        'P7b: creating a node under the plan root of a deleted repository',
        (ids) => ({
          ops: [{ op: 'upsert', nodeRef: 'late', parentRef: ids.root, title: 'Late node' }],
        }),
        userOptions,
      ],
      [
        'P7c: a patch naming a node of a deleted repository',
        (ids) => ({ ops: [{ op: 'upsert', nodeRef: ids.a, title: 'A (edited)' }] }),
        userOptions,
      ],
      [
        'P7d: an agent patch creating the plan root of a deleted repository',
        () => rootAgain,
        agentOptions,
      ],
      [
        'P7e: an agent patch creating a node under the plan root of a deleted repository',
        (ids) => ({
          ops: [{ op: 'upsert', nodeRef: 'late', parentRef: ids.root, title: 'Late node' }],
        }),
        agentOptions,
      ],
    ];

    it.each(cases)(
      '%s is repository_gone',
      async (_name, patchOf, optionsOf) => {
        const ids = await seedRepository();
        await peerDb.transaction((tx) => deleteRepository(tx, ids.repositoryId));
        expect(await rowsOf(ids.repositoryId), 'the delete must have removed the plan').toEqual(
          NO_ROWS,
        );

        const outcome = await settle(applyPlanPatch(db, patchOf(ids), optionsOf(ids.repositoryId)));

        const kind =
          !outcome.ok && outcome.error instanceof PlanPatchError ? outcome.error.kind : undefined;
        expect(
          kind,
          `the patch against the deleted repository ended: ${describeOutcome(outcome)}`,
        ).toBe('repository_gone');
      },
      TEST_TIMEOUT,
    );
  });
});
