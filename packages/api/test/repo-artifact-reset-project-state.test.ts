import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
// The claim's own writes use a condition the fake has no builder for; what it protects is not under test.
vi.mock('@haive/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/database')>()),
  acquireRootClaim: async () => ({ release: async () => true, lost: () => false }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import { bundleFileName, claimFileName } from '@haive/shared/project-state';
import { repoRoutes, resetOnboardingArtifacts } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

const FORMAT = '.haive-data/state/format.json';
const RENDER = '.haive-data/state/project/render.json';
const PROJECT_DIR = '.haive-data/state/project';
const STATE_DIR = '.haive-data/state';
const ARTIFACTS_DIR = '.haive-data/state/artifacts';
const BUNDLES_DIR = '.haive-data/state/bundles';
const SETTINGS_DIR = '.haive-data/state/settings';
const ENVIRONMENT = '.haive-data/state/project/environment.json';
const setting = (name: string) => `${SETTINGS_DIR}/${name}.json`;
const AGENT = '.claude/agents/code-reviewer.md';
const claimFile = (diskPath: string) => `${STATE_DIR}/${claimFileName(diskPath)}`;
const bundleFile = (source: string) => `${STATE_DIR}/${bundleFileName(source)}`;
const ZIP_SOURCE = 'zip:team-skills';
const BASE_SOURCE = 'git:https%3A%2F%2Fexample.test%2Fx.git#main';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const exists = async (root: string, rel: string): Promise<boolean> =>
  (await lstatNoFollow(root, rel)) !== null;

/** A repository root holding what 12 leaves under `.haive-data/state/`, and a plan snapshot beside it. */
async function repoRoot(extra: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reset-project-state-'));
  dirs.push(root);
  const files = {
    [FORMAT]: '{"schemaVersion":1}\n',
    [RENDER]: '{"framework":null}\n',
    '.haive-data/plan.json': '{}\n',
    ...extra,
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text, 'utf8');
  }
  return root;
}

const noProvenance = {
  writtenHashes: new Map<string, string>(),
  haiveDirs: new Set<string>(),
  haiveEntries: new Map<string, string | null>(),
};

describe('the reset takes back the project state onboarding recorded', () => {
  it('removes both record files and the two directories that held them', async () => {
    const root = await repoRoot();

    const { removed } = await resetOnboardingArtifacts(root, noProvenance);

    for (const rel of [FORMAT, RENDER, PROJECT_DIR, STATE_DIR]) {
      expect(await exists(root, rel), rel).toBe(false);
      expect(removed, rel).toContain(rel);
    }
    // `.haive-data` holds more than onboarding's own: the plan snapshot is not the reset's.
    expect(await exists(root, '.haive-data/plan.json')).toBe(true);
  });

  it('keeps `.haive-data/state` while a file somebody put there is in it', async () => {
    const root = await repoRoot({ [`${STATE_DIR}/mine.md`]: 'mine\n' });

    const { removed } = await resetOnboardingArtifacts(root, noProvenance);

    expect(await exists(root, FORMAT)).toBe(false);
    expect(await exists(root, RENDER)).toBe(false);
    expect(await exists(root, PROJECT_DIR)).toBe(false);
    expect(await readFile(path.join(root, STATE_DIR, 'mine.md'), 'utf8')).toBe('mine\n');
    expect(removed).not.toContain(STATE_DIR);
  });

  it('keeps `.haive-data/state/project`, and so `.haive-data/state`, while a file of theirs is in it', async () => {
    const root = await repoRoot({ [`${PROJECT_DIR}/mine.json`]: '{}\n' });

    const { removed } = await resetOnboardingArtifacts(root, noProvenance);

    expect(await exists(root, RENDER)).toBe(false);
    expect(await exists(root, FORMAT)).toBe(false);
    expect(await readFile(path.join(root, PROJECT_DIR, 'mine.json'), 'utf8')).toBe('{}\n');
    expect(removed).not.toContain(PROJECT_DIR);
    expect(removed).not.toContain(STATE_DIR);
  });
});

