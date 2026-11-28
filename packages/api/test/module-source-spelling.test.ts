import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: undefined as unknown, enqueue: vi.fn() }));
vi.mock('../src/queues.js', () => ({ getModuleSourceQueue: () => ({ add: h.enqueue }) }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAdmin: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-000000000337');
    await next();
  },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService, secretsService } from '@haive/shared';
import type { AppEnv } from '../src/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { moduleSourceRoutes } from '../src/modules/sources.js';

const fake = createFakeDb({
  moduleSources: schema.moduleSources,
  systemSecrets: schema.systemSecrets,
  auditEvents: schema.auditEvents,
});
const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/sources', moduleSourceRoutes());

let moduleSeq = 0;
const secretKeys = () => fake.rows(schema.systemSecrets).map((row) => String(row.key));
const audit = (action: string) =>
  fake.rows(schema.auditEvents).filter((row) => row.action === action);

async function add() {
  const res = await app.request('/sources', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'git',
      moduleId: 'spelling-' + ++moduleSeq,
      url: 'https://example.com/spelling.git',
      ref: 'main',
      token: randomBytes(24).toString('hex'),
    }),
  });
  expect(res.status).toBe(201);
  const source = (await res.json()) as { id: string };
  expect(secretKeys()).toContain('module_source:' + source.id + ':token');
  return source.id;
}

describe('module source routes build keys and audit targets from the row id', () => {
  beforeAll(async () => {
    vi.spyOn(configService, 'getEncryptionKey').mockResolvedValue(randomBytes(32).toString('hex'));
    await secretsService.initialize(fake.db as never);
  });
  beforeEach(() => {
    h.db = fake.db;
    h.enqueue.mockReset().mockResolvedValue({ id: 'fetch' });
    vi.stubEnv('HAIVE_PUBLISHED_INSTALL', 'true');
    secretsService.clearCache();
  });

  it('deletes the token secret and audits the canonical id when called through an upper-case id', async () => {
    const id = await add();
    const res = await app.request('/sources/' + id.toUpperCase(), { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(secretKeys().filter((key) => key.startsWith('module_source:'))).not.toContain(
      'module_source:' + id + ':token',
    );
    expect(audit('module_source.delete')).toMatchObject([{ targetId: id }]);
  });

  it('audits the canonical id of a fetch requested through an upper-case id', async () => {
    const id = await add();
    const res = await app.request('/sources/' + id.toUpperCase() + '/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(202);
    expect(audit('module_source.fetch')).toMatchObject([{ targetId: id }]);
  });

  it('deletes the token secret through the canonical id', async () => {
    const id = await add();
    const res = await app.request('/sources/' + id, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(secretKeys()).not.toContain('module_source:' + id + ':token');
  });
});
