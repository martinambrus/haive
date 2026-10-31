import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import {
  allowAudit,
  audits,
  cleanActor,
  createDatabase,
  makeActor,
  refuseAudit,
  schema,
} from './security-audit-db.js';
const url = process.env.REPOSITORY_SECURITY_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/repository_security_audit_test'))
  throw new Error('Use a dedicated repository_security_audit_test database');
const h = vi.hoisted(() => ({
  db: undefined as any,
  actor: '',
  gitHook: undefined as ((args: string[]) => Promise<void>) | undefined,
  lockTimeoutMs: 30_000,
  ragProbe: undefined as (() => Promise<boolean>) | undefined,
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: async (command: string, args: string[], options: any) => {
        await h.gitHook?.(args);
        return promisify(actual.execFile)(command, args, options);
      },
    }),
  };
});
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
// These controls exercise Postgres row contention; the RAG writer lease is held in memory.
vi.mock('../src/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('@haive/shared/rag', async (original) => {
  const actual = await original<typeof import('@haive/shared/rag')>();
  return {
    ...actual,
    tryAcquireRagSyncLock: async () => ({ lost: false, release: async () => {} }),
    resolveRagConnection: async (...args: Parameters<typeof actual.resolveRagConnection>) => {
      if (!h.ragProbe) return actual.resolveRagConnection(...args);
      return {
        mode: 'external',
        embeddingDimensions: 8,
        pg: {
          begin: async (run: (tx: unknown) => unknown) =>
            run({
              unsafe: async (statement: string) =>
                statement.startsWith('SELECT') && (await h.ragProbe?.()) ? [{ found: 1 }] : [],
            }),
        },
        close: async () => {},
      };
    },
  };
});

vi.mock('@haive/database', async (original) => ({
  ...(await original<typeof import('@haive/database')>()),
  get REPOSITORY_TASKS_LOCK_TIMEOUT_MS() {
    return h.lockTimeoutMs;
  },
}));
vi.mock('../src/middleware/auth.js', async (original) => ({
  ...(await original<any>()),
  requireAuth: async (c: any, next: any) => {
    c.set('userId', h.actor);
    await next();
  },
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<any>()),
  configService: { getEncryptionKey: async () => 'ab'.repeat(32), get: async () => null },
}));
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { repoRoutes } from '../src/routes/repos.js';
import { repositoryIntegrationRoutes } from '../src/routes/repository-integrations.js';
import { REPOSITORY_BUSY } from '../src/lib/repository-busy.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

