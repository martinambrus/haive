import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService } from '@haive/shared';
import { emptyProjectState, renderProjectState } from '@haive/shared/project-state';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { prepareJournalFilesNoFollow } from '@haive/shared/fs-safe';

const fsSeam = vi.hoisted(() => ({
  afterUndo: null as null | (() => Promise<void>),
  afterPrepare: null as null | (() => Promise<void>),
}));
vi.mock('@haive/shared/fs-safe', async (load) => {
  const real = await load<typeof import('@haive/shared/fs-safe')>();
  return {
    ...real,
    prepareJournalFilesNoFollow: async (
      ...args: Parameters<typeof real.prepareJournalFilesNoFollow>
    ) => {
      const result = await real.prepareJournalFilesNoFollow(...args);
      await fsSeam.afterPrepare?.();
      return result;
    },
    rewriteFileIfNoFollow: async (...args: Parameters<typeof real.rewriteFileIfNoFollow>) => {
      const result = await real.rewriteFileIfNoFollow(...args);
      if (result === 'rewritten' && args[3]?.journal?.direction === 'undo')
        await fsSeam.afterUndo?.();
      return result;
    },
  };
});
import { watchCheckout } from '../src/project-state/watch.js';
import { readNamedCheckout } from '../src/repo/checkout-head.js';
import {
  recoverProjectStateWrite,
  writeProjectStateColumn,
  ProjectStateWriteError,
} from '../src/project-state/write.js';

const url = process.env.T117_DATABASE_URL;
if (
  url &&
  (!/^\/codex_t117_[a-z0-9_]+$/.test(new URL(url).pathname) ||
    ['', '5432'].includes(new URL(url).port))
)
  throw new Error('exclusive T117 scratch database required');
const db = url ? createDatabase(url) : null;
const users: string[] = [];
const dirs: string[] = [];
const context = (name: string) => ({
  projectInfo: { name },
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
});
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@local',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@local',
    },
  }).trim();
const outbox = async (id: string) =>
  (
    await db!
      .select()
      .from(schema.projectStateOutbox)
      .where(eq(schema.projectStateOutbox.repositoryId, id))
  )[0]!;
const synced = async (id: string) =>
  (
    await db!
      .select()
      .from(schema.projectStateSync)
      .where(eq(schema.projectStateSync.repositoryId, id))
  )[0]!;
const column = async (id: string) =>
  (await db!.select().from(schema.repositories).where(eq(schema.repositories.id, id)))[0]!
    .renderContext;

