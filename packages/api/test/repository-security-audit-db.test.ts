import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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
const url = process.env.SECURITY_AUDIT_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/t376_audit_test'))
  throw new Error('Use a dedicated t376_audit_test database');
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
    await cleanActor(db, h.actor);
  });
  const changes = [
    [
      'mask',
      'PATCH',
      'tooling',
      { secretMaskEnabled: false, secretMaskAllow: ['private'], secretMaskDenyExtend: ['other'] },
    ],
    ['rules', 'PATCH', 'tooling', { agentRulesOverride: 'synthetic-rule-content' }],
    ['app config', 'PATCH', 'tooling', { appAuth: null }],
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
        if (refused) await refuseAudit(db);
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
