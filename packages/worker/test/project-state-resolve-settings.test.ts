import { gitRun } from '../src/repo/git-exec.js';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  conflictSide,
  emptyProjectState,
  normalizeProjectState,
  type ProjectStateAnswer,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import { resolveProjectStateConflict } from '../src/project-state/resolve.js';
import { syncProjectStateFromCheckout } from '../src/project-state/sync.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const STATE_DIR = '.haive-data/state';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
const record = (
  settings: Record<string, unknown>,
  environment: ProjectStateRecord['environment'] = null,
): ProjectStateRecord =>
  normalizeProjectState({
    ...emptyProjectState(),
    settings: Object.assign(Object.create(null) as Record<string, unknown>, settings),
    environment,
  });
const env = (name: string, confirmed: Record<string, unknown> = {}) => ({
  envDetectData: { project: { name } },
  confirmedValues: confirmed,
});

const RENDER = {
  projectInfo: { name: 'acme' },
  framework: 'drupal',
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
};

interface Seed {
  unit: string;
  base?: unknown;
  local?: unknown;
  incoming?: unknown;
  file?: string | null;
  columns?: Record<string, unknown>;
  baseRecord?: ProjectStateRecord;
}

async function setup(seed: Seed) {
  const root = await mkdtemp(join(tmpdir(), 'project-state-resolve-settings-'));
  dirs.push(root);
  const { repositories, projectStateSync: sync, tasks } = schema;
  const conflicts = schema.projectStateConflicts;
  const fake = createFakeDb({
    repositories,
    projectStateSync: sync,
    projectStateOutbox: schema.projectStateOutbox,
    projectStateConflicts: conflicts,
    tasks,
    taskSteps: schema.taskSteps,
    onboardingArtifacts: schema.onboardingArtifacts,
    cliProviders: schema.cliProviders,
    customBundles: schema.customBundles,
    customBundleItems: schema.customBundleItems,
  });
  fake.insert(repositories, {
    id: REPO,
    userId: OWNER,
    name: 'acme',
    source: 'git_https',
    status: 'ready',
    storagePath: root,
    rtkEnabled: null,
    renderContext: {
      ...RENDER,
      agentTargets: [],
      enabledCliProviders: [],
      rtkChoiceRecorded: true,
    },
    updatedAt: new Date(1000),
    ...seed.columns,
  });
  fake.insert(sync, {
    repositoryId: REPO,
    baseSnapshot: json({ ...(seed.baseRecord ?? record({})), render: RENDER }),
    lastError: null,
    updatedAt: new Date(0),
  });
  const id = randomUUID();
  fake.insert(conflicts, {
    id,
    repositoryId: REPO,
    unit: seed.unit,
    base: conflictSide(seed.base),
    local: conflictSide(seed.local),
    incoming: conflictSide(seed.incoming),
    detectedAt: new Date(2000),
    resolution: null,
    resolvedAt: null,
    resolvedBy: null,
  });
  const rel = `${STATE_DIR}/${seed.unit.split('#')[0]}`;
  await mkdir(join(root, STATE_DIR, 'project'), { recursive: true });
  await writeFile(join(root, STATE_DIR, 'format.json'), '{"schemaVersion":1}\n');
  await writeFile(join(root, STATE_DIR, 'project/render.json'), JSON.stringify(RENDER));
  if (seed.file !== null && seed.file !== undefined) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), seed.file);
  }
  const db = fake.db as unknown as Database;
  const answer = (a: ProjectStateAnswer) =>
    resolveProjectStateConflict(db, {
      repositoryId: REPO,
      userId: OWNER,
      conflictId: id,
      answer: a,
    });
  return {
    root,
    fake,
    db,
    id,
    answer,
    row: () => fake.rows(conflicts).find((r) => r.id === id)!,
    repo: () => fake.rows(repositories).find((r) => r.id === REPO)!,
    base: () =>
      fake.rows(sync).find((r) => r.repositoryId === REPO)!.baseSnapshot as ProjectStateRecord,
    file: () => readFile(join(root, rel), 'utf8').catch(() => null),
    rel,
    addTask: (type: string, status: string) =>
      fake.insert(tasks, {
        id: randomUUID(),
        userId: OWNER,
        repositoryId: REPO,
        type,
        status,
        title: 't',
      }),
  };
}