/** The pending value, or an error naming the wait when `ms` pass first. */
async function answeredWithin<T>(ms: number, pending: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!url)('Repository security settings commit with their audit, on Postgres', () => {
  let db: ReturnType<typeof createDatabase>;
  let repository: string;
  let connection: string;
  const roots: string[] = [];
  const git = async (root: string, args: string[]) =>
    (await promisify(execFile)('git', args, { cwd: root })).stdout.trim();
  const app = new Hono<AppEnv>()
    .onError(errorHandler)
    .route('/repositories', toolingUpgradeRoutes)
    .route('/repositories', repositoryIntegrationRoutes)
    .route('/repos', repoRoutes);
  const stored = () =>
    db.query.repositories.findFirst({ where: eq(schema.repositories.id, repository) });
  beforeAll(() => {
    db = createDatabase(url!);
    h.db = db;
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
  });
  beforeEach(async () => {
    h.actor = (await makeActor(db)).id;
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId: h.actor,
        name: 'test',
        source: 'local_path',
        onboardingTooling: {
          schemaVersion: 1,
          tooling: {
            ragMode: 'none',
            importedMcpSettingsJson:
              '{"mcpServers":{"external":{"command":"sh","env":{"TOKEN":"synthetic-secret"}}}}',
            importedMcpServerNames: ['external'],
          },
        },
      })
      .returning();
    repository = repo!.id;
    const [row] = await db
      .insert(schema.integrationConnections)
      .values({
        providerId: 'github',
        scope: 'user',
        ownerUserId: h.actor,
        accountLabel: 'synthetic-account',
        authMethod: 'token',
      })
      .returning();
    connection = row!.id;
  });
  afterEach(async () => {
    h.db = db;
    h.gitHook = undefined;
    h.ragProbe = undefined;
    h.lockTimeoutMs = 30_000;
    await allowAudit(db);
    await db.execute(sql`DROP TRIGGER IF EXISTS refuse_remote_persist ON repositories`);
    await db.execute(sql`DROP FUNCTION IF EXISTS refuse_remote_persist()`);
    await db.execute(sql`DROP TRIGGER IF EXISTS refuse_remote_commit ON audit_events`);
    await db.execute(sql`DROP FUNCTION IF EXISTS refuse_remote_commit()`);
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    await cleanActor(db, h.actor);
  });
  for (const failure of ['none', 'persist', 'commit', 'audit'] as const)
    for (const existing of [false, true])
      it(`remote ${existing ? 'relink' : 'link'}: ${failure} failure preserves checkout and binding`, async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'remote-audit-'));
        roots.push(root);
        await git(root, ['init']);
        if (existing) {
          await git(root, ['remote', 'add', 'origin', 'https://old.test/r']);
          await git(root, ['config', '--add', 'remote.origin.url', 'https://extra.test/r']);
          await git(root, ['config', '--add', 'remote.origin.pushurl', 'https://push.test/r']);
        }
        await db
          .update(schema.repositories)
          .set({
            localPath: root,
            remoteUrl: existing ? 'https://old.test/r' : null,
            branch: 'main',
          })
          .where(eq(schema.repositories.id, repository));
        const [cred] = await db
          .insert(schema.repoCredentials)
          .values({
            userId: h.actor,
            host: 'new.test',
            label: 'test',
            usernameEncrypted: 'synthetic',
            secretEncrypted: 'synthetic',
            encryptedDek: 'synthetic',
          })
          .returning();
        const before = await stored();
        if (failure === 'persist') {
          // A prior interrupted run may have left the function and the trigger behind.
          await db.execute(
            sql.raw(
              `CREATE OR REPLACE FUNCTION refuse_remote_persist() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${repository}'::uuid THEN RAISE EXCEPTION 'persist refused'; END IF; RETURN NEW; END $$`,
            ),
          );
          await db.execute(sql`DROP TRIGGER IF EXISTS refuse_remote_persist ON repositories`);
          await db.execute(
            sql`CREATE TRIGGER refuse_remote_persist BEFORE UPDATE ON repositories FOR EACH ROW EXECUTE FUNCTION refuse_remote_persist()`,
          );
        }
        if (failure === 'commit') {
          // A prior interrupted run may have left the function behind.
          await db.execute(
            sql`CREATE OR REPLACE FUNCTION refuse_remote_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
          );
          await db.execute(
            sql.raw(
              `CREATE OR REPLACE FUNCTION refuse_remote_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target_id = '${repository}'::uuid THEN RAISE EXCEPTION 'commit refused'; END IF; RETURN NEW; END $$`,
            ),
          );
          await db.execute(sql`DROP TRIGGER IF EXISTS refuse_remote_commit ON audit_events`);
          await db.execute(
            sql`CREATE CONSTRAINT TRIGGER refuse_remote_commit AFTER INSERT ON audit_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_remote_commit()`,
          );
        }
        if (failure === 'commit') {
          // The trigger must allow other repositories' audit rows to commit.
          const [unrelated] = await db
            .insert(schema.auditEvents)
            .values({
              actorUserId: h.actor,
              action: 'repository.remote.update',
              targetType: 'repository',
              targetId: h.actor,
            })
            .returning();
          await db.delete(schema.auditEvents).where(eq(schema.auditEvents.id, unrelated!.id));
        }
        if (failure === 'audit') await refuseAudit(db, h.actor);
        const res = await app.request(`/repos/${repository}/remote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            remoteUrl: 'https://user:synthetic-password@new.test/r',
            credentialsId: cred!.id,
            branch: 'next',
          }),
        });
        expect(res.status).toBe(failure === 'none' ? 200 : 500);
        const config = await git(root, ['config', '--local', '--list']);
        if (failure !== 'none') {
          expect(await stored()).toEqual(before);
          if (existing) {
            expect(await git(root, ['config', '--get-all', 'remote.origin.url'])).toBe(
              'https://old.test/r\nhttps://extra.test/r',
            );
            expect(await git(root, ['config', '--get-all', 'remote.origin.pushurl'])).toBe(
              'https://push.test/r',
            );
          } else expect(config).not.toContain('remote.origin.');
          expect(await audits(db)).toEqual([]);
        } else {
          expect(await stored()).toMatchObject({
            remoteUrl: 'https://new.test/r',
            credentialsSecretId: cred!.id,
            branch: 'next',
          });
          expect((await audits(db))[0]).toMatchObject({
            action: 'repository.remote.update',
            targetId: repository,
            metadata: { host: 'new.test', credentialsChanged: true, branchChanged: true },
          });
          expect(JSON.stringify(await audits(db))).not.toMatch(/synthetic-password|user:|https:/);
        }
      });
  it.each([undefined, '', 'main'])(
    'remote metadata treats retained credentials and branch %s as unchanged',
    async (branch) => {
      const root = await mkdtemp(path.join(tmpdir(), 'remote-flags-'));
      roots.push(root);
      await git(root, ['init']);
      await git(root, ['remote', 'add', 'origin', 'git@same.test:o/old.git']);
      const [cred] = await db
        .insert(schema.repoCredentials)
        .values({
          userId: h.actor,
          host: 'same.test',
          label: 'test',
          usernameEncrypted: 'synthetic',
          secretEncrypted: 'synthetic',
          encryptedDek: 'synthetic',
        })
        .returning();
      await db
        .update(schema.repositories)
        .set({
          localPath: root,
          remoteUrl: 'git@same.test:o/old.git',
          credentialsSecretId: cred!.id,
          branch: 'main',
        })
        .where(eq(schema.repositories.id, repository));
      const res = await app.request(`/repos/${repository}/remote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          remoteUrl: 'git@same.test:o/new.git',
          branch,
          ...(branch === 'main' ? { credentialsId: cred!.id } : {}),
        }),
      });
      expect(res.status).toBe(200);
      expect((await stored())!).toMatchObject({ credentialsSecretId: cred!.id, branch: 'main' });
      expect((await audits(db))[0]!.metadata).toEqual({
        host: 'same.test',
        credentialsChanged: false,
        branchChanged: false,
      });
    },
  );
  it('restores a failed remote update before a queued relink acquires the row', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'remote-race-'));
    roots.push(root);
    await git(root, ['init']);
    await git(root, ['remote', 'add', 'origin', 'https://old.test/r']);
    await db
      .update(schema.repositories)
      .set({ localPath: root, remoteUrl: 'https://old.test/r' })
      .where(eq(schema.repositories.id, repository));
    let reached!: () => void;
    let release!: () => void;
    const atUpdate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    let second: Promise<Response> | undefined;
    h.db = new Proxy(db, {
      get(target, key) {
        if (key === 'transaction')
          return async (fn: (tx: any) => Promise<unknown>) => {
            if (!first) return target.transaction(fn);
            first = false;
            try {
              return await target.transaction((tx) =>
                fn(
                  new Proxy(tx, {
                    get(t, prop) {
                      if (prop === 'update')
                        return () => ({
                          set: () => ({
                            where: async () => {
                              reached();
                              await resume;
                              throw new Error('first persistence failed');
                            },
                          }),
                        });
                      const value = Reflect.get(t, prop);
                      return typeof value === 'function' ? value.bind(t) : value;
                    },
                  }),
                ),
              );
            } catch (err) {
              // Hold the rejected transaction's caller until its queued successor commits.
              // Restoration after ROLLBACK would then clobber the successor's checkout.
              await second;
              throw err;
            }
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const remote = (remoteUrl: string) =>
      Promise.resolve(
        app.request(`/repos/${repository}/remote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ remoteUrl }),
        }),
      );
    const failed = remote('https://first.test/r');
    try {
      await atUpdate;
      second = remote('https://second.test/r');
      await expect
        .poll(
          async () =>
            (
              await db.execute(sql`
        select 1 from pg_stat_activity a join pg_locks l on l.pid = a.pid
        where a.datname = current_database() and not l.granted
          and a.query like 'select %"repositories"%'
      `)
            ).length,
          { timeout: 15_000 },
        )
        .toBeGreaterThan(0);
    } finally {
      release();
    }
    try {
      expect((await failed).status).toBe(500);
      expect((await second!).status).toBe(200);
      expect((await stored())!.remoteUrl).toBe('https://second.test/r');
      expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://second.test/r');
      expect(await audits(db)).toHaveLength(1);
    } finally {
      h.db = db;
    }
  }, 30_000);
  it('allows a task insert while a relink is held inside Git', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'remote-fk-'));
    roots.push(root);
    await git(root, ['init']);
    await git(root, ['remote', 'add', 'origin', 'https://old.test/r']);
    await db
      .update(schema.repositories)
      .set({ localPath: root, remoteUrl: 'https://old.test/r' })
      .where(eq(schema.repositories.id, repository));
    let reached = false;
    let finished = false;
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.gitHook = async (args) => {
      if (args.includes('--replace-all') && args.at(-1) === 'https://new.test/r') {
        reached = true;
        await resume;
        finished = true;
      }
    };
    const request = Promise.resolve(
      app.request(`/repos/${repository}/remote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ remoteUrl: 'https://new.test/r' }),
      }),
    );
    try {
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 15_000 });
      const [task] = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
        return tx
          .insert(schema.tasks)
          .values({
            userId: h.actor,
            repositoryId: repository,
            type: 'workflow',
            title: 'concurrent task',
          })
          .returning();
      });
      expect(task!.repositoryId).toBe(repository);
      expect(finished).toBe(false);
    } finally {
      release();
      await request;
      h.gitHook = undefined;
    }
    expect((await request).status).toBe(200);
    expect((await stored())!.remoteUrl).toBe('https://new.test/r');
    expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://new.test/r');
  }, 30_000);
  it('answers a queued relink 409 busy within the lock bound, before it changes Git', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'remote-busy-'));
    roots.push(root);
    await git(root, ['init']);
    await git(root, ['remote', 'add', 'origin', 'https://old.test/r']);
    await db
      .update(schema.repositories)
      .set({ localPath: root, remoteUrl: 'https://old.test/r' })
      .where(eq(schema.repositories.id, repository));
    h.lockTimeoutMs = 300;
    let reached = false;
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queuedGitCalls: string[][] = [];
    h.gitHook = async (args) => {
      if (args.includes('https://queued.test/r')) queuedGitCalls.push(args);
      if (args.includes('--replace-all') && args.at(-1) === 'https://first.test/r') {
        reached = true;
        await resume;
      }
    };
    const relink = (remoteUrl: string) =>
      Promise.resolve(
        app.request(`/repos/${repository}/remote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ remoteUrl }),
        }),
      );
    const first = relink('https://first.test/r');
    let queued: Promise<Response> | undefined;
    try {
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 15_000 });
      queued = relink('https://queued.test/r');
      const answer = await answeredWithin(5_000, queued);
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({ error: REPOSITORY_BUSY, code: null });
      expect(queuedGitCalls).toEqual([]);
      expect(await git(root, ['config', '--get-all', 'remote.origin.url'])).toBe(
        'https://old.test/r',
      );
      expect((await stored())!.remoteUrl).toBe('https://old.test/r');
    } finally {
      release();
      await Promise.all([first, queued]);
      h.gitHook = undefined;
    }
    expect((await first).status).toBe(200);
    expect((await stored())!.remoteUrl).toBe('https://first.test/r');
    expect(await git(root, ['config', '--get-all', 'remote.origin.url'])).toBe(
      'https://first.test/r',
    );
    expect((await audits(db)).map((row) => row.metadata)).toEqual([
      { host: 'first.test', credentialsChanged: false, branchChanged: false },
    ]);
  }, 30_000);
  const sendSetting = (suffix: string, body: unknown, method = 'PATCH') =>
    app.request(`${suffix === 'exclusions' ? '/repos' : '/repositories'}/${repository}/${suffix}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const writtenRows = async () => ({
    repository: await stored(),
    audits: await audits(db),
    grants: await db.select().from(schema.integrationGrants),
    cleanups: await db.select().from(schema.repoCleanups),
    outbox: await db.select().from(schema.projectStateOutbox),
  });
  /** `send` is a plain writer of the repository row, sent while a relink holds that row inside git. */
  const answeredBusyBehindRelink = async (send: () => Response | Promise<Response>) => {
    const root = await mkdtemp(path.join(tmpdir(), 'remote-held-'));
    roots.push(root);
    await git(root, ['init']);
    await git(root, ['remote', 'add', 'origin', 'https://old.test/r']);
    await db
      .update(schema.repositories)
      .set({ localPath: root, remoteUrl: 'https://old.test/r' })
      .where(eq(schema.repositories.id, repository));
    h.lockTimeoutMs = 300;
    let reached = false;
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.gitHook = async (args) => {
      if (args.includes('--replace-all') && args.at(-1) === 'https://first.test/r') {
        reached = true;
        await resume;
      }
    };
    const relink = Promise.resolve(
      app.request(`/repos/${repository}/remote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ remoteUrl: 'https://first.test/r' }),
      }),
    );
    let writer: Promise<Response> | undefined;
    try {
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 15_000 });
      const before = await writtenRows();
      writer = Promise.resolve(send());
      const answer = await answeredWithin(5_000, writer);
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({ error: REPOSITORY_BUSY, code: null });
      expect(await writtenRows()).toEqual(before);
    } finally {
      release();
      // A failing writer assertion must still wait for the released relink to commit
      // before afterEach deletes the actor and that actor's audit rows.
      await Promise.allSettled([relink, writer]);
      h.gitHook = undefined;
    }
    expect((await relink).status).toBe(200);
    expect((await audits(db)).map((row) => row.action)).toEqual(['repository.remote.update']);
  };
  it(
    'answers an exclusions save 409 busy within the lock bound while a relink holds the row',
    () =>
      answeredBusyBehindRelink(() => sendSetting('exclusions', { scopeExcludeGlobs: ['queued'] })),
    30_000,
  );
  it(
    'answers a tooling security save 409 busy within the lock bound while a relink holds the row',
    () => answeredBusyBehindRelink(() => sendSetting('tooling', { secretMaskEnabled: false })),
    30_000,
  );
  it(
    'answers a tooling rebuild 409 busy before its pending flag or any other write behind a held relink',
    () =>
      answeredBusyBehindRelink(() =>
        sendSetting('tooling', {
          ragEmbedAction: 'rebuild_index',
          secretMaskEnabled: false,
        }),
      ),
    30_000,
  );
  it('finishes a retry flag restore while a relink arrives during its second probe', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'remote-retry-'));
    roots.push(root);
    await git(root, ['init']);
    await git(root, ['remote', 'add', 'origin', 'https://old.test/r']);
    const degradedAt = new Date('2026-01-01T00:00:00Z');
    await db
      .update(schema.repositories)
      .set({
        localPath: root,
        remoteUrl: 'https://old.test/r',
        ragEmbedDegradedAt: degradedAt,
        ragEmbedDegradedReason: 'pending fallback rows',
        onboardingTooling: {
          schemaVersion: 1,
          tooling: {
            ragMode: 'external',
            ragConnectionString: 'postgres://unused.test/rag',
            embeddingDimensions: 8,
          },
        },
      })
      .where(eq(schema.repositories.id, repository));
    let reached = false;
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.gitHook = async (args) => {
      if (args.includes('--replace-all') && args.at(-1) === 'https://first.test/r') {
        reached = true;
        await resume;
      }
    };
    let relink: Promise<Response> | undefined;
    let probes = 0;
    h.ragProbe = async () => {
      if (++probes === 1) return false;
      relink = Promise.resolve(
        app.request(`/repos/${repository}/remote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ remoteUrl: 'https://first.test/r' }),
        }),
      );
      // On the old code the relink takes the row and holds it in git; on the fix it
      // queues on the save's row. Either proves it has arrived before the flag restore.
      await expect
        .poll(
          async () =>
            reached ||
            (
              await db.execute(sql`
        select 1 from pg_stat_activity a join pg_locks l on l.pid = a.pid
        where a.datname = current_database() and not l.granted
          and a.query like 'select %"repositories"%'
      `)
            ).length > 0,
          { timeout: 3_000 },
        )
        .toBe(true);
      return true;
    };
    const save = Promise.resolve(
      sendSetting('tooling', { ragEmbedAction: 'retry', secretMaskEnabled: false }),
    );
    try {
      const answer = await answeredWithin(5_000, save);
      expect(answer.status).toBe(200);
      expect(await answer.json()).toMatchObject({ degradationKept: true });
      expect(await stored()).toMatchObject({
        secretMaskEnabled: false,
        ragEmbedDegradedAt: degradedAt,
        ragEmbedDegradedReason: 'pending fallback rows',
      });
      expect(probes).toBe(2);
    } finally {
      release();
      await Promise.all([save, relink]);
    }
    expect((await relink!).status).toBe(200);
  }, 30_000);
  it(
    'answers an integrations allow-list save 409 busy within the lock bound while a relink holds the row',
    () =>
      answeredBusyBehindRelink(() =>
        sendSetting('integrations', { restricted: true, connectionIds: [connection] }, 'PUT'),
      ),
    30_000,
  );
  it(
    'bounds both concurrent allow-list PUTs behind a held relink, including the advisory waiter',
    () =>
      answeredBusyBehindRelink(async () => {
        // Keep the first PUT on the row longer than the second PUT's advisory budget.
        // Equal deadlines can let the second win the key at the exact timeout turn.
        h.lockTimeoutMs = 2_000;
        const body = { restricted: true, connectionIds: [connection] };
        const first = Promise.resolve(sendSetting('integrations', body, 'PUT'));
        let second: Promise<Response> | undefined;
        try {
          await expect
            .poll(
              async () =>
                (
                  await db.execute(sql`
          select 1 from pg_stat_activity a join pg_locks l on l.pid = a.pid
          where a.datname = current_database() and not l.granted
            and a.query like 'select %"repositories"%'
        `)
                ).length,
              { timeout: 3_000 },
            )
            .toBeGreaterThan(0);
          h.lockTimeoutMs = 300;
          second = Promise.resolve(sendSetting('integrations', body, 'PUT'));
          const answer = await answeredWithin(1_000, second);
          expect(answer.status).toBe(409);
          expect(await answer.json()).toEqual({ error: REPOSITORY_BUSY, code: null });
          return await answeredWithin(3_000, first);
        } finally {
          await Promise.all([first, second]);
        }
      }),
    30_000,
  );
  it(
    'answers a repository delete 409 busy within the lock bound while a relink holds the row',
    () => answeredBusyBehindRelink(() => app.request(`/repos/${repository}`, { method: 'DELETE' })),
    30_000,
  );
  it('no-op tooling saves and quality knobs write no security row', async () => {
    const current = (await stored())!;
    const res = await sendSetting('tooling', {
      secretMaskEnabled: current.secretMaskEnabled,
      secretMaskAllow: current.secretMaskAllow,
      secretMaskDenyExtend: current.secretMaskDenyExtend,
      appAuth: null,
      reviewDimensions: ['security'],
      stepGuidanceEnabled: false,
    });
    expect(res.status).toBe(200);
    expect(await audits(db)).toEqual([]);
  });
  it('a mixed tooling save audits only the security field that changed', async () => {
    const current = (await stored())!;
    expect(
      (
        await sendSetting('tooling', {
          secretMaskEnabled: current.secretMaskEnabled,
          secretMaskAllow: current.secretMaskAllow,
          secretMaskDenyExtend: current.secretMaskDenyExtend,
          agentRulesOverride: current.agentRulesOverride,
          appAuth: current.appAuth,
          prWorkflowEnabled: !current.prWorkflowEnabled,
        })
      ).status,
    ).toBe(200);
    expect((await audits(db))[0]!.metadata).toEqual({
      fields: ['prWorkflowEnabled'],
      values: { prWorkflowEnabled: !current.prWorkflowEnabled },
    });
  });
  it('integrations audit a restricted-only flip with no grant delta', async () => {
    for (const restricted of [true, true, false]) {
      expect(
        (await sendSetting('integrations', { restricted, connectionIds: [] }, 'PUT')).status,
      ).toBe(200);
    }
    const rows = await audits(db);
    expect(rows.map((row) => row.metadata)).toEqual([
      { restricted: true, added: [], removed: [] },
      { restricted: false, added: [], removed: [] },
    ]);
  });
  for (const suffix of ['tooling', 'exclusions', 'integrations'] as const)
    it(`interleaved ${suffix} saves read the prior commit under the row lock`, async () => {
      const change =
        suffix === 'tooling'
          ? { secretMaskEnabled: false }
          : suffix === 'exclusions'
            ? { scopeExcludeGlobs: ['saved'] }
            : { integrationsRestricted: true };
      const body = suffix === 'integrations' ? { restricted: true, connectionIds: [] } : change;
      let reached!: () => void;
      let release!: () => void;
      const written = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      // An independent repository save, like an imported settings write, holds only
      // the row lock. Route-specific advisory locks cannot substitute for this read.
      const prior = db.transaction(async (tx) => {
        await tx
          .update(schema.repositories)
          .set(change)
          .where(eq(schema.repositories.id, repository));
        reached();
        await resume;
      });
      await written;
      const save = Promise.resolve(
        sendSetting(suffix, body, suffix === 'integrations' ? 'PUT' : 'PATCH'),
      );
      let waiting: string | undefined;
      let response: Response | undefined;
      try {
        await expect
          .poll(
            async () => {
              const rows = await db.execute<{ query: string }>(sql`
            select a.query from pg_stat_activity a join pg_locks l on l.pid = a.pid
            where a.datname = current_database() and not l.granted
              and a.query like '%"repositories"%'
          `);
              waiting = rows[0]?.query;
              return Boolean(waiting);
            },
            { timeout: 15_000 },
          )
          .toBe(true);
        expect(waiting).toMatch(/^select /);
      } finally {
        release();
        await prior;
        response = await save;
      }
      expect(response!.status).toBe(200);
      expect(await stored()).toMatchObject(change);
      expect(await audits(db)).toEqual([]);
    }, 30_000);
  it('scope records added and removed counts and omits no-op saves', async () => {
    await db
      .update(schema.repositories)
      .set({ scopeExcludeGlobs: ['old'] })
      .where(eq(schema.repositories.id, repository));
    expect((await sendSetting('exclusions', { scopeExcludeGlobs: ['new'] })).status).toBe(200);
    expect((await audits(db))[0]!.metadata).toEqual({ addedCount: 1, removedCount: 1 });
    expect((await sendSetting('exclusions', { scopeExcludeGlobs: ['new'] })).status).toBe(200);
    expect(await audits(db)).toHaveLength(1);
  });
  it('integrations record added and removed ids and omit no-op saves', async () => {
    expect(
      (await sendSetting('integrations', { restricted: true, connectionIds: [connection] }, 'PUT'))
        .status,
    ).toBe(200);
    expect((await audits(db))[0]!.metadata).toEqual({
      restricted: true,
      added: [connection],
      removed: [],
    });
    expect(
      (await sendSetting('integrations', { restricted: true, connectionIds: [connection] }, 'PUT'))
        .status,
    ).toBe(200);
    expect(await audits(db)).toHaveLength(1);
    expect(
      (await sendSetting('integrations', { restricted: true, connectionIds: [] }, 'PUT')).status,
    ).toBe(200);
    expect((await audits(db))[1]!.metadata).toEqual({
      restricted: true,
      added: [],
      removed: [connection],
    });
  });
  const securityCases = [
    ['secretMaskEnabled', false, false],
    ['secretMaskAllow', ['private'], 1],
    ['secretMaskDenyExtend', ['other'], 1],
    ['agentRulesOverride', 'synthetic-rule-content', true],
    [
      'appAuth',
      {
        enabled: true,
        loginUrl: '/login',
        usernameSelector: '#user',
        passwordSelector: '#pass',
        submitSelector: '#go',
        successCondition: { type: 'url_contains', value: '/home' },
      },
      true,
    ],
    ['verifyCommands', { test: 'synthetic-command' }, 1],
    ['prWorkflowEnabled', false, false],
  ] as const;
  for (const [field, value, safeValue] of securityCases)
    for (const refused of [false, true])
      it(`security field ${field}: ${refused ? 'refused row rolls back' : 'names only the actual field and its new safe value'}`, async () => {
        const before = await stored();
        const outboxBefore = await db.select().from(schema.projectStateOutbox);
        if (refused) await refuseAudit(db, h.actor);
        const res = await sendSetting('tooling', { [field]: value });
        expect(res.status).toBe(refused ? 500 : 200);
        const rows = await audits(db);
        expect(rows).toHaveLength(refused ? 0 : 1);
        if (refused) {
          expect(await stored()).toEqual(before);
          expect(await db.select().from(schema.projectStateOutbox)).toEqual(outboxBefore);
        } else {
          expect(rows[0]).toMatchObject({
            action: 'repository.security.update',
            metadata: { fields: [field], values: { [field]: safeValue } },
          });
          expect(JSON.stringify(rows)).not.toMatch(
            /synthetic-rule-content|synthetic-command|#user|#pass/,
          );
          expect((await sendSetting('tooling', { [field]: value })).status).toBe(200);
          expect(await audits(db)).toHaveLength(1);
        }
      });
  const changes = [
    [
      'mask',
      'PATCH',
      'tooling',
      { secretMaskEnabled: false, secretMaskAllow: ['private'], secretMaskDenyExtend: ['other'] },
    ],
    ['rules', 'PATCH', 'tooling', { agentRulesOverride: 'synthetic-rule-content' }],
    [
      'app config',
      'PATCH',
      'tooling',
      {
        appAuth: {
          enabled: true,
          loginUrl: '/login',
          usernameSelector: '#user',
          passwordSelector: '#pass',
          submitSelector: '#go',
          successCondition: { type: 'url_contains', value: '/home' },
        },
      },
    ],
    ['MCP accept', 'PATCH', 'tooling', { repoMcpServersAction: 'accept' }],
    ['MCP discard', 'PATCH', 'tooling', { repoMcpServersAction: 'discard' }],
    ['exclusions', 'PATCH', 'exclusions', { scopeExcludeGlobs: ['private'] }],
    ['integrations', 'PUT', 'integrations', {}],
  ] as const;
  for (const [label, method, suffix, raw] of changes)
    for (const refused of [false, true])
      it(`${label}: ${refused ? 'audit refusal undoes the change and fails' : 'success writes safe audit'}`, async () => {
        const before = await stored();
        const outboxBefore = await db.select().from(schema.projectStateOutbox);
        if (refused) await refuseAudit(db, h.actor);
        const body =
          label === 'integrations' ? { restricted: true, connectionIds: [connection] } : raw;
        const path =
          suffix === 'exclusions'
            ? `/repos/${repository}/${suffix}`
            : `/repositories/${repository}/${suffix}`;
        const res = await app.request(path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status).toBe(refused ? 500 : 200);
        const rows = await audits(db);
        expect(rows).toHaveLength(refused ? 0 : 1);
        if (refused) {
          expect(await stored()).toEqual(before);
          expect(await db.select().from(schema.projectStateOutbox)).toEqual(outboxBefore);
          expect(await db.select().from(schema.integrationGrants)).toEqual([]);
        } else {
          expect(rows[0]).toMatchObject({
            actorUserId: h.actor,
            targetType: 'repository',
            targetId: repository,
          });
          expect(JSON.stringify(rows)).not.toMatch(
            /synthetic-secret|synthetic-account|synthetic-rule-content/,
          );
        }
      });
});