describe('the reset takes back the claim files of the rows it supersedes', () => {
  const provenance = (...paths: string[]) => ({
    ...noProvenance,
    writtenHashes: new Map(paths.map((p) => [p, 'h'.repeat(64)])),
  });

  it('removes a claim file per live row and the empty directory that held them', async () => {
    const marker = '.claude/agents/imported.md';
    const root = await repoRoot({
      [claimFile(AGENT)]: '{}\n',
      [claimFile(marker)]: '{}\n',
    });

    const { removed } = await resetOnboardingArtifacts(root, provenance(AGENT, marker));

    for (const rel of [claimFile(AGENT), claimFile(marker), ARTIFACTS_DIR, STATE_DIR]) {
      expect(await exists(root, rel), rel).toBe(false);
      expect(removed, rel).toContain(rel);
    }
  });

  it.each(['.git/config', '.git./config'])(
    'removes the claim file of a live row at git-data path %j an earlier release recorded',
    async (legacy) => {
      const root = await repoRoot({ [claimFile(AGENT)]: '{}\n', [claimFile(legacy)]: '{}\n' });

      const { removed } = await resetOnboardingArtifacts(root, provenance(AGENT, legacy));

      expect(await exists(root, claimFile(legacy))).toBe(false);
      expect(removed).toContain(claimFile(legacy));
    },
  );

  it('leaves a claim file no live row names, and the directory around it', async () => {
    const teammate = '.claude/agents/teammate.md';
    const root = await repoRoot({
      [claimFile(AGENT)]: '{}\n',
      [claimFile(teammate)]: '{"unsynced":true}\n',
    });

    const { removed } = await resetOnboardingArtifacts(root, provenance(AGENT));

    expect(await exists(root, claimFile(AGENT))).toBe(false);
    expect(await readFile(path.join(root, claimFile(teammate)), 'utf8')).toBe(
      '{"unsynced":true}\n',
    );
    expect(removed).not.toContain(ARTIFACTS_DIR);
    expect(removed).not.toContain(STATE_DIR);
  });
});

describe('the reset takes back the bundle descriptors of the record', () => {
  it('removes the descriptor of each source it is given, and the empty directory that held them', async () => {
    const root = await repoRoot({
      [bundleFile(ZIP_SOURCE)]: '{}\n',
      [bundleFile(BASE_SOURCE)]: '{}\n',
    });

    const { removed } = await resetOnboardingArtifacts(root, {
      ...noProvenance,
      bundleSources: [ZIP_SOURCE, BASE_SOURCE],
    });

    for (const rel of [bundleFile(ZIP_SOURCE), bundleFile(BASE_SOURCE), BUNDLES_DIR, STATE_DIR]) {
      expect(await exists(root, rel), rel).toBe(false);
      expect(removed, rel).toContain(rel);
    }
  });

  it('leaves a descriptor no source names, and the directory around it', async () => {
    const root = await repoRoot({
      [bundleFile(ZIP_SOURCE)]: '{}\n',
      [bundleFile(BASE_SOURCE)]: '{"unsynced":true}\n',
    });

    const { removed } = await resetOnboardingArtifacts(root, {
      ...noProvenance,
      bundleSources: [ZIP_SOURCE],
    });

    expect(await exists(root, bundleFile(ZIP_SOURCE))).toBe(false);
    expect(await readFile(path.join(root, bundleFile(BASE_SOURCE)), 'utf8')).toBe(
      '{"unsynced":true}\n',
    );
    expect(removed).not.toContain(BUNDLES_DIR);
    expect(removed).not.toContain(STATE_DIR);
  });
});

describe('the reset takes back the settings and the environment of the record', () => {
  it('removes the environment, every settings file this release writes and the directories that held them', async () => {
    const root = await repoRoot({
      [ENVIRONMENT]: '{}\n',
      [setting('scope-exclude-globs')]: '[]\n',
      [setting('rtk-enabled')]: 'true\n',
      [setting('onboarding-tooling')]: '{}\n',
    });

    const { removed } = await resetOnboardingArtifacts(root, noProvenance);

    for (const rel of [
      ENVIRONMENT,
      setting('scope-exclude-globs'),
      setting('onboarding-tooling'),
      SETTINGS_DIR,
      STATE_DIR,
    ]) {
      expect(await exists(root, rel), rel).toBe(false);
      expect(removed, rel).toContain(rel);
    }
  });

  it('removes a settings file only the sync base names', async () => {
    const root = await repoRoot({ [setting('from-a-newer-release')]: '1\n' });

    await resetOnboardingArtifacts(root, {
      ...noProvenance,
      settingNames: ['from-a-newer-release'],
    });

    expect(await exists(root, setting('from-a-newer-release'))).toBe(false);
    expect(await exists(root, SETTINGS_DIR)).toBe(false);
    expect(await exists(root, STATE_DIR)).toBe(false);
  });

  it('leaves a settings file nothing names, and the directories around it', async () => {
    const root = await repoRoot({ [setting('from-a-newer-release')]: '1\n' });

    const { removed } = await resetOnboardingArtifacts(root, noProvenance);

    expect(await exists(root, setting('from-a-newer-release'))).toBe(true);
    expect(removed).not.toContain(SETTINGS_DIR);
    expect(removed).not.toContain(STATE_DIR);
  });
});

