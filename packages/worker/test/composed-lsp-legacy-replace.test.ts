import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getTableName } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import {
  imageRepo,
  ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
} from '@haive/shared';
import { createFakeDb } from '@haive/database/testing';
import {
  declareDepsStep,
  stableStringify,
  type DeclareDepsDetect,
} from '../src/step-engine/steps/env-replicate/01-declare-deps.js';
import {
  generateDockerfileStep,
  renderDockerfile,
} from '../src/step-engine/steps/env-replicate/02-generate-dockerfile.js';
import { createBuildImageStep } from '../src/step-engine/steps/env-replicate/03-build-image.js';
import type { DockerRunner } from '../src/sandbox/docker-runner.js';
import type { StepContext } from '../src/step-engine/step-definition.js';

const adoption = vi.hoisted(() => ({ on: true }));
vi.mock('../src/lsp/composed-adoption.js', async (original) => ({
  ...(await original<object>()),
  get COMPOSED_LSP_NEW_ENVIRONMENT_ADOPTION() {
    return adoption.on;
  },
}));

// Explicit replacement of a stored legacy environment template. Controls whose title says PIN
// are expected to pass on code without the feature.

const KEY = 'lspInstallContractVersion';
const REPLACE = 'replaceLegacyLspInstall';
const REFUSED = 'composed_lsp_replacement_refused';
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

const PROVIDERS = [
  { id: CLAUDE, name: 'claude-code', enabled: true },
  { id: CLAUDE2, name: 'claude-code', enabled: true },
  { id: CODEX, name: 'codex', enabled: true },
  { id: ZAI, name: 'zai', enabled: true },
];

interface Scenario {
  defaultProvider?: string;
  providers?: typeof PROVIDERS;
  repoLsp?: string[] | null;
  runList?: string[];
  choices?: { stepId: string; cliProviderId: string | null }[];
  /** The saved row's stored contract ('absent' = no key). */
  stored?: 'absent' | { value: unknown };
  /** Another task shares the saved row, whose stored deps then differ from a fresh apply. */
  share?: 'live' | 'completed';
  /** The submitted value of the replacement checkbox; undefined = key absent. */
  replace?: boolean;
}

let repoPath: string;
beforeEach(async () => {
  repoPath = await mkdtemp(path.join(os.tmpdir(), 'haive-lsp-replace-'));
});
afterEach(async () => {
  adoption.on = true;
  await rm(repoPath, { recursive: true, force: true });
});

function buildFake(s: Scenario, storedDeps: Record<string, unknown> | null) {
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
    taskEvents: schema.taskEvents,
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
    envTemplateId: storedDeps ? TEMPLATE : null,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    lspServers: s.repoLsp === undefined ? ['intelephense-extended'] : s.repoLsp,
    lspServerVersions: null,
    onboardingEnvironment: {
      schemaVersion: ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
      envDetectData: {},
      confirmedValues: {},
    },
    onboardingTooling: { schemaVersion: ONBOARDING_TOOLING_SCHEMA_VERSION, tooling: {} },
  });
  for (const p of s.providers ?? PROVIDERS)
    fake.insert(schema.cliProviders, { userId: USER, ...p });
  for (const c of s.choices ?? []) {
    fake.insert(schema.taskStepCliChoices, { taskId: TASK, role: 'default', ...c });
  }
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
    if (s.share) {
      fake.insert(schema.tasks, {
        id: OTHER_TASK,
        userId: USER,
        type: 'custom-lsp',
        status: s.share === 'live' ? 'running' : 'completed',
        ignoreSavedStepClis: false,
        envTemplateId: TEMPLATE,
      });
    }
  }
  return fake;
}

