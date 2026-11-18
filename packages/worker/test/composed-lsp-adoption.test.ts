import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  declareDepsStep,
  stableStringify,
} from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

// Most controls pin the writer with the switch on; the rollback controls below turn it off.
const adoption = vi.hoisted(() => ({ on: true }));
vi.mock('../src/lsp/composed-adoption.js', async (original) => ({
  ...(await original<object>()),
  get COMPOSED_LSP_NEW_ENVIRONMENT_ADOPTION() {
    return adoption.on;
  },
}));

// Contract-2 writer in step 01. A genuinely NEW environment (no linked template) gets
// declaredDeps.lspInstallContractVersion = 2 only when every eligibility rule holds; an
// existing row's contract is carried verbatim; an unknown stored contract is refused.
// Controls whose title says "legacy parity pin" are expected to pass on code without the writer.

const KEY = 'lspInstallContractVersion';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TASK = uuid(1);
const REPO = uuid(2);
const TEMPLATE = uuid(3);
const OTHER_TASK = uuid(4);
const USER = uuid(5);
const CLAUDE = uuid(10);
const CLAUDE2 = uuid(11);
const CODEX = uuid(12);
const ZAI = uuid(13);
const UNKNOWN = uuid(14);
const KEPT_DOCKERFILE = 'FROM ubuntu:24.04\nRUN echo kept\n';

const ELIGIBLE_RUN_LIST = [
  '00-triage',
  '04-verify-environment',
  '01-worktree-setup',
  '01b-install-plugins',
  '01b1-verify-composed-lsp',
  '05-implement',
];
const without = (id: string) => ELIGIBLE_RUN_LIST.filter((s) => s !== id);

interface ProviderRow {
  id: string;
  name: string;
  enabled: boolean;
}
const PROVIDERS: ProviderRow[] = [
  { id: CLAUDE, name: 'claude-code', enabled: true },
  { id: CLAUDE2, name: 'claude-code', enabled: true },
  { id: CODEX, name: 'codex', enabled: true },
  { id: ZAI, name: 'zai', enabled: true },
];

interface Scenario {
  defaultProvider?: string;
  providers?: ProviderRow[];
  repoLsp?: string[] | null;
  repoVersions?: Record<string, string> | null;
  formLsp?: string[];
  runList?: string[];
  choices?: { stepId: string; role?: string; cliProviderId: string | null }[];
  summary?: string | null;
  prefs?: { stepId: string; cliProviderId: string; explicit: boolean }[];
  rolePrefs?: { stepId: string; cliProviderId: string; explicit: boolean }[];
  ignoreSaved?: boolean;
  keepLegacy?: boolean;
  rubyVersion?: string;
  /** Link the task to a saved row whose stored contract is this value ('absent' = no key). */
  stored?: 'absent' | { value: unknown };
  /** Another live task shares the saved row and its stored deps differ (fork). */
  fork?: boolean;
  /** Register only the tables a legacy fixture has. */
  legacyTables?: boolean;
}

function buildFake(s: Scenario, storedDeps: Record<string, unknown> | null) {
  const fake = createFakeDb(
    s.legacyTables
      ? {
          tasks: schema.tasks,
          repositories: schema.repositories,
          envTemplates: schema.envTemplates,
          cliProviders: schema.cliProviders,
        }
      : {
          tasks: schema.tasks,
          repositories: schema.repositories,
          envTemplates: schema.envTemplates,
          cliProviders: schema.cliProviders,
          taskStepCliChoices: schema.taskStepCliChoices,
          userStepCliPreferences: schema.userStepCliPreferences,
          userStepCliRolePreferences: schema.userStepCliRolePreferences,
          taskTypeDefinitions: schema.taskTypeDefinitions,
        },
  );
  const task = {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type: 'custom-lsp',
    status: 'running',
    executionPath: 'quick_bugfix',
    runListSnapshot: s.runList ?? ELIGIBLE_RUN_LIST,
    summaryCliProviderId: s.summary ?? null,
    ignoreSavedStepClis: s.ignoreSaved ?? false,
    envTemplateId: storedDeps ? TEMPLATE : null,
  };
  fake.insert(schema.tasks, task);
  fake.insert(schema.repositories, {
    id: REPO,
    lspServers: s.repoLsp === undefined ? ['intelephense-extended'] : s.repoLsp,
    lspServerVersions: s.repoVersions ?? null,
  });
  for (const p of s.providers ?? PROVIDERS)
    fake.insert(schema.cliProviders, { userId: USER, ...p });
  if (storedDeps) {
    fake.insert(schema.envTemplates, {
      id: TEMPLATE,
      userId: USER,
      repositoryId: REPO,
      name: 'task-00000000',
      baseImage: 'ubuntu:24.04',
      declaredDeps: storedDeps,
      generatedDockerfile: KEPT_DOCKERFILE,
      status: 'ready',
    });
    if (s.fork) {
      fake.insert(schema.tasks, {
        id: OTHER_TASK,
        userId: USER,
        type: 'custom-lsp',
        status: 'running',
        ignoreSavedStepClis: false,
        envTemplateId: TEMPLATE,
      });
    }
  }
  if (!s.legacyTables) {
    for (const c of s.choices ?? []) {
      fake.insert(schema.taskStepCliChoices, { taskId: TASK, role: 'default', ...c });
    }
    for (const p of s.prefs ?? []) {
      fake.insert(schema.userStepCliPreferences, { userId: USER, ...p });
    }
    for (const p of s.rolePrefs ?? []) {
      fake.insert(schema.userStepCliRolePreferences, { userId: USER, role: 'review', ...p });
    }
  }
  return fake;
}