/** The statements the route's closing transaction makes, against the fake. The provenance query joins
 *  `task_steps` to `tasks`, which the fake has no builder for; a repository with no onboarding run
 *  has no rows to read there. */
async function setup(root: string, snapshot: Record<string, unknown> = {}) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    tasks: schema.tasks,
    onboardingArtifacts: schema.onboardingArtifacts,
    projectStateSync: schema.projectStateSync,
    projectStateConflicts: schema.projectStateConflicts,
    projectStateOutbox: schema.projectStateOutbox,
    customBundles: schema.customBundles,
  });
  const context = {
    projectInfo: {},
    framework: null,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
    rtkChoiceRecorded: true,
  };
  for (const [id, storagePath] of [
    [REPO, root],
    [OTHER, '/elsewhere'],
  ] as const) {
    fake.insert(schema.repositories, {
      id,
      userId: USER,
      name: id,
      status: 'ready',
      storagePath,
      onboardedAt: new Date('2026-01-01T00:00:00Z'),
      renderContext: context,
    });
    fake.insert(schema.projectStateSync, {
      repositoryId: id,
      baseSnapshot: { render: context, ...snapshot },
    });
    fake.insert(schema.projectStateOutbox, { repositoryId: id, revision: 2, writtenRevision: 1 });
    fake.insert(schema.projectStateConflicts, {
      repositoryId: id,
      unit: 'project/render.json#framework',
      base: { v: 'a' },
      local: { v: 'b' },
      incoming: { v: 'c' },
    });
  }
  fake.insert(schema.projectStateConflicts, {
    repositoryId: REPO,
    unit: 'project/render.json#acceptedAgentIds',
    base: { v: [] },
    local: { v: ['x'] },
    incoming: { v: ['y'] },
    resolution: 'keep_mine',
    resolvedAt: new Date(1),
  });
  const noRows = (): unknown => {
    const query: Record<string, unknown> = {};
    for (const method of ['innerJoin', 'where', 'orderBy']) query[method] = () => query;
    query.then = (ok: (rows: unknown[]) => unknown, bad: (err: unknown) => unknown) =>
      Promise.resolve([]).then(ok, bad);
    return query;
  };
  h.db = {
    ...fake.db,
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) =>
        table === schema.taskSteps ? noRows() : fake.db.select(fields).from(table as never),
    }),
  };
  return fake;
}

const app = new Hono<AppEnv>();
app.route('/', repoRoutes);
app.onError(errorHandler);

const reset = () => app.request(`/${REPO}/onboarding-artifacts`, { method: 'DELETE' });

