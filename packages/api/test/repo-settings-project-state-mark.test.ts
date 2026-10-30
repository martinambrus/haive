import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
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
  userSecretsService: { get: async () => null },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { repoRoutes } from '../src/routes/repos.js';
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';
const RULES = 'Rules that stay out of the generic repository payloads.\n';

const app = new Hono<AppEnv>();
app.route('/repos', repoRoutes);
app.route('/tooling', toolingUpgradeRoutes);
app.onError(errorHandler);

let fake: ReturnType<typeof createFakeDb>;
beforeEach(() => {
  fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    projectStateOutbox: schema.projectStateOutbox,
    envTemplates: schema.envTemplates,
    toolPackageVersions: schema.toolPackageVersions,
    stepGuidance: schema.stepGuidance,
    projectStateConflicts: schema.projectStateConflicts,
  });
  for (const id of [REPO, OTHER]) {
    fake.insert(schema.repositories, {
      id,
      userId: USER,
      name: id,
      source: 'local_path',
      rtkEnabled: true,
      rtkVersion: '0.1.0',
      fileTree: { files: ['a.ts'] },
      renderContext: { rtkEnabled: true },
      agentRulesOverride: RULES,
    });
  }
  h.db = fake.db;
});

const outbox = (id: string) =>
  fake.rows(schema.projectStateOutbox).find((r) => r.repositoryId === id);
