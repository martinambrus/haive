import { describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/middleware/auth.js')>()),
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { get: async () => null, getBoolean: async () => true },
  userSecretsService: { get: async () => null, listForUser: async () => [] },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { MAX_AGENT_RULES_BYTES } from '@haive/shared/project-state';
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

// The real app, for the test that needs its origin guard in front of the route.
const { createApiApp } = await import('../src/index.js');

const REPO = '00000000-0000-4000-8000-0000000000c1';
const OTHER_REPO = '00000000-0000-4000-8000-0000000000c2';
const OTHER_USER = '00000000-0000-4000-8000-0000000000a2';
const OTHER_RULES = 'Rules of the other repository.\n';
const SAVED_AT = new Date('2026-01-01T00:00:00Z');

const TABLES = {
  repositories: schema.repositories,
  auditEvents: schema.auditEvents,
  tasks: schema.tasks,
  onboardingArtifacts: schema.onboardingArtifacts,
  projectStateOutbox: schema.projectStateOutbox,
  projectStateConflicts: schema.projectStateConflicts,
  envTemplates: schema.envTemplates,
  toolPackageVersions: schema.toolPackageVersions,
  stepGuidance: schema.stepGuidance,
};

const app = new Hono<AppEnv>();
app.route('/', toolingUpgradeRoutes);
app.onError(errorHandler);

type Fake = ReturnType<typeof createFakeDb>;

/** Two repositories of `owner`: REPO holding `rules` (null: follows Haive's default rules) and one
 *  that no request about REPO may touch. */
function seed(fake: Fake, rules: string | null, owner: string): Fake {
  for (const [id, override] of [
    [REPO, rules],
    [OTHER_REPO, OTHER_RULES],
  ] as const) {
    fake.insert(schema.repositories, {
      id,
      userId: owner,
      name: id,
      source: 'local_path',
      rtkEnabled: true,
      rtkVersion: '0.1.0',
      agentRulesOverride: override,
      updatedAt: SAVED_AT,
    });
  }
  h.db = fake.db;
  return fake;
}

const setup = (rules: string | null = null, owner = USER): Fake =>
  seed(createFakeDb(TABLES), rules, owner);

/** Every table the fake holds, as it stands: what a request that must write nothing is compared to. */
const everything = (fake: Fake) => Object.values(TABLES).map((table) => fake.rows(table));
const row = (fake: Fake, id = REPO) => fake.rows(schema.repositories).find((r) => r.id === id)!;
const outbox = (fake: Fake, id: string) =>
  fake.rows(schema.projectStateOutbox).find((r) => r.repositoryId === id);

const patch = (body: Record<string, unknown>) =>
  app.request(`/${REPO}/tooling`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const config = () => app.request(`/${REPO}/tooling-config`);
type RulesBody = { agentRulesOverride?: string | null; error?: string };

describe('GET tooling-config carries the AGENTS.md rules override', () => {
  it('is null while the repository follows the default rules', async () => {
    setup(null);

    const res = await config();

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('agentRulesOverride', null);
  });

  it('is the stored text', async () => {
    setup('Answer in English.\n');

    expect(((await (await config()).json()) as RulesBody).agentRulesOverride).toBe(
      'Answer in English.\n',
    );
  });

  it("is '' for an explicit empty override, not null, and the read writes nothing", async () => {
    const fake = setup('');
    const before = everything(fake);

    const body = (await (await config()).json()) as RulesBody;

    expect(body.agentRulesOverride).toBe('');
    expect(everything(fake)).toEqual(before);
    expect(fake.rows(schema.projectStateOutbox)).toEqual([]);
  });
});

describe('PATCH tooling sets, clears and resets the override', () => {
  it('stores the normalised text, bumps the outbox of that repository only and returns it', async () => {
    const fake = setup(null);

    const res = await patch({ agentRulesOverride: 'Be brief.\r\nNo emojis.' });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      repositoryId: REPO,
      ok: true,
      agentRulesOverride: 'Be brief.\nNo emojis.\n',
    });
    expect(row(fake).agentRulesOverride).toBe('Be brief.\nNo emojis.\n');
    expect(outbox(fake, REPO)).toMatchObject({ revision: 1, writtenRevision: 0 });
    expect(outbox(fake, OTHER_REPO)).toBeUndefined();
    expect(row(fake, OTHER_REPO).agentRulesOverride).toBe(OTHER_RULES);
  });

  it("stores '' for '' (an override that renders no block), never NULL, and marks", async () => {
    const fake = setup('Old rules.\n');

    const res = await patch({ agentRulesOverride: '' });

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('agentRulesOverride', '');
    expect(row(fake).agentRulesOverride).toBe('');
    expect(outbox(fake, REPO)).toMatchObject({ revision: 1 });
    expect(outbox(fake, OTHER_REPO)).toBeUndefined();
  });

  it("stores '' for whitespace-only text", async () => {
    const fake = setup(null);

    const res = await patch({ agentRulesOverride: '  \r\n\t \n' });

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('agentRulesOverride', '');
    expect(row(fake).agentRulesOverride).toBe('');
    expect(outbox(fake, REPO)).toMatchObject({ revision: 1 });
  });

  it('resets to the default (NULL) for null and marks', async () => {
    const fake = setup('Old rules.\n');

    const res = await patch({ agentRulesOverride: null });

    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty('agentRulesOverride', null);
    expect(row(fake).agentRulesOverride).toBeNull();
    expect(outbox(fake, REPO)).toMatchObject({ revision: 1 });
    expect(outbox(fake, OTHER_REPO)).toBeUndefined();
    expect(row(fake, OTHER_REPO).agentRulesOverride).toBe(OTHER_RULES);
  });

  it.each([
    ['nothing else', {}],
    ['other fields', { rtkEnabled: false, rtkVersion: '0.2.0' }],
  ])(
    'leaves a stored override alone and out of the answer when a save carries %s',
    async (_n, body) => {
      const fake = setup('Kept rules.\n');

      const res = await patch(body);

      expect(res.status).toBe(200);
      expect(await res.json()).not.toHaveProperty('agentRulesOverride');
      expect(row(fake).agentRulesOverride).toBe('Kept rules.\n');
      if (Object.keys(body).length === 0) expect(fake.rows(schema.projectStateOutbox)).toEqual([]);
    },
  );

  it('writes the column and the mark in one transaction: a mark that cannot be written takes the column back', async () => {
    const { projectStateOutbox: _outbox, ...withoutOutbox } = TABLES;
    const fake = seed(createFakeDb(withoutOutbox), 'Kept rules.\n', USER);

    const res = await patch({ agentRulesOverride: 'New rules.\n' });

    expect(res.status).toBe(500);
    expect(row(fake).agentRulesOverride).toBe('Kept rules.\n');
    expect(row(fake).updatedAt).toEqual(SAVED_AT);
  });

  it('accepts text of exactly the limit and refuses one byte more, counting bytes of the stored text', async () => {
    const fake = setup(null);

    const atLimit = 'a'.repeat(MAX_AGENT_RULES_BYTES - 1);
    expect((await patch({ agentRulesOverride: atLimit })).status).toBe(200);
    expect(row(fake).agentRulesOverride).toBe(`${atLimit}\n`);

    expect((await patch({ agentRulesOverride: 'a'.repeat(MAX_AGENT_RULES_BYTES) })).status).toBe(
      400,
    );
    expect(row(fake).agentRulesOverride).toBe(`${atLimit}\n`);
  });
});

