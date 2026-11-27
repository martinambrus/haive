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
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const OTHER_REPO = '00000000-0000-4000-8000-0000000000c2';
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

const patch = (body: Record<string, unknown>) =>
  app.request(`/${REPO}/tooling`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const HOSTILE = [
  '1.2.3\nRUN id',
  '$(id)',
  '`id`',
  '1.2.3;id',
  '"1.2.3"',
  "'1.2.3'",
  '-latest',
  '1 2',
  '1\0x',
  '１.2.3',
  '1.2.3\n',
  ' 1.2.3',
  '1.2.3\u2028',
  'a'.repeat(65),
  'file:/tmp/tooling-pin-probe',
  'git+https://example.invalid/tool.git',
  'https://example.invalid/tool.tgz',
  'npm:other-package@1.2.3',
  '1.2.3 --package=other-package',
];
const VALID = ['1.2.3', 'v1.0.1', '1.18.4', 'latest', '2.0.0-rc.1', '1.0.0+build.5'];
describe('tooling version saves', () => {
  for (const field of ['rtkVersion', 'lspServerVersions', 'chromeDevtoolsMcpVersion']) {
    const bodyOf = (token: string) => ({
      rtkEnabled: false,
      [field]: field === 'lspServerVersions' ? { 'intelephense-extended': token } : token,
    });
    it.each(HOSTILE)(`${field} refuses %j with no writes`, async (token) => {
      const fake = setup();
      const before = everything(fake);
      const res = await patch(bodyOf(token));
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty('error', expect.stringMatching(/version|token/i));
      expect(everything(fake)).toEqual(before);
    });
    it.each(VALID)(`${field} saves %s unchanged`, async (token) => {
      const fake = setup();
      expect((await patch(bodyOf(token))).status).toBe(200);
      expect(row(fake)[field]).toEqual(
        field === 'lspServerVersions' ? { 'intelephense-extended': token } : token,
      );
    });
  }
});

it('refuses a cached upgrade token with no writes', async () => {
  const fake = setup();
  fake.insert(schema.toolPackageVersions, {
    name: 'rtk',
    versions: ['9.9.9$(id)'],
    latestVersion: '9.9.9$(id)',
  });
  const before = everything(fake);
  const res = await app.request(`/${REPO}/tooling-upgrade`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(res.status).toBe(400);
  expect(await res.json()).toHaveProperty('error', expect.stringMatching(/version token/));
  expect(everything(fake)).toEqual(before);
});

it('does not carry an invalid stored LSP pin through an unrelated cached upgrade', async () => {
  const fake = setup();
  fake.patch(schema.repositories, REPO, { lspServerVersions: { pyright: '$(id)' } });
  fake.insert(schema.toolPackageVersions, {
    name: 'rtk',
    versions: ['9.9.9'],
    latestVersion: '9.9.9',
  });
  const before = everything(fake);
  const res = await app.request(`/${REPO}/tooling-upgrade`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(res.status).toBe(400);
  expect(everything(fake)).toEqual(before);
});

// Feed rows bypass the PATCH boundary. Exercise both newestFor branches, with each
// tool that upgrade-apply can persist; rust-analyzer and jdtls are not pinnable.
describe('stored tool upgrade feed cannot introduce non-version operands', () => {
  for (const [component, tool] of [
    ['rtk', 'rtk'],
    ['chrome-devtools-mcp', 'chrome-devtools-mcp'],
    ['intelephense', 'intelephense'],
    ['intelephense-extended', 'intelephense'],
    ['vtsls', 'vtsls'],
    ['pyright', 'pyright'],
    ['gopls', 'gopls'],
    ['solargraph', 'solargraph'],
  ] as const) {
    for (const source of ['head', 'latest']) {
      it(`${component} applies a valid ${source} upgrade`, async () => {
        const fake = setup();
        fake.patch(schema.repositories, REPO, {
          chromeDevtoolsMcpVersion: '0.1.0',
          lspServerVersions: { [component]: '0.1.0' },
        });
        fake.insert(schema.toolPackageVersions, {
          name: tool,
          versions: source === 'head' ? ['9.9.9'] : [],
          latestVersion: '9.9.9',
        });
        const res = await app.request(`/${REPO}/tooling-upgrade`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ components: [component] }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toHaveProperty('applied', [
          { component, from: '0.1.0', to: '9.9.9' },
        ]);
        const stored = row(fake);
        expect(
          component === 'rtk'
            ? stored.rtkVersion
            : component === 'chrome-devtools-mcp'
              ? stored.chromeDevtoolsMcpVersion
              : (stored.lspServerVersions as Record<string, string>)[component],
        ).toBe('9.9.9');
      });
      it.each([
        '9.9.9\nRUN id',
        '9.9.9$(id)',
        '9.9.9 --package=other-package',
        'file:/tmp/tooling-pin-probe',
        'git+https://example.invalid/tool.git',
        'https://example.invalid/tool.tgz',
        'npm:other-package@1.2.3',
      ])(`${component} refuses or skips ${source} %j without writes`, async (pin) => {
        const fake = setup();
        fake.patch(schema.repositories, REPO, {
          rtkVersion: '0.1.0',
          chromeDevtoolsMcpVersion: '0.1.0',
          lspServerVersions: { [component]: '0.1.0' },
        });
        fake.insert(schema.toolPackageVersions, {
          name: tool,
          versions: source === 'head' ? [pin] : [],
          latestVersion: pin,
        });
        const before = everything(fake);
        const res = await app.request(`/${REPO}/tooling-upgrade`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ components: [component] }),
        });
        // isNewer skips specs without a numeric version prefix. Others reach
        // assertVersionToken and are refused before any transaction or write.
        expect(res.status).toBe(pin.startsWith('9.9.9') ? 400 : 200);
        if (res.status === 200) expect(await res.json()).toHaveProperty('applied', []);
        expect(everything(fake)).toEqual(before);
      });
    }
  }
});
