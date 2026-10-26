import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkOnboardingMarkers,
  checkRepositoryOnboardingMarkers,
  NO_ONBOARDING_TASKS,
  resolveOnboardingVerdict,
} from '../src/onboarding-admission.js';
import { CLI_PROVIDER_CATALOG } from '../src/cli-providers/catalog.js';
import { deriveRenderTargets, readRenderContextColumn } from '../src/project-state/index.js';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { KB_DIR } from '../src/knowledge-paths.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const context = (cliTargets: string[], extra = {}) => ({
  projectInfo: { name: 'Intentionally agent-less' },
  framework: null,
  acceptedAgentIds: [],
  customAgentSpecs: [],
  lspLanguages: [],
  cliTargets,
  rtkEnabled: false,
  rtkChoiceRecorded: true,
  ...extra,
});
const markers = checkOnboardingMarkers as (
  root: string,
  recorded?: unknown,
) => ReturnType<typeof checkOnboardingMarkers>;
async function rootWith(...paths: string[]) {
  const root = await mkdtemp(join(tmpdir(), 't118-agentless-markers-'));
  dirs.push(root);
  for (const rel of paths) {
    if (rel.endsWith('.json')) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), '{}\n');
    } else await mkdir(join(root, rel), { recursive: true });
  }
  return root;
}
const CONFIG = '.claude/workflow-config.json';
const completed = (missing: string[]) =>
  resolveOnboardingVerdict({
    source: 'git_https',
    missing,
    onboardedAt: new Date(2000),
    facts: {
      ...NO_ONBOARDING_TASKS,
      hasAny: true,
      hasCompleted: true,
      newestCompletedAt: new Date(2000),
    },
  });

