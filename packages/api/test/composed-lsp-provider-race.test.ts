import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import {
  ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
} from '@haive/shared';
import { createFakeDb } from '@haive/database/testing';
import { writeStepCliChoice } from '../src/lib/step-cli-choice.js';

/**
 * The composed-LSP provider rule (a task linked to a contract-2 env template may only run on
 * claude-code providers) is checked and then written by independent writers: step 01 (replacing a
 * legacy template, or adopting a new contract-2 template) and the writers of a CLI choice. These
 * controls run the real code of both sides over one fake db with row locks and stop one writer at
 * the point between its check and its write, then read the FINAL rows: whatever the
 * implementation, the two must never both stand. No timers: a barrier hook starts the other
 * writer, then waits for it to finish or to block on a lock the first one holds.
 */

const adoption = vi.hoisted(() => ({ on: true }));
vi.mock('../../worker/src/lsp/composed-adoption.js', async (original) => ({
  ...(await original<object>()),
  get COMPOSED_LSP_NEW_ENVIRONMENT_ADOPTION() {
    return adoption.on;
  },
}));

interface DeclareDeps {
  apply(ctx: unknown, args: unknown): Promise<unknown>;
}
let declareDepsStep: DeclareDeps;
beforeAll(async () => {
  // A variable specifier keeps the api typecheck from pulling the worker's sources in.
  const modulePath = new URL(
    '../../worker/src/step-engine/steps/env-replicate/01-declare-deps.ts',
    import.meta.url,
  ).pathname;
  declareDepsStep = (await import(modulePath)).declareDepsStep as DeclareDeps;
});

const KEY = 'lspInstallContractVersion';
const REFUSED = 'composed_lsp_replacement_refused';
const LOCKED = 'composed_lsp_provider_locked';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TASK = uuid(1);
const REPO = uuid(2);
const TEMPLATE = uuid(3);
const USER = uuid(5);
const CLAUDE = uuid(10);
const CLAUDE2 = uuid(11);
const CODEX = uuid(12);
const ZAI = uuid(13);
const RUN_LIST = [
  '00-triage',
  '04-verify-environment',
  '01-worktree-setup',
  '01b-install-plugins',
  '01b1-verify-composed-lsp',
  '05-implement',
];
const PROVIDERS = [
  { id: CLAUDE, name: 'claude-code', enabled: true },
  { id: CLAUDE2, name: 'claude-code', enabled: true },
  { id: CODEX, name: 'codex', enabled: true },
  { id: ZAI, name: 'zai', enabled: true },
];

type Deps = Record<string, unknown>;

let repoPath: string;
beforeEach(async () => {
  repoPath = await mkdtemp(path.join(os.tmpdir(), 'haive-lsp-race-'));
});
afterEach(async () => {
  adoption.on = true;
  await rm(repoPath, { recursive: true, force: true });
});
afterAll(() => {
  adoption.on = true;
});

function buildFake(storedDeps: Deps | null) {
  const fake = createFakeDb(
    {
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
    },
    { rowLocks: true },
  );
  fake.insert(schema.tasks, {
    id: TASK,
    userId: USER,
    repositoryId: REPO,
    type: 'custom-lsp',
    status: 'running',
    executionPath: 'quick_bugfix',
    runListSnapshot: RUN_LIST,
    ignoreSavedStepClis: false,
    cliProviderId: CLAUDE,
    envTemplateId: storedDeps ? TEMPLATE : null,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    lspServers: ['intelephense-extended'],
    lspServerVersions: null,
    onboardingEnvironment: {
      schemaVersion: ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
      envDetectData: {},
      confirmedValues: {},
    },
    onboardingTooling: { schemaVersion: ONBOARDING_TOOLING_SCHEMA_VERSION, tooling: {} },
  });
  for (const p of PROVIDERS) fake.insert(schema.cliProviders, { userId: USER, ...p });
  if (storedDeps) {
    fake.insert(schema.envTemplates, {
      id: TEMPLATE,
      userId: USER,
      repositoryId: REPO,
      name: 'task-00000000',
      baseImage: 'ubuntu:24.04',
      declaredDeps: storedDeps,
      generatedDockerfile: 'FROM ubuntu:24.04\nRUN echo kept\n',
      status: 'ready',
    });
  }
  fake.insert(schema.taskSteps, {
    id: uuid(99),
    taskId: TASK,
    stepId: '01-declare-deps',
    status: 'running',
  });
  return fake;
}

