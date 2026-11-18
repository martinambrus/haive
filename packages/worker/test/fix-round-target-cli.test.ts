import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { ExecutionContractError } from '@haive/shared/modularity';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { resolvePreferredCli } from '../src/step-engine/step-runner.js';
import { phase2ImplementStep } from '../src/step-engine/steps/workflow/07-phase-2-implement.js';
import {
  eligibleFixRoundProviders,
  FixRoundCliUnavailable,
  recordFixRoundCliChoice,
  resolveFixRoundCli,
} from '../src/step-engine/steps/workflow/_fix-round-cli.js';

const dialect = new PgDialect();
const USER = 'owner';
const TASK = 'task-1';
const LEGACY = '07-phase-2-implement';
const CUSTOM = 'module.fix-demo.repair';
const OTHER_MODULE = 'module.fix-demo.other';
const CORE = '08c-code-review';
const ROUND = 'fix:2:default';

const provider = (id: string, over: Partial<CliProviderRecord> = {}): CliProviderRecord =>
  ({
    id,
    userId: USER,
    name: 'claude-code',
    label: id,
    enabled: true,
    authMode: 'subscription',
    envVars: null,
    cliArgs: null,
    createdAt: new Date(0),
    ...over,
  }) as CliProviderRecord;
const original = provider('original');
const picked = provider('picked');
const PROVIDERS = [original, picked];

const pin = (stepId: string) => ({
  version: 1,
  guardedSpans: [],
  fixTarget: { stepId, capabilityVersion: 1 },
});
const customStep = (extra: object = {}, id = CUSTOM): StepDefinition =>
  ({
    metadata: {
      id,
      workflowType: 'module.fix-demo',
      index: 1,
      title: id,
      description: id,
      requiresCli: false,
    },
    llm: phase2ImplementStep.llm,
    editsCodeOrTests: true,
    fixConsumer: { version: 1 },
    ...extra,
  }) as unknown as StepDefinition;

interface Row {
  stepId: string;
  role: string;
  cliProviderId: string | null;
  effortLevel?: string | null;
  at: number;
}

/** Answers the choices query the way Postgres orders it: newest updated_at first, then role
 *  ascending, over the roles and step the WHERE binds. Every table read is logged. */
function callLoggingDb(opts: {
  rows?: Row[];
  contract?: unknown;
  providers?: CliProviderRecord[];
  saved?: { cliProviderId: string; effortLevel: string | null };
}) {
  const calls: string[] = [];
  const table = (name: string, findFirst: (arg: { where: SQL }) => unknown) => ({
    findFirst: async (arg: { where: SQL }) => {
      calls.push(name);
      return findFirst(arg);
    },
  });
  const tables: Record<string, ReturnType<typeof table>> = {
    taskStepCliChoices: table('taskStepCliChoices', ({ where }) => {
      const params = dialect.sqlToQuery(where).params;
      const roundQuery = params.some((p) => typeof p === 'string' && p.startsWith('fix:'));
      const stepId = params[1];
      const mine = (opts.rows ?? []).filter((r) => r.stepId === stepId);
      if (!roundQuery) {
        const row = mine.find((r) => r.role === 'default');
        return row && { ...row, effortLevel: row.effortLevel ?? null };
      }
      const roles = params.slice(2) as string[];
      return mine
        .filter((r) => roles.includes(r.role))
        .sort((a, b) => b.at - a.at || (a.role < b.role ? -1 : 1))
        .map((r) => ({ ...r, effortLevel: r.effortLevel ?? null }))[0];
    }),
    tasks: table('tasks', () => ({ executionContract: opts.contract ?? null })),
    cliProviders: table('cliProviders', ({ where }) => {
      const params = dialect.sqlToQuery(where).params;
      return (opts.providers ?? PROVIDERS).find((p) => params.includes(p.id));
    }),
    userStepCliPreferences: table('userStepCliPreferences', () => opts.saved),
  };
  const db = { query: tables } as unknown as Database;
  return { db, calls };
}

const roundRow = (stepId: string, providerId: string | null = picked.id, at = 2): Row => ({
  stepId,
  role: ROUND,
  cliProviderId: providerId,
  at,
});
const ordinaryRow = (stepId: string, providerId: string | null, at: number): Row => ({
  stepId,
  role: 'default',
  cliProviderId: providerId,
  effortLevel: 'high',
  at,
});

