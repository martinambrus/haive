import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabase, hasPgCode, schema, type Database } from '@haive/database';
import { HAIVE_DATA_FILES, logger } from '@haive/shared';
import * as fsSafe from '@haive/shared/fs-safe';
import { applyPlanPatch, lockPlanPatch, markPlanMirrorDirty } from '@haive/shared/plan';
import {
  writePlanMirror,
  reconcilePlanFromCheckout,
  importPlanMirror,
  PlanMirrorHeldError,
} from '../src/plan/mirror.js';
import * as gitExec from '../src/repo/git-exec.js';
import { readNamedCheckout } from '../src/repo/checkout-head.js';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));

const { sweepDirtyPlanMirrors } = await import('../src/queues/plan-mirror-queue.js');

const url = process.env.GONE_CHECKOUT_PLAN_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/gone_checkout_plan_test')) {
  throw new Error('Use a dedicated gone_checkout_plan_test database for the gone-checkout test');
}

// A retry that fails logs a long line each time; the spy below still records the call.
vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
});

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@local',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@local',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' });

describe.skipIf(!url)('the plan sweep when a checkout directory is gone', () => {
  let db: Database;
  let root: string;
  const users: string[] = [];

  beforeAll(async () => {
    db = createDatabase(url!);
    h.db = db;
    root = await mkdtemp(join(tmpdir(), 'gone-checkout-plan-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of users.splice(0)) await db.delete(schema.users).where(eq(schema.users.id, id));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await db.$client.end({ timeout: 5 });
  });

  /** A repository whose mirror row is dirty (revision 1, nothing written) and whose directory does
   *  not exist: a plan of two nodes, or none at all. */
  async function dirtyRepository(opts: { plan: boolean; updatedAt: Date }) {
    const userId = randomUUID();
    users.push(userId);
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
    const storagePath = join(root, userId);
    const [repo] = await db
      .insert(schema.repositories)
      .values({ userId, name: 'gone-checkout', source: 'blank', storagePath })
      .returning({ id: schema.repositories.id });
    const repositoryId = repo!.id;
    if (opts.plan) {
      await applyPlanPatch(
        db,
        {
          ops: [
            { op: 'upsert', nodeRef: 'root', parentRef: null, title: 'Product' },
            { op: 'upsert', nodeRef: 'a', parentRef: 'root', title: 'A' },
          ],
        },
        { repositoryId, origin: 'llm' },
      );
    } else {
      await markPlanMirrorDirty(db, repositoryId);
    }
    await db
      .update(schema.planMirrorState)
      .set({ updatedAt: opts.updatedAt })
      .where(eq(schema.planMirrorState.repositoryId, repositoryId));
    return { id: repositoryId, path: storagePath };
  }

  async function createCheckout(dir: string) {
    await mkdir(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '--allow-empty', '-qm', 'initial');
  }

  const mirror = async (repositoryId: string) =>
    (
      await db
        .select()
        .from(schema.planMirrorState)
        .where(eq(schema.planMirrorState.repositoryId, repositoryId))
    )[0];

  it('flushes a 4106-node plan while another connection holds P without recording a snapshot error', async () => {
    const repo = await dirtyRepository({ plan: true, updatedAt: new Date() });
    await createCheckout(repo.path);
    const [rootNode] = await db
      .select()
      .from(schema.planNodes)
      .where(eq(schema.planNodes.repositoryId, repo.id))
      .orderBy(schema.planNodes.path)
      .limit(1);
    await db.insert(schema.planNodes).values(
      Array.from({ length: 4104 }, (_, i) => {
        const id = randomUUID();
        return {
          id,
          repositoryId: repo.id,
          parentId: rootNode!.id,
          path: `${rootNode!.path}${id}/`,
          title: `Component ${i}`,
          ordinal: i + 1,
        };
      }),
    );
    const peer = createDatabase(url!);
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = peer.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`plan-patch:${repo.id}`}, 0))`,
      );
      holding.resolve();
      await release.promise;
    });
    try {
      await holding.promise;
      expect(await writePlanMirror(db, repo.id, repo.path)).toContain(HAIVE_DATA_FILES.plan);
      expect((await mirror(repo.id))!.lastError).toBeNull();
      const file = JSON.parse(await readFile(join(repo.path, HAIVE_DATA_FILES.plan), 'utf8'));
      expect(file.nodes).toHaveLength(4106);
    } finally {
      release.resolve();
      await holder;
      await peer.$client.end({ timeout: 5 });
    }
  });

  type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
  type Method = (...args: unknown[]) => unknown;

  // Pause real statements rather than relying on the relative speed of two connections.
  function observeStatements(database: Database, before: (text: string) => Promise<void>) {
    let pid = 0;
    const dialect = new PgDialect();
    const builder = (query: object): object =>
      new Proxy(query, {
        get(target, key) {
          const member = Reflect.get(target, key, target);
          if (typeof member !== 'function') return member;
          if (key === 'then')
            return (resolve: Method, reject: Method) =>
              Promise.resolve()
                .then(() => before((target as { toSQL(): { sql: string } }).toSQL().sql))
                .then(() => member.call(target, resolve, reject))
                .catch(reject);
          return (...args: unknown[]) => {
            const next = member.apply(target, args);
            return next && typeof next === 'object' ? builder(next) : next;
          };
        },
      });
    const transaction = (tx: Tx): Tx =>
      new Proxy(tx, {
        get(target, key) {
          const member = Reflect.get(target, key, target);
          if (key === 'transaction')
            return (callback: (nested: Tx) => Promise<unknown>) =>
              target.transaction((nested) => callback(transaction(nested)));
          if (key === 'execute')
            return async (query: Parameters<Tx['execute']>[0]) => {
              await before(dialect.sqlToQuery(query as ReturnType<typeof sql>).sql);
              return target.execute(query);
            };
          if (['select', 'insert', 'update', 'delete'].includes(String(key)))
            return (...args: unknown[]) => builder(member.apply(target, args));
          return typeof member === 'function' ? member.bind(target) : member;
        },
      });
    const wrapped = new Proxy(database, {
      get(target, key) {
        if (key !== 'transaction') return Reflect.get(target, key, target);
        return (
          callback: (tx: Tx) => Promise<unknown>,
          options?: Parameters<Database['transaction']>[1],
        ) =>
          target.transaction(async (tx) => {
            const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
            pid = row!.pid;
            return callback(transaction(tx));
          }, options);
      },
    });
    return { db: wrapped, pid: () => pid };
  }

  const settle = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

  async function waitForBlock(waiter: () => number, holder: () => number) {
    // Time bounds only a broken fixture; pg_blocking_pids establishes the ordering.
    await vi.waitFor(
      async () => {
        const [row] = await db.execute<{ blocked: boolean }>(sql`
        select ${holder()}::int = any(pg_blocking_pids(${waiter()}::int)) as blocked
      `);
        expect(row?.blocked).toBe(true);
      },
      { timeout: 5_000, interval: 10 },
    );
  }

  it.each([true, false])(
    'does not deadlock a question convergence against a patch (base present: %s)',
    async (hasBase) => {
      const repo = await dirtyRepository({ plan: true, updatedAt: new Date() });
      await createCheckout(repo.path);
      await writePlanMirror(db, repo.id, repo.path);
      const snapshot = JSON.parse(await readFile(join(repo.path, HAIVE_DATA_FILES.plan), 'utf8'));
      if (hasBase)
        await db
          .update(schema.planMirrorState)
          .set({ syncedSnapshot: snapshot })
          .where(eq(schema.planMirrorState.repositoryId, repo.id));
      const node = snapshot.nodes.find((n: { parentId: string | null }) => n.parentId === null);
      await db.insert(schema.projectStateConflicts).values({
        repositoryId: repo.id,
        unit: `plan/${node.id}#title`,
        base: { v: 'Base' },
        local: { v: node.title },
        incoming: { v: 'Converged' },
      });
      const peer = createDatabase(url!);
      const patchAtOutbox = Promise.withResolvers<void>();
      const releasePatch = Promise.withResolvers<void>();
      const patchDb = observeStatements(peer, async (text) => {
        if (/^insert into "plan_mirror_state"/.test(text)) {
          patchAtOutbox.resolve();
          await releasePatch.promise;
        }
      });
      const patch = settle(
        applyPlanPatch(
          patchDb.db,
          {
            ops: [{ op: 'upsert', nodeRef: node.id, title: 'Converged' }],
          },
          { repositoryId: repo.id, origin: 'user' },
        ),
      );
      let flush: ReturnType<typeof settle<string[]>> | undefined;
      const flushing = observeStatements(db, async () => {});
      try {
        await patchAtOutbox.promise; // The patch owns the asked node, but not the outbox.
        flush = settle(writePlanMirror(flushing.db, repo.id, repo.path));
        await waitForBlock(flushing.pid, patchDb.pid); // Convergence is waiting on that node.
      } finally {
        releasePatch.resolve();
        const outcomes = await Promise.all([patch, flush]);
        await peer.$client.end({ timeout: 5 });
        for (const outcome of outcomes) {
          if (!outcome) continue;
          if (!outcome.ok)
            expect(hasPgCode(outcome.error, '40P01'), String(outcome.error)).toBe(false);
          expect(outcome.ok, outcome.ok ? '' : String(outcome.error)).toBe(true);
        }
      }
      const [question] = await db
        .select()
        .from(schema.projectStateConflicts)
        .where(eq(schema.projectStateConflicts.repositoryId, repo.id));
      expect(question!.resolution).toBe('converged');
      await writePlanMirror(db, repo.id, repo.path);
      expect((await mirror(repo.id))!.lastError).toBeNull();
    },
  );

  it('lets a peer flush wait for the mirror lock without leaving an error on the clean row', async () => {
    const repo = await dirtyRepository({ plan: true, updatedAt: new Date() });
    await createCheckout(repo.path);
    const atStamp = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let paused = false;
    const first = observeStatements(db, async (text) => {
      if (!paused && /^update "plan_mirror_state"/.test(text)) {
        paused = true;
        atStamp.resolve();
        await release.promise;
      }
    });
    const peer = createDatabase(url!);
    const second = observeStatements(peer, async () => {});
    const winner = settle(writePlanMirror(first.db, repo.id, repo.path));
    let waiter: ReturnType<typeof settle<string[]>> | undefined;
    try {
      await atStamp.promise;
      waiter = settle(writePlanMirror(second.db, repo.id, repo.path));
      await waitForBlock(second.pid, first.pid);
    } finally {
      release.resolve();
      const outcomes = await Promise.all([winner, waiter]);
      await peer.$client.end({ timeout: 5 });
      const state = (await mirror(repo.id))!;
      expect(state.writtenRevision).toBe(state.revision);
      expect(state.lastError).toBeNull();
      for (const outcome of outcomes) expect(outcome?.ok).toBe(true);
    }
  });

  it('commits a patch while the flush is held after render and before its stamp', async () => {
    const repo = await dirtyRepository({ plan: true, updatedAt: new Date() });
    await createCheckout(repo.path);
    const atStamp = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let paused = false;
    const flushing = observeStatements(db, async (text) => {
      if (!paused && /^update "plan_mirror_state"/.test(text)) {
        paused = true;
        atStamp.resolve();
        await release.promise;
      }
    });
    const peer = createDatabase(url!);
    const flush = settle(writePlanMirror(flushing.db, repo.id, repo.path));
    try {
      await atStamp.promise;
      const onDisk = JSON.parse(await readFile(join(repo.path, HAIVE_DATA_FILES.plan), 'utf8'));
      const node = onDisk.nodes[0];
      // A bound prevents a regression from hanging while this test deliberately holds the flush.
      await peer.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
        await applyPlanPatch(
          tx,
          {
            ops: [{ op: 'upsert', nodeRef: node.id, title: 'Committed during flush' }],
          },
          { repositoryId: repo.id, origin: 'user' },
        );
      });
      expect(
        (await peer.query.planNodes.findFirst({
          where: eq(schema.planNodes.id, node.id),
        }))!.title,
      ).toBe('Committed during flush');
    } finally {
      release.resolve();
      expect((await flush).ok).toBe(true);
      await peer.$client.end({ timeout: 5 });
    }
    const state = (await mirror(repo.id))!;
    expect(state.writtenRevision).toBeLessThan(state.revision);
    await writePlanMirror(db, repo.id, repo.path);
    const file = JSON.parse(await readFile(join(repo.path, HAIVE_DATA_FILES.plan), 'utf8'));
    expect(file.nodes[0].title).toBe('Committed during flush');
    expect((await mirror(repo.id))!.writtenRevision).toBe((await mirror(repo.id))!.revision);
  });

  async function incomingRepo() {
    const repo = await dirtyRepository({ plan: true, updatedAt: new Date() });
    await createCheckout(repo.path);
    await db
      .update(schema.repositories)
      .set({ status: 'ready' })
      .where(eq(schema.repositories.id, repo.id));
    await writePlanMirror(db, repo.id, repo.path);
    const file = join(repo.path, HAIVE_DATA_FILES.plan);
    const incoming = JSON.parse(await readFile(file, 'utf8'));
    incoming.nodes[0].title = 'Incoming product';
    await writeFile(file, JSON.stringify(incoming));
    return repo;
  }

  async function emptyIncomingRepo() {
    const repo = await dirtyRepository({ plan: false, updatedAt: new Date() });
    await createCheckout(repo.path);
    await db
      .update(schema.repositories)
      .set({ status: 'ready' })
      .where(eq(schema.repositories.id, repo.id));
    await mkdir(join(repo.path, '.haive-data'), { recursive: true });
    await writeFile(
      join(repo.path, HAIVE_DATA_FILES.plan),
      JSON.stringify({
        schemaVersion: 2,
        nodes: [
          {
            id: randomUUID(),
            parentId: null,
            ordinal: 0,
            title: 'Imported',
            kind: 'component',
            body: null,
            status: 'todo',
            taskable: false,
          },
        ],
        edges: [],
        codeLinks: [],
      }),
    );
    return repo;
  }

  it.each(['reconcile', 'import'] as const)(
    'rolls back %s writes when plan.json changes during the database apply',
    async (mode) => {
      const repo = mode === 'reconcile' ? await incomingRepo() : await emptyIncomingRepo();
      const expectedCheckout = (await readNamedCheckout(repo.path))!;
      const beforeNodes = await db
        .select()
        .from(schema.planNodes)
        .where(eq(schema.planNodes.repositoryId, repo.id));
      const beforeState = await mirror(repo.id);
      let moved = false;
      const observed = observeStatements(db, async (text) => {
        // Both paths have written their nodes before they stamp the mirror.
        if (!moved && /^insert into "plan_mirror_state"/.test(text)) {
          moved = true;
          const file = join(repo.path, HAIVE_DATA_FILES.plan);
          const incoming = JSON.parse(await readFile(file, 'utf8'));
          incoming.nodes[0].title = 'Checkout moved during apply';
          await writeFile(file, JSON.stringify(incoming));
        }
      });
      const applied =
        mode === 'reconcile'
          ? reconcilePlanFromCheckout(observed.db, repo.id, repo.path, { expectedCheckout })
          : importPlanMirror(observed.db, repo.id, repo.path, expectedCheckout);
      await expect(applied).rejects.toMatchObject({
        name: 'PlanMirrorHeldError',
        code: 'checkout_changed',
      });
      expect(moved).toBe(true);
      expect(
        await db.select().from(schema.planNodes).where(eq(schema.planNodes.repositoryId, repo.id)),
      ).toEqual(beforeNodes);
      expect(await mirror(repo.id)).toEqual(beforeState);
    },
  );

  it('defers an import as held when another connection owns P', async () => {
    const repo = await emptyIncomingRepo();
    const peer = createDatabase(url!);
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = peer.transaction(async (tx) => {
      await lockPlanPatch(tx, repo.id);
      holding.resolve();
      await release.promise;
    });
    try {
      await holding.promise;
      await expect(importPlanMirror(db, repo.id, repo.path)).rejects.toBeInstanceOf(
        PlanMirrorHeldError,
      );
      expect(
        await db.query.planNodes.findFirst({
          where: eq(schema.planNodes.repositoryId, repo.id),
        }),
      ).toBeUndefined();
      expect((await mirror(repo.id))!.lastError).toBeNull();
    } finally {
      release.resolve();
      await holder;
      await peer.$client.end({ timeout: 5 });
    }
  });

  function observePatchLock(beforeLock?: () => Promise<void>) {
    let held = false;
    let locks = 0;
    const dialect = new PgDialect();
    const wrapped = new Proxy(db, {
      get(target, prop) {
        if (prop !== 'transaction') return Reflect.get(target, prop, target);
        return (callback: (tx: unknown) => Promise<unknown>) =>
          target.transaction(async (tx) => {
            try {
              return await callback(
                new Proxy(tx, {
                  get(transaction, key) {
                    if (key !== 'execute') return Reflect.get(transaction, key, transaction);
                    return async (query: Parameters<typeof tx.execute>[0]) => {
                      const compiled = dialect.sqlToQuery(query as ReturnType<typeof sql>);
                      const patchLock = compiled.params.some(
                        (p) => typeof p === 'string' && p.startsWith('plan-patch:'),
                      );
                      if (patchLock) await beforeLock?.();
                      const result = await tx.execute(query);
                      if (patchLock) {
                        held = true;
                        locks++;
                      }
                      return result;
                    };
                  },
                }),
              );
            } finally {
              held = false;
            }
          });
      },
    });
    return { db: wrapped, held: () => held, locks: () => locks };
  }

  it('does reconcile preparation before P and only rechecks the checkout after its writes', async () => {
    const repo = await incomingRepo();
    const expectedCheckout = await readNamedCheckout(repo.path);
    const observed = observePatchLock();
    let applied = false;
    let rechecks = 0;
    const writes = observeStatements(observed.db, async (text) => {
      if (/^insert into "plan_mirror_state"/.test(text)) applied = true;
    });
    const run = gitExec.gitRun;
    const git = vi.spyOn(gitExec, 'gitRun').mockImplementation(async (...args) => {
      if (observed.held()) {
        expect(applied, 'git inside P must be the final checkout guard').toBe(true);
        rechecks++;
      }
      return run(...args);
    });
    await reconcilePlanFromCheckout(writes.db, repo.id, repo.path, {
      expectedCheckout: expectedCheckout!,
    });
    expect(git).toHaveBeenCalled();
    expect(rechecks).toBeGreaterThan(0);
    expect(observed.locks()).toBe(1);
    const nodes = await db
      .select()
      .from(schema.planNodes)
      .where(eq(schema.planNodes.repositoryId, repo.id));
    expect(nodes.find((n) => n.parentId === null)!.title).toBe('Incoming product');
  });

  it('holds a reconcile when the plan changes between its preparation and P', async () => {
    const repo = await incomingRepo();
    const [node] = await db
      .select()
      .from(schema.planNodes)
      .where(eq(schema.planNodes.repositoryId, repo.id))
      .limit(1);
    const observed = observePatchLock(async () => {
      await applyPlanPatch(
        db,
        { ops: [{ op: 'upsert', nodeRef: node!.id, status: 'done' }] },
        { repositoryId: repo.id, origin: 'user' },
      );
    });
    await expect(reconcilePlanFromCheckout(observed.db, repo.id, repo.path)).rejects.toBeInstanceOf(
      PlanMirrorHeldError,
    );
    expect((await mirror(repo.id))!.revision).toBeGreaterThan(
      (await mirror(repo.id))!.writtenRevision,
    );
  });

  it('commits an automatic reconcile before the flush writes files', async () => {
    const repo = await incomingRepo();
    const observed = observePatchLock();
    const write = fsSafe.writeFileNoFollow;
    const rewrite = fsSafe.rewriteFileIfNoFollow;
    vi.spyOn(fsSafe, 'writeFileNoFollow').mockImplementation((...args) => {
      expect(observed.held(), 'flush wrote a file while reconcile held P').toBe(false);
      return write(...args);
    });
    vi.spyOn(fsSafe, 'rewriteFileIfNoFollow').mockImplementation((...args) => {
      expect(observed.held(), 'flush rewrote a file while reconcile held P').toBe(false);
      return rewrite(...args);
    });
    await writePlanMirror(observed.db, repo.id, repo.path);
    expect(observed.locks()).toBe(1);
    expect((await mirror(repo.id))!.lastError).toBeNull();
  });

  it('defers an automatic reconcile as a held flush when P is already held', async () => {
    const repo = await incomingRepo();
    const peer = createDatabase(url!);
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = peer.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`plan-patch:${repo.id}`}, 0))`,
      );
      holding.resolve();
      await release.promise;
    });
    try {
      await holding.promise;
      await expect(writePlanMirror(db, repo.id, repo.path)).rejects.toBeInstanceOf(
        PlanMirrorHeldError,
      );
      expect((await mirror(repo.id))!.lastError).not.toContain('plan is busy');
    } finally {
      release.resolve();
      await holder;
      await peer.$client.end({ timeout: 5 });
    }
    await expect(writePlanMirror(db, repo.id, repo.path)).resolves.toContain(HAIVE_DATA_FILES.plan);
  });

  it('holds a dirty row whose directory was never created: no warning, still dirty, a reason stored', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const gone = await dirtyRepository({ plan: true, updatedAt: new Date() });

    expect(await sweepDirtyPlanMirrors()).toBe(0);

    expect(warn).not.toHaveBeenCalled();
    const row = await mirror(gone.id);
    expect(row!.revision).toBe(1);
    expect(row!.writtenRevision).toBe(0);
    expect(row!.lastError).not.toBeNull();
  });

  it('writes the plan on the next tick once the checkout is back at the same path', async () => {
    const gone = await dirtyRepository({ plan: true, updatedAt: new Date() });
    expect(await sweepDirtyPlanMirrors()).toBe(0);

    await createCheckout(gone.path);

    expect(await sweepDirtyPlanMirrors()).toBe(1);
    const row = await mirror(gone.id);
    expect(row!.writtenRevision).toBe(row!.revision);
    expect(row!.lastError).toBeNull();
    expect((await stat(join(gone.path, HAIVE_DATA_FILES.plan))).isFile()).toBe(true);
    expect((await stat(join(gone.path, HAIVE_DATA_FILES.planMarkdown))).isFile()).toBe(true);
  });

  it('still retires a dirty row with no plan whose directory is gone, without a warning', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const gone = await dirtyRepository({ plan: false, updatedAt: new Date() });

    expect(await sweepDirtyPlanMirrors()).toBe(1);

    expect(warn).not.toHaveBeenCalled();
    const row = await mirror(gone.id);
    expect(row!.writtenRevision).toBe(row!.revision);
  });

  it('writes the live row of the same tick and leaves the gone row dirty', async () => {
    const gone = await dirtyRepository({ plan: true, updatedAt: new Date(Date.now() - 60_000) });
    const live = await dirtyRepository({ plan: true, updatedAt: new Date() });
    await createCheckout(live.path);

    expect(await sweepDirtyPlanMirrors()).toBe(1);

    const liveRow = await mirror(live.id);
    expect(liveRow!.writtenRevision).toBe(liveRow!.revision);
    expect((await stat(join(live.path, HAIVE_DATA_FILES.plan))).isFile()).toBe(true);
    const goneRow = await mirror(gone.id);
    expect(goneRow!.writtenRevision).toBeLessThan(goneRow!.revision);
  });

  it('removes the mirror row with its repository', async () => {
    const gone = await dirtyRepository({ plan: true, updatedAt: new Date() });
    expect(await mirror(gone.id)).toBeDefined();

    await db.delete(schema.repositories).where(eq(schema.repositories.id, gone.id));

    expect(await mirror(gone.id)).toBeUndefined();
  });
});