describe('resetting a repository through the route', () => {
  it('takes the record files and their directories off its checkout', async () => {
    const root = await repoRoot();
    await setup(root);

    const res = await reset();

    expect(res.status).toBe(200);
    const { removed } = (await res.json()) as { removed: string[] };
    expect(removed).toEqual(expect.arrayContaining([FORMAT, RENDER, PROJECT_DIR, STATE_DIR]));
    expect(await exists(root, STATE_DIR)).toBe(false);
  });

  it('takes the claim files of its live rows off the checkout, with their directory', async () => {
    const root = await repoRoot({ [claimFile(AGENT)]: '{}\n' });
    const fake = await setup(root);
    fake.insert(schema.onboardingArtifacts, {
      userId: USER,
      repositoryId: REPO,
      taskId: null,
      diskPath: AGENT,
      templateId: 'agent.code-reviewer',
      templateKind: 'agent',
      templateSchemaVersion: 1,
      templateContentHash: 'a'.repeat(64),
      writtenHash: 'b'.repeat(64),
      sourceStepId: 'project-state-import',
      source: 'backfill',
      importedAt: new Date(1),
    });

    expect((await reset()).status).toBe(200);

    expect(await exists(root, claimFile(AGENT))).toBe(false);
    expect(await exists(root, ARTIFACTS_DIR)).toBe(false);
    expect(await exists(root, STATE_DIR)).toBe(false);
  });

  it('takes the descriptors of the sync base and of its local bundles off the checkout', async () => {
    const root = await repoRoot({
      [bundleFile(ZIP_SOURCE)]: '{}\n',
      [bundleFile(BASE_SOURCE)]: '{}\n',
    });
    const fake = await setup(root, { bundles: [{ source: BASE_SOURCE, name: 'theirs' }] });
    fake.insert(schema.customBundles, {
      userId: USER,
      repositoryId: REPO,
      name: 'team-skills',
      sourceType: 'zip',
      storageRoot: '/bundles/team-skills',
    });

    expect((await reset()).status).toBe(200);

    expect(await exists(root, bundleFile(ZIP_SOURCE))).toBe(false);
    expect(await exists(root, bundleFile(BASE_SOURCE))).toBe(false);
    expect(await exists(root, BUNDLES_DIR)).toBe(false);
    expect(await exists(root, STATE_DIR)).toBe(false);
  });

  it('takes the settings and the environment off the checkout, the base’s unknown names too, so a later sync finds no record', async () => {
    const root = await repoRoot({
      [ENVIRONMENT]: '{}\n',
      [setting('rtk-enabled')]: 'true\n',
      [setting('from-a-newer-release')]: '1\n',
    });
    await setup(root, { settings: { 'from-a-newer-release': 1 } });

    expect((await reset()).status).toBe(200);

    expect(await exists(root, ENVIRONMENT)).toBe(false);
    expect(await exists(root, setting('rtk-enabled'))).toBe(false);
    expect(await exists(root, setting('from-a-newer-release'))).toBe(false);
    expect(await exists(root, STATE_DIR)).toBe(false);
  });

  it('clears the render context it recorded, beside the onboarded stamp, and only on that repository', async () => {
    const fake = await setup(await repoRoot());

    expect((await reset()).status).toBe(200);

    const rows = fake.rows(schema.repositories);
    const mine = rows.find((r) => r.id === REPO)!;
    expect(mine.onboardedAt).toBeNull();
    expect(mine.onboardingResetAt).toBeInstanceOf(Date);
    expect(mine.renderContext).toBeNull();
    expect(rows.find((r) => r.id === OTHER)!.renderContext).not.toBeNull();
  });

  it('drops the sync record that goes with it, and only that repository’s', async () => {
    const fake = await setup(await repoRoot());

    expect((await reset()).status).toBe(200);

    expect(fake.rows(schema.projectStateSync).map((r) => r.repositoryId)).toEqual([OTHER]);
  });
});

describe('resetting a repository with a dirty project state outbox', () => {
  it('deletes its outbox row, and only that repository’s', async () => {
    const fake = await setup(await repoRoot());

    expect((await reset()).status).toBe(200);

    expect(fake.rows(schema.projectStateOutbox).map((r) => r.repositoryId)).toEqual([OTHER]);
  });
});

describe('resetting a repository with project state conflicts', () => {
  it('deletes its conflict rows, pending and answered alike, and only that repository’s', async () => {
    const fake = await setup(await repoRoot());

    expect((await reset()).status).toBe(200);

    expect(fake.rows(schema.projectStateConflicts).map((r) => r.repositoryId)).toEqual([OTHER]);
  });

  it('leaves a plan question alone: the reset takes back files, not the plan', async () => {
    const fake = await setup(await repoRoot());
    const unit = 'plan/00000000-0000-4000-8000-0000000000c1#title';
    fake.insert(schema.projectStateConflicts, {
      repositoryId: REPO,
      unit,
      base: { v: 'a' },
      local: { v: 'b' },
      incoming: { v: 'c' },
    });

    expect((await reset()).status).toBe(200);

    expect(fake.rows(schema.projectStateConflicts).map((r) => [r.repositoryId, r.unit])).toEqual([
      [OTHER, 'project/render.json#framework'],
      [REPO, unit],
    ]);
  });
});