describe('eligibleFixRoundProviders parity', () => {
  const candidates = [
    picked,
    provider('disabled', { enabled: false }),
    provider('foreign', { userId: 'someone-else' }),
  ];

  it('lists the eligible owned provider for the real implementation step', () => {
    expect(eligibleFixRoundProviders(USER, candidates, phase2ImplementStep)).toEqual([picked]);
  });

  it.each([
    ['an undefined target', undefined],
    ['a core step outside the dispatch list', customStep({}, 'zz-core-not-listed')],
    ['a target without llm', customStep({ llm: undefined })],
  ])('returns nothing for %s', (_name, target) => {
    expect(eligibleFixRoundProviders(USER, candidates, target as StepDefinition)).toEqual([]);
  });
});

describe('eligibleFixRoundProviders for a custom fix consumer', () => {
  const candidates = [
    picked,
    provider('disabled', { enabled: false }),
    provider('foreign', { userId: 'someone-else' }),
  ];

  it('lists the eligible owned provider for a capable module step', () => {
    expect(eligibleFixRoundProviders(USER, candidates, customStep())).toEqual([picked]);
  });

  it('returns nothing for the same module step without fixConsumer', () => {
    expect(
      eligibleFixRoundProviders(USER, candidates, customStep({ fixConsumer: undefined })),
    ).toEqual([]);
  });
});

