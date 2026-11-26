import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  link,
  lstat,
  readFile,
  rm,
  rename,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { WorktreeAliasSweeper, worktreeAliasStore } from '../src/repo/worktree-alias-background.js';

const url = process.env.WORKTREE_ALIAS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/worktree_alias_test'))
  throw new Error('Use a dedicated worktree_alias_test database');
describe.skipIf(!url)('legacy worktree alias sweep on Postgres', () => {
  let db: Database;
  let root: string;
  let userId: string;
  let repoId: string;
  beforeAll(async () => {
    db = createDatabase(url!);
    root = await mkdtemp(path.join(tmpdir(), 'alias-sweep-db-'));
  });
  beforeEach(async () => {
    userId = randomUUID();
    repoId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'test',
      emailBlindIndex: userId,
      passwordHash: 'test',
    });
    await db.insert(schema.repositories).values({
      id: repoId,
      userId,
      name: 'fixture',
      source: 'blank',
      storagePath: path.join(root, userId, repoId),
    });
  });
  afterEach(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await rm(root, { recursive: true, force: true });
  });
  const row = async () =>
    (await db.select().from(schema.repositories).where(eq(schema.repositories.id, repoId)))[0]!;

  it('durably resumes discovery after worker replacement and records completion exactly once', async () => {
    const anchor = path.join(root, userId, repoId);
    await mkdir(path.join(anchor, '.haive/worktrees/task'), { recursive: true });
    await writeFile(path.join(anchor, 'outside'), 'original');
    await link(path.join(anchor, 'outside'), path.join(anchor, '.haive/worktrees/task/a'));
    await writeFile(path.join(anchor, '.haive/worktrees/task/b'), 'ordinary');
    const store = worktreeAliasStore(db, root);
    const first = new WorktreeAliasSweeper(store, { maxSteps: 2 });
    await first.tick();
    await first.stop();
    expect((await row()).worktreeAliasScan).toMatchObject({
      cursor: '.haive/worktrees/task/a',
      complete: false,
    });
    expect(await db.select().from(schema.worktreeAliasNames)).toHaveLength(1);
    expect((await lstat(path.join(anchor, 'outside'))).nlink).toBe(2);
    const resumed = new WorktreeAliasSweeper(store, { maxSteps: 16 });
    await resumed.tick();
    expect((await row()).worktreeAliasesSweptAt).toBeNull();
    await resumed.tick();
    await resumed.stop();
    const finished = await row();
    expect(finished.worktreeAliasesSweptAt).toBeInstanceOf(Date);
    expect(finished.worktreeAliasScan).toBeNull();
    expect(await db.select().from(schema.worktreeAliasNames)).toHaveLength(0);
    expect(await store.next('')).toBeNull();
    expect((await lstat(path.join(anchor, 'outside'))).nlink).toBe(1);
    await writeFile(path.join(anchor, 'outside'), 'changed');
    expect(await readFile(path.join(anchor, '.haive/worktrees/task/a'), 'utf8')).toBe('original');
    expect(await store.complete({ id: repoId, anchor })).toBe(false);
    expect((await row()).worktreeAliasesSweptAt).toEqual(finished.worktreeAliasesSweptAt);
  });
  it('rolls a checkpoint back with its failed inode insert and fences completion during root changes', async () => {
    const store = worktreeAliasStore(db, root);
    const repo = (await store.next(''))!;
    const scan = { cursor: '.haive/worktrees/task/a', examined: 2, complete: false };
    await expect(
      store.checkpoint!(repo, scan, [{ path: null as unknown as string, dev: '1', ino: '2' }]),
    ).rejects.toThrow();
    expect((await row()).worktreeAliasScan).toBeNull();
    await store.checkpoint!(repo, scan, [
      { path: scan.cursor, dev: '9007199254740993', ino: '9007199254740995' },
    ]);
    expect((await store.load!(repo))?.names[0]?.ino).toBe('9007199254740995');
    await db
      .update(schema.repositories)
      .set({ rootClaimedAt: new Date() })
      .where(eq(schema.repositories.id, repoId));
    expect(await store.complete(repo)).toBe(false);
    await db
      .update(schema.repositories)
      .set({ rootClaimedAt: null })
      .where(eq(schema.repositories.id, repoId));
    expect(await store.complete(repo)).toBe(true);
  });

  it.each([false, true])(
    'rediscovers and recovers a copy interrupted inside the primitive (published=%s)',
    async (published) => {
      const anchor = path.join(root, userId, repoId);
      const tree = path.join(anchor, '.haive/worktrees/task');
      await mkdir(tree, { recursive: true });
      await writeFile(path.join(anchor, 'outside'), 'original');
      await link(path.join(anchor, 'outside'), path.join(tree, 'source'));
      const identity = await lstat(path.join(tree, 'source'), { bigint: true });
      const store = worktreeAliasStore(db, root);
      const repo = (await store.next(''))!;
      await store.checkpoint!(
        repo,
        { cursor: '.haive/worktrees/task/source', examined: 2, complete: true },
        [
          {
            path: '.haive/worktrees/task/source',
            dev: identity.dev.toString(),
            ino: identity.ino.toString(),
          },
        ],
      );
      await rename(
        path.join(tree, 'source'),
        path.join(tree, '.source.haive-alias-park-123-11111111-1111-1111-1111-111111111111'),
      );
      if (published) await writeFile(path.join(tree, 'source'), 'published');
      const restarted = new WorktreeAliasSweeper(store, { maxSteps: 32 });
      for (let i = 0; i < 5 && !(await row()).worktreeAliasesSweptAt; i++) await restarted.tick();
      await restarted.stop();
      expect((await row()).worktreeAliasesSweptAt).toBeInstanceOf(Date);
      expect(await readFile(path.join(tree, 'source'), 'utf8')).toBe(
        published ? 'published' : 'original',
      );
      expect((await lstat(path.join(anchor, 'outside'))).nlink).toBe(1);
      const names = await readdir(tree);
      expect(names.some((name) => name.includes('.haive-alias-park-'))).toBe(false);
      expect(names.some((name) => name.includes('.haive-alias-kept-'))).toBe(published);
    },
  );
  it('excludes a read-only local folder and advances past an invalid stored root', async () => {
    const store = worktreeAliasStore(db, root);
    await db
      .update(schema.repositories)
      .set({ source: 'local_path', storagePath: null, localPath: '/person/checkout' })
      .where(eq(schema.repositories.id, repoId));
    expect(await store.next('')).toBeNull();
    await db
      .update(schema.repositories)
      .set({ source: 'blank', storagePath: '/unmanaged' })
      .where(eq(schema.repositories.id, repoId));
    expect(await store.next('')).toMatchObject({ id: repoId, refusal: expect.any(String) });
    const worker = new WorktreeAliasSweeper(store);
    await worker.tick();
    await worker.tick();
    await worker.stop();
    expect((await row()).worktreeAliasesSweptAt).toBeNull();
  });
});
