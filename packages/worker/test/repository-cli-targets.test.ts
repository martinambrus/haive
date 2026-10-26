import { describe, expect, it } from 'vitest';
import { renderContextFromColumn } from '../src/step-engine/_render-targets.js';
import { recoverCliTargets } from '../src/project-state/cli-targets-backfill.js';
import {
  readRenderContextColumn,
  deriveRenderTargets,
  foreignReason,
} from '@haive/shared/project-state';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { seedRepositoryCliTargets } from '../src/project-state/cli-targets-backfill.js';
import { upgradePlanStep } from '../src/step-engine/steps/onboarding-upgrade/01-upgrade-plan.js';
import { expandManifestFor, REFERENCE_CONTEXT } from '../src/step-engine/template-manifest.js';
import {
  newDb,
  seedProviders,
  seedRepository,
  seedLiveRow,
  ctxFor,
  REPO,
} from './support/upgrade-plan-fixtures.js';
import { resolveTaskSkillTargetDirs } from '../src/step-engine/steps/onboarding/_helpers.js';
import { TASK } from './support/upgrade-plan-fixtures.js';

const legacy = {
  projectInfo: {},
  framework: null,
  acceptedAgentIds: ['code-reviewer'],
  customAgentSpecs: [],
  lspLanguages: [],
  agentTargets: [{ dir: '.claude/agents', format: 'markdown' as const, supportsLsp: false }],
  enabledCliProviders: [
    { name: 'claude-code' as const, rulesFile: 'CLAUDE.md', rulesFileMode: 'import' as const },
  ],
};
const column = (names: string[]) => ({ ...legacy, cliTargets: names, rtkChoiceRecorded: false });