describe('reset recorded CLI member units', () => {
  const CLI_DIR = `${STATE_DIR}/cli`;
  const cli = (name: string) => `${CLI_DIR}/${name}.json`;
  it('removes known and future recorded members by name and sweeps the empty CLI/state directories', async () => {
    const names = ['claude-code', 'codex', 'future-cli'];
    const root = await repoRoot(
      Object.fromEntries(names.map((name) => [cli(name), JSON.stringify({ provider: name })])),
    );
    const evidence = { ...noProvenance, cliNames: names };
    const { removed } = await resetOnboardingArtifacts(root, evidence);
    for (const rel of [...names.map(cli), CLI_DIR, STATE_DIR]) {
      expect.soft(await exists(root, rel), rel).toBe(false);
      expect.soft(removed, rel).toContain(rel);
    }
    expect(await readFile(path.join(root, '.haive-data/plan.json'), 'utf8')).toBe('{}\n');
  });
  it('sweeps an empty CLI directory even when the authoritative member list is empty', async () => {
    const root = await repoRoot();
    await mkdir(path.join(root, CLI_DIR));
    const evidence = { ...noProvenance, cliNames: [] };
    const { removed } = await resetOnboardingArtifacts(root, evidence);
    expect.soft(await exists(root, CLI_DIR)).toBe(false);
    expect.soft(removed).toContain(CLI_DIR);
    expect.soft(await exists(root, STATE_DIR)).toBe(false);
  });
  it('leaves unproven member files and unrelated CLI contents, preserving the directory around them', async () => {
    const root = await repoRoot({
      [cli('mine')]: 'my record\n',
      [`${CLI_DIR}/notes.txt`]: 'notes\n',
    });
    await resetOnboardingArtifacts(root, noProvenance);
    expect(await readFile(path.join(root, cli('mine')), 'utf8')).toBe('my record\n');
    expect(await readFile(path.join(root, CLI_DIR, 'notes.txt'), 'utf8')).toBe('notes\n');
    expect(await exists(root, CLI_DIR)).toBe(true);
  });
  it('removes only named leaves when a recorded member shares cli/ with unproven contents', async () => {
    const root = await repoRoot({
      [cli('future-cli')]: '{"provider":"future-cli"}\n',
      [cli('mine')]: 'user metadata\n',
      [`${CLI_DIR}/notes.txt`]: 'notes\n',
    });
    const evidence = { ...noProvenance, cliNames: ['future-cli'] };
    await resetOnboardingArtifacts(root, evidence);
    expect(await exists(root, cli('future-cli'))).toBe(false);
    expect(await readFile(path.join(root, cli('mine')), 'utf8')).toBe('user metadata\n');
    expect(await readFile(path.join(root, CLI_DIR, 'notes.txt'), 'utf8')).toBe('notes\n');
    expect(await exists(root, CLI_DIR)).toBe(true);
  });
  it('rejects invalid provider names instead of interpreting them as paths', async () => {
    const root = await repoRoot({
      [`${STATE_DIR}/escape.json`]: 'outside cli\n',
      [cli('mine')]: 'unproven\n',
    });
    const evidence = {
      ...noProvenance,
      cliNames: ['../escape', 'mine/../../escape', 'bad_name', '', '.git'],
    };
    await resetOnboardingArtifacts(root, evidence);
    expect(await readFile(path.join(root, STATE_DIR, 'escape.json'), 'utf8')).toBe('outside cli\n');
    expect(await readFile(path.join(root, cli('mine')), 'utf8')).toBe('unproven\n');
  });
  it('never traverses a linked CLI directory or removes its outside member', async () => {
    const root = await repoRoot(),
      outside = await repoRoot();
    await writeFile(path.join(outside, 'future-cli.json'), 'outside\n');
    await symlink(outside, path.join(root, CLI_DIR));
    const evidence = { ...noProvenance, cliNames: ['future-cli'] };
    await resetOnboardingArtifacts(root, evidence);
    expect(await readFile(path.join(outside, 'future-cli.json'), 'utf8')).toBe('outside\n');
    expect(await exists(root, CLI_DIR)).toBe(true);
  });
  it('unlinks a proven member leaf link without following it to an outside file', async () => {
    const root = await repoRoot(),
      outside = await repoRoot();
    await writeFile(path.join(outside, 'member.json'), 'outside\n');
    await mkdir(path.join(root, CLI_DIR));
    await symlink(path.join(outside, 'member.json'), path.join(root, cli('future-cli')));
    const evidence = { ...noProvenance, cliNames: ['future-cli'] };
    await resetOnboardingArtifacts(root, evidence);
    expect.soft(await exists(root, cli('future-cli'))).toBe(false);
    expect(await readFile(path.join(outside, 'member.json'), 'utf8')).toBe('outside\n');
  });
});
