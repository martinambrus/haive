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
const h = vi.hoisted(() => ({ db: undefined as any, actor: '' }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
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
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

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
    await allowAudit(db);
    await db.execute(sql`DROP TRIGGER IF EXISTS refuse_remote_persist ON repositories`);
    await db.execute(sql`DROP FUNCTION IF EXISTS refuse_remote_persist()`);
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    await cleanActor(db, h.actor);
  });
  for (const failure of ['none', 'persist', 'audit'] as const)
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
          await db.execute(
            sql.raw(
              `CREATE FUNCTION refuse_remote_persist() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${repository}'::uuid THEN RAISE EXCEPTION 'persist refused'; END IF; RETURN NEW; END $$`,
            ),
          );
          await db.execute(
            sql`CREATE TRIGGER refuse_remote_persist BEFORE UPDATE ON repositories FOR EACH ROW EXECUTE FUNCTION refuse_remote_persist()`,
          );
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
  const sendSetting = (suffix: string, body: unknown, method = 'PATCH') =>
    app.request(`${suffix === 'exclusions' ? '/repos' : '/repositories'}/${repository}/${suffix}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
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