const LSP = 'settings/lsp-servers.json';
const lspSeed = (over: Partial<Seed> = {}): Seed => ({
  unit: LSP,
  base: ['vtsls'],
  local: ['pyright'],
  incoming: ['gopls'],
  file: '["gopls"]\n',
  columns: { lspServers: ['pyright'] },
  baseRecord: record({ 'lsp-servers': ['vtsls'] }),
  ...over,
});

describe('answering a settings question: keep mine', () => {
  it('writes the column’s value into the unit’s file and the base, leaves the column, closes the row', async () => {
    const s = await setup(lspSeed());

    const result = await s.answer('keep_mine');

    expect(result).toMatchObject({ kind: 'resolved', written: [s.rel] });
    expect(JSON.parse((await s.file())!)).toEqual(['pyright']);
    expect(s.repo().lspServers).toEqual(['pyright']);
    expect(s.base().settings['lsp-servers']).toEqual(['pyright']);
    expect(s.row()).toMatchObject({ resolution: 'keep_mine', resolvedBy: OWNER });
  });

  it('is met by no conflict and no write on the next sync', async () => {
    const s = await setup(lspSeed());
    await s.answer('keep_mine');
    await syncProjectStateFromCheckout(s.db, { repositoryId: REPO, repoPath: s.root });
    const before = json({
      r: s.fake.rows(schema.repositories),
      s: s.fake.rows(schema.projectStateSync),
    });

    const next = await syncProjectStateFromCheckout(s.db, { repositoryId: REPO, repoPath: s.root });

    expect(next.outcome).not.toBe('conflict');
    expect(s.fake.rows(schema.projectStateConflicts).filter((r) => r.resolvedAt == null)).toEqual(
      [],
    );
    expect(
      json({ r: s.fake.rows(schema.repositories), s: s.fake.rows(schema.projectStateSync) }),
    ).toEqual(before);
  });

  it('has no value to keep where the column holds none', async () => {
    const s = await setup(lspSeed({ columns: { lspServers: null } }));

    expect(await s.answer('keep_mine')).toEqual({ kind: 'no_local' });
    expect(s.row().resolvedAt).toBeNull();
  });
});

describe('answering a settings question: take theirs', () => {
  it('applies the other install’s value to the column, rewrites no file and takes it into the base', async () => {
    const s = await setup(lspSeed());
    const fileBefore = await s.file();

    const result = await s.answer('take_theirs');

    expect(result).toMatchObject({ kind: 'resolved', written: [] });
    expect(s.repo().lspServers).toEqual(['gopls']);
    expect(await s.file()).toBe(fileBefore);
    expect(s.base().settings['lsp-servers']).toEqual(['gopls']);
    expect(s.row()).toMatchObject({ resolution: 'take_theirs' });
  });

  it('applies it with the routes’ normalisers', async () => {
    const s = await setup(lspSeed({ file: '["gopls","made-up"]\n' }));

    expect((await s.answer('take_theirs')).kind).toBe('resolved');
    expect(s.repo().lspServers).toEqual(['gopls']);
  });

  it('reads a value the column cannot hold as moved: the re-sync drops the question and the column stays', async () => {
    const s = await setup(
      lspSeed({
        unit: 'settings/review-dimensions.json',
        base: ['security'],
        local: ['performance'],
        incoming: ['nope'],
        file: '["nope"]\n',
        columns: { reviewDimensions: ['performance'] },
        baseRecord: record({ 'review-dimensions': ['security'] }),
      }),
    );

    expect((await s.answer('take_theirs')).kind).toBe('moved');
    expect(s.row().resolution).toBe('converged');
    expect(s.repo().reviewDimensions).toEqual(['performance']);
  });

  it('unsets a setting the other install unset', async () => {
    const s = await setup(
      lspSeed({
        unit: 'settings/rtk-version.json',
        base: '0.1.0',
        local: '0.2.0',
        incoming: undefined,
        file: null,
        columns: { rtkVersion: '0.2.0' },
        baseRecord: record({ 'rtk-version': '0.1.0' }),
      }),
    );

    expect((await s.answer('take_theirs')).kind).toBe('resolved');
    expect(s.repo().rtkVersion ?? null).toBeNull();
    expect(s.base().settings).toEqual({});
  });

  it('cannot unset a setting that is never unset', async () => {
    const s = await setup(
      lspSeed({
        unit: 'settings/scope-exclude-globs.json',
        base: 'x',
        local: ['a'],
        incoming: undefined,
        file: null,
        columns: { scopeExcludeGlobs: ['a'] },
      }),
    );

    expect((await s.answer('take_theirs')).kind).toBe('invalid');
    expect(s.repo().scopeExcludeGlobs).toEqual(['a']);
  });
});