function makeRun(s: Scenario, storedDeps: Record<string, unknown> | null) {
  const fake = buildFake(s, storedDeps);
  const emitProgress = vi.fn(async () => {});
  const ctx = {
    taskId: TASK,
    userId: USER,
    cliProviderId: s.defaultProvider ?? CLAUDE,
    db: fake.db as unknown as Database,
    logger: { info: vi.fn() },
    emitProgress,
  } as unknown as StepContext;
  const args = {
    detected: { runtimes: [], cliSupportsLsp: true },
    formValues: {
      runtimes: [],
      containerTool: 'none',
      databaseKind: 'none',
      databaseVersion: '',
      preinstallDeps: true,
      browserTesting: false,
      extraPackages: '',
      ...(s.formLsp ? { lspServers: s.formLsp } : {}),
      ...(s.keepLegacy !== undefined ? { keepLegacyLspInstall: s.keepLegacy } : {}),
      ...(s.rubyVersion ? { rubyVersion: s.rubyVersion } : {}),
    },
    iteration: 0,
    previousIterations: [],
  } as unknown as Parameters<typeof declareDepsStep.apply>[1];
  return { fake, ctx, args, emitProgress, apply: () => declareDepsStep.apply(ctx, args) };
}

type Deps = Record<string, unknown>;
const depsOf = (fake: ReturnType<typeof buildFake>, id?: string): Deps => {
  const rows = fake.rows(schema.envTemplates);
  const row = id ? rows.find((r) => r.id === id) : rows[0];
  return row?.declaredDeps as Deps;
};
const dropKey = (deps: Deps): Deps => {
  const { [KEY]: _dropped, ...rest } = deps;
  return rest;
};

/** The deps this scenario writes for a new environment when the opt-out is ticked. */
async function legacyDeps(s: Scenario): Promise<Deps> {
  const r = makeRun({ ...s, keepLegacy: true, stored: undefined, fork: false }, null);
  await r.apply();
  return depsOf(r.fake);
}

async function applyNew(s: Scenario): Promise<Deps> {
  const r = makeRun(s, null);
  await r.apply();
  return depsOf(r.fake);
}

/** An existing linked row whose deps equal what apply writes (so an update is in place). */
async function makeExisting(s: Scenario) {
  const base = await legacyDeps(s);
  const stored = s.stored ?? 'absent';
  const storedDeps: Deps = {
    ...base,
    ...(stored === 'absent' ? {} : { [KEY]: stored.value }),
    ...(s.fork ? { extraPackages: ['vim'] } : {}),
  };
  return makeRun(s, storedDeps);
}

const LEGACY_N2_DEPS = {
  runtimes: [],
  versions: { node: null, php: null, python: null, java: null },
  packageManagers: {},
  preinstallDeps: true,
  containerTool: 'none',
  database: { kind: 'none', version: null },
  lspServers: ['intelephense-extended'],
  browserTesting: false,
  extraPackages: [],
};

