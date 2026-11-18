import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import {
  ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
} from '@haive/shared';
import { createFakeDb } from '@haive/database/testing';
import {
  declareDepsStep,
  type DeclareDepsDetect,
  type DeclareDepsFormValues,
} from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

// These controls pin the writer with the switch on, independent of its shipped value.
vi.mock('../src/lsp/composed-adoption.js', async (original) => ({
  ...(await original<object>()),
  COMPOSED_LSP_NEW_ENVIRONMENT_ADOPTION: true,
}));

// Detect, form and reuse reconciliation for the composed-LSP opt-out. Controls whose title says
// "legacy parity pin" are expected to pass on code without the writer.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TASK = uuid(1);
const REPO = uuid(2);
const TEMPLATE = uuid(3);
const USER = uuid(5);
const CLAUDE = uuid(10);
const CODEX = uuid(12);
const ZAI = uuid(13);

const ELIGIBLE_RUN_LIST = [
  '00-triage',
  '04-verify-environment',
  '01-worktree-setup',
  '01b-install-plugins',
  '01b1-verify-composed-lsp',
  '05-implement',
];

const PROVIDERS = [
  { id: CLAUDE, name: 'claude-code', enabled: true },
  { id: CODEX, name: 'codex', enabled: true },
  { id: ZAI, name: 'zai', enabled: true },
];

let repoPath: string;
beforeEach(async () => {
  repoPath = await mkdtemp(path.join(os.tmpdir(), 'haive-composed-lsp-'));
});
afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true });
});

interface Scenario {
  defaultProvider?: string;
  providers?: typeof PROVIDERS;
  runList?: string[];
  linked?: boolean;
}

function makeCtx(s: Scenario = {}): StepContext {
  const fake = createFakeDb({
    tasks: schema.tasks,
    repositories: schema.repositories,
    envTemplates: schema.envTemplates,
    cliProviders: schema.cliProviders,
    taskStepCliChoices: schema.taskStepCliChoices,
    userStepCliPreferences: schema.userStepCliPreferences,
    userStepCliRolePreferences: schema.userStepCliRolePreferences,
    taskTypeDefinitions: schema.taskTypeDefinitions,
    taskSteps: schema.taskSteps,
    toolPackageVersions: schema.toolPackageVersions,
  });
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type: 'custom-lsp',
    status: 'running',
    executionPath: 'quick_bugfix',
    runListSnapshot: s.runList ?? ELIGIBLE_RUN_LIST,
    ignoreSavedStepClis: false,
    envTemplateId: s.linked ? TEMPLATE : null,
  });
  // Valid onboarding mirrors keep detect off the joined task_steps fallback the fake cannot run.
  fake.insert(schema.repositories, {
    id: REPO,
    lspServers: ['intelephense-extended'],
    onboardingEnvironment: {
      schemaVersion: ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
      envDetectData: {},
      confirmedValues: {},
    },
    onboardingTooling: { schemaVersion: ONBOARDING_TOOLING_SCHEMA_VERSION, tooling: {} },
  });
  for (const p of s.providers ?? PROVIDERS)
    fake.insert(schema.cliProviders, { userId: USER, ...p });
  if (s.linked) {
    fake.insert(schema.envTemplates, {
      id: TEMPLATE,
      userId: USER,
      repositoryId: REPO,
      name: 'task-00000000',
      baseImage: 'ubuntu:24.04',
      declaredDeps: {},
    });
  }
  return {
    taskId: TASK,
    userId: USER,
    cliProviderId: s.defaultProvider ?? CLAUDE,
    repoPath,
    db: fake.db as unknown as Database,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  } as unknown as StepContext;
}

const adoptable = (detected: unknown) =>
  (detected as { composedLspAdoptable?: boolean }).composedLspAdoptable;

