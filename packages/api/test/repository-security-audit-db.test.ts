import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';
import type { StepContext, StepDefinition } from '@haive/shared/step';
import { eq, sql } from 'drizzle-orm';
import { cp, mkdtemp, rm } from 'node:fs/promises';
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
  freshCalls: 0,
  relinkDatabase: undefined as
    ((db: ReturnType<typeof createDatabase>) => ReturnType<typeof createDatabase>) | undefined,
  actor: '',
  gitHook: undefined as ((args: string[]) => Promise<void>) | undefined,
  lockTimeoutMs: 30_000,
  ragProbe: undefined as (() => Promise<boolean>) | undefined,
  gate4Ensure: vi.fn(async () => ({ added: true, updated: false })),
  gate4Push: vi.fn(async () => {}),
}));
// Only the gate-4 Git seam is faked; its transaction and the relink route use real Postgres.
vi.mock('../../worker/src/repo/git-push.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getOriginUrl: async () => null,
  ensureOrigin: h.gate4Ensure,
  pushBranch: h.gate4Push,
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
vi.mock('../src/db.js', () => ({
  getDb: () => h.db,
  withFreshDatabase: async (run: (db: ReturnType<typeof createDatabase>) => Promise<unknown>) => {
    const fresh = createDatabase(url!);
    try {
      h.freshCalls += 1;
      return await run(h.freshCalls === 2 && h.relinkDatabase ? h.relinkDatabase(fresh) : fresh);
    } finally {
      await fresh.$client.end({ timeout: 5 });
    }
  },
}));
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
  TASK_START_LOCK_TIMEOUT_MS: 300,
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
  configService: {
    getEncryptionKey: async () => 'ab'.repeat(32),
    get: async () => null,
    getFresh: async () => 'normal',
  },
}));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: vi.fn() }) }));
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { taskRoutes } from '../src/routes/tasks/index.js';
import { repoRoutes } from '../src/routes/repos.js';
import { repositoryIntegrationRoutes } from '../src/routes/repository-integrations.js';
import { REPOSITORY_BUSY } from '../src/lib/repository-busy.js';
import { lockRemoteRelink, markRemoteIntent } from '../src/lib/remote-reconcile.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
// Runtime-only test loading keeps the API typecheck independent of worker sources.
const gate4Module = new URL(
  '../../worker/src/step-engine/steps/workflow/11a-gate-4-push.ts',
  import.meta.url,
).pathname;

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
  let gate4PushStep: StepDefinition;
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
    .route('/tasks', taskRoutes)
    .route('/repos', repoRoutes);
  const stored = () =>
    db.query.repositories.findFirst({ where: eq(schema.repositories.id, repository) });
  // pg_stat_activity.query is truncated (1023 bytes by default). Adding a repository
  // column can push FROM beyond it, so identify the blocker rather than match SQL text.
  const waitersOn = (pid: number) =>
    db.execute<{ query: string }>(sql`
      select a.query from pg_stat_activity a
      where a.datname = current_database() and ${pid} = any(pg_blocking_pids(a.pid))
    `);
  let checkoutFixture: string;
  beforeAll(async () => {
    ({ gate4PushStep } = await import(gate4Module));
    db = createDatabase(url!);
    h.db = db;
    checkoutFixture = await mkdtemp(path.join(tmpdir(), 'relink-fixture-'));
    await git(checkoutFixture, ['init']);
    await git(checkoutFixture, ['remote', 'add', 'origin', 'https://old.test/r']);
  });
  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    if (checkoutFixture) await rm(checkoutFixture, { recursive: true, force: true });
  });
  beforeEach(async () => {
    h.gate4Ensure.mockClear();
    h.gate4Push.mockClear();
    h.freshCalls = 0;
    h.relinkDatabase = undefined;
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
            sql`CREATE TRIGGER refuse_remote_persist BEFORE UPDATE OF remote_url ON repositories FOR EACH ROW EXECUTE FUNCTION refuse_remote_persist()`,
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
          expect(await stored()).toEqual({
            ...before,
            remoteRelinkIntent: failure === 'commit' ? expect.any(String) : null,
          });
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
            metadata: {
              source: 'api',
              actorKind: 'authenticated_user',
              fields: ['remoteUrl', 'credentialsSecretId', 'branch'],
              host: 'new.test',
              credentialsChanged: true,
              branchChanged: true,
            },
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
        source: 'api',
        actorKind: 'authenticated_user',
        fields: ['remoteUrl'],
        host: 'same.test',
        credentialsChanged: false,
        branchChanged: false,
      });
    },
  );
  it('restores a failed remote update while refusing a competing relink, then admits its retry', async () => {
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
    let second: Promise<Response> | undefined;
    // Fresh client 1 commits intent; client 2 runs the actual Git/persistence transaction.
    h.relinkDatabase = (fresh) =>
      new Proxy(fresh, {
        get(target, key) {
          if (key === 'transaction')
            return async (fn: (tx: any) => Promise<unknown>) => {
              try {
                return await target.transaction(async (tx) => {
                  return fn(
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
                  );
                });
              } catch (err) {
                // Delay the rejection until the competing request has answered. Its claim
                // must refuse while this writer still owns the checkout, including rollback.
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
      const answer = await answeredWithin(5_000, second);
      expect(answer.status).toBe(409);
      expect(await answer.json()).toMatchObject({ code: 'checkout_unavailable' });
    } finally {
      release();
    }
    try {
      expect((await failed).status).toBe(500);
      expect((await stored())!.remoteUrl).toBe('https://old.test/r');
      expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://old.test/r');
      expect(await audits(db)).toHaveLength(0);
      expect((await remote('https://second.test/r')).status).toBe(200);
      expect((await stored())!.remoteUrl).toBe('https://second.test/r');
      expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://second.test/r');
      expect(await audits(db)).toHaveLength(1);
    } finally {
      h.relinkDatabase = undefined;
    }
  }, 30_000);
  it.each(['plain writer', 'worker then task start', 'advisory waiter'] as const)(
    'relink Git does not pin a %s behind its repository row',
    async (kind) => {
      const root = await mkdtemp(path.join(tmpdir(), 'relink-writer-'));
      roots.push(root);
      await cp(checkoutFixture, root, { recursive: true });
      await db
        .update(schema.repositories)
        .set({ localPath: root, status: 'ready' })
        .where(eq(schema.repositories.id, repository));
      const [task] = await db
        .insert(schema.tasks)
        .values({
          userId: h.actor,
          repositoryId: repository,
          type: 'workflow',
          title: 'start control',
        })
        .returning();
      let arrived!: () => void;
      let release!: () => void;
      const arrival = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.gitHook = async (args) => {
        if (
          args.includes('remote') &&
          args.includes('add') &&
          args.at(-1) === 'https://held.test/r'
        ) {
          arrived();
          await resume;
        }
      };
      const relink = Promise.resolve(
        app.request(`/repos/${repository}/remote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ remoteUrl: 'https://held.test/r' }),
        }),
      );
      let writer: Promise<unknown> | undefined;
      try {
        await answeredWithin(5_000, arrival);
        if (kind === 'plain writer') {
          // The deadline is only a probe: production plain UPDATE has no lock bound.
          writer = db.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '300ms'`);
            await tx
              .update(schema.repositories)
              .set({ name: 'concurrent writer' })
              .where(eq(schema.repositories.id, repository));
          });
          await writer;
          expect((await stored())!.name).toBe('concurrent writer');
        } else if (kind === 'advisory waiter') {
          h.lockTimeoutMs = 300;
          const token = (await stored())!.remoteRelinkIntent;
          expect(await db.transaction((tx) => lockRemoteRelink(tx, repository, true))).toBe(false);
          await expect(markRemoteIntent(repository, h.actor)).rejects.toMatchObject({
            status: 409,
            message: REPOSITORY_BUSY,
          });
          expect((await stored())!.remoteRelinkIntent).toBe(token);
        } else {
          let taking!: () => void;
          const take = new Promise<void>((resolve) => {
            taking = resolve;
          });
          writer = db.transaction(async (tx) => {
            // The project-state writer on current main takes these before its row.
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`onboarding-upgrade:${repository}`}, 0))`,
            );
            taking();
            await tx
              .select({ id: schema.repositories.id })
              .from(schema.repositories)
              .where(eq(schema.repositories.id, repository))
              .for('no key update');
          });
          await take;
          const answer = await answeredWithin(
            5_000,
            Promise.resolve(
              app.request(`/tasks/${task!.id}/action`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'start' }),
              }),
            ),
          );
          expect(answer.status).toBe(409);
          // T780 still refuses a Start under the mutation lease. It must not exhaust
          // the task-key budget behind a worker waiting on relink's Git.
          expect(await answer.json()).not.toMatchObject({ error: REPOSITORY_BUSY });
          expect(
            (await db.query.tasks.findFirst({ where: eq(schema.tasks.id, task!.id) }))!.status,
          ).toBe('created');
          await answeredWithin(1_000, writer);
        }
      } finally {
        release();
        await Promise.allSettled([relink, writer]);
        h.gitHook = undefined;
      }
      expect((await relink).status).toBe(200);
      if (kind === 'plain writer') expect((await stored())!.name).toBe('concurrent writer');
    },
    15_000,
  );
  it('upgrades the relink row while a deletion-order FOR UPDATE waiter holds the task key', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'relink-delete-order-'));
    roots.push(root);
    await cp(checkoutFixture, root, { recursive: true });
    await db
      .update(schema.repositories)
      .set({ localPath: root, remoteUrl: 'https://old.test/r' })
      .where(eq(schema.repositories.id, repository));
    let arrived!: () => void;
    let release!: () => void;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.gitHook = async (args) => {
      if (args.includes('--replace-all') && args.at(-1) === 'https://new.test/r') {
        arrived();
        await resume;
      }
    };
    const relink = Promise.resolve(
      app.request(`/repos/${repository}/remote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ remoteUrl: 'https://new.test/r' }),
      }),
    );
    let deleting: Promise<unknown> | undefined;
    try {
      await answeredWithin(5_000, arrival);
      let pid = 0;
      deleting = db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2000ms'`);
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        pid = backend!.pid;
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`onboarding-upgrade:${repository}`}, 0))`,
        );
        return tx
          .select({ id: schema.repositories.id })
          .from(schema.repositories)
          .where(eq(schema.repositories.id, repository))
          .for('update');
      });
      // Observe the server-side wait before allowing the KEY SHARE upgrade.
      await expect
        .poll(
          async () =>
            (
              await db.execute(sql`
        select 1 from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock'
      `)
            ).length,
        )
        .toBe(1);
      release();
      expect((await answeredWithin(5_000, relink)).status).toBe(200);
      await answeredWithin(5_000, deleting);
    } finally {
      release();
      await Promise.allSettled([relink, deleting]);
      h.gitHook = undefined;
    }
  });
  it.each(['omitted', 'branch', 'credential', 'remote', 'intent'] as const)(
    'compares relink-owned columns and preserves concurrent %s changes',
    async (kind) => {
      const root = await mkdtemp(path.join(tmpdir(), 'relink-cas-'));
      roots.push(root);
      await cp(checkoutFixture, root, { recursive: true });
      await db
        .update(schema.repositories)
        .set({ localPath: root, remoteUrl: 'https://old.test/r', branch: 'main' })
        .where(eq(schema.repositories.id, repository));
      const [cred] = await db
        .insert(schema.repoCredentials)
        .values({
          userId: h.actor,
          host: 'new.test',
          label: 'concurrent',
          usernameEncrypted: 'synthetic',
          secretEncrypted: 'synthetic',
          encryptedDek: 'synthetic',
        })
        .returning();
      let arrived!: () => void;
      let release!: () => void;
      const arrival = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.gitHook = async (args) => {
        if (args.includes('--replace-all') && args.at(-1) === 'https://new.test/r') {
          arrived();
          await resume;
        }
      };
      const relink = Promise.resolve(
        app.request(`/repos/${repository}/remote`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            remoteUrl: 'https://new.test/r',
            ...(kind === 'branch' ? { branch: 'requested' } : {}),
            ...(kind === 'credential' ? { credentialsId: null } : {}),
          }),
        }),
      );
      try {
        await answeredWithin(5_000, arrival);
        await db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '300ms'`);
          await tx
            .update(schema.repositories)
            .set({
              name: 'concurrent',
              ...(kind === 'omitted'
                ? { branch: 'concurrent', credentialsSecretId: cred!.id }
                : {}),
              ...(kind === 'branch' ? { branch: 'concurrent' } : {}),
              ...(kind === 'credential' ? { credentialsSecretId: cred!.id } : {}),
              ...(kind === 'remote' ? { remoteUrl: 'https://concurrent.test/r' } : {}),
              ...(kind === 'intent'
                ? { remoteRelinkIntent: '00000000-0000-4000-8000-000000000516' }
                : {}),
            })
            .where(eq(schema.repositories.id, repository));
        });
      } finally {
        release();
        await relink;
        h.gitHook = undefined;
      }
      expect((await relink).status).toBe(kind === 'omitted' ? 200 : 409);
      const current = (await stored())!;
      expect(current.name).toBe('concurrent');
      expect(current.branch).toBe(['omitted', 'branch'].includes(kind) ? 'concurrent' : 'main');
      expect(current.credentialsSecretId).toBe(
        ['omitted', 'credential'].includes(kind) ? cred!.id : null,
      );
      expect(current.remoteUrl).toBe(
        kind === 'omitted'
          ? 'https://new.test/r'
          : kind === 'remote'
            ? 'https://concurrent.test/r'
            : 'https://old.test/r',
      );
      expect(await git(root, ['remote', 'get-url', 'origin'])).toBe(
        kind === 'omitted' ? 'https://new.test/r' : 'https://old.test/r',
      );
      expect(current.remoteRelinkIntent).not.toBeNull();
      if (kind === 'intent')
        expect(current.remoteRelinkIntent).toBe('00000000-0000-4000-8000-000000000516');
      const events = await audits(db);
      expect(events).toHaveLength(kind === 'omitted' ? 1 : 0);
      if (kind === 'omitted')
        expect(events[0]!.metadata).toMatchObject({
          fields: ['remoteUrl'],
          credentialsChanged: false,
          branchChanged: false,
        });
    },
  );
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
      if (args.some((arg) => arg === 'https://queued.test/r')) queuedGitCalls.push(args);
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
      expect(await answer.json()).toEqual({
        error:
          'This repository is being changed by another file or configuration operation. Try again in a moment.',
        code: 'checkout_unavailable',
      });
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
      {
        source: 'api',
        actorKind: 'authenticated_user',
        fields: ['remoteUrl'],
        host: 'first.test',
        credentialsChanged: false,
        branchChanged: false,
      },
    ]);
  }, 30_000);
  it('bounds gate-4 origin writes behind a relink parked in Git', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'remote-gate4-'));
    roots.push(root);
    await cp(checkoutFixture, root, { recursive: true });
    await git(root, ['remote', 'remove', 'origin']);
    await db
      .update(schema.repositories)
      .set({ localPath: root, remoteUrl: null })
      .where(eq(schema.repositories.id, repository));
    h.lockTimeoutMs = 300;
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.gitHook = async (args) => {
      if (args.includes('add') && args.at(-1) === 'https://relink.test/r') {
        entered();
        await resume;
      }
    };
    const relink = Promise.resolve(
      app.request(`/repos/${repository}/remote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ remoteUrl: 'https://relink.test/r' }),
      }),
    );
    let push: Promise<unknown> | undefined;
    try {
      await answeredWithin(5_000, reached);
      push = gate4PushStep.apply({ db, userId: h.actor, logger } as unknown as StepContext, {
        iteration: 0,
        previousIterations: [],
        detected: {
          hasGit: true,
          workspacePath: root,
          branch: 'main',
          hasOrigin: false,
          originUrl: null,
          recentCommits: '',
          repositoryId: repository,
          boundCredentialId: null,
          credentials: [],
        },
        formValues: { push: true, remoteUrl: 'https://gate4.test/r' },
      });
      await expect(answeredWithin(5_000, push)).rejects.toThrow(
        'Repository is busy. Retry this step in a moment.',
      );
      expect(h.gate4Ensure).not.toHaveBeenCalled();
      expect(h.gate4Push).not.toHaveBeenCalled();
      expect((await stored())!.remoteUrl).toBeNull();
      expect(await audits(db)).toEqual([]);
    } finally {
      release();
      await Promise.allSettled([relink, push]);
      h.gitHook = undefined;
    }
    expect((await relink).status).toBe(200);
    expect((await stored())!.remoteUrl).toBe('https://relink.test/r');
    expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://relink.test/r');
  }, 15_000);
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
  /** Real Git is parked while a settings writer or deletion contends for the same row. */
  const answeredBehindRelink = async (
    send: () => Response | Promise<Response>,
    expected = 200,
    blockingWriter = false,
  ) => {
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
    let held: Promise<unknown> | undefined;
    let unlock = () => {};
    let preserved: Awaited<ReturnType<typeof stored>>;
    try {
      await vi.waitFor(() => expect(reached).toBe(true), { timeout: 15_000 });
      if (blockingWriter) {
        let acquired!: () => void;
        const acquisition = new Promise<void>((resolve) => {
          acquired = resolve;
        });
        const resumeWriter = new Promise<void>((resolve) => {
          unlock = resolve;
        });
        held = db.transaction(async (tx) => {
          await tx
            .select({ id: schema.repositories.id })
            .from(schema.repositories)
            .where(eq(schema.repositories.id, repository))
            .for('no key update');
          acquired();
          await resumeWriter;
        });
        await acquisition;
      }
      const before = await writtenRows();
      writer = Promise.resolve(send());
      const answer = await answeredWithin(5_000, writer);
      expect(answer.status).toBe(expected);
      if (expected === 409) {
        expect(await answer.json()).toEqual({ error: REPOSITORY_BUSY, code: null });
        expect(await writtenRows()).toEqual(before);
      }
      preserved = await stored();
    } finally {
      unlock();
      await held;
      release();
      // A failing writer assertion must still wait for the released relink to commit
      // before afterEach deletes the actor and that actor's audit rows.
      await Promise.allSettled([relink, writer]);
      h.gitHook = undefined;
    }
    expect((await relink).status).toBe(200);
    expect(
      (await audits(db)).filter((row) => row.action === 'repository.remote.update'),
    ).toHaveLength(1);
    for (const field of [
      'scopeExcludeGlobs',
      'secretMaskEnabled',
      'ragEmbedDegradedAt',
      'ragEmbedDegradedReason',
      'integrationsRestricted',
    ] as const)
      expect((await stored())![field]).toEqual(preserved![field]);
  };
  it(
    'allows an exclusions save while relink Git holds KEY SHARE',
    () => answeredBehindRelink(() => sendSetting('exclusions', { scopeExcludeGlobs: ['queued'] })),
    30_000,
  );
  it(
    'allows a tooling security save while relink Git holds KEY SHARE',
    () => answeredBehindRelink(() => sendSetting('tooling', { secretMaskEnabled: false })),
    30_000,
  );
  it(
    'allows the bounded tooling rebuild pending flag while relink Git holds KEY SHARE',
    () =>
      answeredBehindRelink(() =>
        sendSetting('tooling', {
          ragEmbedAction: 'rebuild_index',
        }),
      ),
    30_000,
  );
  it('restores degradation after a committed retry while relink Git holds KEY SHARE', async () => {
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
    h.lockTimeoutMs = 300;
    let relinkArrived = false;
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
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
      // Probe errors are swallowed by the route: record arrival here, assert it outside.
      for (let i = 0; i < 100 && !reached; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      relinkArrived = reached;
      return true;
    };
    const save = Promise.resolve(sendSetting('tooling', { ragEmbedAction: 'retry' }));
    try {
      const answer = await answeredWithin(5_000, save);
      expect(answer.status).toBe(200);
      expect(await answer.json()).toMatchObject({ degradationKept: true });
      expect(await stored()).toMatchObject({
        secretMaskEnabled: true,
        ragEmbedDegradedAt: degradedAt,
        ragEmbedDegradedReason: 'pending fallback rows',
      });
      expect(probes).toBe(2);
      expect(relinkArrived).toBe(true);
      expect(
        warnings.mock.calls.some(
          (call) => call[1] === 'retry degraded flag restore deferred by repository lock',
        ),
      ).toBe(false);
    } finally {
      release();
      await Promise.all([save, relink]);
      warnings.mockRestore();
    }
    expect((await relink!).status).toBe(200);
  }, 30_000);
  const prepareRetry = async () => {
    const degradedAt = new Date('2026-01-01T00:00:00Z');
    await db
      .update(schema.repositories)
      .set({
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
    return degradedAt;
  };
  it('runs both retry probes with no repository row lock held', async () => {
    const degradedAt = await prepareRetry();
    const available: boolean[] = [];
    h.ragProbe = async () => {
      try {
        await db.transaction((tx) =>
          tx.execute(sql`SELECT id FROM repositories WHERE id = ${repository} FOR UPDATE NOWAIT`),
        );
        available.push(true);
      } catch {
        available.push(false);
      }
      return available.length === 2;
    };
    const answer = await sendSetting('tooling', { ragEmbedAction: 'retry' });
    expect(answer.status).toBe(200);
    expect(available).toEqual([true, true]);
    expect(await answer.json()).toMatchObject({ degradationKept: true });
    expect(await stored()).toMatchObject({ ragEmbedDegradedAt: degradedAt });
  });
  it('warns and preserves a committed retry save when its bounded restore cannot lock the row', async () => {
    await prepareRetry();
    h.lockTimeoutMs = 300;
    let probes = 0;
    let acquired = false;
    let release!: () => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holder: Promise<unknown> | undefined;
    let holderError: unknown;
    h.ragProbe = async () => {
      if (++probes === 1) return false;
      let arrived!: () => void;
      const arrival = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      holder = db
        .transaction(async (tx) => {
          try {
            await tx.execute(
              sql`SELECT id FROM repositories WHERE id = ${repository} FOR UPDATE NOWAIT`,
            );
            acquired = true;
          } catch {
            /* Assert acquisition outside this swallowed probe. */
          } finally {
            arrived();
          }
          if (acquired) await resume;
        })
        .catch((err: unknown) => {
          holderError = err;
        });
      await arrival;
      return true;
    };
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const save = Promise.resolve(sendSetting('tooling', { ragEmbedAction: 'retry' }));
    try {
      const answer = await answeredWithin(5_000, save);
      expect(answer.status).toBe(200);
      expect(await answer.json()).toMatchObject({ degradationKept: false });
      expect(acquired).toBe(true);
      expect(holderError).toBeUndefined();
      expect(probes).toBe(2);
      expect(await stored()).toMatchObject({ secretMaskEnabled: true, ragEmbedDegradedAt: null });
      expect((await audits(db)).map((row) => row.action)).toEqual([]);
      expect(
        warnings.mock.calls.some(
          (call) => call[1] === 'retry degraded flag restore deferred by repository lock',
        ),
      ).toBe(true);
    } finally {
      release();
      await Promise.all([save, holder]);
      warnings.mockRestore();
    }
  });
  it(
    'allows an integrations allow-list save while relink Git holds KEY SHARE',
    () =>
      answeredBehindRelink(() =>
        sendSetting('integrations', { restricted: true, connectionIds: [connection] }, 'PUT'),
      ),
    30_000,
  );
  it(
    'bounds both concurrent allow-list PUTs behind a row writer, including the advisory waiter',
    () =>
      answeredBehindRelink(
        async () => {
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
        },
        409,
        true,
      ),
    30_000,
  );
  it(
    'answers a repository delete 409 busy within the lock bound while a relink holds the row',
    () =>
      answeredBehindRelink(() => app.request(`/repos/${repository}`, { method: 'DELETE' }), 409),
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
      source: 'api',
      actorKind: 'authenticated_user',
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
      let holderPid = 0;
      const prior = db.transaction(async (tx) => {
        const [holder] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        holderPid = holder!.pid;
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
              const rows = await waitersOn(holderPid);
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
  it('scope null-to-empty normalization records no membership change', async () => {
    await db
      .update(schema.repositories)
      .set({ scopeExcludeGlobs: null })
      .where(eq(schema.repositories.id, repository));
    expect((await sendSetting('exclusions', { scopeExcludeGlobs: [] })).status).toBe(200);
    expect((await stored())!.scopeExcludeGlobs).toEqual([]);
    expect(await audits(db)).toEqual([]);
  });

  it('scope records added and removed counts and omits no-op saves', async () => {
    await db
      .update(schema.repositories)
      .set({ scopeExcludeGlobs: ['old'] })
      .where(eq(schema.repositories.id, repository));
    expect((await sendSetting('exclusions', { scopeExcludeGlobs: ['new'] })).status).toBe(200);
    expect((await audits(db))[0]!.metadata).toEqual({
      source: 'api',
      actorKind: 'authenticated_user',
      fields: ['scopeExcludeGlobs'],
      addedCount: 1,
      removedCount: 1,
    });
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
            metadata: {
              source: 'api',
              actorKind: 'authenticated_user',
              fields: [field],
              values: { [field]: safeValue },
            },
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
