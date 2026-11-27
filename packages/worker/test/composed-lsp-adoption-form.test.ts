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
import { checkTaskComposedLspProvider } from '@haive/shared/composed-lsp-provider-lock';
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
  repoLsp?: string[] | null;
  onboardingLsp?: string[];
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
    cliProviderId: s.defaultProvider ?? CLAUDE,
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
    lspServers: s.repoLsp === undefined ? ['intelephense-extended'] : s.repoLsp,
    onboardingEnvironment: {
      schemaVersion: ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
      envDetectData: {},
      confirmedValues: {},
    },
    onboardingTooling: {
      schemaVersion: ONBOARDING_TOOLING_SCHEMA_VERSION,
      tooling: { lspLanguages: s.onboardingLsp ?? [] },
    },
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
    emitProgress: vi.fn(),
  } as unknown as StepContext;
}

const adoptable = (detected: unknown) =>
  (detected as { composedLspAdoptable?: boolean }).composedLspAdoptable;

describe('detect composedLspAdoptable', () => {
  it.each([
    { keys: [] },
    { keys: ['vtsls'] },
    { keys: ['intelephense-extended', 'pyright'] },
    { keys: ['intelephense-extended', 'vtsls'] },
  ])('does not offer adoption for effective selection %j', async ({ keys }) => {
    const detected = await declareDepsStep.detect!(makeCtx({ repoLsp: keys }));
    expect(adoptable(detected)).not.toBe(true);
  });

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
    const legacyKeys = (d: object) =>
      Object.keys(d).filter((k) => k !== 'composedLspAdoptable' && k !== 'legacyLspReplaceable');
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
  it.each([
    {
      label: 'mixed suggestion edited to PHP',
      onboardingLsp: ['php', 'typescript'],
      lspServers: ['intelephense-extended'],
      keepLegacyLspInstall: true,
    },
    {
      label: 'empty suggestion edited to PHP',
      onboardingLsp: [],
      lspServers: ['intelephense-extended'],
      keepLegacyLspInstall: true,
    },
    {
      label: 'unchanged mixed suggestion with opt-out unchecked',
      onboardingLsp: ['php', 'typescript'],
      lspServers: ['intelephense-extended', 'vtsls'],
      keepLegacyLspInstall: false,
    },
  ])(
    'offers the opt-out and stays legacy for $label',
    async ({ onboardingLsp, lspServers, keepLegacyLspInstall }) => {
      const ctx = makeCtx({ repoLsp: null, onboardingLsp });
      const detected = await declareDepsStep.detect!(ctx);
      const form = declareDepsStep.form!(ctx, detected)!;
      expect(form.fields).toContainEqual(
        expect.objectContaining({ id: 'keepLegacyLspInstall', type: 'checkbox', default: false }),
      );
      expect(detected.suggestedLsp).toEqual(
        onboardingLsp.length ? ['intelephense-extended', 'vtsls'] : [],
      );
      // A human can remove the incompatible server (or add PHP) and keep other CLIs usable.
      await declareDepsStep.apply(ctx, {
        detected,
        formValues: {
          runtimes: ['php'],
          phpVersion: '8.3',
          containerTool: 'none',
          databaseKind: 'none',
          databaseVersion: '',
          lspServers,
          keepLegacyLspInstall,
          browserTesting: false,
        },
        iteration: 0,
        previousIterations: [],
      });
      const template = await ctx.db.query.envTemplates.findFirst();
      expect(template?.declaredDeps).toMatchObject({ lspServers });
      expect(template?.declaredDeps).not.toHaveProperty('lspInstallContractVersion');
      expect((await ctx.db.query.tasks.findFirst())?.envTemplateId).toBe(template?.id);
      expect(
        await checkTaskComposedLspProvider(ctx.db, {
          taskId: TASK,
          userId: USER,
          providerId: CODEX,
        }),
      ).toBeNull();
    },
  );

  it('keeps the PHP-only editable suggestion adoptable with the opt-out unchecked', async () => {
    const ctx = makeCtx({ repoLsp: null, onboardingLsp: ['php'] });
    const detected = await declareDepsStep.detect!(ctx);
    expect(declareDepsStep.form!(ctx, detected)!.fields).toContainEqual(
      expect.objectContaining({ id: 'keepLegacyLspInstall', default: false }),
    );
    await declareDepsStep.apply(ctx, {
      detected,
      formValues: {
        runtimes: ['php'],
        phpVersion: '8.3',
        containerTool: 'none',
        databaseKind: 'none',
        databaseVersion: '',
        lspServers: ['intelephense-extended'],
        keepLegacyLspInstall: false,
        browserTesting: false,
      },
      iteration: 0,
      previousIterations: [],
    });
    expect((await ctx.db.query.envTemplates.findFirst())?.declaredDeps).toHaveProperty(
      'lspInstallContractVersion',
      2,
    );
  });

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