describe('contract-2 writer: new environment', () => {
  it('N1 eligible environment writes contract 2 and nothing else changes', async () => {
    const deps = await applyNew({});
    expect(deps[KEY]).toBe(2);
    expect(stableStringify(dropKey(deps))).toBe(stableStringify(await legacyDeps({})));
  });

  it('N2 opt-out writes no contract key (legacy parity pin)', async () => {
    const deps = await applyNew({ keepLegacy: true });
    expect(deps).not.toHaveProperty(KEY);
    expect(stableStringify(deps)).toBe(stableStringify(LEGACY_N2_DEPS));
  });

  it.each<[string, Scenario]>([
    ['run list without 01b1-verify-composed-lsp', { runList: without('01b1-verify-composed-lsp') }],
    ['run list without 01b-install-plugins', { runList: without('01b-install-plugins') }],
    ['zai default (supports LSP, not the verified provider)', { defaultProvider: ZAI }],
    ['codex default (CLI without LSP support)', { defaultProvider: CODEX }],
    ['a step choice naming codex', { choices: [{ stepId: '05-implement', cliProviderId: CODEX }] }],
    [
      'a step choice naming a second claude-code provider',
      { choices: [{ stepId: '05-implement', cliProviderId: CLAUDE2 }] },
    ],
    [
      'a step choice naming an unknown provider id',
      { choices: [{ stepId: '05-implement', cliProviderId: UNKNOWN }] },
    ],
    ['summary CLI codex', { summary: CODEX }],
    [
      'saved explicit role pref codex on a run-list step',
      { rolePrefs: [{ stepId: '05-implement', cliProviderId: CODEX, explicit: true }] },
    ],
    [
      'saved explicit pref codex on a run-list step',
      { prefs: [{ stepId: '05-implement', cliProviderId: CODEX, explicit: true }] },
    ],
    [
      'disabled claude-code default',
      { providers: PROVIDERS.map((p) => (p.id === CLAUDE ? { ...p, enabled: false } : p)) },
    ],
    ['empty repo list over a non-empty form', { repoLsp: [], formLsp: ['intelephense-extended'] }],
    ['selection [php] (alias)', { repoLsp: ['php'] }],
    ['selection with another server', { repoLsp: ['intelephense-extended', 'vtsls'] }],
  ])('N3 ineligible: %s writes no key (legacy parity pin)', async (_title, scenario) => {
    expect(await applyNew(scenario)).not.toHaveProperty(KEY);
  });

  it('N3 control: the form selection is used when the repo has no list', async () => {
    const deps = await applyNew({ repoLsp: null, formLsp: ['intelephense'] });
    expect(deps[KEY]).toBe(2);
    expect(deps.lspServers).toEqual(['intelephense']);
  });

  it('N4 saved explicit pref on a step outside the run list stays eligible', async () => {
    const deps = await applyNew({
      prefs: [{ stepId: '99-not-in-run-list', cliProviderId: CODEX, explicit: true }],
      rolePrefs: [{ stepId: '99-not-in-run-list', cliProviderId: CODEX, explicit: true }],
    });
    expect(deps[KEY]).toBe(2);
  });

  it('N4 saved explicit pref is ignored when ignoreSavedStepClis is set', async () => {
    const deps = await applyNew({
      ignoreSaved: true,
      prefs: [{ stepId: '05-implement', cliProviderId: CODEX, explicit: true }],
      rolePrefs: [{ stepId: '05-implement', cliProviderId: CODEX, explicit: true }],
    });
    expect(deps[KEY]).toBe(2);
  });

  it('N4 a non-explicit pref row stays eligible', async () => {
    const deps = await applyNew({
      prefs: [{ stepId: '05-implement', cliProviderId: CODEX, explicit: false }],
      rolePrefs: [{ stepId: '05-implement', cliProviderId: CODEX, explicit: false }],
    });
    expect(deps[KEY]).toBe(2);
  });

  it('N5 an alias version pin is kept exactly as before, plus contract 2', async () => {
    const s: Scenario = { repoVersions: { php: '1.2.3' } };
    const deps = await applyNew(s);
    expect(deps[KEY]).toBe(2);
    expect(deps.lspServerVersions).toEqual({ php: '1.2.3' });
    expect(stableStringify(dropKey(deps))).toBe(stableStringify(await legacyDeps(s)));
  });

  it('N6 a CLI without LSP support touches no table a legacy fixture lacks (legacy parity pin)', async () => {
    const deps = await applyNew({ defaultProvider: CODEX, legacyTables: true });
    expect(deps).not.toHaveProperty(KEY);
    expect(deps.lspServers).toEqual([]);
  });
});

