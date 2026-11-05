import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, schema, type Database } from '@haive/database';
import { configService, secretsService } from '@haive/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../src/context.js';
import { moduleRoutes } from '../src/modules/loader.js';
import { errorHandler } from '../src/middleware/error-handler.js';

const h = vi.hoisted(() => ({ db: undefined as unknown, role: 'admin', auditFails: false }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', async (original) => ({
  ...(await original<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', '00000000-0000-4000-8000-000000000337');
    c.set('userRole', h.role);
    await next();
  },
}));
vi.mock('../src/lib/audit.js', async (original) => {
  const audit = await original<typeof import('../src/lib/audit.js')>();
  return {
    ...audit,
    insertAuditEvent: async (...args: Parameters<typeof audit.insertAuditEvent>) => {
      if (h.auditFails) throw new Error('audit refused');
      return audit.insertAuditEvent(...args);
    },
  };
});
const url = process.env.MODULE_SOURCES_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/module_sources_test'))
  throw new Error('Use a dedicated module_sources_test database');
const actor = '00000000-0000-4000-8000-000000000337';
const git = { kind: 'git', moduleId: 'alpha', url: 'https://example.com/alpha.git', ref: 'main' };
const registry = {
  kind: 'registry',
  moduleId: 'beta',
  packageName: '@haive-module/beta',
  version: '1.2.3',
};
const token = 't337-secret-never-return';
const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/modules', moduleRoutes([]));
const send = (method: string, path = '', body?: unknown) =>
  app.request('/modules/sources' + path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
type Source = { id: string; moduleId: string; hasToken: boolean; resolvedSha: string | null };
const key = (id: string) => 'module_source:' + id + ':token';
async function add(body: unknown = { ...git, token }) {
  const res = await send('POST', '', body);
  expect(res.status).toBe(201);
  const source = (await res.json()) as Source;
  expect(JSON.stringify(source)).not.toContain(token);
  return source;
}
let db: Database;
let close: () => Promise<void>;
describe.skipIf(!url)('module install sources (real database)', () => {
  beforeAll(async () => {
    const connection = createDatabase(url!);
    db = connection;
    close = () => connection.$client.end({ timeout: 5 });
    h.db = db;
    vi.spyOn(configService, 'getEncryptionKey').mockResolvedValue('33'.repeat(32));
    await secretsService.initialize(db);
    await db
      .insert(schema.users)
      .values({
        id: actor,
        emailEncrypted: 'test',
        emailBlindIndex: actor,
        passwordHash: 'test',
        role: 'admin',
      })
      .onConflictDoNothing();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await close?.();
  });
  beforeEach(async () => {
    h.role = 'admin';
    h.auditFails = false;
    vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'true');
    await db.execute(
      sql.raw(
        "DO $$ BEGIN IF to_regclass('module_sources') IS NOT NULL THEN DELETE FROM module_sources; END IF; END $$",
      ),
    );
    await db.execute(sql.raw("DELETE FROM system_secrets WHERE key LIKE 'module_source:%'"));
    await db.execute(sql.raw("DELETE FROM audit_events WHERE target_type = 'module_source'"));
    secretsService.clearCache();
  });
  it.each(['GET', 'POST', 'PUT', 'DELETE'])('refuses a normal user: %s', async (method) => {
    h.role = 'user';
    expect(
      (
        await send(
          method,
          method === 'PUT' || method === 'DELETE' ? '/00000000-0000-4000-8000-000000000001' : '',
          git,
        )
      ).status,
    ).toBe(403);
  });
  it('lists sources and capability without exposing tokens', async () => {
    const source = await add();
    const res = await send('GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ writable: true, sources: [source] });
    expect(JSON.stringify(source)).not.toContain(token);
  });
  it('keeps requested ref and unused fetch fields, encrypting the token', async () => {
    const source = await add();
    expect(source).toMatchObject({
      hasToken: true,
      resolvedSha: null,
      ref: 'main',
      fetchStatus: null,
      fetchedAt: null,
      lastError: null,
    });
    const secret = await db.query.systemSecrets.findFirst();
    expect(secret!.encryptedValue).not.toContain(token);
    expect(await secretsService.get(key(source.id))).toBe(token);
  });
  it.each([undefined, ''])('keeps token on an edit with token %s', async (value) => {
    const source = await add();
    const res = await send('PUT', '/' + source.id, {
      ...git,
      ref: 'v2',
      ...(value === undefined ? {} : { token: value }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasToken: true, ref: 'v2' });
    expect(await secretsService.getFresh(key(source.id))).toBe(token);
  });
  it('replaces and explicitly clears a token without returning it', async () => {
    const source = await add();
    const res = await send('PUT', '/' + source.id, { ...git, token: 'replacement' });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('replacement');
    const cleared = await send('PUT', '/' + source.id, { ...git, clearToken: true });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ hasToken: false });
    expect(await secretsService.getFresh(key(source.id))).toBeNull();
  });
  it('records a registry source', async () => {
    expect(await add(registry)).toMatchObject({ ...registry, hasToken: false });
  });
  it.each([
    { ...git, moduleId: 'Bad' },
    { ...git, moduleId: 'alpha\n' },
    { ...git, moduleId: 'a'.repeat(24) },
    { ...git, url: 'http://example.com/a' },
    { ...git, url: 'https://user:pass@example.com/a' },
    { ...git, url: 'https://example.com/a?token=oops' },
    { ...git, url: 'https://example.com/a#ref' },
    { ...git, url: 'https://example.com/a?' },
    { ...git, url: 'https://example.com/a#' },
    { ...git, ref: '' },
    { ...git, version: '1.0.0' },
    { ...registry, packageName: '@haive-module/other' },
    { ...registry, version: '^1.2.3' },
    { ...registry, version: '01.2.3' },
    { ...registry, version: '1.2.3-01' },
    { ...registry, url: git.url },
    { ...git, token: 'x', clearToken: true },
  ])('rejects invalid source %#', async (body) => {
    expect((await send('POST', '', body)).status).toBe(400);
  });
  describe('bare branch and tag refs', () => {
    it.each([
      '-x',
      '--upload-pack=touch /tmp/x',
      '-c core.sshCommand=x',
      '+x',
      '+refs/heads/*:refs/heads/*',
      ' main ',
      'a b',
      'a\tb',
      'a\u00a0b',
      'a..b',
      'a:b',
      'a\u0000b',
      'a\u001fb',
      'a\u007fb',
      'refs/heads/main',
      'refs/tags/v1',
      'a\\b',
      'a~b',
      'a^b',
      'a?b',
      'a*b',
      'a[b',
      'a@{b',
      'a/',
      '/a',
      'a//b',
      '.a',
      'a/.b',
      'a.',
      'a.lock',
      'a.lock/b',
      '@',
      'HEAD',
    ])('rejects ref %j on create and update', async (ref) => {
      const source = await add();
      expect((await send('POST', '', { ...git, moduleId: 'other', ref })).status).toBe(400);
      expect((await send('PUT', '/' + source.id, { ...git, ref })).status).toBe(400);
      expect(await (await send('GET')).json()).toMatchObject({ sources: [{ ref: 'main' }] });
    });
    it.each(['v1.2.3', 'feature/x'])('accepts ref %s on create and update', async (ref) => {
      const source = await add({ ...git, ref });
      expect(source).toMatchObject({ ref });
      const res = await send('PUT', '/' + source.id, { ...git, ref });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ref });
    });
  });
  it('refuses duplicate ids on create and edit', async () => {
    await add();
    const second = await add(registry);
    expect((await send('POST', '', git)).status).toBe(409);
    expect((await send('PUT', '/' + second.id, git)).status).toBe(409);
  });
  it('defaults to read-only on source checkouts and refuses all writes with a named reason', async () => {
    const source = await add();
    vi.stubEnv('HAIVE_PUBLISHED_INSTALL', '');
    expect(await (await send('GET')).json()).toMatchObject({ writable: false });
    for (const [method, path, body] of [
      ['POST', '', git],
      ['PUT', '/' + source.id, git],
      ['DELETE', '/' + source.id, undefined],
    ] as const) {
      const res = await send(method, path, body);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'source_checkout' });
    }
  });
  it('deletes the source and secret, auditing without secret metadata', async () => {
    const source = await add();
    const res = await send('DELETE', '/' + source.id);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(token);
    expect(await secretsService.getFresh(key(source.id))).toBeNull();
    const audits = await db.execute(
      sql.raw(
        "SELECT action, metadata FROM audit_events WHERE target_type = 'module_source' ORDER BY created_at",
      ),
    );
    expect(audits.map((a) => a.action)).toEqual(['module_source.create', 'module_source.delete']);
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(await (await send('GET')).json()).toMatchObject({ sources: [] });
  });
  it('returns 404 for missing targets', async () => {
    for (const method of ['PUT', 'DELETE'])
      expect(
        (
          await send(
            method,
            '/00000000-0000-4000-8000-000000000001',
            method === 'PUT' ? git : undefined,
          )
        ).status,
      ).toBe(404);
  });
  it('rolls back source creation and its secret on audit failure', async () => {
    h.auditFails = true;
    const res = await send('POST', '', { ...git, token });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(token);
    expect(await (await send('GET')).json()).toMatchObject({ sources: [] });
    expect(
      await db.execute(sql.raw("SELECT key FROM system_secrets WHERE key LIKE 'module_source:%'")),
    ).toHaveLength(0);
  });
  it.each(['PUT', 'DELETE'])('rolls back %s and its secret on audit failure', async (method) => {
    const source = await add();
    h.auditFails = true;
    expect(
      (
        await send(
          method,
          '/' + source.id,
          method === 'PUT' ? { ...git, ref: 'changed', clearToken: true } : undefined,
        )
      ).status,
    ).toBe(500);
    expect(await (await send('GET')).json()).toMatchObject({
      sources: [{ ref: 'main', hasToken: true }],
    });
    expect(await secretsService.getFresh(key(source.id))).toBe(token);
    expect(
      await db.execute(sql.raw("SELECT id FROM audit_events WHERE target_type = 'module_source'")),
    ).toHaveLength(1);
  });
});