describe('repository CLI rendering across installations', () => {
  it('a Codex-only install maintains recorded Claude and Codex, even with stale derived fields', () => {
    const rendered = renderContextFromColumn(column(['claude-code', 'codex', 'future-cli']), [
      { name: 'codex', enabled: true },
    ]);
    expect(rendered.cliTargets).toEqual(['claude-code', 'codex', 'future-cli']);
    expect(rendered.agentTargets.map((t) => t.dir)).toEqual(['.claude/agents', '.codex/agents']);
    expect(rendered.enabledCliProviders.map((p) => p.name)).toEqual(['claude-code', 'codex']);
  });
  it('explicit [] does not fall back to local providers or stale target metadata', () => {
    const rendered = renderContextFromColumn(column([]), [{ name: 'claude-code', enabled: true }]);
    expect(rendered.agentTargets).toEqual([]);
    expect(rendered.enabledCliProviders).toEqual([]);
    expect(readRenderContextColumn(column([])).kind).toBe('column');
  });
  it('keeps the recorded Amp fallback apart from blank/new Amp membership', () => {
    expect(
      renderContextFromColumn({ ...column(['amp']), legacyAgentFallback: true }, []).agentTargets,
    ).toEqual(legacy.agentTargets);
    expect(
      renderContextFromColumn({ ...column(['amp']), agentTargets: [] }, []).agentTargets,
    ).toEqual([]);
    expect(deriveRenderTargets(['amp'], []).agentTargets).toEqual([]);
    expect(renderContextFromColumn(column([]), []).agentTargets).toEqual([]);
  });
  it('backfill skips malformed newest rows, chooses the newest valid snapshot and preserves []', () => {
    const row = (id: string, at: number, context: unknown) => ({
      id,
      generatedAt: new Date(at),
      formValuesSnapshot: context,
    });
    expect(
      recoverCliTargets([
        row('a', 1, legacy),
        row('b', 2, { ...legacy, enabledCliProviders: [], cliTargets: [] }),
        row('c', 3, { enabledCliProviders: [{ name: 'codex' }] }),
      ]),
    ).toEqual([]);
    expect(
      recoverCliTargets([
        row('a', 1, legacy),
        row('b', 2, {
          ...legacy,
          enabledCliProviders: [{ name: 'codex', rulesFile: 'AGENTS.md', rulesFileMode: 'native' }],
        }),
      ]),
    ).toEqual(['codex']);
    expect(
      recoverCliTargets([row('c', 3, { enabledCliProviders: [{ name: 'codex' }] })]),
    ).toBeUndefined();
  });
  it('only a valid explicit prior marker can authorize a known removed target', () => {
    const marker = {
      templateId: 'agent.code-reviewer',
      templateKind: 'agent',
      diskPath: '.claude/agents/code-reviewer.md',
      source: 'backfill',
      sourceStepId: 'project-state-import',
      haiveVersion: '0.1.0',
      formValuesSnapshot: { ...legacy, cliTargets: ['claude-code'] },
    };
    const current = { haiveVersion: '0.1.0', agentTargets: [], skillDirs: [] };
    expect(foreignReason(marker, current)).toBeNull();
    expect(foreignReason({ ...marker, formValuesSnapshot: legacy }, current)).toBe('not-rendered');
    expect(foreignReason({ ...marker, diskPath: '.future/agents/code-reviewer.md' }, current)).toBe(
      'not-rendered',
    );
    expect(foreignReason({ ...marker, haiveVersion: '99.0.0' }, current)).toBe('newer-release');
    expect(foreignReason({ ...marker, templateId: 'custom:foreign:agent' }, current)).toBe(
      'custom-bundle',
    );
  });
});

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('repository CLI upgrade choices and backfill writes', () => {
  it('declining the default-on re-addition exposes removed CLI files as obsolete, without restoring membership', async () => {
    const fake = newDb();
    seedProviders(fake);
    seedRepository(fake, {
      source: 'git_https',
      rtkEnabled: false,
      renderContext: column(['claude-code']),
    });
    const prior = {
      ...REFERENCE_CONTEXT,
      cliTargets: ['claude-code', 'codex'],
      ...deriveRenderTargets(['claude-code', 'codex'], []),
    };
    const item = expandManifestFor(prior).find(
      (r) => r.diskPath === '.codex/agents/code-reviewer.toml',
    )!;
    const dir = await mkdtemp(join(tmpdir(), 'cli-plan-'));
    dirs.push(dir);
    await mkdir(dirname(join(dir, item.diskPath)), { recursive: true });
    await writeFile(join(dir, item.diskPath), item.content);
    seedLiveRow(fake, {
      path: item.diskPath,
      snapshot: { ...legacy, cliTargets: ['claude-code', 'codex'] },
      at: 1,
    });
    const row = fake.rows(schema.onboardingArtifacts)[0]!;
    fake.patch(schema.onboardingArtifacts, row.id as string, {
      templateId: item.templateId,
      writtenHash: item.writtenHash,
      templateContentHash: item.templateContentHash,
    });
    const ctx = ctxFor(fake, dir);
    const detected = await upgradePlanStep.detect!(ctx);
    const form = upgradePlanStep.form!(ctx, detected)!;
    expect(form.fields.find((f) => f.id === 'addCliTargets')).toMatchObject({
      defaults: ['codex'],
    });
    const output = await upgradePlanStep.apply(ctx, {
      detected,
      formValues: { addCliTargets: [] },
      iteration: 0,
      previousIterations: [],
    });
    expect(output.renderCtxSnapshot.cliTargets).toEqual(['claude-code']);
    expect(output.entries.find((e) => e.diskPath === item.diskPath)?.bucket).toBe('obsolete');
    fake.patch(schema.repositories, REPO, { renderContext: column([]) });
    await expect(
      upgradePlanStep.apply(ctx, {
        detected,
        formValues: { addCliTargets: ['codex'] },
        iteration: 0,
        previousIterations: [],
      }),
    ).rejects.toThrow('context changed');
  });
  it('backfills through the decoder, preserves an existing authoritative [], and repeats without new dirty revisions', async () => {
    const fake = createFakeDb({
      repositories: schema.repositories,
      onboardingArtifacts: schema.onboardingArtifacts,
      tasks: schema.tasks,
      projectStateOutbox: schema.projectStateOutbox,
    });
    fake.insert(schema.repositories, {
      id: REPO,
      renderContext: { ...legacy, rtkChoiceRecorded: false },
      rootClaimedAt: null,
    });
    fake.insert(schema.onboardingArtifacts, {
      repositoryId: REPO,
      supersededAt: null,
      generatedAt: new Date(1),
      formValuesSnapshot: { ...legacy, cliTargets: ['codex', 'future-cli'] },
    });
    fake.insert(schema.onboardingArtifacts, {
      repositoryId: REPO,
      supersededAt: null,
      generatedAt: new Date(2),
      formValuesSnapshot: { enabledCliProviders: [{ name: 'gemini' }] },
    });
    await seedRepositoryCliTargets(fake.db as unknown as Database);
    expect(fake.rows(schema.repositories)[0]?.renderContext).toMatchObject({
      cliTargets: ['codex', 'future-cli'],
      rtkChoiceRecorded: false,
    });
    expect(fake.rows(schema.projectStateOutbox)[0]?.revision).toBe(1);
    await seedRepositoryCliTargets(fake.db as unknown as Database);
    expect(fake.rows(schema.projectStateOutbox)[0]?.revision).toBe(1);
    fake.patch(schema.repositories, REPO, { renderContext: column([]) });
    await seedRepositoryCliTargets(fake.db as unknown as Database);
    expect(fake.rows(schema.repositories)[0]?.renderContext).toMatchObject({ cliTargets: [] });
  });
});

