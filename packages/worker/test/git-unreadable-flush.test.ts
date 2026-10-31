import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { HAIVE_DATA_FILES, logger } from '@haive/shared';
import { markPlanMirrorDirty } from '@haive/shared/plan';
import { failGit, type FakeGit } from './support/fake-git.js';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));

const { writePlanMirror } = await import('../src/plan/mirror.js');
const { sweepDirtyPlanMirrors } = await import('../src/queues/plan-mirror-queue.js');

const USER = '00000000-0000-4000-8000-0000000000a1';

const dirs: string[] = [];
let shim: FakeGit | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  await shim?.restore();
  shim = null;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

type Conn = Record<string | symbol, unknown> & {
  select: (cols?: Record<string, unknown>) => unknown;
  transaction: (fn: (tx: Conn) => Promise<unknown>) => Promise<unknown>;
};

function mapRows(builder: unknown, map: (row: Record<string, unknown>) => unknown): unknown {
  return new Proxy(builder as object, {
    get(target, prop) {
      if (prop === 'then') {
        return (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) =>
          (target as Promise<Record<string, unknown>[]>)
            .then((rows) => rows.map(map))
            .then(ok, bad);
      }
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        mapRows((value as (...a: unknown[]) => unknown).apply(target, args), map);
    },
  });
}

const empty = (): unknown =>
  new Proxy(Promise.resolve([]) as object, {
    get(target, prop) {
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value === 'function') return value.bind(target);
      return () => empty();
    },
  });

function withHasBase(conn: Conn): Conn {
  return new Proxy(conn, {
    get(target, prop) {
      if (prop === 'select') {
        return (cols?: Record<string, unknown>) => {
          if (!cols) {
            return {
              from: (table: unknown) =>
                table === schema.projectStateConflicts
                  ? empty()
                  : (target.select() as { from: (t: unknown) => unknown }).from(table),
            };
          }
          if (!('hasBase' in cols)) return target.select(cols);
          const { hasBase: _hasBase, ...rest } = cols;
          return mapRows(
            target.select({ ...rest, snapshot: schema.planMirrorState.syncedSnapshot }),
            ({ snapshot, ...row }) => ({ ...row, hasBase: snapshot != null }),
          );
        };
      }
      if (prop === 'transaction') {
        return (fn: (tx: Conn) => Promise<unknown>) =>
          target.transaction((tx) => fn(withHasBase(tx)));
      }
      return target[prop];
    },
  });
}

const FIRST = '00000000-0000-4000-8000-0000000000b1';
const SECOND = '00000000-0000-4000-8000-0000000000b2';

async function checkout(opts: { git: boolean }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'unreadable-flush-'));
  dirs.push(dir);
  if (opts.git) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: dir });
  }
  return dir;
}

const openMerge = (dir: string) =>
  writeFile(path.join(dir, '.git', 'MERGE_HEAD'), `${'0'.repeat(40)}\n`);

/** The dirty-row query compares two columns, which the fake database does not evaluate. */
function sweepOf(conn: Conn, fake: ReturnType<typeof createFakeDb>): Conn {
  return new Proxy(conn, {
    get(target, prop) {
      if (prop !== 'select') return target[prop];
      return (cols?: Record<string, unknown>) => {
        const select = target.select(cols) as { from: (t: unknown) => unknown };
        if (!cols || Object.keys(cols).join() !== 'repositoryId') return select;
        return {
          from: (table: unknown) =>
            table === schema.planMirrorState
              ? {
                  where: () => ({
                    orderBy: () => ({
                      limit: async () =>
                        fake
                          .rows(schema.planMirrorState)
                          .filter((r) => (r.writtenRevision as number) < (r.revision as number))
                          .sort(
                            (a, b) =>
                              ((a.updatedAt as Date | null)?.getTime() ?? 0) -
                              ((b.updatedAt as Date | null)?.getTime() ?? 0),
                          )
                          .map((r) => ({ repositoryId: r.repositoryId })),
                    }),
                  }),
                }
              : select.from(table),
        };
      };
    },
  });
}