function makeRun(s: Scenario, storedDeps: Record<string, unknown> | null) {
  const fake = buildFake(s, storedDeps);
  const ctx = {
    taskId: TASK,
    userId: USER,
    cliProviderId: s.defaultProvider ?? CLAUDE,
    repoPath,
    db: fake.db as unknown as Database,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    emitProgress: vi.fn(async () => {}),
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
      ...(s.replace !== undefined ? { [REPLACE]: s.replace } : {}),
    },
    iteration: 0,
    previousIterations: [],
  } as unknown as Parameters<typeof declareDepsStep.apply>[1];
  return { fake, ctx, apply: () => declareDepsStep.apply(ctx, args) };
}

type Deps = Record<string, unknown>;
type Row = Record<string, unknown>;
type Run = ReturnType<typeof makeRun>;

async function applyNew(s: Scenario): Promise<Deps> {
  const r = makeRun({ ...s, stored: undefined, share: undefined, replace: undefined }, null);
  await r.apply();
  return r.fake.rows(schema.envTemplates)[0]!.declaredDeps as Deps;
}

/** A linked row whose deps equal a legacy apply (an update is in place), or stale when shared. */
async function makeLegacy(s: Scenario): Promise<Run> {
  const base = makeRun({ ...s, stored: undefined, share: undefined, replace: undefined }, null);
  adoption.on = false;
  await base.apply();
  adoption.on = true;
  const deps = base.fake.rows(schema.envTemplates)[0]!.declaredDeps as Deps;
  const stored = s.stored ?? 'absent';
  const { [KEY]: _dropped, ...rest } = deps;
  return makeRun(s, {
    ...rest,
    ...(stored === 'absent' ? {} : { [KEY]: stored.value }),
    ...(s.share ? { extraPackages: ['vim'] } : {}),
  });
}

const templates = (r: Run): Row[] => r.fake.rows(schema.envTemplates);
const source = (r: Run): Row => templates(r).find((row) => row.id === TEMPLATE)!;
const candidates = (r: Run): Row[] => templates(r).filter((row) => row.id !== TEMPLATE);
const events = (r: Run): Row[] => r.fake.rows(schema.taskEvents);
const linkOf = (r: Run, id: string) =>
  r.fake.rows(schema.tasks).find((t) => t.id === id)!.envTemplateId;

const STORED: [string, Scenario['stored']][] = [
  ['absent', 'absent'],
  ['1', { value: 1 }],
];
const SHARING: [string, Scenario['share']][] = [
  ['unshared', undefined],
  ['shared with a live running task', 'live'],
  ['shared with a completed task', 'completed'],
];

describe('replacement of a stored legacy template', () => {
  it.each(
    STORED.flatMap(([a, stored]) => SHARING.map(([b, share]) => [a, b, stored, share] as const)),
  )(
    'B1 stored %s, %s: ticked and eligible inserts a new row and leaves the source alone',
    async (_a, _b, stored, share) => {
      const s: Scenario = { stored, share, replace: true };
      const r = await makeLegacy(s);
      const before = structuredClone(source(r));
      const result = (await r.apply()) as { envTemplateId: string; baseImage: string };

      const evs = events(r);
      expect(evs).toHaveLength(1);
      const created = candidates(r);
      expect(created).toHaveLength(1);
      const f = created[0]!;
      expect(evs[0]).toMatchObject({
        taskId: TASK,
        eventType: 'env_template.replaced',
        payload: { sourceTemplateId: TEMPLATE, candidateTemplateId: f.id },
      });
      expect(f).toMatchObject({
        userId: USER,
        repositoryId: REPO,
        name: 'task-00000000',
        baseImage: 'ubuntu:24.04',
        status: 'pending',
      });
      for (const col of ['generatedDockerfile', 'dockerfileHash', 'imageTag', 'builtImageId']) {
        expect(f[col] ?? null).toBeNull();
      }
      expect((f.declaredDeps as Deps)[KEY]).toBe(2);
      expect(stableStringify(f.declaredDeps)).toBe(stableStringify(await applyNew(s)));
      expect(result).toEqual({ envTemplateId: f.id, baseImage: 'ubuntu:24.04' });
      expect(linkOf(r, TASK)).toBe(f.id);
      if (share) expect(linkOf(r, OTHER_TASK)).toBe(TEMPLATE);
      expect(source(r)).toEqual(before);
    },
  );
});