describe('detect composedLspAdoptable', () => {
  it('C1 is true for an eligible new environment', async () => {
    const detected = await declareDepsStep.detect!(makeCtx());
    expect(adoptable(detected)).toBe(true);
  });

  it.each<[string, Scenario]>([
    ['a linked env template', { linked: true }],
    ['zai default', { defaultProvider: ZAI }],
    ['codex default', { defaultProvider: CODEX }],
    [
      'a run list without 01b1-verify-composed-lsp',
      { runList: ELIGIBLE_RUN_LIST.filter((id) => id !== '01b1-verify-composed-lsp') },
    ],
    [
      'a disabled claude-code default',
      { providers: PROVIDERS.map((p) => (p.id === CLAUDE ? { ...p, enabled: false } : p)) },
    ],
  ])('C1 is not true with %s (legacy parity pin)', async (_title, scenario) => {
    const detected = await declareDepsStep.detect!(makeCtx(scenario));
    expect(adoptable(detected)).not.toBe(true);
  });

  it('C1 leaves the other detect output as it was (legacy parity pin)', async () => {
    const detected = await declareDepsStep.detect!(makeCtx());
    const legacyKeys = (d: object) => Object.keys(d).filter((k) => k !== 'composedLspAdoptable');
    expect(legacyKeys(detected)).toEqual(
      legacyKeys(await declareDepsStep.detect!(makeCtx({ linked: true }))),
    );
  });
});

function baseDetect(extra: Record<string, unknown> = {}): DeclareDepsDetect {
  return {
    runtimes: [],
    containerTool: 'none',
    webserver: 'nginx-fpm',
    ddevProjectName: null,
    database: { kind: 'none', version: null },
    suggestedLsp: ['intelephense-extended'],
    cliSupportsLsp: true,
    ...extra,
  } as unknown as DeclareDepsDetect;
}

const fieldIds = (detected: DeclareDepsDetect) =>
  declareDepsStep.form!({} as never, detected)!.fields.map((f) => f.id);

describe('form keepLegacyLspInstall checkbox', () => {
  it('C2 is offered, unchecked, right after the legacy fields when adoptable', () => {
    const legacy = fieldIds(baseDetect());
    const ids = fieldIds(baseDetect({ composedLspAdoptable: true }));
    expect(ids.filter((id) => id !== 'keepLegacyLspInstall')).toEqual(legacy);
    expect(ids).toContain('keepLegacyLspInstall');
    const field = declareDepsStep.form!(
      {} as never,
      baseDetect({ composedLspAdoptable: true }),
    )!.fields.find((f) => f.id === 'keepLegacyLspInstall');
    expect(field).toMatchObject({ type: 'checkbox', default: false });
  });

  it.each([false, undefined])(
    'C2 field list is exactly the legacy one when composedLspAdoptable is %s (legacy parity pin)',
    (value) => {
      const ids = fieldIds(baseDetect(value === undefined ? {} : { composedLspAdoptable: value }));
      expect(ids).not.toContain('keepLegacyLspInstall');
      expect(ids).toEqual(fieldIds(baseDetect()));
    },
  );
});

describe('reconcileReusedFormValues keepLegacyLspInstall', () => {
  const reuse = (reused: Record<string, unknown>) =>
    declareDepsStep.reconcileReusedFormValues!(
      {} as StepContext,
      baseDetect(),
      reused as unknown as DeclareDepsFormValues,
    ) as unknown as Promise<Record<string, unknown>> | Record<string, unknown>;

  const answers = {
    runtimes: ['php'],
    phpVersion: '8.3',
    containerTool: 'docker-compose',
    databaseKind: 'postgres',
    databaseVersion: '15',
    lspServers: ['intelephense-extended'],
    preinstallDeps: false,
    browserTesting: true,
    extraPackages: 'vim',
  };

  it.each([true, false])('D1 drops keepLegacyLspInstall=%s and keeps the rest', async (flag) => {
    const out = await reuse({ ...answers, keepLegacyLspInstall: flag });
    expect(Object.hasOwn(out, 'keepLegacyLspInstall')).toBe(false);
    expect(out).toEqual(answers);
  });

  it('D1 returns the same reference when the key is absent (legacy parity pin)', async () => {
    const reused = { ...answers };
    expect(await reuse(reused)).toBe(reused);
  });
});