const send = (path: string, method: string, body: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('a settings edit marks the project state record dirty', () => {
  it('PATCH exclusions stores the list and bumps the outbox of that repository only', async () => {
    const res = await send(`/repos/${REPO}/exclusions`, 'PATCH', {
      scopeExcludeGlobs: ['vendor/', 'node_modules'],
    });

    expect(res.status).toBe(200);
    const { repository } = (await res.json()) as { repository: Record<string, unknown> };
    expect(repository).not.toHaveProperty('fileTree');
    expect(repository).not.toHaveProperty('renderContext');
    expect(repository).not.toHaveProperty('agentRulesOverride');
    expect(fake.rows(schema.repositories).find((r) => r.id === REPO)?.scopeExcludeGlobs).toEqual([
      'node_modules',
      'vendor',
    ]);
    expect(outbox(REPO)).toMatchObject({ revision: 1, writtenRevision: 0 });
    expect(outbox(OTHER)).toBeUndefined();

    await send(`/repos/${REPO}/exclusions`, 'PATCH', { scopeExcludeGlobs: [] });
    expect(outbox(REPO)).toMatchObject({ revision: 2 });
  });

  it('PATCH tooling marks it for a portable setting', async () => {
    for (const body of [
      { rtkEnabled: false },
      { rtkVersion: '0.2.0' },
      { lspServers: ['vtsls'] },
      { lspServerVersions: { vtsls: '1.0.0' } },
      { chromeDevtoolsMcpVersion: '0.9.0' },
      { reviewDimensions: ['security'] },
      { agentRulesOverride: 'Keep answers short.\n' },
      { agentRulesOverride: '' },
      { agentRulesOverride: null },
    ]) {
      const before = (outbox(REPO)?.revision as number | undefined) ?? 0;
      expect((await send(`/tooling/${REPO}/tooling`, 'PATCH', body)).status).toBe(200);
      expect(outbox(REPO)?.revision, JSON.stringify(body)).toBe(before + 1);
    }
    expect(outbox(OTHER)).toBeUndefined();
  });

  it('PATCH tooling leaves it clean for a setting that stays on this machine', async () => {
    for (const body of [
      { secretMaskEnabled: false },
      { verifyCommands: { test: 'npm test' } },
      { appAuth: { loginUrl: 'https://example.test/login' } },
    ]) {
      expect((await send(`/tooling/${REPO}/tooling`, 'PATCH', body)).status).toBe(200);
    }

    expect(outbox(REPO)).toBeUndefined();
  });

  it('POST tooling-upgrade marks it when a pin moved, and not when none did', async () => {
    expect((await send(`/tooling/${REPO}/tooling-upgrade`, 'POST', {})).status).toBe(200);
    expect(outbox(REPO)).toBeUndefined();

    fake.insert(schema.toolPackageVersions, {
      name: 'rtk',
      versions: ['0.3.0', '0.1.0'],
      latestVersion: '0.3.0',
    });
    const res = await send(`/tooling/${REPO}/tooling-upgrade`, 'POST', {});

    expect(res.status).toBe(200);
    expect(fake.rows(schema.repositories).find((r) => r.id === REPO)?.rtkVersion).toBe('0.3.0');
    expect(outbox(REPO)).toMatchObject({ revision: 1 });
    expect(outbox(OTHER)).toBeUndefined();
  });
});

describe('repository CLI removal is explicit', () => {
  const context = () => ({
    projectInfo: {},
    framework: null,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
    cliTargets: ['claude-code', 'codex', 'future-cli'],
    rtkChoiceRecorded: false,
  });
  const put = () => {
    fake.patch(schema.repositories, REPO, { renderContext: context() });
  };
  it('a partial tooling save never removes teammates CLIs', async () => {
    put();
    expect((await send(`/tooling/${REPO}/tooling`, 'PATCH', { rtkEnabled: false })).status).toBe(
      200,
    );
    expect(fake.rows(schema.repositories).find((r) => r.id === REPO)?.renderContext).toEqual(
      context(),
    );
  });
  it('requires an exact observed list, then removes only selected members and marks the outbox', async () => {
    put();
    expect(
      (
        await send(`/tooling/${REPO}/cli-targets/remove`, 'POST', {
          providers: ['claude-code'],
          expectedTargets: ['codex'],
        })
      ).status,
    ).toBe(409);
    expect(outbox(REPO)).toBeUndefined();
    const response = await send(`/tooling/${REPO}/cli-targets/remove`, 'POST', {
      providers: ['claude-code'],
      expectedTargets: context().cliTargets,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cliTargets: ['codex', 'future-cli'] });
    expect(fake.rows(schema.repositories).find((r) => r.id === REPO)?.renderContext).toMatchObject({
      cliTargets: ['codex', 'future-cli'],
      agentTargets: [{ dir: '.codex/agents', format: 'toml' }],
    });
    expect(outbox(REPO)).toMatchObject({ revision: 1 });
    expect(outbox(OTHER)).toBeUndefined();
  });
  it('an unowned repository and absent/invalid action cannot mutate state', async () => {
    put();
    expect((await send(`/tooling/${REPO}/cli-targets/remove`, 'POST', {})).status).toBe(400);
    fake.patch(schema.repositories, REPO, { userId: 'someone-else' });
    expect(
      (
        await send(`/tooling/${REPO}/cli-targets/remove`, 'POST', {
          providers: ['claude-code'],
          expectedTargets: context().cliTargets,
        })
      ).status,
    ).toBe(404);
    expect(outbox(REPO)).toBeUndefined();
  });
  it('a running upgrade or pending filesystem journal holds removal', async () => {
    put();
    fake.insert(schema.projectStateOutbox, {
      repositoryId: REPO,
      revision: 1,
      writtenRevision: 0,
      writeIntent: { pending: true },
    });
    const action = { providers: ['claude-code'], expectedTargets: context().cliTargets };
    expect((await send(`/tooling/${REPO}/cli-targets/remove`, 'POST', action)).status).toBe(409);
    await fake.db.update(schema.projectStateOutbox).set({ writeIntent: null });
    fake.insert(schema.tasks, {
      repositoryId: REPO,
      type: 'onboarding_upgrade',
      status: 'waiting_form',
      deadAt: null,
    });
    expect((await send(`/tooling/${REPO}/cli-targets/remove`, 'POST', action)).status).toBe(409);
    expect(fake.rows(schema.repositories).find((r) => r.id === REPO)?.renderContext).toEqual(
      context(),
    );
  });
});

it('an unchanged removal action cannot clear an inherited Amp fallback', async () => {
  const inherited = {
    projectInfo: {},
    framework: null,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
    rtkChoiceRecorded: false,
    cliTargets: ['amp'],
    legacyAgentFallback: true,
    agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: false }],
  };
  fake.patch(schema.repositories, REPO, { renderContext: inherited });
  const response = await send(`/tooling/${REPO}/cli-targets/remove`, 'POST', {
    providers: ['codex'],
    expectedTargets: ['amp'],
  });
  expect(response.status).toBe(200);
  expect(fake.rows(schema.repositories).find((row) => row.id === REPO)?.renderContext).toEqual(
    inherited,
  );
  expect(outbox(REPO)).toBeUndefined();
});

it('a real removal clears inherited fallback metadata for the subsequent obsolete/Keep preview', async () => {
  const inherited = {
    projectInfo: {},
    framework: null,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
    rtkChoiceRecorded: false,
    cliTargets: ['amp'],
    legacyAgentFallback: true,
    agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: false }],
  };
  fake.patch(schema.repositories, REPO, { renderContext: inherited });
  expect(
    (
      await send(`/tooling/${REPO}/cli-targets/remove`, 'POST', {
        providers: ['amp'],
        expectedTargets: ['amp'],
      })
    ).status,
  ).toBe(200);
  expect(fake.rows(schema.repositories).find((r) => r.id === REPO)?.renderContext).toMatchObject({
    cliTargets: [],
    legacyAgentFallback: false,
    agentTargets: [],
  });
  expect(outbox(REPO)).toMatchObject({ revision: 1 });
});