describe('refused replacement', () => {
  const REASONS: [string, string, Scenario, boolean?][] = [
    ['rollout_off', 'rollout switched off', {}, true],
    ['cli_unsupported', 'codex default', { defaultProvider: CODEX }],
    ['selection', 'repo selection vtsls', { repoLsp: ['vtsls'] }],
    [
      'run_list',
      'run list without 01b1-verify-composed-lsp',
      { runList: without('01b1-verify-composed-lsp') },
    ],
    ['providers', 'zai default', { defaultProvider: ZAI }],
    [
      'providers',
      'a step choice naming codex',
      { choices: [{ stepId: '05-implement', cliProviderId: CODEX }] },
    ],
  ];

  it.each(
    STORED.flatMap(([a, stored]) =>
      REASONS.map(
        ([reason, title, scenario, off]) => [reason, title, a, stored, scenario, off] as const,
      ),
    ),
  )(
    'B2 %s (%s), stored %s: rejected before any write',
    async (reason, _t, _a, stored, scenario, off) => {
      const r = await makeLegacy({ ...scenario, stored, replace: true });
      const before = structuredClone([templates(r), r.fake.rows(schema.tasks)]);
      if (off) adoption.on = false;
      await expect(r.apply()).rejects.toMatchObject(
        reason === 'selection'
          ? { name: 'ReopenStepFormError', notice: true }
          : { code: REFUSED, reason },
      );
      expect(events(r)).toHaveLength(0);
      expect(templates(r)).toHaveLength(1);
      expect([templates(r), r.fake.rows(schema.tasks)]).toEqual(before);
    },
  );
});

describe('replacement provider read under the lock', () => {
  it('refuses providers under the lock when a newer codex is enabled and chosen while claude remains the default', async () => {
    const r = await makeLegacy({
      providers: [
        { id: CLAUDE, name: 'claude-code', enabled: true },
        { id: CODEX, name: 'codex', enabled: false },
      ],
      stored: 'absent',
      replace: true,
    });
    r.fake.patch(schema.tasks, TASK, { cliProviderId: null });
    r.fake.patch(schema.cliProviders, CLAUDE, { createdAt: new Date(1) });
    r.fake.patch(schema.cliProviders, CODEX, { createdAt: new Date(2) });
    const before = structuredClone([templates(r), r.fake.rows(schema.tasks)]);
    let enabledUnderLock = false;
    r.fake.hooks.beforeInsert = (table) => {
      if (table === schema.envTemplates) {
        enabledUnderLock = true;
        r.fake.patch(schema.cliProviders, CODEX, { enabled: true });
        r.fake.insert(schema.taskStepCliChoices, {
          taskId: TASK,
          stepId: '05-implement',
          role: 'default',
          cliProviderId: CODEX,
        });
      }
    };
    await expect(r.apply()).rejects.toMatchObject({ code: REFUSED, reason: 'providers' });
    expect(enabledUnderLock).toBe(true);
    expect(events(r)).toHaveLength(0);
    expect(candidates(r)).toHaveLength(0);
    expect([templates(r), r.fake.rows(schema.tasks)]).toEqual(before);
  });

  it('decides on the provider read under the lock when the task has no default: refuses after an enable makes another provider the oldest', async () => {
    const r = await makeLegacy({
      defaultProvider: CLAUDE,
      providers: [
        { id: CODEX, name: 'codex', enabled: false },
        { id: CLAUDE, name: 'claude-code', enabled: true },
      ],
      stored: 'absent',
      replace: true,
    });
    r.fake.patch(schema.tasks, TASK, { cliProviderId: null });
    r.fake.hooks.beforeInsert = (table) => {
      if (table === schema.envTemplates)
        r.fake.patch(schema.cliProviders, CODEX, { enabled: true });
    };
    await expect(r.apply()).rejects.toMatchObject({ code: REFUSED, reason: 'cli_unsupported' });
  });

  it('decides on the provider read under the lock when the task has no default: accepts after a disable makes another claude-code provider the oldest', async () => {
    const r = await makeLegacy({ defaultProvider: CLAUDE, stored: 'absent', replace: true });
    r.fake.patch(schema.tasks, TASK, { cliProviderId: null });
    r.fake.hooks.beforeInsert = (table) => {
      if (table === schema.envTemplates)
        r.fake.patch(schema.cliProviders, CLAUDE, { enabled: false });
    };
    await r.apply();
    const linked = r.fake.rows(schema.tasks).find((t) => t.id === TASK)!.envTemplateId;
    const row = templates(r).find((t) => t.id === linked)!;
    expect((row.declaredDeps as Deps)[KEY]).toBe(2);
  });
});