/** Observe resolved real SQL, retaining its thenable builder for every unaffected call. */
function afterSql(hooks: {
  intentRead?: (rows: unknown[]) => Promise<void>;
  updated?: (table: unknown, values: Record<string, unknown>) => Promise<void>;
}): Database {
  return new Proxy(db!, {
    get(target, key) {
      if (key === 'transaction')
        return (callback: Parameters<Database['transaction']>[0]) =>
          target.transaction(async (tx) => {
            const wrapped = new Proxy(tx, {
              get(inner, prop) {
                if (prop === 'select')
                  return (fields?: Parameters<typeof tx.select>[0]) => {
                    const builder = tx.select(fields!);
                    return {
                      from: (table: Parameters<typeof builder.from>[0]) => {
                        const query = builder.from(table);
                        if (
                          table !== schema.projectStateOutbox ||
                          !fields ||
                          !Object.hasOwn(fields, 'intent')
                        )
                          return query;
                        return {
                          where: (condition: Parameters<typeof query.where>[0]) => {
                            const run = query.where(condition);
                            return new Proxy(run, {
                              get(q, member) {
                                if (member === 'then')
                                  return (
                                    resolve: (rows: unknown[]) => unknown,
                                    reject: (err: unknown) => unknown,
                                  ) =>
                                    q
                                      .then(async (rows) => {
                                        await hooks.intentRead?.(rows);
                                        return rows;
                                      })
                                      .then(resolve, reject);
                                const value = Reflect.get(q, member);
                                return typeof value === 'function' ? value.bind(q) : value;
                              },
                            });
                          },
                        };
                      },
                    };
                  };
                if (prop === 'update')
                  return (table: Parameters<typeof tx.update>[0]) => ({
                    set: (values: Record<string, unknown>) => {
                      const query = tx.update(table).set(values as never);
                      if (!hooks.updated) return query;
                      return {
                        where: (condition: Parameters<typeof query.where>[0]) => {
                          const run = query.where(condition);
                          return new Proxy(run, {
                            get(q, member) {
                              if (member === 'then')
                                return (
                                  resolve: (rows: unknown) => unknown,
                                  reject: (err: unknown) => unknown,
                                ) =>
                                  q
                                    .then(async (rows) => {
                                      await hooks.updated!(table, values);
                                      return rows;
                                    })
                                    .then(resolve, reject);
                              const value = Reflect.get(q, member);
                              return typeof value === 'function' ? value.bind(q) : value;
                            },
                          });
                        },
                      };
                    },
                  });
                const value = Reflect.get(inner, prop);
                return typeof value === 'function' ? value.bind(inner) : value;
              },
            });
            return callback(wrapped);
          });
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function fixture() {
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(true);
  const root = await mkdtemp(join(tmpdir(), 't117-late-'));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  for (const [rel, text] of renderProjectState({
    ...emptyProjectState(),
    render: context('accepted'),
    settings: { 'rtk-version': '1.0.0' },
  })) {
    const path = join(root, '.haive-data/state', rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'accepted');
  const userId = randomUUID();
  users.push(userId);
  await db!.insert(schema.users).values({
    id: userId,
    emailEncrypted: 'fixture',
    emailBlindIndex: userId,
    passwordHash: 'fixture',
  });
  const [repo] = await db!
    .insert(schema.repositories)
    .values({ userId, source: 'blank', name: 'late', storagePath: root })
    .returning();
  const id = repo!.id;
  expect(await watchCheckout(db!, id)).toBe('synced');
  return {
    root,
    id,
    head: (await readNamedCheckout(root))!,
    base: await synced(id),
    column: await column(id),
  };
}
async function interrupted(s: Awaited<ReturnType<typeof fixture>>, staged = true) {
  const changes = [];
  for (const [rel, after] of [
    ['project/render.json', JSON.stringify(context('abandoned')) + '\n'],
    ['settings/rtk-version.json', '"8.0.0"\n'],
  ] as const) {
    const path = join(s.root, '.haive-data/state', rel);
    const info = await stat(path);
    changes.push({
      rel,
      before: await readFile(path, 'utf8'),
      after,
      metadata: { uid: info.uid, gid: info.gid, mode: info.mode & 0o7777 },
    });
  }
  const stage = staged
    ? await prepareJournalFilesNoFollow(
        s.root,
        `.haive-data/.state-writes/${randomUUID()}`,
        changes,
        1024 * 1024,
      )
    : undefined;
  const intent = { id: randomUUID(), changes, ...(stage ? { stage } : {}) };
  await markProjectStateDirty(db!, s.id);
  await db!
    .update(schema.projectStateOutbox)
    .set({ writeIntent: intent })
    .where(eq(schema.projectStateOutbox.repositoryId, s.id));
  for (const change of changes)
    await writeFile(join(s.root, '.haive-data/state', change.rel), change.after);
  return intent;
}
afterEach(async () => {
  fsSeam.afterUndo = null;
  fsSeam.afterPrepare = null;
  for (const id of users.splice(0)) await db!.delete(schema.users).where(eq(schema.users.id, id));
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

describe.skipIf(!url)('T117 late recovery and writer commit fences', () => {
  it.each(['public recovery', 'writer preparation'] as const)(
    'R1 holds a staged undo when HEAD moves after post-admission intent SELECT: %s',
    async (entry) => {
      const s = await fixture();
      const intent = await interrupted(s);
      let intentReads = 0;
      let undo = 0;
      fsSeam.afterUndo = async () => {
        undo++;
      };
      const observed = afterSql({
        intentRead: async (rows) => {
          intentReads++;
          expect((rows[0] as { intent: { id: string } }).intent.id).toBe(intent.id);
          if (intentReads === 1) git(s.root, 'checkout', '--detach', '-q');
        },
      });
      if (entry === 'public recovery')
        await recoverProjectStateWrite(observed, s.id, s.root, s.head).catch(() => undefined);
      else
        await writeProjectStateColumn(observed, {
          repositoryId: s.id,
          repoPath: s.root,
          column: s.column as never,
          expectedCheckout: s.head,
          keepColumnOnFailure: true,
          refuseWhileHeld: true,
          refuseDuringGitOperation: true,
        }).catch(() => undefined);
      expect(intentReads).toBeGreaterThanOrEqual(1);
      expect.soft(undo).toBe(0);
      expect.soft((await outbox(s.id)).writeIntent).toEqual(intent);
      expect(await readFile(join(s.root, '.haive-data/state/project/render.json'), 'utf8')).toBe(
        intent.changes[0]!.after,
      );
      expect.soft(await synced(s.id)).toEqual(s.base);
      expect(await column(s.id)).toEqual(s.column);
    },
  );
  it('R1 retains a replayable partially undone journal when HEAD moves during undo', async () => {
    const s = await fixture();
    const intent = await interrupted(s);
    let undo = 0;
    fsSeam.afterUndo = async () => {
      if (++undo === 1) git(s.root, 'checkout', '--detach', '-q');
    };
    await recoverProjectStateWrite(db!, s.id, s.root, s.head).catch(() => undefined);
    expect.soft(undo).toBe(1);
    expect.soft((await outbox(s.id)).writeIntent).toEqual(intent);
    expect(await readFile(join(s.root, '.haive-data/state/project/render.json'), 'utf8')).toBe(
      intent.changes[0]!.after,
    );
    expect(
      await readFile(join(s.root, '.haive-data/state/settings/rtk-version.json'), 'utf8'),
    ).toBe(intent.changes[1]!.before);
    expect.soft(await synced(s.id)).toEqual(s.base);
    expect(await column(s.id)).toEqual(s.column);
    fsSeam.afterUndo = null;
    git(s.root, 'checkout', '-q', 'main');
    await recoverProjectStateWrite(db!, s.id, s.root, (await readNamedCheckout(s.root))!);
    expect((await outbox(s.id)).writeIntent).toBeNull();
    for (const change of intent.changes)
      expect(await readFile(join(s.root, '.haive-data/state', change.rel), 'utf8')).toBe(
        change.before,
      );
  });
  it.each(['after-prepare', 'after-manifest-sql'] as const)(
    'R1 refuses legacy image manifest commit after movement %s',
    async (phase) => {
      const s = await fixture();
      const intent = await interrupted(s, false);
      let moved = 0;
      const move = async () => {
        if (moved++ === 0) git(s.root, 'checkout', '--detach', '-q');
      };
      if (phase === 'after-prepare') fsSeam.afterPrepare = move;
      const observed = afterSql({
        updated: async (table, values) => {
          if (
            phase === 'after-manifest-sql' &&
            table === schema.projectStateOutbox &&
            (values.writeIntent as { stage?: unknown } | undefined)?.stage
          )
            await move();
        },
      });
      await recoverProjectStateWrite(observed, s.id, s.root, s.head).catch(() => undefined);
      expect(moved).toBe(1);
      expect.soft((await outbox(s.id)).writeIntent).toEqual(intent);
      expect.soft(await synced(s.id)).toEqual(s.base);
      expect(await column(s.id)).toEqual(s.column);
    },
  );
  it.each(['detach', 'record-edit'] as const)(
    'R2 rejects acknowledgement after the actual writer column SQL tail: %s',
    async (move) => {
      const s = await fixture();
      const local = { ...(s.column as Record<string, unknown>), ...context('local') };
      await db!
        .update(schema.repositories)
        .set({ renderContext: local })
        .where(eq(schema.repositories.id, s.id));
      await markProjectStateDirty(db!, s.id);
      const dirty = await outbox(s.id);
      const path = join(s.root, '.haive-data/state/project/render.json');
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(context('accepted'));
      let writerUpdates = 0;
      let error: unknown;
      const observed = afterSql({
        updated: async (table, values) => {
          if (table !== schema.repositories || !Object.hasOwn(values, 'renderContext')) return;
          writerUpdates++;
          expect(values.renderContext).toEqual(local);
          // Incoming bytes were unchanged, so the importer had no render-column write. This is the
          // actual writer: its complete local output is already public and its prepared intent committed.
          expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(context('local'));
          expect((await outbox(s.id)).writeIntent).toBeTruthy();
          if (move === 'detach') git(s.root, 'checkout', '--detach', '-q');
          else await writeFile(path, JSON.stringify(context('editor-after-sql')) + '\n');
        },
      });
      try {
        await writeProjectStateColumn(observed, {
          repositoryId: s.id,
          repoPath: s.root,
          column: local as never,
          expectedColumns: [local],
          expectedCheckout: s.head,
          keepColumnOnFailure: true,
          refuseDuringGitOperation: true,
          refuseWhileHeld: true,
        });
      } catch (err) {
        error = err;
      }
      expect(writerUpdates).toBe(1);
      expect.soft(await synced(s.id)).toEqual(s.base);
      const after = await outbox(s.id);
      expect.soft(after.writtenRevision).toBe(dirty.writtenRevision);
      expect.soft(after.writeIntent).toBeTruthy();
      expect.soft(after.revision).toBeGreaterThan(after.writtenRevision);
      expect(await column(s.id)).toEqual(local);
      expect(error).toBeInstanceOf(ProjectStateWriteError);
      expect((error as ProjectStateWriteError).written).toContain(
        '.haive-data/state/project/render.json',
      );
    },
  );
});