describe('answering a settings question: the file moved or the repository is busy', () => {
  it('reads as moved, and re-asks against the file, when it no longer holds their value', async () => {
    const s = await setup(lspSeed({ file: '["jdtls"]\n' }));

    expect(await s.answer('keep_mine')).toEqual({ kind: 'moved' });
    expect(s.row().resolvedAt).toBeNull();
    expect(s.repo().lspServers).toEqual(['pyright']);
    expect(await s.file()).toBe('["jdtls"]\n');
  });

  it('reads as moved when the file is gone though their value was a value', async () => {
    const s = await setup(lspSeed({ file: null }));

    expect(await s.answer('take_theirs')).toEqual({ kind: 'moved' });
  });

  it('is busy while an onboarding holds the checkout', async () => {
    const s = await setup(lspSeed());
    s.addTask('onboarding', 'running');

    expect(await s.answer('keep_mine')).toEqual({ kind: 'busy' });
    expect(existsSync(join(s.root, s.rel))).toBe(true);
  });

  it('closed by the other answer reads as settled', async () => {
    const s = await setup(lspSeed());
    await s.answer('take_theirs');

    expect(await s.answer('keep_mine')).toEqual({ kind: 'settled', resolution: 'take_theirs' });
  });
});

describe('answering an environment question', () => {
  const KEY = 'project/environment.json#confirmedValues';
  const envSeed = (over: Partial<Seed> = {}): Seed => ({
    unit: KEY,
    base: { web: 'apache' },
    local: { web: 'nginx' },
    incoming: { web: 'caddy' },
    file: JSON.stringify(env('acme', { web: 'caddy' })),
    columns: { onboardingEnvironment: { schemaVersion: 1, ...env('acme', { web: 'nginx' }) } },
    baseRecord: record({}, env('acme', { web: 'apache' })),
    ...over,
  });

  it('keep mine writes the environment with my key into the file and the base', async () => {
    const s = await setup(envSeed());

    expect((await s.answer('keep_mine')).kind).toBe('resolved');
    expect(JSON.parse((await s.file())!)).toEqual(env('acme', { web: 'nginx' }));
    expect(s.base().environment).toEqual(env('acme', { web: 'nginx' }));
    expect(s.repo().onboardingEnvironment).toEqual({
      schemaVersion: 1,
      ...env('acme', { web: 'nginx' }),
    });
  });

  it('take theirs moves the key in the column, with its schema version, and leaves the file', async () => {
    const s = await setup(envSeed());
    const before = await s.file();

    expect((await s.answer('take_theirs')).kind).toBe('resolved');
    expect(s.repo().onboardingEnvironment).toEqual({
      schemaVersion: 1,
      ...env('acme', { web: 'caddy' }),
    });
    expect(await s.file()).toBe(before);
    expect(s.base().environment).toEqual(env('acme', { web: 'caddy' }));
  });

  it('cannot take a key into a column that holds no environment', async () => {
    const s = await setup(envSeed({ columns: { onboardingEnvironment: null } }));

    expect((await s.answer('take_theirs')).kind).toBe('invalid');
  });
});

