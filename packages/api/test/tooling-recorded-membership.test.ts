import { randomUUID } from 'node:crypto';
import { is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  userSecretsService: { listForUser: async () => [] },
}));
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const app = new Hono<AppEnv>();
app.route('/', toolingUpgradeRoutes);
app.onError(errorHandler);
const portable = {
  projectInfo: {},
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
};
const legacy = {
  ...portable,
  enabledCliProviders: [{ name: 'claude-code', rulesFile: 'CLAUDE.md', rulesFileMode: 'import' }],
  rtkChoiceRecorded: false,
};

describe('tooling GET displays completed recorded membership without changing its column', () => {
  it.each([null, legacy])('uses strict live membership before %j', async (column) => {
    const fake = createFakeDb(
      Object.fromEntries(
        Object.entries(schema).filter(([, value]) => is(value, PgTable)),
      ) as Record<string, PgTable>,
    );
    h.db = fake.db;
    const id = randomUUID();
    fake.insert(schema.repositories, {
      id,
      userId: USER,
      name: 'Repo',
      source: 'upload',
      renderContext: column,
    });
    fake.insert(schema.onboardingArtifacts, {
      repositoryId: id,
      userId: USER,
      generatedAt: new Date(1),
      formValuesSnapshot: { ...portable, cliTargets: ['gemini', 'future-cli'] },
    });
    fake.insert(schema.onboardingArtifacts, {
      repositoryId: id,
      userId: USER,
      generatedAt: new Date(2),
      formValuesSnapshot: { ...portable, cliTargets: [], invalid: true },
    });
    fake.insert(schema.onboardingArtifacts, {
      repositoryId: id,
      userId: USER,
      generatedAt: new Date(3),
      formValuesSnapshot: { ...portable, cliTargets: [] },
      supersededAt: new Date(4),
    });
    const before = structuredClone(fake.rows(schema.repositories));
    const response = await app.request(`/${id}/tooling-config`);
    expect(response.status).toBe(200);
    expect(fake.rows(schema.repositories)).toEqual(before);
    expect(((await response.json()) as { cliTargets: string[] }).cliTargets).toEqual([
      'gemini',
      'future-cli',
    ]);
  });
  it('keeps authoritative current [] before history', async () => {
    const fake = createFakeDb(
      Object.fromEntries(
        Object.entries(schema).filter(([, value]) => is(value, PgTable)),
      ) as Record<string, PgTable>,
    );
    h.db = fake.db;
    const id = randomUUID();
    fake.insert(schema.repositories, {
      id,
      userId: USER,
      renderContext: { ...legacy, cliTargets: [] },
    });
    fake.insert(schema.onboardingArtifacts, {
      repositoryId: id,
      userId: USER,
      formValuesSnapshot: { ...portable, cliTargets: ['gemini'] },
    });
    const response = await app.request(`/${id}/tooling-config`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { cliTargets: string[] }).cliTargets).toEqual([]);
  });
});