describe('replacement pins', () => {
  it.each([
    ['unshared', undefined],
    ['shared with a live task', 'live'],
  ] as const)(
    "B3 stored 2 ticked, %s: today's behaviour, no new row, no event (PIN)",
    async (_t, share) => {
      const r = await makeLegacy({ stored: { value: 2 }, share, replace: true });
      const before = structuredClone(source(r));
      const result = (await r.apply()) as { envTemplateId: string };
      expect(events(r)).toHaveLength(0);
      if (!share) {
        expect(templates(r)).toHaveLength(1);
        expect(result.envTemplateId).toBe(TEMPLATE);
        expect(linkOf(r, TASK)).toBe(TEMPLATE);
        expect((source(r).declaredDeps as Deps)[KEY]).toBe(2);
      } else {
        expect(templates(r)).toHaveLength(2);
        expect(source(r)).toEqual(before);
        expect((candidates(r)[0]!.declaredDeps as Deps)[KEY]).toBe(2);
        expect(linkOf(r, OTHER_TASK)).toBe(TEMPLATE);
      }
    },
  );

  it('B3 ticked with no linked template takes the new-environment path, no event (PIN)', async () => {
    const r = makeRun({ replace: true }, null);
    await r.apply();
    expect(templates(r)).toHaveLength(1);
    const row = templates(r)[0]!;
    expect((row.declaredDeps as Deps)[KEY]).toBe(2);
    expect(linkOf(r, TASK)).toBe(row.id);
    expect(events(r)).toHaveLength(0);
  });

  it.each(
    [false, undefined].flatMap((replace) =>
      STORED.flatMap(([a, stored]) =>
        [
          ['unshared', undefined],
          ['shared with a live task', 'live'],
        ].map(([b, share]) => [String(replace), a, b, stored, share, replace] as const),
      ),
    ),
  )(
    'B3 unticked (%s) legacy stored %s, %s: in place or fork as today, no event (PIN)',
    async (_r, _a, _b, stored, share, replace) => {
      const r = await makeLegacy({ stored, share: share as Scenario['share'], replace });
      const before = structuredClone(source(r));
      const result = (await r.apply()) as { envTemplateId: string };
      expect(events(r)).toHaveLength(0);
      const storedKey = stored === 'absent' ? undefined : 1;
      if (!share) {
        expect(templates(r)).toHaveLength(1);
        expect(result.envTemplateId).toBe(TEMPLATE);
        expect((source(r).declaredDeps as Deps)[KEY]).toBe(storedKey);
      } else {
        expect(templates(r)).toHaveLength(2);
        expect(source(r)).toEqual(before);
        const fork = candidates(r)[0]!;
        expect((fork.declaredDeps as Deps)[KEY]).toBe(storedKey);
        expect(linkOf(r, TASK)).toBe(fork.id);
        expect(linkOf(r, OTHER_TASK)).toBe(TEMPLATE);
      }
    },
  );
});