describe('contract-2 writer: existing linked row', () => {
  const written = (r: Awaited<ReturnType<typeof makeExisting>>) =>
    r.fake.rows(schema.envTemplates).find((row) => row.id === TEMPLATE) as Record<string, unknown>;

  it('E1 stored absent stays absent and the saved Dockerfile is kept (legacy parity pin)', async () => {
    const r = await makeExisting({ stored: 'absent' });
    await r.apply();
    expect(written(r).declaredDeps).not.toHaveProperty(KEY);
    expect(written(r).generatedDockerfile).toBe(KEPT_DOCKERFILE);
  });

  it('E2 stored 1 stays 1 and the saved Dockerfile is kept', async () => {
    const r = await makeExisting({ stored: { value: 1 } });
    await r.apply();
    expect((written(r).declaredDeps as Deps)[KEY]).toBe(1);
    expect(written(r).generatedDockerfile).toBe(KEPT_DOCKERFILE);
  });

  it('E3 stored 2 stays 2 and the saved Dockerfile is kept', async () => {
    const r = await makeExisting({ stored: { value: 2 } });
    await r.apply();
    expect((written(r).declaredDeps as Deps)[KEY]).toBe(2);
    expect(written(r).generatedDockerfile).toBe(KEPT_DOCKERFILE);
  });

  it('E4 stored 2 ignores keepLegacyLspInstall', async () => {
    const r = await makeExisting({ stored: { value: 2 }, keepLegacy: true });
    await r.apply();
    expect((written(r).declaredDeps as Deps)[KEY]).toBe(2);
  });

  it.each<[string, Scenario]>([
    ['empty repo selection', { repoLsp: [] }],
    ['zai default', { defaultProvider: ZAI }],
    ['run list without 01b1-verify-composed-lsp', { runList: without('01b1-verify-composed-lsp') }],
    ['codex default (no LSP support)', { defaultProvider: CODEX }],
  ])('E5 stored 2 is never re-decided or dropped: %s', async (_title, scenario) => {
    const r = await makeExisting({ ...scenario, stored: { value: 2 } });
    await r.apply();
    expect((written(r).declaredDeps as Deps)[KEY]).toBe(2);
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['0', 0],
    ['3', 3],
    ["'1'", '1'],
    ["'2'", '2'],
    ['{}', {}],
  ])('E6 stored %s is refused before any progress or write', async (_title, value) => {
    const r = await makeExisting({ stored: { value }, rubyVersion: '3.3.0' });
    const before = structuredClone([r.fake.rows(schema.envTemplates), r.fake.rows(schema.tasks)]);
    await expect(r.apply()).rejects.toThrow(/Unsupported LSP install contract/);
    expect(r.emitProgress).not.toHaveBeenCalled();
    expect([r.fake.rows(schema.envTemplates), r.fake.rows(schema.tasks)]).toEqual(before);
  });

  it('E7 a forked row carries the stored 2 and leaves the shared row untouched', async () => {
    const r = await makeExisting({ stored: { value: 2 }, fork: true });
    const original = structuredClone(written(r));
    await r.apply();
    const rows = r.fake.rows(schema.envTemplates);
    expect(rows).toHaveLength(2);
    const fork = rows.find((row) => row.id !== TEMPLATE)!;
    expect((fork.declaredDeps as Deps)[KEY]).toBe(2);
    expect(written(r)).toEqual(original);
  });

  it('E7 a forked row from a stored-absent row has no key (legacy parity pin)', async () => {
    const r = await makeExisting({ stored: 'absent', fork: true });
    const original = structuredClone(written(r));
    await r.apply();
    const rows = r.fake.rows(schema.envTemplates);
    expect(rows).toHaveLength(2);
    const fork = rows.find((row) => row.id !== TEMPLATE)!;
    expect(fork.declaredDeps).not.toHaveProperty(KEY);
    expect(written(r)).toEqual(original);
  });
});

describe('contract-2 writer: rollback switch', () => {
  it('ships switched on', async () => {
    const actual = await vi.importActual<typeof import('../src/lsp/composed-adoption.js')>(
      '../src/lsp/composed-adoption.js',
    );
    expect(actual.COMPOSED_LSP_NEW_ENVIRONMENT_ADOPTION).toBe(true);
  });

  it('switched off, an eligible new environment writes no contract key', async () => {
    adoption.on = false;
    try {
      const deps = await applyNew({});
      expect(deps).not.toHaveProperty(KEY);
      expect(stableStringify(deps)).toBe(stableStringify(await legacyDeps({})));
    } finally {
      adoption.on = true;
    }
  });
});