it('mixed-snapshot backfill takes newest membership without replacing the RTK-aware context origin', async () => {
  const fake = createFakeDb({
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    tasks: schema.tasks,
    projectStateOutbox: schema.projectStateOutbox,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    renderContext: null,
    rootClaimedAt: null,
    rtkChoiceMadeAt: null,
  });
  fake.insert(schema.onboardingArtifacts, {
    repositoryId: REPO,
    supersededAt: null,
    generatedAt: new Date(1),
    formValuesSnapshot: { ...legacy, framework: 'recorded-rtk-origin', rtkEnabled: true },
  });
  fake.insert(schema.onboardingArtifacts, {
    repositoryId: REPO,
    supersededAt: null,
    generatedAt: new Date(2),
    formValuesSnapshot: {
      ...legacy,
      framework: 'newest-pre-rtk',
      cliTargets: ['codex', 'future-cli'],
    },
  });
  await seedRepositoryCliTargets(fake.db as unknown as Database);
  expect(fake.rows(schema.repositories)[0]?.renderContext).toMatchObject({
    framework: 'recorded-rtk-origin',
    rtkEnabled: true,
    rtkChoiceRecorded: true,
    cliTargets: ['codex', 'future-cli'],
  });
});

it('skill writes use the current onboarding union, then the authoritative repository set in later tasks', async () => {
  const fake = newDb();
  seedProviders(fake);
  seedRepository(fake, {
    source: 'git_https',
    rtkEnabled: false,
    renderContext: column(['claude-code']),
  });
  fake.patch(schema.tasks, TASK, { type: 'onboarding' });
  fake.insert(schema.taskSteps, {
    taskId: TASK,
    stepId: '07-generate-files',
    round: 0,
    detectOutput: { cliTargets: ['claude-code', 'codex'] },
  });
  const ctx = ctxFor(fake, '/unused');
  expect(await resolveTaskSkillTargetDirs(ctx)).toEqual(['.claude/skills', '.agents/skills']);
  fake.patch(schema.tasks, TASK, { type: 'workflow' });
  expect(await resolveTaskSkillTargetDirs(ctx)).toEqual(['.claude/skills']);
  fake.patch(schema.repositories, REPO, { renderContext: column([]) });
  expect(await resolveTaskSkillTargetDirs(ctx, ['.claude/skills'])).toEqual([]);
});