describe('answering an ordinary rtk-enabled conflict', () => {
  const rtkSeed = (over: Partial<Seed> = {}): Seed => ({
    unit: 'settings/rtk-enabled.json',
    base: true,
    local: false,
    incoming: true,
    file: 'true\n',
    columns: { rtkEnabled: false },
    baseRecord: record({ 'rtk-enabled': true }),
    ...over,
  });

  it('keep mine goes through the settings path: the file and the base take the column', async () => {
    const s = await setup(rtkSeed());

    const result = await s.answer('keep_mine');

    expect(result).toMatchObject({ kind: 'resolved', written: [s.rel] });
    expect(JSON.parse((await s.file())!)).toBe(false);
    expect(s.base().settings['rtk-enabled']).toBe(false);
    expect(s.repo().rtkEnabled).toBe(false);
  });

  it('is moved, and left open, when the checkout file no longer holds the other value', async () => {
    const s = await setup(rtkSeed({ file: 'false\n' }));

    expect((await s.answer('take_theirs')).kind).toBe('moved');
    expect(s.repo().rtkChoiceMadeAt ?? null).toBeNull();
  });
});

describe('answering an agent-rules question', () => {
  const RULES = 'settings/agent-rules.md';
  const BASE = '# House rules\n\n- Keep it small.\n';
  const MINE = '# House rules\n\n- Keep it small.\n- Mine, first.\n- Mine, second.\n';
  const THEIRS = '# House rules\n\n- Keep it small.\n\n```sh\nrm -rf build\n```\n';
  const crlf = (text: string) => text.replace(/\n/g, '\r\n');
  const rulesSeed = (over: Partial<Seed> = {}): Seed => ({
    unit: RULES,
    base: BASE,
    local: MINE,
    incoming: THEIRS,
    file: THEIRS,
    columns: { agentRulesOverride: MINE },
    baseRecord: record({ 'agent-rules': BASE }),
    ...over,
  });

  describe('keep mine', () => {
    it('writes the multi-line text into the .md and the base, leaves the column, closes the row', async () => {
      const s = await setup(rulesSeed());

      const result = await s.answer('keep_mine');

      expect(result).toMatchObject({ kind: 'resolved', written: [s.rel] });
      expect(await s.file()).toBe(MINE);
      expect(s.repo().agentRulesOverride).toBe(MINE);
      expect(s.base().settings['agent-rules']).toBe(MINE);
      expect(s.row()).toMatchObject({ resolution: 'keep_mine', resolvedBy: OWNER });
    });

    it('is met by no conflict and no write on the next sync', async () => {
      const s = await setup(rulesSeed());
      await s.answer('keep_mine');
      await syncProjectStateFromCheckout(s.db, { repositoryId: REPO, repoPath: s.root });
      const before = json({
        r: s.fake.rows(schema.repositories),
        s: s.fake.rows(schema.projectStateSync),
      });

      const next = await syncProjectStateFromCheckout(s.db, {
        repositoryId: REPO,
        repoPath: s.root,
      });

      expect(next.outcome).not.toBe('conflict');
      expect(s.fake.rows(schema.projectStateConflicts).filter((r) => r.resolvedAt == null)).toEqual(
        [],
      );
      expect(s.repo().agentRulesOverride).toBe(MINE);
      expect(
        json({ r: s.fake.rows(schema.repositories), s: s.fake.rows(schema.projectStateSync) }),
      ).toEqual(before);
    });

    it('keeps the empty text: a 0-byte file, and the empty text in the base and the column', async () => {
      const s = await setup(rulesSeed({ local: '', columns: { agentRulesOverride: '' } }));

      const result = await s.answer('keep_mine');

      expect(result).toMatchObject({ kind: 'resolved', written: [s.rel] });
      expect(await s.file()).toBe('');
      expect(s.repo().agentRulesOverride).toBe('');
      expect(s.base().settings['agent-rules']).toBe('');
    });

    it('has no value to keep where the column holds none', async () => {
      const s = await setup(rulesSeed({ local: undefined, columns: { agentRulesOverride: null } }));

      expect(await s.answer('keep_mine')).toEqual({ kind: 'no_local' });
      expect(s.row().resolvedAt).toBeNull();
      expect(await s.file()).toBe(THEIRS);
    });

    it('writes the canonical bytes over a file that read as theirs with CRLF line ends', async () => {
      const s = await setup(rulesSeed({ file: crlf(THEIRS) }));

      const result = await s.answer('keep_mine');

      expect(result).toMatchObject({ kind: 'resolved', written: [s.rel] });
      expect(await s.file()).toBe(MINE);
    });
  });

  describe('take theirs', () => {
    it('applies the text to the column and the base, and leaves the file', async () => {
      const s = await setup(rulesSeed());

      const result = await s.answer('take_theirs');

      expect(result).toMatchObject({ kind: 'resolved', written: [] });
      expect(s.repo().agentRulesOverride).toBe(THEIRS);
      expect(await s.file()).toBe(THEIRS);
      expect(s.base().settings['agent-rules']).toBe(THEIRS);
      expect(s.row()).toMatchObject({ resolution: 'take_theirs' });
    });

    it('takes the empty text as the empty text, never as NULL', async () => {
      const s = await setup(rulesSeed({ incoming: '', file: '' }));

      const result = await s.answer('take_theirs');

      expect(result).toMatchObject({ kind: 'resolved', written: [] });
      expect(s.repo().agentRulesOverride).toBe('');
      expect(s.base().settings['agent-rules']).toBe('');
    });

    it('unsets the override where the other install reset it', async () => {
      const s = await setup(rulesSeed({ incoming: undefined, file: null }));

      expect((await s.answer('take_theirs')).kind).toBe('resolved');
      expect(s.repo().agentRulesOverride ?? null).toBeNull();
      expect(s.base().settings).toEqual({});
    });

    it('is not moved by a file that holds the same text with CRLF line ends', async () => {
      const s = await setup(rulesSeed({ file: crlf(THEIRS) }));

      const result = await s.answer('take_theirs');

      expect(result).toMatchObject({ kind: 'resolved', written: [] });
      expect(s.repo().agentRulesOverride).toBe(THEIRS);
    });
  });

  describe('a file that moved', () => {
    it('reads as moved, and re-asks against the file, when it no longer holds their text', async () => {
      const s = await setup(rulesSeed({ file: 'edited by hand\n' }));

      expect(await s.answer('keep_mine')).toEqual({ kind: 'moved' });
      expect(s.row().resolvedAt).toBeNull();
      expect(s.repo().agentRulesOverride).toBe(MINE);
      expect(await s.file()).toBe('edited by hand\n');
    });

    it('reads as moved when the file is gone though their text was a value', async () => {
      const s = await setup(rulesSeed({ file: null }));

      expect(await s.answer('take_theirs')).toEqual({ kind: 'moved' });
    });

    it('reads as moved when the file holds a text the setting refuses', async () => {
      const s = await setup(rulesSeed({ file: '# Rules\n\n<!-- haive:rules -->\n' }));

      expect(await s.answer('take_theirs')).toEqual({ kind: 'moved' });
      expect(s.repo().agentRulesOverride).toBe(MINE);
    });
  });
});