function makeRun(storedDeps: Deps | null, replace: boolean) {
  const fake = buildFake(storedDeps);
  const ctx = {
    taskId: TASK,
    taskStepId: uuid(99),
    userId: USER,
    cliProviderId: CLAUDE,
    repoPath,
    db: fake.db as unknown as Database,
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    emitProgress: vi.fn(async () => {}),
  };
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
      ...(replace ? { replaceLegacyLspInstall: true } : {}),
    },
    iteration: 0,
    previousIterations: [],
  };
  return { fake, apply: () => declareDepsStep.apply(ctx, args) };
}

/** A task linked to a stored legacy template (no contract key), the replacement box ticked. */
async function makeLegacy() {
  const base = makeRun(null, false);
  adoption.on = false;
  await base.apply();
  adoption.on = true;
  const deps = base.fake.rows(schema.envTemplates)[0]!.declaredDeps as Deps;
  const { [KEY]: _dropped, ...rest } = deps;
  return makeRun(rest, true);
}

const noop = () => undefined;
const isHttp = (e: unknown, status: number, code: string): boolean =>
  (e as { status?: number } | null)?.status === status && (e as { code?: string })?.code === code;

type Subject = 'replace' | 'adopt';
type Interleaving = 'cli-first' | 'link-first' | 'default-change';

async function race(subject: Subject, interleaving: Interleaving) {
  const run = subject === 'replace' ? await makeLegacy() : makeRun(null, false);
  const { fake } = run;
  let reached = false;
  let change: Promise<unknown> = Promise.resolve();
  let blockedSignal!: () => void;
  const blocked = new Promise<void>((resolve) => (blockedSignal = resolve));
  fake.hooks.onWait = () => blockedSignal();

  const barrier = async (): Promise<void> => {
    if (reached) return;
    reached = true;
    if (interleaving === 'default-change') {
      fake.patch(schema.tasks, TASK, { cliProviderId: CODEX });
      return;
    }
    change = writeStepCliChoice(fake.db as unknown as Database, {
      userId: USER,
      taskId: TASK,
      stepId: '05-implement',
      role: 'default',
      cliProviderId: CODEX,
      requestedEffort: null,
      remember: false,
    });
    await Promise.race([blocked, change.then(noop, noop)]);
  };
  fake.hooks.beforeInsert = async (table) => {
    if (interleaving !== 'link-first' && table === schema.envTemplates) await barrier();
  };
  fake.hooks.beforeUpdate = async (table) => {
    if (interleaving === 'link-first' && table === schema.tasks) await barrier();
  };

  const [applyResult] = await Promise.allSettled([run.apply()]);
  // `change` is assigned inside the barrier, so it is settled after the subject finished.
  const [changeResult] = await Promise.allSettled([change]);
  return { fake, reached, applyResult, changeResult };
}

function finalState(fake: ReturnType<typeof buildFake>) {
  const task = fake.rows(schema.tasks).find((t) => t.id === TASK)!;
  const templates = fake.rows(schema.envTemplates);
  const linked = templates.find((t) => t.id === task.envTemplateId);
  const providerName = (id: unknown) => PROVIDERS.find((p) => p.id === id)?.name;
  const nonClaude = new Set<unknown>();
  for (const id of [task.cliProviderId, task.summaryCliProviderId]) {
    if (id && providerName(id) !== 'claude-code') nonClaude.add(id);
  }
  for (const c of fake.rows(schema.taskStepCliChoices)) {
    if (
      c.taskId === TASK &&
      RUN_LIST.includes(c.stepId as string) &&
      c.cliProviderId &&
      providerName(c.cliProviderId) !== 'claude-code'
    ) {
      nonClaude.add(c.cliProviderId);
    }
  }
  const contract2 = (linked?.declaredDeps as Deps | undefined)?.[KEY] === 2;
  return { task, templates, linked, contract2, nonClaude };
}