describe('replacement repeated', () => {
  it.each(STORED)(
    'B4 a second apply with the box ticked (stored %s) is a no-op on top of the first',
    async (_a, stored) => {
      const r = await makeLegacy({ stored, replace: true });
      const first = (await r.apply()) as { envTemplateId: string };
      const second = (await r.apply()) as { envTemplateId: string };
      expect(events(r)).toHaveLength(1);
      expect(templates(r)).toHaveLength(2);
      const f = candidates(r)[0]!;
      expect(first.envTemplateId).toBe(f.id);
      expect(second.envTemplateId).toBe(f.id);
      expect(linkOf(r, TASK)).toBe(f.id);
      expect((f.declaredDeps as Deps)[KEY]).toBe(2);
    },
  );
});

describe('replacement atomicity', () => {
  function instrument(r: Run) {
    const state = { failTasksUpdate: false, transactions: [] as string[][] };
    const db = r.fake.db as unknown as Record<string, (...a: unknown[]) => unknown>;
    const origTransaction = db.transaction!.bind(db);
    const origUpdate = db.update!.bind(db);
    const guard = (table: unknown) => {
      if (state.failTasksUpdate && table === schema.tasks) {
        state.failTasksUpdate = false;
        throw new Error('link failed');
      }
    };
    db.update = (table) => {
      guard(table);
      return origUpdate(table);
    };
    db.transaction = (fn) =>
      origTransaction((tx: unknown) => {
        const writes: string[] = [];
        state.transactions.push(writes);
        const wrapped = new Proxy(tx as object, {
          get(target, prop) {
            const value = Reflect.get(target, prop) as unknown;
            if (prop === 'insert' || prop === 'update') {
              return (table: unknown) => {
                if (prop === 'update') guard(table);
                writes.push(`${prop}:${getTableName(table as never)}`);
                return (value as (t: unknown) => unknown).call(target, table);
              };
            }
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return (fn as (t: unknown) => unknown)(wrapped);
      });
    return state;
  }

  it('B5 a failing link leaves no new row and no event', async () => {
    const r = await makeLegacy({ replace: true });
    const state = instrument(r);
    const before = structuredClone([templates(r), r.fake.rows(schema.tasks)]);
    state.failTasksUpdate = true;
    await expect(r.apply()).rejects.toThrow('link failed');
    expect(templates(r)).toHaveLength(1);
    expect(events(r)).toHaveLength(0);
    expect([templates(r), r.fake.rows(schema.tasks)]).toEqual(before);
  });

  it('B5 the row, the link and the event are written inside one transaction', async () => {
    const r = await makeLegacy({ replace: true });
    const state = instrument(r);
    await r.apply();
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]).toEqual(
      expect.arrayContaining(['insert:env_templates', 'update:tasks', 'insert:task_events']),
    );
  });
});

describe('detect and form offer', () => {
  const detectFlag = async (s: Scenario, storedDeps: Deps | null) => {
    const r = makeRun(s, storedDeps);
    const out = (await declareDepsStep.detect!(r.ctx)) as { legacyLspReplaceable?: boolean };
    return out.legacyLspReplaceable;
  };

  it.each([
    ['absent', {}],
    ['1', { [KEY]: 1 }],
  ])('B6 legacy stored %s, eligible: replaceable', async (_t, deps) => {
    expect(await detectFlag({}, deps)).toBe(true);
  });

  it.each<[string, Scenario, Deps | null, boolean?]>([
    ['stored 2', {}, { [KEY]: 2 }],
    ['no linked template', {}, null],
    [
      'run list without 01b1-verify-composed-lsp',
      { runList: without('01b1-verify-composed-lsp') },
      {},
    ],
    ['codex default (CLI without LSP support)', { defaultProvider: CODEX }, {}],
    ['repo selection vtsls', { repoLsp: ['vtsls'] }, {}],
    ['zai default', { defaultProvider: ZAI }, {}],
    ['rollout switched off', {}, {}, true],
  ])('B6 not replaceable: %s', async (_t, scenario, deps, off) => {
    if (off) adoption.on = false;
    expect(await detectFlag(scenario, deps)).not.toBe(true);
  });

  const detected = (extra: Record<string, unknown>) =>
    ({
      runtimes: [],
      containerTool: 'none',
      webserver: 'nginx-fpm',
      ddevProjectName: null,
      database: { kind: 'none', version: null },
      suggestedLsp: ['intelephense-extended'],
      cliSupportsLsp: true,
      ...extra,
    }) as unknown as DeclareDepsDetect;
  const fields = (extra: Record<string, unknown>) =>
    declareDepsStep.form!({} as never, detected(extra))!.fields;

  it('B6 the form offers the checkbox, unchecked, only when replaceable', () => {
    expect(fields({ legacyLspReplaceable: true }).find((f) => f.id === REPLACE)).toMatchObject({
      type: 'checkbox',
      default: false,
    });
    for (const extra of [{}, { legacyLspReplaceable: false }]) {
      expect(fields(extra).map((f) => f.id)).not.toContain(REPLACE);
    }
  });

  it('B7 the replacement checkbox is human-only', () => {
    expect(declareDepsStep.humanOnlyFormFields).toEqual([REPLACE]);
  });
});

describe('generator parity for contract 2', () => {
  const stripBlock = (dockerfile: string) => {
    const lines = dockerfile.split('\n');
    const at = lines.indexOf('# Language servers');
    return at < 0 ? dockerfile : [...lines.slice(0, at), ...lines.slice(at + 3)].join('\n');
  };
  const base: Deps = {
    runtimes: [],
    versions: { node: null, php: null, python: null, java: null },
    packageManagers: {},
    preinstallDeps: true,
    containerTool: 'none',
    database: { kind: 'none', version: null },
    browserTesting: false,
    extraPackages: [],
  };

  it.each<[string, Deps]>([
    ['extended, unpinned', { lspServers: ['intelephense-extended'] }],
    [
      'extended, pinned',
      {
        lspServers: ['intelephense-extended'],
        lspServerVersions: { 'intelephense-extended': '1.2.3' },
      },
    ],
    [
      'plain intelephense, pinned',
      { lspServers: ['intelephense'], lspServerVersions: { intelephense: '1.2.3' } },
    ],
    [
      'with node and php runtimes',
      {
        runtimes: ['node', 'php'],
        versions: { node: '22', php: '8.3', python: null, java: null },
        lspServers: ['intelephense-extended'],
      },
    ],
    ['empty selection', { lspServers: [] }],
  ])('B8 %s: key 2 removes exactly the language-server block (PIN)', (_t, extra) => {
    const legacy = renderDockerfile('ubuntu:24.04', { ...base, ...extra });
    const composed = renderDockerfile('ubuntu:24.04', { ...base, ...extra, [KEY]: 2 });
    expect(composed).not.toContain('# Language servers');
    expect(composed).toBe(stripBlock(legacy));
  });

  it('B8 step 02 renders a null-body contract-2 row without the block (PIN)', async () => {
    const fake = createFakeDb({ tasks: schema.tasks, envTemplates: schema.envTemplates });
    fake.insert(schema.tasks, { id: TASK, userId: USER, envTemplateId: TEMPLATE });
    fake.insert(schema.envTemplates, {
      id: TEMPLATE,
      userId: USER,
      name: 'task-00000000',
      baseImage: 'ubuntu:24.04',
      declaredDeps: { ...base, lspServers: ['intelephense-extended'], [KEY]: 2 },
      generatedDockerfile: null,
    });
    const ctx = { taskId: TASK, db: fake.db as unknown as Database } as unknown as StepContext;
    const out = (await generateDockerfileStep.detect!(ctx)) as { currentDockerfile: string };
    expect(out.currentDockerfile).toContain('FROM ubuntu:24.04');
    expect(out.currentDockerfile).not.toContain('# Language servers');
  });
});

describe('step 03 default image tag', () => {
  const ID_2 = 'abcdef12-0000-4000-8000-000000000002';
  const ID_1 = 'fedcba98-0000-4000-8000-000000000001';
  const ID_ABSENT = '12345678-0000-4000-8000-000000000003';
  const step = createBuildImageStep({} as DockerRunner);

  async function defaultTag(id: string, deps: Deps): Promise<string> {
    const fake = createFakeDb({ tasks: schema.tasks, envTemplates: schema.envTemplates });
    fake.insert(schema.tasks, { id: TASK, userId: USER, envTemplateId: id });
    fake.insert(schema.envTemplates, {
      id,
      userId: USER,
      name: 'task-00000000',
      baseImage: 'ubuntu:24.04',
      declaredDeps: deps,
      generatedDockerfile: 'FROM ubuntu:24.04\n',
      status: 'pending',
    });
    const ctx = {
      taskId: TASK,
      db: fake.db as unknown as Database,
      logger: { info: vi.fn(), warn: vi.fn() },
    } as unknown as StepContext;
    const detected = await step.detect!(ctx);
    const field = step.form!(ctx, detected, undefined)!.fields.find((f) => f.id === 'imageTag');
    return (field as { default: string }).default;
  }

  it('B9 a contract-2 row carries the first 8 characters of its id', async () => {
    const tag = await defaultTag(ID_2, { [KEY]: 2 });
    expect(tag).toBe(`${imageRepo('env')}-task-00000000-abcdef12:latest`);
  });

  it('B9 every other row keeps the name-only tag (PIN)', async () => {
    const legacy = `${imageRepo('env')}-task-00000000:latest`;
    expect(await defaultTag(ID_1, { [KEY]: 1 })).toBe(legacy);
    expect(await defaultTag(ID_ABSENT, {})).toBe(legacy);
  });

  it('B9 same-named contract-2 and legacy rows get different defaults', async () => {
    expect(await defaultTag(ID_2, { [KEY]: 2 })).not.toBe(await defaultTag(ID_1, { [KEY]: 1 }));
  });
});

it('replacement derives LSP support from the current task provider, not stale step context', async () => {
  const r = await makeLegacy({ replace: true });
  r.fake.patch(schema.tasks, TASK, { cliProviderId: CLAUDE });
  r.ctx.cliProviderId = CODEX;
  await r.apply();
  expect(candidates(r)[0]?.declaredDeps).toMatchObject({
    lspInstallContractVersion: 2,
    lspServers: ['intelephense-extended'],
  });
});

it('locked replacement re-reads provider capability after a provider rename', async () => {
  const r = await makeLegacy({ replace: true });
  r.fake.patch(schema.tasks, TASK, { cliProviderId: CLAUDE });
  r.fake.hooks.beforeInsert = (table) => {
    if (table === schema.envTemplates) r.fake.patch(schema.cliProviders, CLAUDE, { name: 'codex' });
  };
  await expect(r.apply()).rejects.toMatchObject({ reason: 'cli_unsupported' });
  expect(candidates(r)).toHaveLength(0);
});

describe('step 01 Retry and the contract-2 image tag', () => {
  it.each([1, 2])(
    're-declaration invalidates contract %s without changing its default tag',
    async (contract) => {
      const deps = { ...(await applyNew({})), [KEY]: contract };
      const r = makeRun({}, deps);
      const dockerfile = KEPT_DOCKERFILE.trim();
      const { envTemplateHash } =
        await import('../src/step-engine/steps/env-replicate/02-generate-dockerfile.js');
      const hash = envTemplateHash(dockerfile, deps);
      Object.assign(r.ctx, { taskStepId: uuid(99), throwIfCancelled: vi.fn() });
      r.fake.insert(schema.taskSteps, {
        id: uuid(99),
        taskId: TASK,
        stepId: '03-build-image',
        status: 'running',
      });
      const runner = {
        inspect: vi.fn(async () => ({ exists: true, imageId: 'sha256:kept' })),
        build: vi.fn(async () => ({
          exitCode: 0,
          imageId: 'sha256:new',
          durationMs: 0,
          stderr: '',
          stdout: '',
        })),
        remove: vi.fn(async () => ({ ok: true })),
      };
      const build = createBuildImageStep(runner as unknown as DockerRunner);
      r.fake.patch(schema.envTemplates, TEMPLATE, {
        generatedDockerfile: dockerfile,
        dockerfileHash: hash,
        builtImageId: 'sha256:kept',
        status: 'ready',
      });
      const before = await build.detect!(r.ctx);
      const tagField = build.form!(r.ctx, before)!.fields.find((f) => f.id === 'imageTag');
      if (tagField?.type !== 'text') throw new Error('expected image tag field');
      const imageTag = tagField.default!;
      r.fake.patch(schema.envTemplates, TEMPLATE, { imageTag });
      await r.apply();
      expect(source(r)).toMatchObject({
        status: 'pending',
        imageTag: null,
        dockerfileHash: null,
        builtImageId: 'sha256:kept',
        generatedDockerfile: dockerfile,
      });
      const detected = await generateDockerfileStep.detect!(r.ctx);
      await generateDockerfileStep.apply(r.ctx, {
        detected,
        formValues: { dockerfile },
        iteration: 0,
        previousIterations: [],
      });
      const after = await build.detect!(r.ctx);
      expect(after).toMatchObject({ status: 'pending', currentImageId: 'sha256:kept', dockerfile });
      const form = build.form!(r.ctx, after)!;
      expect(form.fields.find((f) => f.id === 'imageTag')).toMatchObject({
        type: 'text',
        default: imageTag,
      });
      expect(form.fields.some((f) => f.id === 'forceRebuild')).toBe(false);
      expect(source(r).dockerfileHash).toBe(hash);
      const result = await build.apply(r.ctx, {
        detected: after,
        formValues: { imageTag },
        iteration: 0,
        previousIterations: [],
      });
      expect(result).toMatchObject({ skipped: false, imageTag, imageId: 'sha256:new' });
      expect(runner.build).toHaveBeenCalledOnce();
      expect(runner.remove).toHaveBeenCalledWith('sha256:kept');
    },
  );
});

describe('replacement belongs to the current step pass', () => {
  it.each(['step reset', 'generation', 'epoch', 'Stop', 'dead', 'pointer'])(
    'rolls back the candidate after %s overtakes it',
    async (change) => {
      const r = await makeLegacy({ replace: true });
      Object.assign(r.ctx, { taskStepId: uuid(99), epoch: 1, round: 0, rerunGeneration: 0 });
      r.fake.insert(schema.taskSteps, {
        id: uuid(99),
        taskId: TASK,
        stepId: '01-declare-deps',
        status: 'running',
        rerunGeneration: 0,
      });
      r.fake.patch(schema.tasks, TASK, {
        orchestrationEpoch: 1,
        currentStepId: '01-declare-deps',
        currentRound: 0,
      });
      r.fake.hooks.beforeInsert = (table) => {
        if (table !== schema.envTemplates) return;
        if (change === 'step reset')
          r.fake.patch(schema.taskSteps, uuid(99), { status: 'pending' });
        if (change === 'generation')
          r.fake.patch(schema.taskSteps, uuid(99), { rerunGeneration: 1 });
        if (change === 'epoch') r.fake.patch(schema.tasks, TASK, { orchestrationEpoch: 2 });
        if (change === 'Stop') r.fake.patch(schema.tasks, TASK, { status: 'failed' });
        if (change === 'dead') r.fake.patch(schema.tasks, TASK, { deadAt: new Date() });
        if (change === 'pointer')
          r.fake.patch(schema.tasks, TASK, { currentStepId: '02-generate-dockerfile' });
      };
      await expect(r.apply()).rejects.toMatchObject({ name: 'StepSupersededError' });
      expect(candidates(r)).toEqual([]);
      expect(linkOf(r, TASK)).toBe(TEMPLATE);
      expect(events(r)).toEqual([]);
    },
  );
});