describe('resolveFixRoundCli matrix, parity', () => {
  it('honors a round row on the legacy implementation step', async () => {
    const { db } = callLoggingDb({ rows: [roundRow(LEGACY)] });
    expect(await resolveFixRoundCli(db, USER, TASK, LEGACY, 'default', 2)).toEqual(picked);
  });

  it('does not honor a round row on a module step of an unpinned task', async () => {
    const { db } = callLoggingDb({ rows: [roundRow(CUSTOM)] });
    expect(await resolveFixRoundCli(db, USER, TASK, CUSTOM, 'default', 2)).toBeUndefined();
  });

  it('does not honor a round row on another module step of a pinned task', async () => {
    const { db } = callLoggingDb({ rows: [roundRow(OTHER_MODULE)], contract: pin(CUSTOM) });
    expect(await resolveFixRoundCli(db, USER, TASK, OTHER_MODULE, 'default', 2)).toBeUndefined();
  });

  it.each([
    [LEGACY, null],
    [CUSTOM, pin(CUSTOM)],
  ])('reads nothing for %s at round 0 or an undefined round', async (stepId, contract) => {
    const { db, calls } = callLoggingDb({ rows: [roundRow(stepId)], contract });
    expect(await resolveFixRoundCli(db, USER, TASK, stepId, 'default', 0)).toBeUndefined();
    expect(await resolveFixRoundCli(db, USER, TASK, stepId, 'default', undefined)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('reads nothing for a core step other than the implementation step', async () => {
    const { db, calls } = callLoggingDb({ rows: [roundRow(CORE)] });
    expect(await resolveFixRoundCli(db, USER, TASK, CORE, 'default', 2)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('makes exactly one db call for the legacy implementation step with no round row', async () => {
    const { db, calls } = callLoggingDb({ rows: [] });
    expect(await resolveFixRoundCli(db, USER, TASK, LEGACY, 'default', 2)).toBeUndefined();
    expect(calls).toEqual(['taskStepCliChoices']);
  });
});

describe('resolveFixRoundCli matrix, pinned custom target', () => {
  it('honors a round row on the pinned step', async () => {
    const { db } = callLoggingDb({ rows: [roundRow(CUSTOM)], contract: pin(CUSTOM) });
    expect(await resolveFixRoundCli(db, USER, TASK, CUSTOM, 'default', 2)).toEqual(picked);
  });

  it('does not honor a round row on the legacy step of a pinned task', async () => {
    const { db } = callLoggingDb({ rows: [roundRow(LEGACY)], contract: pin(CUSTOM) });
    expect(await resolveFixRoundCli(db, USER, TASK, LEGACY, 'default', 2)).toBeUndefined();
  });

  it('rejects with ExecutionContractError for a malformed pin instead of reading 07', async () => {
    const { db } = callLoggingDb({ rows: [roundRow(LEGACY)], contract: { version: 99 } });
    await expect(resolveFixRoundCli(db, USER, TASK, LEGACY, 'default', 2)).rejects.toBeInstanceOf(
      ExecutionContractError,
    );
  });
});

const TARGETS: [string, string, unknown][] = [
  ['legacy 07', LEGACY, null],
  ['pinned custom', CUSTOM, pin(CUSTOM)],
];

describe.each(TARGETS)('latest wins, %s', (_name, stepId, contract) => {
  const run = (rows: Row[], round = 2, providers?: CliProviderRecord[]) =>
    resolveFixRoundCli(
      callLoggingDb({ rows, contract, providers }).db,
      USER,
      TASK,
      stepId,
      'default',
      round,
    );

  it('lets a newer ordinary default row beat the round row', async () => {
    expect(await run([roundRow(stepId, picked.id, 1), ordinaryRow(stepId, original.id, 2)])).toBe(
      undefined,
    );
  });

  it('lets a newer round row win', async () => {
    expect(
      await run([ordinaryRow(stepId, original.id, 1), roundRow(stepId, picked.id, 2)]),
    ).toEqual(picked);
  });

  it('ends the override when a newer ordinary row was cleared', async () => {
    expect(await run([roundRow(stepId, picked.id, 1), ordinaryRow(stepId, null, 2)])).toBe(
      undefined,
    );
  });

  it('gives a tie to the ordinary row', async () => {
    expect(await run([roundRow(stepId, picked.id, 5), ordinaryRow(stepId, original.id, 5)])).toBe(
      undefined,
    );
  });

  it('does not apply the round 2 row at round 3', async () => {
    expect(await run([roundRow(stepId)], 3)).toBeUndefined();
  });

  it.each([
    ['deleted', []],
    ['foreign', [provider(picked.id, { userId: 'someone-else' })]],
    ['disabled', [provider(picked.id, { enabled: false })]],
  ] as const)('refuses a %s round provider', async (_state, providers) => {
    await expect(run([roundRow(stepId)], 2, [...providers])).rejects.toBeInstanceOf(
      FixRoundCliUnavailable,
    );
  });
});

describe.each(TARGETS)('resolvePreferredCli precedence, %s', (_name, stepId, contract) => {
  const resolve = (rows: Row[], saved?: { cliProviderId: string; effortLevel: string | null }) =>
    resolvePreferredCli(
      callLoggingDb({ rows, contract, saved }).db,
      USER,
      stepId,
      'fallback',
      PROVIDERS,
      'default',
      TASK,
      false,
      2,
    );

  it('puts the round override above a step default choice and a saved preference', async () => {
    expect(
      await resolve([ordinaryRow(stepId, original.id, 1), roundRow(stepId, picked.id, 2)], {
        cliProviderId: original.id,
        effortLevel: 'low',
      }),
    ).toEqual({ cliProviderId: picked.id, effortLevel: null, roundProvider: picked });
  });

  it('puts a step default choice above a saved preference', async () => {
    expect(
      await resolve([ordinaryRow(stepId, picked.id, 1)], {
        cliProviderId: original.id,
        effortLevel: 'low',
      }),
    ).toEqual({ cliProviderId: picked.id, effortLevel: 'high' });
  });

  it('puts a saved preference above the task default', async () => {
    expect(await resolve([], { cliProviderId: original.id, effortLevel: 'low' })).toEqual({
      cliProviderId: original.id,
      effortLevel: 'low',
    });
  });

  it('falls to the task default', async () => {
    expect(await resolve([])).toEqual({ cliProviderId: 'fallback', effortLevel: null });
  });
});

interface Recorder {
  inserts: { values: Record<string, unknown>; config: Record<string, unknown> }[];
  deletes: { table: unknown; params: unknown[] }[];
}

function writeDb(providers: CliProviderRecord[] = PROVIDERS) {
  const rec: Recorder = { inserts: [], deletes: [] };
  const db = {
    query: {
      cliProviders: {
        findFirst: async ({ where }: { where: SQL }) => {
          const params = dialect.sqlToQuery(where).params;
          return providers.find((p) => params.includes(p.id));
        },
      },
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (config: Record<string, unknown>) => {
          rec.inserts.push({ values, config });
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: async (where: SQL) => {
        rec.deletes.push({ table, params: dialect.sqlToQuery(where).params });
      },
    }),
  } as unknown as Database;
  return { db, rec };
}

describe('recordFixRoundCliChoice parity, legacy 07', () => {
  it('inserts the exact row for the implementation step', async () => {
    const { db, rec } = writeDb();
    await recordFixRoundCliChoice(db, USER, TASK, phase2ImplementStep, 3, picked.id);
    expect(rec.inserts).toHaveLength(1);
    expect(rec.inserts[0]!.values).toEqual({
      taskId: TASK,
      stepId: LEGACY,
      role: 'fix:3:default',
      cliProviderId: picked.id,
      effortLevel: null,
    });
    expect(rec.inserts[0]!.config.set).toEqual({
      cliProviderId: picked.id,
      effortLevel: null,
      updatedAt: expect.any(Date),
    });
    expect(rec.deletes).toEqual([]);
  });

  it('deletes only the task, step and round slot for the same CLI', async () => {
    const { db, rec } = writeDb();
    await recordFixRoundCliChoice(db, USER, TASK, phase2ImplementStep, 3, 'same');
    expect(rec.inserts).toEqual([]);
    expect(rec.deletes).toHaveLength(1);
    expect(rec.deletes[0]!.table).toBe(schema.taskStepCliChoices);
    expect(rec.deletes[0]!.params).toEqual([TASK, LEGACY, 'fix:3:default']);
  });

  it('refuses a provider the step cannot run', async () => {
    const { db } = writeDb([provider('picked', { name: 'ollama' })]);
    await expect(
      recordFixRoundCliChoice(db, USER, TASK, phase2ImplementStep, 3, 'picked'),
    ).rejects.toBeInstanceOf(FixRoundCliUnavailable);
  });
});

describe('recordFixRoundCliChoice, pinned custom target', () => {
  it('inserts one row for the custom step, and refuses a provider it cannot run', async () => {
    const { db, rec } = writeDb();
    await recordFixRoundCliChoice(db, USER, TASK, customStep(), 3, picked.id);
    expect(rec.inserts).toHaveLength(1);
    expect(rec.inserts[0]!.values).toEqual({
      taskId: TASK,
      stepId: CUSTOM,
      role: 'fix:3:default',
      cliProviderId: picked.id,
      effortLevel: null,
    });
    const unfit = writeDb([provider('picked', { name: 'ollama' })]);
    await expect(
      recordFixRoundCliChoice(unfit.db, USER, TASK, customStep(), 3, 'picked'),
    ).rejects.toBeInstanceOf(FixRoundCliUnavailable);
    expect(unfit.rec.inserts).toEqual([]);
  });

  it('deletes only the custom step slot for the same CLI, never the 07 slot', async () => {
    const { db, rec } = writeDb();
    await recordFixRoundCliChoice(db, USER, TASK, customStep(), 3, 'same');
    expect(rec.inserts).toEqual([]);
    expect(rec.deletes).toHaveLength(1);
    expect(rec.deletes[0]!.params).toEqual([TASK, CUSTOM, 'fix:3:default']);
  });
});

describe('fixRoundTargetDef', () => {
  const legacy = customStep({}, LEGACY);
  const capable = customStep();
  const registryOf = (...defs: StepDefinition[]) => {
    const byId = new Map(defs.map((d) => [d.metadata.id, d]));
    return { get: (id: string) => byId.get(id) };
  };
  const targetDef = async (contract: unknown, registry: ReturnType<typeof registryOf>) => {
    const mod = (await import('../src/step-engine/fix-consumer.js')) as unknown as {
      fixRoundTargetDef: (
        contract: unknown,
        registry: { get(id: string): StepDefinition | undefined },
      ) => StepDefinition | undefined;
    };
    return mod.fixRoundTargetDef(contract, registry);
  };

  it.each([
    ['a null contract', null],
    ['a contract without a pin', { version: 1, guardedSpans: [] }],
  ])('returns the registry implementation step for %s', async (_name, contract) => {
    expect(await targetDef(contract, registryOf(legacy, capable))).toBe(legacy);
  });

  it('returns the capable definition for a pin', async () => {
    expect(await targetDef(pin(CUSTOM), registryOf(legacy, capable))).toBe(capable);
  });

  it.each([
    ['an unregistered pin', pin(CUSTOM), registryOf(legacy)],
    [
      'a step without the capability',
      pin(CUSTOM),
      registryOf(legacy, customStep({ fixConsumer: undefined })),
    ],
    [
      'a wrong capability version',
      pin(CUSTOM),
      registryOf(legacy, customStep({ fixConsumer: { version: 2 } })),
    ],
    ['a core step id', pin(CORE), registryOf(legacy, customStep({}, CORE))],
    [
      'a fan-out step',
      pin(CUSTOM),
      registryOf(legacy, customStep({ agentMining: { dispatch: 'fan-out' } })),
    ],
    ['a malformed contract', { version: 99 }, registryOf(legacy, capable)],
  ])('returns undefined, never the implementation step, for %s', async (_n, contract, registry) => {
    expect(await targetDef(contract, registry)).toBeUndefined();
  });
});