const INVALID: [name: string, value: unknown, reason: string][] = [
  ['a number', 5, 'is not text'],
  ['a boolean', true, 'is not text'],
  ['an object', { text: 'rules' }, 'is not text'],
  ['a Haive region marker', 'Before\n<!-- haive:cli-rules -->\nAfter\n', 'region marker'],
  ['a line of exactly seven =', 'Title\n=======\n', 'seven'],
  ['a NUL', 'a\u0000b', 'NUL'],
  ['a lone surrogate', 'a\ud800b', 'lone surrogate'],
  // 32769 characters, 65538 bytes: under the limit as characters, over it as bytes.
  ['more than 64 KiB, measured in bytes', 'é'.repeat(MAX_AGENT_RULES_BYTES / 2 + 1), '64 KiB'],
];

describe('PATCH tooling refuses an override that is not valid and writes nothing', () => {
  it.each(INVALID)('answers 400 for %s', async (_name, value, reason) => {
    const fake = setup('Kept rules.\n');
    const before = everything(fake);

    // The other fields of the same request are not written either.
    const res = await patch({ rtkEnabled: false, rtkVersion: '9.9.9', agentRulesOverride: value });

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as RulesBody;
    expect(error).toMatch(/^Invalid AGENTS\.md rules: /);
    expect(error).toContain(reason);
    expect(everything(fake)).toEqual(before);
    expect(fake.rows(schema.projectStateOutbox)).toEqual([]);
  });

  it('keeps the MCP decision a request of its own', async () => {
    const fake = setup('Kept rules.\n');
    const before = everything(fake);

    const res = await patch({ repoMcpServersAction: 'accept', agentRulesOverride: 'New.\n' });

    expect(res.status).toBe(400);
    expect(((await res.json()) as RulesBody).error).toMatch(/request of their own/);
    expect(everything(fake)).toEqual(before);
    expect(fake.rows(schema.projectStateOutbox)).toEqual([]);
  });
});

describe('the override is scoped to its owner and to the app itself', () => {
  it("answers 404 on another user's repository and writes nothing", async () => {
    const fake = setup('Their rules.\n', OTHER_USER);
    const before = everything(fake);

    expect((await patch({ agentRulesOverride: 'Mine now.\n' })).status).toBe(404);
    expect((await patch({ agentRulesOverride: null })).status).toBe(404);
    expect((await config()).status).toBe(404);

    expect(everything(fake)).toEqual(before);
    expect(fake.rows(schema.projectStateOutbox)).toEqual([]);
  });

  describe('a save through the real app', () => {
    const web = createApiApp('http://localhost:3000');
    const save = (origin?: string) =>
      web.request(`/repositories/${REPO}/tooling`, {
        method: 'PATCH',
        headers: {
          host: 'localhost:3001',
          'content-type': 'application/json',
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ agentRulesOverride: 'Rules from a page.\n' }),
      });

    it.each(['http://localhost:5173', 'null'])(
      'from another page (Origin %s) is refused before the route reads it',
      async (origin) => {
        const fake = setup('Kept rules.\n');
        const before = everything(fake);

        const res = await save(origin);

        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: 'Refused a request from another page' });
        expect(everything(fake)).toEqual(before);
        expect(fake.rows(schema.projectStateOutbox)).toEqual([]);
      },
    );

    it.each([
      ['the app itself', 'http://localhost:3000'],
      ['no page at all', undefined],
    ])('from %s is past the guard and stored', async (_who, origin) => {
      const fake = setup('Kept rules.\n');

      const res = await save(origin);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ agentRulesOverride: 'Rules from a page.\n' });
      expect(row(fake).agentRulesOverride).toBe('Rules from a page.\n');
      expect(outbox(fake, REPO)).toMatchObject({ revision: 1 });
    });
  });
});