describe('completion markers for recorded agent-less membership', () => {
  it('accepts completed Amp-only output without inventing a Claude agent directory', async () => {
    expect(CLI_PROVIDER_CATALOG.amp.projectAgentsDir).toBeNull();
    const destinations = deriveRenderTargets(['amp'], []);
    expect(destinations.agentTargets).toEqual([]);
    expect(destinations.skillDirs).toEqual(['.claude/skills']);
    const column = context(['amp']);
    expect(readRenderContextColumn(column).kind).toBe('column');
    const root = await rootWith(KB_DIR, CONFIG, ...destinations.skillDirs);
    const found = await markers(root, column);
    const verdict = completed(found.missing);
    expect.soft(found.missing).toEqual([]);
    expect(found.present).not.toContain('.claude/agents');
    expect(verdict.onboarded).toBe(true);
  });

  it.each([[[]], [['future-cli']]])(
    'accepts completed no-export membership %j with KB and config',
    async (names) => {
      const destinations = deriveRenderTargets(names, []);
      expect(destinations.agentTargets).toEqual([]);
      expect(destinations.skillDirs).toEqual([]);
      const root = await rootWith(KB_DIR, CONFIG);
      const found = await markers(root, context(names));
      expect.soft(found.missing).toEqual([]);
      expect(completed(found.missing).onboarded).toBe(true);
    },
  );

  it.each(['claude-code', 'codex', 'gemini'])(
    'keeps native categories required for %s',
    async (name) => {
      const destinations = deriveRenderTargets([name], []);
      const root = await rootWith(
        KB_DIR,
        CONFIG,
        ...destinations.agentTargets.map((t) => t.dir),
        ...destinations.skillDirs,
      );
      expect((await markers(root, context([name]))).missing).toEqual([]);
      for (const target of destinations.agentTargets)
        await rm(join(root, target.dir), { recursive: true });
      expect((await markers(root, context([name]))).missing).toEqual(['.claude/agents']);
    },
  );

  it.each([
    ['amp', 'codex'],
    ['claude-code', 'gemini'],
  ])('retains any-catalog category presence for mixed %j/%j', async (...names) => {
    expect(readRenderContextColumn(context(names)).kind).toBe('column');
    // Completion remains a category marker, not per-member mirror-health: one existing native dir
    // can precede a newly adopted CLI whose generated skills are intentionally deferred.
    const root = await rootWith(KB_DIR, CONFIG, '.grok/agents', '.gemini/skills');
    expect((await markers(root, context(names))).missing).toEqual([]);
    await rm(join(root, '.grok/agents'), { recursive: true });
    expect((await markers(root, context(names))).missing).toEqual(['.claude/agents']);
  });

  it.each([KB_DIR, CONFIG, '.claude/skills'])(
    'retains the Amp marker requirement for %s',
    async (missing) => {
      const root = await rootWith(
        ...[KB_DIR, CONFIG, '.claude/skills'].filter((rel) => rel !== missing),
      );
      const found = await markers(root, context(['amp']));
      expect(found.missing).toEqual([missing]);
      expect(completed(found.missing).onboarded).toBe(false);
    },
  );

  it.each([{ names: ['amp'] }, { names: [] }])(
    'keeps an actually recorded legacy agent fallback required for $names',
    async ({ names }) => {
      const root = await rootWith(KB_DIR, CONFIG, '.claude/skills');
      const column = context(names, {
        legacyAgentFallback: true,
        agentTargets: [{ dir: '.claude/agents', format: 'markdown', supportsLsp: false }],
      });
      expect((await markers(root, column)).missing).toEqual(['.claude/agents']);
    },
  );

  it('retains unresolved and decoder-refused legacy requirements', async () => {
    const root = await rootWith(KB_DIR, CONFIG);
    expect((await markers(root)).missing).toEqual(['.claude/agents', '.claude/skills']);
    expect((await markers(root, { ...context([]), futureField: true })).missing).toEqual([
      '.claude/agents',
      '.claude/skills',
    ]);
  });

  it('does not follow a required skills marker link for Amp', async () => {
    const root = await rootWith(KB_DIR, CONFIG);
    const outside = await rootWith('skills');
    await symlink(join(outside, 'skills'), join(root, '.claude/skills'));
    expect((await markers(root, context(['amp']))).missing).toEqual(['.claude/skills']);
  });

  it('keeps live, cancelled and reset verdict gates after category applicability', async () => {
    const root = await rootWith(KB_DIR, CONFIG, '.claude/skills');
    const { missing } = await markers(root, context(['amp']));
    const base = {
      source: 'git_https',
      missing,
      onboardedAt: null,
      facts: { ...NO_ONBOARDING_TASKS, hasAny: true },
    };
    expect(
      resolveOnboardingVerdict({
        ...base,
        onboardedAt: new Date(),
        facts: { ...base.facts, liveTaskId: 'live' },
      }),
    ).toEqual({ onboarded: false, inProgressTaskId: 'live', canMarkOnboarded: false });
    expect(resolveOnboardingVerdict(base)).toEqual({
      onboarded: false,
      inProgressTaskId: null,
      canMarkOnboarded: true,
    });
    expect(resolveOnboardingVerdict({ ...base, onboardingResetAt: new Date() })).toEqual({
      onboarded: false,
      inProgressTaskId: null,
      canMarkOnboarded: false,
    });
  });
});

const fixtureIds = new Map<string, string>();
const fixtureId = (label: string) => {
  if (!fixtureIds.has(label)) fixtureIds.set(label, randomUUID());
  return fixtureIds.get(label)!;
};