describe.each<Subject>(['replace', 'adopt'])(
  'composed-LSP provider race, step 01 %s',
  (subject) => {
    it.each<Interleaving>(['cli-first', 'link-first', 'default-change'])(
      'never ends with a contract-2 template and a non-claude provider (%s)',
      async (interleaving) => {
        const { fake, reached, applyResult, changeResult } = await race(subject, interleaving);
        expect(reached, 'the barrier was reached').toBe(true);
        const { task, templates, linked, contract2, nonClaude } = finalState(fake);

        expect(
          contract2 && nonClaude.size > 0,
          'RACE: the task ended linked to a contract-2 environment template while a provider ' +
            'that can run it is not claude-code (the provider rule was checked, then written ' +
            'without locking the task row)',
        ).toBe(false);

        const changeRejected =
          changeResult.status === 'rejected' && isHttp(changeResult.reason, 409, LOCKED);
        if (changeResult.status === 'rejected') expect(changeRejected).toBe(true);
        const choices = fake.rows(schema.taskStepCliChoices);

        const refused =
          applyResult.status === 'rejected' &&
          (applyResult.reason as { code?: string }).code === REFUSED &&
          (applyResult.reason as { reason?: string }).reason ===
            (interleaving === 'default-change' ? 'cli_unsupported' : 'providers');
        if (subject === 'replace') {
          const outcomeA =
            refused &&
            templates.length === 1 &&
            templates[0]!.id === TEMPLATE &&
            task.envTemplateId === TEMPLATE;
          const outcomeB =
            interleaving !== 'default-change' &&
            changeRejected &&
            applyResult.status === 'fulfilled' &&
            choices.length === 0 &&
            task.envTemplateId !== TEMPLATE &&
            contract2;
          expect(outcomeA || outcomeB, 'one consistent replacement outcome').toBe(true);
        } else {
          const demoted =
            applyResult.status === 'fulfilled' &&
            linked !== undefined &&
            (linked.declaredDeps as Deps)[KEY] === undefined &&
            (interleaving === 'default-change'
              ? task.cliProviderId === CODEX
              : changeResult.status === 'fulfilled' &&
                choices.some((c) => c.cliProviderId === CODEX));
          const locked =
            interleaving !== 'default-change' &&
            changeRejected &&
            applyResult.status === 'fulfilled' &&
            contract2;
          expect(demoted || locked, 'one consistent adoption outcome').toBe(true);
        }
      },
    );
  },
);

// Lock order (see the lock helper): a repository delete holds the repository row and then asks for
// task rows, and a template insert takes a KEY SHARE on the repository row, so step 01 must insert
// its template row before it takes the task row lock, and then link under that lock.
describe.each<Subject>(['replace', 'adopt'])('composed-LSP lock order, step 01 %s', (subject) => {
  it('inserts its template row before taking the task row lock and links under it', async () => {
    const run = subject === 'replace' ? await makeLegacy() : makeRun(null, false);
    const atInsert: boolean[] = [];
    const atLink: boolean[] = [];
    run.fake.hooks.beforeInsert = (table) => {
      if (table === schema.envTemplates) atInsert.push(run.fake.rowLocked(schema.tasks, TASK));
    };
    run.fake.hooks.beforeUpdate = (table) => {
      if (table === schema.tasks) atLink.push(run.fake.rowLocked(schema.tasks, TASK));
    };
    await run.apply();
    expect(atInsert, 'the task row lock was not held at the template insert').toEqual([false]);
    expect(atLink, 'the task row lock was held at the link write').toEqual([true]);
  });
});

// Only a NEW environment adopts: a fork of a shared row carries the contract the task's current
// template already has (its provider rule already applies), so the adoption re-check must never
// demote it, even when a saved preference for another CLI would fail that check for a new one.
describe('a fork of a shared contract-2 template', () => {
  it('keeps contract 2 whatever the adoption re-check would say for a new environment', async () => {
    const base = makeRun(null, false);
    await base.apply();
    const deps = base.fake.rows(schema.envTemplates)[0]!.declaredDeps as Deps;
    expect(deps[KEY], 'a new environment adopts').toBe(2);
    const run = makeRun({ ...deps, extraPackages: ['vim'] }, false);
    run.fake.insert(schema.tasks, {
      id: uuid(4),
      userId: USER,
      type: 'custom-lsp',
      status: 'running',
      ignoreSavedStepClis: false,
      envTemplateId: TEMPLATE,
    });
    run.fake.insert(schema.userStepCliPreferences, {
      userId: USER,
      stepId: '05-implement',
      cliProviderId: CODEX,
      explicit: true,
    });
    await run.apply();
    const task = run.fake.rows(schema.tasks).find((t) => t.id === TASK)!;
    const forked = run.fake.rows(schema.envTemplates).find((t) => t.id === task.envTemplateId)!;
    expect(forked.id, 'the task took a row of its own').not.toBe(TEMPLATE);
    expect((forked.declaredDeps as Deps)[KEY]).toBe(2);
  });
});