function setup(ids: string[], paths: string[]) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    planNodes: schema.planNodes,
    planMirrorState: schema.planMirrorState,
    planNodeEdges: schema.planNodeEdges,
    planNodeCodeLinks: schema.planNodeCodeLinks,
    projectStateConflicts: schema.projectStateConflicts,
  });
  ids.forEach((id, i) => {
    const node = `00000000-0000-4000-8000-0000000000c${i + 1}`;
    fake.insert(schema.repositories, {
      id,
      userId: USER,
      name: `repo-${i}`,
      source: 'blank',
      status: 'ready',
      storagePath: paths[i],
    });
    fake.insert(schema.planNodes, {
      id: node,
      repositoryId: id,
      parentId: null,
      path: `/${node}/`,
      ordinal: 0,
      title: 'Shop',
      kind: 'component',
      status: 'todo',
      taskable: false,
    });
    fake.insert(schema.planMirrorState, {
      repositoryId: id,
      revision: 1,
      writtenRevision: 0,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    });
  });
  const db = sweepOf(withHasBase(fake.db as unknown as Conn), fake);
  h.db = db;
  const state = (id: string) =>
    fake.rows(schema.planMirrorState).find((row) => row.repositoryId === id)!;
  return { db: db as unknown as Database, state };
}

const planJson = (dir: string) => path.join(dir, HAIVE_DATA_FILES.plan);
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

describe('a plan flush when git cannot be read', () => {
  it('rejects, leaves plan.json as it was and keeps the row dirty with git text', async () => {
    const dir = await checkout({ git: true });
    const { db, state } = setup([FIRST], [dir]);
    await writePlanMirror(db, FIRST, dir);
    const before = await readFile(planJson(dir));
    const mtime = (await stat(planJson(dir))).mtimeMs;
    await db
      .update(schema.planNodes)
      .set({ title: 'Shop renamed' })
      .where(eq(schema.planNodes.repositoryId, FIRST));
    await markPlanMirrorDirty(db, FIRST);
    await openMerge(dir);
    shim = await failGit(['rev-parse', '--git-path']);

    await expect(writePlanMirror(db, FIRST, dir)).rejects.toThrow(/failed in/);

    expect(await readFile(planJson(dir))).toEqual(before);
    expect((await stat(planJson(dir))).mtimeMs).toBe(mtime);
    const row = state(FIRST);
    expect(row.writtenRevision).toBeLessThan(row.revision as number);
    expect(row.lastError).toMatch(/failed in/);
    expect(row.lastError).not.toMatch(/merge, rebase, cherry-pick or revert is open/);
  });

  it('still writes plan.json and plan.md in a checkout with no .git', async () => {
    const dir = await checkout({ git: false });
    const { db } = setup([FIRST], [dir]);

    await writePlanMirror(db, FIRST, dir);

    expect(await exists(planJson(dir))).toBe(true);
    expect(await exists(path.join(dir, HAIVE_DATA_FILES.planMarkdown))).toBe(true);
  });
});

describe('the plan sweep when git cannot be read', () => {
  it('logs the original error exactly once for one unreadable row in one tick', async () => {
    const dir = await checkout({ git: true });
    const { state } = setup([FIRST], [dir]);
    shim = await failGit(['rev-parse', '--git-path']);
    const warn = vi.spyOn(logger, 'warn');

    expect(await sweepDirtyPlanMirrors()).toBe(0);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({ message: expect.stringContaining(dir) }),
        repositoryId: FIRST,
      },
      expect.any(String),
    );
    expect(state(FIRST).writtenRevision).toBeLessThan(state(FIRST).revision as number);
  });

  it('keeps the unreadable row dirty with git text and still writes the healthy one', async () => {
    const first = await checkout({ git: true });
    const second = await checkout({ git: true });
    const { state } = setup([FIRST, SECOND], [first, second]);
    shim = await failGit(['rev-parse', '--git-path'], { until: 1 });

    expect(await sweepDirtyPlanMirrors()).toBe(1);

    expect(await exists(planJson(first))).toBe(false);
    expect(await exists(planJson(second))).toBe(true);
    const row = state(FIRST);
    expect(row.writtenRevision).toBeLessThan(row.revision as number);
    expect(row.lastError).toMatch(/git rev-parse --git-path MERGE_HEAD failed in /);
    expect(state(SECOND).lastError).toBeNull();
  });
});