it('R1 refuses taking known incoming progress over unavailable stored proof', async () => {
  const stored = 'f'.repeat(40);
  const s = await setup({
    unit: 'settings/review-watermarks.json#kbSyncedCommit',
    local: stored,
    columns: { kbSyncedCommit: stored },
    file: '{}',
  });
  const identity = {
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@local',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@local',
  };
  expect((await gitRun(s.root, ['init', '-q', '-b', 'main'], identity)).code).toBe(0);
  expect(
    (await gitRun(s.root, ['commit', '--allow-empty', '-qm', 'known incoming'], identity)).code,
  ).toBe(0);
  const incoming = (await gitRun(s.root, ['rev-parse', 'HEAD'])).stdout.trim();
  s.fake.patch(schema.repositories, REPO, { planSyncedCommit: incoming });
  s.fake.patch(schema.projectStateConflicts, s.id, { incoming: conflictSide(incoming) });
  await writeFile(
    join(s.root, s.rel),
    JSON.stringify({ kbSyncedCommit: incoming, planSyncedCommit: incoming }),
  );
  const before = json({
    repo: s.repo(),
    base: s.base(),
    row: s.row(),
    outbox: s.fake.rows(schema.projectStateOutbox),
  });
  const bytes = await s.file();
  expect(await s.answer('take_theirs')).toEqual({ kind: 'invalid' });
  expect(
    json({
      repo: s.repo(),
      base: s.base(),
      row: s.row(),
      outbox: s.fake.rows(schema.projectStateOutbox),
    }),
  ).toEqual(before);
  expect(await s.file()).toBe(bytes);
});