it('zero-provider legacy fallback survives backfill without creating a Claude membership', async () => {
  const fake = createFakeDb({
    repositories: schema.repositories,
    onboardingArtifacts: schema.onboardingArtifacts,
    tasks: schema.tasks,
    projectStateOutbox: schema.projectStateOutbox,
  });
  const prior = { ...legacy, enabledCliProviders: [], rtkChoiceRecorded: false };
  fake.insert(schema.repositories, { id: REPO, renderContext: prior, rootClaimedAt: null });
  fake.insert(schema.onboardingArtifacts, {
    repositoryId: REPO,
    supersededAt: null,
    generatedAt: new Date(1),
    formValuesSnapshot: { ...legacy, enabledCliProviders: [] },
  });
  await seedRepositoryCliTargets(fake.db as unknown as Database);
  const stored = fake.rows(schema.repositories)[0]!.renderContext as typeof prior & {
    cliTargets: string[];
  };
  expect(stored.cliTargets).toEqual([]);
  expect(deriveRenderTargets([], [], undefined, true).agentTargets).toEqual([]);
  expect(stored).toMatchObject({ legacyAgentFallback: true });
  const revision = fake.rows(schema.projectStateOutbox)[0]?.revision;
  await seedRepositoryCliTargets(fake.db as unknown as Database);
  expect(fake.rows(schema.projectStateOutbox)[0]?.revision).toBe(revision);
  expect(renderContextFromColumn(stored, []).enabledCliProviders).toEqual([]);
  expect(renderContextFromColumn(stored, []).agentTargets).toEqual(legacy.agentTargets);
  expect(renderContextFromColumn(column([]), []).agentTargets).toEqual([]);
});
it('membership recovery skips absent lists but stops on a recorded empty list', () => {
  const portable = {
    projectInfo: {},
    framework: null,
    acceptedAgentIds: [],
    customAgentSpecs: [],
    lspLanguages: [],
  };
  const row = (at: number, formValuesSnapshot: unknown) => ({
    id: `00000000-0000-4000-8000-${String(at).padStart(12, '0')}`,
    generatedAt: new Date(at),
    formValuesSnapshot,
  });
  expect(
    recoverCliTargets([
      row(1, { ...legacy, cliTargets: ['codex', 'future-cli'] }),
      row(2, portable),
    ]),
  ).toEqual(['codex', 'future-cli']);
  expect(
    recoverCliTargets([row(1, legacy), row(2, { ...portable, cliTargets: [] }), row(3, portable)]),
  ).toEqual([]);
});

it('unchanged CLI choices retain the legacy fallback, while a real explicit addition clears it for preview', async () => {
  const fake = newDb();
  seedProviders(fake, [
    { name: 'amp', enabled: true },
    { name: 'codex', enabled: true },
  ]);
  const old = { ...column(['amp']), legacyAgentFallback: true };
  seedRepository(fake, { source: 'git_https', rtkEnabled: false, renderContext: old });
  const dir = await mkdtemp(join(tmpdir(), 'fallback-choice-'));
  dirs.push(dir);
  const rendered = expandManifestFor(renderContextFromColumn(old, [])).find(
    (row) => row.diskPath === '.claude/agents/code-reviewer.md',
  )!;
  await mkdir(dirname(join(dir, rendered.diskPath)), { recursive: true });
  await writeFile(join(dir, rendered.diskPath), rendered.content);
  seedLiveRow(fake, { path: rendered.diskPath, snapshot: old, at: 1 });
  const row = fake.rows(schema.onboardingArtifacts)[0]!;
  fake.patch(schema.onboardingArtifacts, row.id as string, {
    templateId: rendered.templateId,
    writtenHash: rendered.writtenHash,
    templateContentHash: rendered.templateContentHash,
    templateSchemaVersion: rendered.templateSchemaVersion,
  });
  const ctx = ctxFor(fake, dir);
  const detected = await upgradePlanStep.detect!(ctx);
  const keep = await upgradePlanStep.apply(ctx, {
    detected,
    formValues: { addCliTargets: [] },
    iteration: 0,
    previousIterations: [],
  });
  expect(keep.renderCtxSnapshot).toMatchObject({ cliTargets: ['amp'], legacyAgentFallback: true });
  expect(keep.entries.find((e) => e.diskPath === rendered.diskPath)?.bucket).toBe('unchanged');
  const add = await upgradePlanStep.apply(ctx, {
    detected,
    formValues: { addCliTargets: ['codex'] },
    iteration: 0,
    previousIterations: [],
  });
  expect(add.renderCtxSnapshot.cliTargets).toEqual(['amp', 'codex']);
  expect(add.renderCtxSnapshot.legacyAgentFallback).toBeUndefined();
  expect(add.entries.find((e) => e.diskPath === rendered.diskPath)?.bucket).toBe('obsolete');
});
it('the fallback compatibility marker decodes strictly and never changes a genuinely explicit empty context', () => {
  expect(readRenderContextColumn({ ...column([]), legacyAgentFallback: 'true' }).kind).toBe(
    'refused',
  );
  expect(renderContextFromColumn(column([]), []).agentTargets).toEqual([]);
  expect(renderContextFromColumn({ ...column([]), agentTargets: [] }, []).agentTargets).toEqual([]);
});