describe('batched marker provenance reads', () => {
  it('uses one column and one snapshot query for multiple candidate roots, skipping unnecessary reads', async () => {
    const fake = createFakeDb({
      repositories: schema.repositories,
      onboardingArtifacts: schema.onboardingArtifacts,
    });
    const db = fake.db as unknown as Database;
    const candidates = [];
    for (const [id, recorded] of [
      [fixtureId('a'), context(['amp'])],
      [fixtureId('b'), null],
    ] as const) {
      const root = await rootWith(KB_DIR, CONFIG, '.claude/skills');
      fake.insert(schema.repositories, { id, userId: fixtureId('owner'), renderContext: recorded });
      candidates.push({ id, root });
    }
    const { rtkChoiceRecorded: _flag, ...snapshot } = context(['amp']);
    fake.insert(schema.onboardingArtifacts, {
      id: fixtureId('snapshot'),
      userId: fixtureId('owner'),
      repositoryId: fixtureId('b'),
      generatedAt: new Date(1),
      supersededAt: null,
      formValuesSnapshot: snapshot,
    });
    const spy = vi.spyOn(fake.db, 'select');
    const checked = await checkRepositoryOnboardingMarkers(db, fixtureId('owner'), candidates, {
      verdictOnly: true,
    });
    expect([...checked.values()].map((result) => result.missing)).toEqual([[], []]);
    expect(
      spy.mock.calls.filter(([fields]) =>
        Object.values(fields ?? {}).includes(schema.repositories.renderContext),
      ),
    ).toHaveLength(1);
    expect(
      spy.mock.calls.filter(([fields]) =>
        Object.values(fields ?? {}).includes(schema.onboardingArtifacts.formValuesSnapshot),
      ),
    ).toHaveLength(1);
    spy.mockClear();
    const full = await rootWith(KB_DIR, CONFIG, '.codex/agents', '.agents/skills');
    const blocked = await rootWith(CONFIG);
    const skipped = await checkRepositoryOnboardingMarkers(
      db,
      fixtureId('owner'),
      [
        { id: fixtureId('full'), root: full },
        { id: fixtureId('blocked'), root: blocked },
      ],
      { verdictOnly: true },
    );
    expect(skipped.get(fixtureId('full'))?.missing).toEqual([]);
    expect(skipped.get(fixtureId('blocked'))?.missing).toContain(KB_DIR);
    expect(spy).not.toHaveBeenCalled();
  });
  it('keeps retained inapplicable directories physically present regardless of another missing category', async () => {
    const root = await rootWith(KB_DIR, CONFIG, '.claude/agents', '.claude/skills');
    expect((await markers(root, context([]))).present).toHaveLength(4);
    const fake = createFakeDb({
      repositories: schema.repositories,
      onboardingArtifacts: schema.onboardingArtifacts,
    });
    fake.insert(schema.repositories, {
      id: fixtureId('a'),
      userId: fixtureId('owner'),
      renderContext: context(['amp']),
    });
    const db = fake.db as unknown as Database;
    const before = (
      await checkRepositoryOnboardingMarkers(db, fixtureId('owner'), [{ id: fixtureId('a'), root }])
    ).get(fixtureId('a'))!;
    await rm(join(root, '.claude/skills'), { recursive: true });
    const after = (
      await checkRepositoryOnboardingMarkers(db, fixtureId('owner'), [{ id: fixtureId('a'), root }])
    ).get(fixtureId('a'))!;
    expect(before.present).toContain('.claude/agents');
    expect(after.present).toContain('.claude/agents');
    expect(after.missing).toEqual(['.claude/skills']);
    expect((await markers(root, context([]))).missing).toEqual([]);
  });

  it('recovers only strict live owned snapshots and keeps current[] authoritative', async () => {
    const fake = createFakeDb({
      repositories: schema.repositories,
      onboardingArtifacts: schema.onboardingArtifacts,
    });
    const db = fake.db as unknown as Database;
    const inputs = [];
    for (const id of [
      fixtureId('current'),
      fixtureId('historical'),
      fixtureId('superseded'),
      fixtureId('foreign'),
    ]) {
      const root = await rootWith(KB_DIR, CONFIG);
      fake.insert(schema.repositories, {
        id,
        userId: fixtureId('owner'),
        renderContext: id === fixtureId('current') ? context([]) : null,
      });
      inputs.push({ id, root });
    }
    const { rtkChoiceRecorded: _flag, ...empty } = context([]);
    const row = (repositoryId: string, extra = {}) =>
      fake.insert(schema.onboardingArtifacts, {
        repositoryId,
        userId: fixtureId('owner'),
        generatedAt: new Date(1),
        supersededAt: null,
        formValuesSnapshot: empty,
        ...extra,
      });
    row(fixtureId('current'), {
      formValuesSnapshot: {
        ...empty,
        cliTargets: ['amp'],
        legacyAgentFallback: true,
        agentTargets: [{ dir: '.claude/agents', format: 'markdown' }],
      },
    });
    row(fixtureId('historical'));
    row(fixtureId('historical'), {
      generatedAt: new Date(3),
      formValuesSnapshot: { ...empty, futureField: true },
    });
    row(fixtureId('superseded'), { supersededAt: new Date(2) });
    row(fixtureId('foreign'), { userId: fixtureId('other-owner') });
    const result = await checkRepositoryOnboardingMarkers(db, fixtureId('owner'), inputs);
    expect(result.get(fixtureId('current'))?.missing).toEqual([]);
    expect(result.get(fixtureId('historical'))?.missing).toEqual([]);
    expect(result.get(fixtureId('superseded'))?.missing).toEqual([
      '.claude/agents',
      '.claude/skills',
    ]);
    expect(result.get(fixtureId('foreign'))?.missing).toEqual(['.claude/agents', '.claude/skills']);
  });
});
