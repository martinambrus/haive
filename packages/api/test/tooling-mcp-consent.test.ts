import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const KEY = vi.hoisted(() => 'a'.repeat(64));
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getEncryptionKey: async () => KEY },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { mcpAcceptanceMark } from '@haive/shared';
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const held = '{"mcpServers":{"evil":{"command":"sh"}}}';
const pending = {
  schemaVersion: 1,
  tooling: { ragMode: 'none', importedMcpSettingsJson: held, importedMcpServerNames: ['evil'] },
};

const app = new Hono<AppEnv>();
app.route('/', toolingUpgradeRoutes);
app.onError(errorHandler);

function setup(onboardingTooling: Record<string, unknown> | null = pending) {
  const fake = createFakeDb({ repositories: schema.repositories });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'r',
    source: 'local_path',
    onboardingTooling,
  });
  h.db = fake.db;
  return fake;
}

const patch = (body: Record<string, unknown>) =>
  app.request(`/${REPO}/tooling`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const tooling = (fake: ReturnType<typeof setup>) =>
  (fake.rows(schema.repositories)[0]!.onboardingTooling as { tooling: Record<string, unknown> })
    .tooling;

describe('deciding the MCP servers held from an imported mirror', () => {
  it('accepting makes them the list the runtime reads, marked with this install key', async () => {
    const fake = setup();
    expect((await patch({ repoMcpServersAction: 'accept' })).status).toBe(200);
    expect(tooling(fake)).toEqual({
      ragMode: 'none',
      mcpSettingsJson: held,
      acceptedMcpSettingsMark: mcpAcceptanceMark(held, KEY),
    });
  });

  it('discarding drops them', async () => {
    const fake = setup();
    expect((await patch({ repoMcpServersAction: 'discard' })).status).toBe(200);
    expect(tooling(fake)).toEqual({ ragMode: 'none' });
  });

  it('decides only in a request of its own', async () => {
    for (const other of [{ reviewDimensions: [] }, { ragEmbedAction: 'rebuild_index' }]) {
      const fake = setup();
      const res = await patch({ repoMcpServersAction: 'accept', ...other });
      expect(res.status).toBe(400);
      expect(fake.rows(schema.repositories)[0]!.onboardingTooling).toEqual(pending);
    }
  });

  it('answers 409 when nothing is waiting', async () => {
    setup({ schemaVersion: 1, tooling: { ragMode: 'none' } });
    expect((await patch({ repoMcpServersAction: 'accept' })).status).toBe(409);
  });

  it('keeps a change another writer made meanwhile', async () => {
    const fake = setup();
    const theirs = { schemaVersion: 1, tooling: { ragMode: 'pgvector' } };
    let raced = false;
    fake.hooks.beforeUpdate = (table) => {
      if (table !== schema.repositories || raced) return;
      raced = true;
      fake.patch(schema.repositories, REPO, { onboardingTooling: theirs });
    };
    expect((await patch({ repoMcpServersAction: 'accept' })).status).toBe(409);
    expect(fake.rows(schema.repositories)[0]!.onboardingTooling).toEqual(theirs);
  });
});
