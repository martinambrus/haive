import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CONFIG_KEYS,
  configService,
  type CliExecJobPayload,
  type StepCapability,
} from '@haive/shared';
import { MINING_ROW_COLUMNS, advanceStep } from '../src/step-engine/step-runner.js';
import { agentDefinitionGuidance } from '../src/step-engine/steps/_retrieval-guidance.js';
import { MODEL_CAPABILITY_BOUNDARY_MARKER } from '../src/cli-adapters/model-capabilities.js';
import { MCP_SURFACE_MARKER } from '../src/sandbox/mcp-surface.js';
import {
  MiningRetryError,
  MiningWaveError,
  ReopenStepFormError,
} from '../src/step-engine/step-definition.js';
import type { StepApplyArgs, StepDefinition } from '../src/step-engine/step-definition.js';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';

interface MiningRow {
  id: string;
  agentId: string;
  agentTitle: string;
  status: string;
  output: unknown;
  rawOutput: string | null;
  errorMessage: string | null;
  cliInvocationId: string | null;
  attempts: number;
  /** Set when a human asked for THIS terminal to be re-run (the fan-out half of Resume). */
  userRetryRequestedAt?: Date | null;
  /** What the agent's last dispatch asked for beyond the step spec. */
  roleKey?: string | null;
  capabilities?: string[] | null;
  preferVision?: boolean | null;
  /** The prompt the step wrote for the agent's last dispatch, before any augmentation. */
  dispatchPrompt?: string | null;
}

interface MockState {
  taskStepRow: Record<string, unknown>;
  miningRows: MiningRow[];
  updates: Record<string, unknown>[];
  inserts: { table: string; row: Record<string, unknown> }[];
  /** Simulate the (task_step_id, agent_id) unique index rejecting a mining insert, so
   *  onConflictDoNothing().returning() yields no row and nothing is enqueued. */
  miningInsertConflicts?: boolean;
  /** Prior CLI runs, keyed by the id a mining row points at. Needed for the
   *  wave-dispatch recovery path, which repeats an agent by the prompt its last
   *  run actually used. */
  invocationRows?: {
    id: string;
    prompt: string;
    errorMessage?: string | null;
    startedAt?: Date | null;
    endedAt?: Date | null;
    exitCode?: number | null;
  }[];
  /** Every projection a read of the mining table asked for, in order. */
  miningProjections?: unknown[];
  /** Simulate another pass changing a mining row after this one read it: every compare-and-swap
   *  on the row matches nothing, or only those whose SET the predicate picks. */
  miningCasLost?: boolean | ((set: Record<string, unknown>) => boolean);
  /** What that other pass left behind, applied when a compare-and-swap is lost. */
  onMiningCasLost?: () => void;
  /** Make a read fail, picked by what it selects. */
  failSelect?: (projection: unknown) => boolean;
  /** Transactions opened, and INSERT statements sent to the mining table. */
  transactions?: number;
  miningInsertStatements?: number;
  /** Every mining-row update that matched, with the WHERE that picked its row. */
  miningUpdateLog?: { set: Record<string, unknown>; where: unknown }[];
}

function tableNameOf(table: unknown): string {
  if (table && typeof table === 'object') {
    const obj = table as Record<string, unknown>;
    const sym = Object.getOwnPropertySymbols(obj).find((s) => s.description === 'drizzle:Name');
    if (sym) {
      const name = obj[sym as unknown as string];
      if (typeof name === 'string') return name;
    }
  }
  return '';
}

/** Every value a drizzle condition binds, flattened; a primitive in a raw `sql` template is
 *  bound all the same. */
function conditionValues(node: unknown, acc: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    for (const n of node) conditionValues(n, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) {
    if (Array.isArray(obj.value)) acc.push(...obj.value);
    else acc.push(obj.value);
  }
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) {
    for (const c of chunks) {
      if (c === null || typeof c !== 'object') acc.push(c);
      else conditionValues(c, acc);
    }
  }
  return acc;
}

/** The mining-row writes whose WHERE names this row id. */
const writesTo = (state: MockState, rowId: string) =>
  (state.miningUpdateLog ?? []).filter((u) => conditionValues(u.where).includes(rowId));

function makeMockDb(state: MockState): Database {
  let nextId = 1;
  const rowsFor = (table: string): unknown[] => {
    if (table === 'task_steps') return state.taskStepRow.id ? [state.taskStepRow] : [];
    if (table === 'task_step_agent_minings') return state.miningRows;
    if (table === 'cli_invocations') return state.invocationRows ?? [];
    return [];
  };
  const db = {
    select: (projection?: unknown) => ({
      from: (table: unknown) => {
        if (state.failSelect?.(projection)) throw new Error('read failed');
        if (tableNameOf(table) === 'task_step_agent_minings') {
          (state.miningProjections ??= []).push(projection);
        }
        const rows = rowsFor(tableNameOf(table));
        // .where() and .orderBy() are each awaited directly by some reads and chained
        // further by others, so both must be thenable AND chainable.
        const thenable = () => ({
          then: (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(rows).then(res, rej),
          limit: async () => rows,
          orderBy: () => thenable(),
        });
        // A joined read (priorRoundTimeoutAttempts, which asks earlier rounds what rung this
        // agent reached) projects from the base table and uses task_steps only to scope the
        // task/step; the mock ignores the join condition and returns the base rows unchanged.
        return { where: thenable, innerJoin: () => ({ where: thenable }) };
      },
    }),
    insert: (table: unknown) => {
      const tableName = tableNameOf(table);
      const values = (v: Record<string, unknown> | Record<string, unknown>[]) => {
        if (tableName === 'task_step_agent_minings') {
          state.miningInsertStatements = (state.miningInsertStatements ?? 0) + 1;
        }
        const commit = () =>
          (Array.isArray(v) ? v : [v]).map((one) => {
            const id = `mock-${nextId++}`;
            const row = { id, createdAt: new Date(), ...one };
            state.inserts.push({ table: tableName, row });
            // A reserved mining row comes back with the column default it did not set.
            return tableName === 'task_step_agent_minings' ? { attempts: 1, ...row } : row;
          });
        return {
          // Awaited directly by a write that needs no row back (the no-provider failure).
          then: (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve(commit()).then(res, rej),
          returning: async () => commit(),
          onConflictDoNothing: () => ({
            returning: async () =>
              state.miningInsertConflicts && tableName === 'task_step_agent_minings'
                ? []
                : commit(),
          }),
          onConflictDoUpdate: async () => {
            state.inserts.push({ table: tableName, row: v as Record<string, unknown> });
          },
        };
      };
      return { values };
    },
    update: (table: unknown) => {
      const tableName = tableNameOf(table);
      return {
        set: (v: Record<string, unknown>) => {
          const record = (where: unknown) => {
            state.updates.push({ table: tableName, ...v });
            if (tableName === 'task_steps') state.taskStepRow = { ...state.taskStepRow, ...v };
            if (tableName === 'task_step_agent_minings') {
              (state.miningUpdateLog ??= []).push({ set: v, where });
            }
          };
          const lost = (): boolean => {
            const rule = state.miningCasLost;
            const isLost =
              tableName === 'task_step_agent_minings' &&
              (typeof rule === 'function' ? rule(v) : rule === true);
            if (isLost) state.onMiningCasLost?.();
            return isLost;
          };
          return {
            where: (cond: unknown) => {
              return {
                then: (res: (v: unknown[]) => unknown, rej: (e: unknown) => unknown) => {
                  if (!lost()) record(cond);
                  return Promise.resolve([]).then(res, rej);
                },
                returning: async () => {
                  if (lost()) return [];
                  record(cond);
                  if (tableName === 'task_steps') return [state.taskStepRow];
                  return tableName === 'task_step_agent_minings' ? [{ id: 'mock-updated' }] : [];
                },
              };
            },
          };
        },
      };
    },
    // One statement's worth of atomicity is all a reservation asks of it.
    transaction: async (fn: (tx: unknown) => unknown) => {
      state.transactions = (state.transactions ?? 0) + 1;
      return fn(db);
    },
    query: {
      userStepCliPreferences: { findFirst: async () => undefined },
      // Read only for a seat other than 'default'.
      userStepCliRolePreferences: { findFirst: async () => undefined },
      tasks: { findFirst: async () => undefined },
      // resolveTaskDispatch resolves the invocation's MCP surface so the prompt can
      // state it; that reads the step-04 tooling output and the env template.
      taskSteps: { findFirst: async () => undefined },
      envTemplates: { findFirst: async () => undefined },
      repositories: { findFirst: async () => undefined },
      // Every fan-out reads what is attached to the task; nothing is, unless a test says so.
      taskAttachments: { findMany: async () => [] },
    },
  } as unknown as Database;
  return db;
}

function miningRow(
  agentId: string,
  attempts: number,
  overrides: Partial<MiningRow> = {},
): MiningRow {
  return {
    id: `mining-${agentId}`,
    agentId,
    agentTitle: agentId,
    status: 'done',
    output: null,
    rawOutput: 'prose, no json',
    errorMessage: null,
    cliInvocationId: `inv-${agentId}`,
    attempts,
    ...overrides,
  };
}

function freshState(miningRows: MiningRow[]): MockState {
  return {
    taskStepRow: {
      id: 'ts-1',
      taskId: 'task-1',
      stepId: 'test-mining-step',
      stepIndex: 0,
      title: 'test',
      status: 'waiting_cli',
      formSchema: null,
      formValues: {},
      detectOutput: { foo: 'bar' },
      output: null,
      errorMessage: null,
      startedAt: new Date(),
      endedAt: null,
    },
    miningRows,
    updates: [],
    inserts: [],
  };
}

function makeProvider(overrides: Partial<CliProviderRecord> = {}): CliProviderRecord {
  return {
    id: 'prov-1',
    userId: 'user-1',
    name: 'claude-code',
    label: 'Claude Code',
    executablePath: '/usr/bin/claude',
    wrapperPath: null,
    envVars: null,
    cliArgs: null,
    supportsSubagents: true,
    authMode: 'subscription',
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CliProviderRecord;
}

/** A mining step whose apply() throws for `unreadable` agents until it is told the
 *  re-roll budget is spent — the exact contract 08c/08d implement. */
function miningStep(unreadable: string[], applyCalls: StepApplyArgs[]): StepDefinition {
  return {
    metadata: {
      id: 'test-mining-step',
      workflowType: 'workflow',
      index: 0,
      title: 'test',
      description: 'test',
      requiresCli: true,
    },
    async detect() {
      return { foo: 'bar' };
    },
    form() {
      return null;
    },
    agentMining: {
      requiredCapabilities: [],
      retry: { maxAttempts: 2 },
      async selectAgents() {
        return [
          { agentId: 'peer-reviewer', agentTitle: 'peer-reviewer', prompt: 'review' },
          { agentId: 'security-code-reviewer', agentTitle: 'security', prompt: 'audit' },
        ];
      },
    },
    async apply(_ctx, args) {
      applyCalls.push(args);
      if (unreadable.length > 0 && args.isFinalMiningAttempt === false) {
        throw new MiningRetryError(unreadable);
      }
      return { reviewIncomplete: unreadable.length > 0 };
    },
  };
}

/** A mining step that retries only a known transient terminal failure before
 *  apply() receives the completed batch. Mirrors discovery's opt-in policy. */
function terminalFailureRetryStep(applyCalls: StepApplyArgs[]): StepDefinition {
  return {
    metadata: {
      id: 'test-mining-step',
      workflowType: 'workflow',
      index: 0,
      title: 'test',
      description: 'test',
      requiresCli: true,
    },
    async detect() {
      return { foo: 'bar' };
    },
    form() {
      return null;
    },
    agentMining: {
      requiredCapabilities: [],
      retry: {
        maxAttempts: 3,
        retryOnInvocationFailure: (result) =>
          result.errorMessage?.includes('Connection closed mid-response') === true,
      },
      async selectAgents() {
        return [
          { agentId: 'peer-reviewer', agentTitle: 'peer-reviewer', prompt: 'review' },
          { agentId: 'security-code-reviewer', agentTitle: 'security', prompt: 'audit' },
        ];
      },
    },
    async apply(_ctx, args) {
      applyCalls.push(args);
      return { settled: true };
    },
  };
}

/** A mining step whose apply() asks for a SECOND wave (one refuter per finding) the
 *  first time it runs, and settles once those agents' results are present — the exact
 *  contract 08c's refutation pass implements. */
function waveStep(
  applyCalls: StepApplyArgs[],
  waveAgentIds: string[],
  /** Keep asking even after the runner says no wave is coming — a step in breach of the
   *  MiningWaveError contract. Pins the apply loop's upper bound. */
  insist = false,
): StepDefinition {
  return {
    metadata: {
      id: 'test-mining-step',
      workflowType: 'workflow',
      index: 0,
      title: 'test',
      description: 'test',
      requiresCli: true,
    },
    async detect() {
      return { foo: 'bar' };
    },
    form() {
      return null;
    },
    agentMining: {
      requiredCapabilities: [],
      async selectAgents() {
        return [{ agentId: 'peer-reviewer', agentTitle: 'peer-reviewer', prompt: 'review' }];
      },
    },
    async apply(_ctx, args) {
      applyCalls.push(args);
      const present = new Set((args.agentMiningResults ?? []).map((r) => r.agentId));
      const missing = waveAgentIds.filter((id) => !present.has(id));
      // Never ask twice: once the wave's rows exist (or the runner says none are
      // coming), settle. Otherwise the step would park on a barrier forever.
      if (missing.length > 0 && (insist || !args.miningWaveExhausted)) {
        throw new MiningWaveError(
          missing.map((id) => ({ agentId: id, agentTitle: id, prompt: `refute ${id}` })),
        );
      }
      return { refuted: missing.length === 0, waveExhausted: args.miningWaveExhausted === true };
    },
  };
}

/** A mining step with 08c's round-9 shape: it re-rolls an unreadable reviewer while any
 *  agent still has budget, and asks for a refutation wave once told the attempt is final.
 *  The wave request therefore arrives from the DEGRADE pass rather than the first apply(),
 *  which is the path that used to escape the runner's catch and fail the whole task. */
function degradeThenWaveStep(
  unreadable: string[],
  waveAgentIds: string[],
  applyCalls: StepApplyArgs[],
): StepDefinition {
  return {
    metadata: {
      id: 'test-mining-step',
      workflowType: 'workflow',
      index: 0,
      title: 'test',
      description: 'test',
      requiresCli: true,
    },
    async detect() {
      return { foo: 'bar' };
    },
    form() {
      return null;
    },
    agentMining: {
      requiredCapabilities: [],
      retry: { maxAttempts: 2 },
      async selectAgents() {
        return [
          { agentId: 'peer-reviewer', agentTitle: 'peer-reviewer', prompt: 'review' },
          { agentId: 'security-code-reviewer', agentTitle: 'security', prompt: 'audit' },
        ];
      },
    },
    async apply(_ctx, args) {
      applyCalls.push(args);
      // 08c:1006 — re-roll the reviewer whose output could not be read, while anyone
      // still has budget.
      if (unreadable.length > 0 && args.isFinalMiningAttempt === false) {
        throw new MiningRetryError(unreadable);
      }
      // 08c:1054 — the degraded reviewer still leaves blocking findings to refute.
      const present = new Set((args.agentMiningResults ?? []).map((r) => r.agentId));
      const missing = waveAgentIds.filter((id) => !present.has(id));
      if (missing.length > 0 && !args.miningWaveExhausted) {
        throw new MiningWaveError(
          missing.map((id) => ({ agentId: id, agentTitle: id, prompt: `refute ${id}` })),
        );
      }
      return { refuted: missing.length === 0, reviewIncomplete: unreadable.length > 0 };
    },
  };
}

function run(
  db: Database,
  stepDef: StepDefinition,
  enqueued: CliExecJobPayload[],
  providers: CliProviderRecord[] = [makeProvider()],
) {
  return advanceStep({
    db,
    taskId: 'task-1',
    userId: 'user-1',
    repoPath: '/tmp',
    workspacePath: '/tmp',
    cliProviderId: 'prov-1',
    stepDef,
    providers,
    deps: {
      async enqueueCliInvocation(payload) {
        // maybeEnqueueStepSummary also enqueues (kind 'cli') on a done step; only the
        // mining re-rolls are under test here.
        if (payload.kind === 'agent_mining') enqueued.push(payload);
      },
    },
  });
}

/** A fan-out step declaring NO retry spec at all — `09_5-skill-generation`'s shape, the one of
 *  the ten mining steps without one. Both automatic re-roll paths are inert here, so this is what
 *  proves a user-requested re-run does not depend on per-step retry config. */
function noRetryMiningStep(applyCalls: StepApplyArgs[]): StepDefinition {
  return {
    metadata: {
      id: 'test-mining-step',
      workflowType: 'workflow',
      index: 0,
      title: 'test',
      description: 'test',
      requiresCli: true,
    },
    async detect() {
      return { foo: 'bar' };
    },
    form() {
      return null;
    },
    agentMining: {
      requiredCapabilities: [],
      async selectAgents() {
        return [
          { agentId: 'peer-reviewer', agentTitle: 'peer-reviewer', prompt: 'review' },
          { agentId: 'security-code-reviewer', agentTitle: 'security', prompt: 'audit' },
        ];
      },
    },
    async apply(_ctx, args) {
      applyCalls.push(args);
      return { settled: true };
    },
  };
}

function reopeningFormStep(): StepDefinition {
  return {
    metadata: {
      id: 'test-mining-step',
      workflowType: 'workflow',
      index: 0,
      title: 'test',
      description: 'test',
      requiresCli: false,
    },
    async detect() {
      return { remaining: 42 };
    },
    form(_ctx, detected) {
      return {
        title: 'More work remains',
        description: `${(detected as { remaining: number }).remaining} items remain`,
        fields: [
          {
            type: 'radio',
            id: 'decision',
            label: 'Continue?',
            options: [
              { value: 'continue', label: 'Continue' },
              { value: 'accept', label: 'Accept' },
            ],
            required: true,
          },
        ],
      };
    },
    async apply() {
      throw new ReopenStepFormError('bounded batch finished');
    },
  } as StepDefinition;
}

describe('advanceStep apply-to-form continuation', () => {
  it('refreshes detection, clears the prior answer, and parks the same step', async () => {
    const state = freshState([miningRow('prior-batch-agent', 1)]);
    state.taskStepRow.formSchema = {
      title: 'Old form',
      fields: [],
    };
    state.taskStepRow.formValues = { decision: 'continue' };

    const result = await run(makeMockDb(state), reopeningFormStep(), []);

    expect(result.status).toBe('waiting_form');
    expect(state.taskStepRow.status).toBe('waiting_form');
    expect(state.taskStepRow.formValues).toBeNull();
    expect(state.taskStepRow.detectOutput).toEqual({ remaining: 42 });
    expect(state.taskStepRow.formSchema).toMatchObject({
      title: 'More work remains',
      description: '42 items remain',
    });
    expect(
      state.updates.some(
        (update) => update.table === 'task_step_agent_minings' && update.consumedAt instanceof Date,
      ),
    ).toBe(true);
  });
});

describe('advanceStep agentMining user-requested re-run', () => {
  it('re-runs only the marked terminal and leaves a done sibling alone', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1, {
        status: 'failed',
        errorMessage: 'CLI process exceeded its time budget (30m).',
        userRetryRequestedAt: new Date(),
      }),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), noRetryMiningStep(applyCalls), enqueued);

    // Parked on the re-roll, so apply() has NOT consumed the batch yet.
    expect(result.status).toBe('waiting_cli');
    expect(applyCalls).toHaveLength(0);
    // Exactly one agent re-dispatched — the whole point. The sibling that finished keeps its
    // output instead of being re-bought.
    expect(enqueued).toHaveLength(1);
    const reroll = state.inserts.find((i) => i.table === 'task_step_agent_minings');
    expect(reroll).toBeUndefined(); // UPDATEd in place, never a second row
    const miningUpdates = state.updates.filter((u) => u.table === 'task_step_agent_minings');
    expect(miningUpdates.some((u) => u.status === 'pending')).toBe(true);
  });

  it('re-runs a marked terminal whose automatic budget is already spent', async () => {
    // The case that matters in practice: the user reaches for this control precisely AFTER the
    // automatic re-rolls are gone. attempts (9) is far past any maxAttempts, and the step
    // declares none at all.
    const state = freshState([
      miningRow('peer-reviewer', 9, {
        status: 'failed',
        errorMessage: 'CLI process exceeded its time budget (30m).',
        userRetryRequestedAt: new Date(),
      }),
      miningRow('security-code-reviewer', 1),
    ]);
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), noRetryMiningStep([]), enqueued);
    expect(result.status).toBe('waiting_cli');
    expect(enqueued).toHaveLength(1);
  });

  it('clears the marker so the request fires exactly once', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1, {
        status: 'failed',
        errorMessage: 'CLI process exceeded its time budget (30m).',
        userRetryRequestedAt: new Date(),
      }),
    ]);
    await run(makeMockDb(state), noRetryMiningStep([]), []);
    const cleared = state.updates.filter(
      (u) => u.table === 'task_step_agent_minings' && u.userRetryRequestedAt === null,
    );
    expect(cleared.length).toBeGreaterThan(0);
  });

  it('does not re-run anything when no terminal is marked', async () => {
    // An unmarked failed row must stay failed and fall through to apply(): without a retry
    // spec there is nothing automatic to fire, and inventing one would re-run agents nobody
    // asked to re-run.
    const state = freshState([
      miningRow('peer-reviewer', 1, {
        status: 'failed',
        errorMessage: 'CLI process exceeded its time budget (30m).',
      }),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    await run(makeMockDb(state), noRetryMiningStep(applyCalls), enqueued);
    expect(enqueued).toHaveLength(0);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.agentMiningResults?.map((r) => r.status).sort()).toEqual([
      'done',
      'failed',
    ]);
  });
});

describe('advanceStep agentMining retry', () => {
  it('re-runs only a transiently failed terminal before apply, preserving its siblings', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1, {
        status: 'failed',
        errorMessage: 'API Error: Connection closed mid-response. The response may be incomplete.',
      }),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), terminalFailureRetryStep(applyCalls), enqueued);

    expect(result.status).toBe('waiting_cli');
    expect(applyCalls).toHaveLength(0);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.agentMiningId).toBe('mining-peer-reviewer');

    const miningUpdates = state.updates.filter((u) => u.table === 'task_step_agent_minings');
    expect(miningUpdates).toHaveLength(1);
    expect(miningUpdates[0]!.status).toBe('pending');
    expect(miningUpdates[0]!.attempts).toBe(2);
  });

  it('stops re-running a transient terminal after its third total attempt', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 3, {
        status: 'failed',
        errorMessage: 'API Error: Connection closed mid-response. The response may be incomplete.',
      }),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), terminalFailureRetryStep(applyCalls), enqueued);

    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
  });

  it('re-rolls only the unreadable agent and parks, leaving the readable one alone', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(
      makeMockDb(state),
      miningStep(['peer-reviewer'], applyCalls),
      enqueued,
    );

    expect(result.status).toBe('waiting_cli');
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.isFinalMiningAttempt).toBe(false);

    // exactly one re-enqueue, onto the peer row (mining id preserved by the unique index)
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.kind).toBe('agent_mining');
    expect(enqueued[0]!.agentMiningId).toBe('mining-peer-reviewer');
    // the step declares no softTimeout, so the re-roll must not opt into one either
    expect(enqueued[0]!.softTimeout).toBe(false);

    // the peer row goes back to pending with attempts bumped; the security row is untouched
    const miningUpdates = state.updates.filter((u) => u.table === 'task_step_agent_minings');
    expect(miningUpdates).toHaveLength(1);
    expect(miningUpdates[0]!.status).toBe('pending');
    expect(miningUpdates[0]!.attempts).toBe(2);
    expect(miningUpdates[0]!.rawOutput).toBeNull();

    // the superseded invocation is the one whose output apply() could not read
    const supersedes = state.updates.filter(
      (u) => u.table === 'cli_invocations' && u.supersededAt instanceof Date,
    );
    expect(supersedes).toHaveLength(1);
  });

  it('degrades instead of failing when the named agent is spent but another has budget', async () => {
    // The mixed-budget case: peer already re-rolled (attempts 2 of 2), security is on its
    // first (attempts 1). miningAgentsWithBudget sees security's spare budget, so
    // isFinalMiningAttempt is false and apply() throws for peer -- but peer cannot be
    // re-rolled. The step must degrade, not die.
    const state = freshState([
      miningRow('peer-reviewer', 2),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(
      makeMockDb(state),
      miningStep(['peer-reviewer'], applyCalls),
      enqueued,
    );

    expect(result.status).toBe('done');
    expect(enqueued).toHaveLength(0);
    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[0]!.isFinalMiningAttempt).toBe(false);
    expect(applyCalls[1]!.isFinalMiningAttempt).toBe(true);
    if (result.status === 'done') {
      expect(result.output).toEqual({ reviewIncomplete: true });
    }
    expect(state.updates.filter((u) => u.table === 'task_step_agent_minings')).toHaveLength(0);
  });

  it('reports the final attempt once every agent is spent, so apply degrades without throwing', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 2),
      miningRow('security-code-reviewer', 2),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(
      makeMockDb(state),
      miningStep(['peer-reviewer'], applyCalls),
      enqueued,
    );

    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.isFinalMiningAttempt).toBe(true);
    expect(enqueued).toHaveLength(0);
  });

  it('leaves apply on its first attempt while every agent still has budget', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    // no unreadable agents -> apply never throws, so no re-roll and no degrade
    const result = await run(makeMockDb(state), miningStep([], applyCalls), enqueued);

    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.isFinalMiningAttempt).toBe(false);
    expect(enqueued).toHaveLength(0);
  });
});

/** The fatal class a fan-out must never degrade past: the provider is gone for hours, so
 *  every downstream step re-hits it and the review that "passed" never happened. */
const RATE_LIMIT_ERR =
  "Provider rate limit or quota exhausted — the provider's usage limit or quota is exhausted; " +
  'retry this task once it resets. (LLM run reported a failure (terminal_reason "api_error"): ' +
  'API Error: Request rejected (429) · [1308][Usage limit reached for 5 hour.])';

describe('advanceStep agentMining fatal provider failure', () => {
  it('fails the step instead of handing apply() a degraded batch', async () => {
    // Task 88b8c808: all three 08c reviewers answered 429, apply() degraded them to
    // non-blocking "did not complete" findings, the step went done, and the next step
    // fired another doomed call. Failing here is what lets task-queue arm the
    // provider_unavailable errorHint and the allowance watch.
    const state = freshState([
      miningRow('peer-reviewer', 2, { status: 'failed', errorMessage: RATE_LIMIT_ERR }),
      miningRow('security-code-reviewer', 2, { status: 'failed', errorMessage: RATE_LIMIT_ERR }),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), terminalFailureRetryStep(applyCalls), enqueued);

    expect(result.status).toBe('failed');
    expect(applyCalls).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
    // The RAW headline reaches the step row — task-queue's failed path matches on it to
    // pick the outage reason, so a prefixed or reworded message would lose the watch.
    expect(result.status === 'failed' && result.error).toBe(RATE_LIMIT_ERR);
  });

  it('fails even when a sibling finished, rather than reporting a partial review', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1),
      miningRow('security-code-reviewer', 2, { status: 'failed', errorMessage: RATE_LIMIT_ERR }),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), terminalFailureRetryStep(applyCalls), enqueued);

    expect(result.status).toBe('failed');
    expect(applyCalls).toHaveLength(0);
  });

  it('leaves an ordinary failure to the existing degrade path', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 3, {
        status: 'failed',
        errorMessage: 'the model disagreed with itself',
      }),
      miningRow('security-code-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), terminalFailureRetryStep(applyCalls), enqueued);

    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(1);
  });
});

describe('advanceStep agentMining second wave', () => {
  it('dispatches the wave and parks, leaving the first wave’s row alone', async () => {
    const state = freshState([miningRow('peer-reviewer', 1)]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(
      makeMockDb(state),
      waveStep(applyCalls, ['refute-abc', 'refute-def']),
      enqueued,
    );

    expect(result.status).toBe('waiting_cli');
    expect(applyCalls).toHaveLength(1);

    // one fresh row + one job per wave agent; the reviewer's row is never updated
    expect(enqueued.map((e) => e.agentMiningId)).toHaveLength(2);
    const miningInserts = state.inserts.filter((i) => i.table === 'task_step_agent_minings');
    expect(miningInserts.map((i) => i.row.agentId)).toEqual(['refute-abc', 'refute-def']);
    expect(miningInserts.every((i) => i.row.status === 'pending')).toBe(true);
    // The first wave's rows are never re-rolled or reset by a wave dispatch. The one update
    // they get is the consumed_at stamp, written for the whole step rather than by row id, so a
    // wave-aware apply() cannot re-fold them; the wave's own rows are what gets linked.
    expect(writesTo(state, 'mining-peer-reviewer')).toEqual([]);
    const stamps = (state.miningUpdateLog ?? []).filter((u) => u.set.consumedAt instanceof Date);
    expect(
      stamps.every((u) => Object.keys(u.set).every((k) => k === 'consumedAt' || k === 'updatedAt')),
    ).toBe(true);
    expect(
      (state.miningUpdateLog ?? []).filter(
        (u) => u.set.status === 'pending' && u.set.cliInvocationId,
      ),
    ).toHaveLength(2);
  });

  it('settles without asking again once the wave’s results are present', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1),
      miningRow('refute-abc', 1),
      miningRow('refute-def', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(
      makeMockDb(state),
      waveStep(applyCalls, ['refute-abc', 'refute-def']),
      enqueued,
    );

    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(1);
    expect(enqueued).toHaveLength(0);
    if (result.status === 'done') {
      expect(result.output).toEqual({ refuted: true, waveExhausted: false });
    }
  });

  it('continues without the wave rather than parking on a barrier nothing will clear', async () => {
    // No provider can take the wave's agent, so no job is enqueued and no row goes pending.
    // Parking here would hang the step forever; apply must be re-run and told the wave is
    // not coming.
    const state = freshState([miningRow('peer-reviewer', 1)]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), waveStep(applyCalls, ['refute-abc']), enqueued, []);

    expect(result.status).toBe('done');
    expect(enqueued).toHaveLength(0);
    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[0]!.miningWaveExhausted).toBeUndefined();
    expect(applyCalls[1]!.miningWaveExhausted).toBe(true);
    if (result.status === 'done') {
      expect(result.output).toEqual({ refuted: false, waveExhausted: true });
    }
  });

  it('dispatches a wave requested from the degrade pass instead of failing the step', async () => {
    // Round 9 of task 7780da14: the security reviewer's output was unreadable on both of
    // its attempts while the peer reviewer still had budget, so miningAgentsWithBudget
    // reported "not final", apply() threw MiningRetryError, nothing could be re-rolled,
    // and the runner re-ran apply() as final. THAT pass asked for the refutation wave.
    // The request used to be raised from inside the catch, where nothing handled it, so
    // the step (and a 26-hour task) died on a control-flow signal.
    const state = freshState([
      miningRow('security-code-reviewer', 2),
      miningRow('peer-reviewer', 1),
    ]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(
      makeMockDb(state),
      degradeThenWaveStep(['security-code-reviewer'], ['refute-abc', 'refute-def'], applyCalls),
      enqueued,
    );

    expect(result.status).toBe('waiting_cli');
    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[0]!.isFinalMiningAttempt).toBe(false);
    expect(applyCalls[1]!.isFinalMiningAttempt).toBe(true);

    // the wave went out as fresh rows; the spent reviewer was never re-rolled
    const miningInserts = state.inserts.filter((i) => i.table === 'task_step_agent_minings');
    expect(miningInserts.map((i) => i.row.agentId)).toEqual(['refute-abc', 'refute-def']);
    expect(miningInserts.every((i) => i.row.status === 'pending')).toBe(true);
    expect(enqueued).toHaveLength(2);
    // No re-roll, no reset — at most the consumed_at stamp (see above).
    expect(writesTo(state, 'mining-peer-reviewer')).toEqual([]);
    expect(writesTo(state, 'mining-security-code-reviewer')).toEqual([]);
  });

  it('fails rather than looping when the wave-exhausted pass asks again', async () => {
    // No provider can take the wave's agent, so the runner tells apply() the wave is not
    // coming. A step that asks anyway is in breach of the contract: the loop must give up
    // and surface the throw, not spin re-dispatching forever.
    const state = freshState([miningRow('peer-reviewer', 1)]);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(
      makeMockDb(state),
      waveStep(applyCalls, ['refute-abc'], true),
      enqueued,
      [],
    );

    expect(result.status).toBe('failed');
    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[1]!.miningWaveExhausted).toBe(true);
    expect(enqueued).toHaveLength(0);
  });
});

describe('advanceStep agentMining retry for a wave-dispatched step', () => {
  /** A step whose later waves are thrown from apply(), so `selectAgents` never
   *  authored them and returns nothing once the first wave exists — plan-build's
   *  shape exactly. */
  function waveStep(): StepDefinition {
    return {
      metadata: { id: 'test-wave-step', title: 'wave', description: '', index: 0 },
      async detect() {
        return { foo: 'bar' };
      },
      form() {
        return null;
      },
      agentMining: {
        requiredCapabilities: [],
        async selectAgents() {
          return [];
        },
      },
      async apply() {
        return { settled: true };
      },
    } as unknown as StepDefinition;
  }

  it('repeats the agent using the prompt its last run used', async () => {
    // The measured failure: eight wave-3 agents died on a five-hour rate limit,
    // and every retry route — the user's Resume, the allowance auto-resume at the
    // reset, the worker-restart reconcile — did nothing at all, because
    // selectAgents cannot re-offer an agent it never authored. The task read as
    // permanently quota-blocked long after the quota returned.
    const state = freshState([
      miningRow('plan-expand-abc-p3', 1, {
        status: 'failed',
        errorMessage: 'Provider rate limit or quota exhausted',
        userRetryRequestedAt: new Date(),
      }),
    ]);
    state.invocationRows = [{ id: 'inv-plan-expand-abc-p3', prompt: 'expand node abc' }];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), waveStep(), enqueued);

    expect(result.status).toBe('waiting_cli');
    expect(enqueued).toHaveLength(1);
    // The prompt rides on the invocation row the dispatch writes, not the job.
    const invocation = state.inserts.find((i) => i.table === 'cli_invocations');
    expect(invocation?.row.prompt).toContain('expand node abc');
  });

  it('does nothing for an agent with no prior run to repeat', async () => {
    // Nothing to reconstruct from, so the old behaviour stands rather than a
    // guessed prompt being sent to a CLI.
    const state = freshState([
      miningRow('plan-expand-abc-p3', 1, {
        status: 'failed',
        errorMessage: 'Provider rate limit or quota exhausted',
        userRetryRequestedAt: new Date(),
        cliInvocationId: null,
      }),
    ]);
    const enqueued: CliExecJobPayload[] = [];
    await run(makeMockDb(state), waveStep(), enqueued);
    expect(enqueued).toHaveLength(0);
  });

  it('never shadows a prompt selectAgents did offer', async () => {
    // The recovery fills gaps only. An agent still on offer keeps the FRESH
    // prompt; repeating a stale one there would undo whatever the new wave knows.
    const state = freshState([
      miningRow('peer-reviewer', 1, {
        status: 'failed',
        errorMessage: 'CLI process exceeded its time budget (30m).',
        userRetryRequestedAt: new Date(),
      }),
    ]);
    state.invocationRows = [{ id: 'inv-peer-reviewer', prompt: 'STALE prompt' }];
    const enqueued: CliExecJobPayload[] = [];
    await run(makeMockDb(state), noRetryMiningStep([]), enqueued);
    expect(enqueued).toHaveLength(1);
    const invocation = state.inserts.find((i) => i.table === 'cli_invocations');
    expect(invocation?.row.prompt).toContain('review');
  });
});

describe('what a mining agent is told about the task', () => {
  // Every augmenter is a no-op in the other tests here (no attachments, no stored terseness
  // level), which is exactly why nothing pinned whether a fan-out was augmented at all, or twice.
  const attached = [
    {
      id: 'att-1',
      taskId: 'task-1',
      filename: 'brief.pdf',
      description: null,
      storedPath: '/elsewhere/brief.pdf',
      contentType: null,
      sizeBytes: 1,
      expandedAt: null,
      expansionNote: null,
      expandedFromId: null,
      createdAt: new Date(),
    },
  ];
  const count = (text: string, needle: string): number => text.split(needle).length - 1;
  const sentPrompts = (state: MockState): string[] =>
    state.inserts.filter((i) => i.table === 'cli_invocations').map((i) => String(i.row.prompt));

  beforeEach(() => {
    const original = configService.get.bind(configService);
    vi.spyOn(configService, 'get').mockImplementation(async (key) =>
      key === CONFIG_KEYS.TERSENESS_LEVEL ? 'full' : original(key),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function withAttachments(state: MockState): Database {
    const db = makeMockDb(state) as unknown as { query: Record<string, unknown> };
    db.query.taskAttachments = { findMany: async () => attached };
    return db as unknown as Database;
  }

  it('tells every agent of a fan-out what is attached, once', async () => {
    const state = freshState([miningRow('peer-reviewer', 1)]);
    await run(withAttachments(state), waveStep([], ['refute-abc', 'refute-def']), []);

    const prompts = sentPrompts(state);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(count(prompt, '[User-attached files]')).toBe(1);
      expect(prompt).toContain('brief.pdf');
      expect(count(prompt, '## Response style')).toBe(1);
    }
  });

  it('records the prompt its step wrote, not the one it sent', async () => {
    const state = freshState([miningRow('peer-reviewer', 1)]);
    await run(withAttachments(state), waveStep([], ['refute-abc']), []);

    const [sent] = sentPrompts(state);
    expect(sent).toContain('[User-attached files]');
    expect(sent).toContain('## Response style');
    const recorded = state.inserts.find(
      (i) => i.table === 'task_step_agent_minings' && i.row.agentId === 'refute-abc',
    );
    expect(recorded?.row.dispatchPrompt).toBe('refute refute-abc');
  });

  it('tells a recovered agent what is attached, and the style directive, once each', async () => {
    // Built from the step's own prompt, so it goes through the augmenters exactly once — with the
    // attachments as they are now, not as the run it repeats saw them.
    const recovering = {
      metadata: { id: 'test-wave-step', title: 'wave', description: '', index: 0 },
      async detect() {
        return { foo: 'bar' };
      },
      form() {
        return null;
      },
      agentMining: {
        requiredCapabilities: [],
        async selectAgents() {
          return [];
        },
      },
      async apply() {
        return { settled: true };
      },
    } as unknown as StepDefinition;
    const state = freshState([
      miningRow('plan-expand-abc-p3', 1, {
        status: 'failed',
        errorMessage: 'Provider rate limit or quota exhausted',
        userRetryRequestedAt: new Date(),
        dispatchPrompt: 'expand node abc',
      }),
    ]);
    state.invocationRows = [
      {
        id: 'inv-plan-expand-abc-p3',
        prompt:
          '[User-attached files]\n  - deleted-since.pdf\n\nexpand node abc\n\n## Response style\nBe concise.',
      },
    ];
    await run(withAttachments(state), recovering, []);

    const [prompt] = sentPrompts(state);
    expect(prompt).toContain('expand node abc');
    expect(prompt).toContain('brief.pdf');
    expect(prompt).not.toContain('deleted-since.pdf');
    expect(count(prompt!, '[User-attached files]')).toBe(1);
    expect(count(prompt!, '## Response style')).toBe(1);
  });

  it('sends a recovered agent that recorded no prompt the one its last run sent, unaugmented', async () => {
    // The stored prompt is the text that run SENT, so it already carries every block; putting it
    // through the augmenters again doubles the notice and the style directive.
    const recovering = {
      metadata: { id: 'test-wave-step', title: 'wave', description: '', index: 0 },
      async detect() {
        return { foo: 'bar' };
      },
      form() {
        return null;
      },
      agentMining: {
        requiredCapabilities: [],
        async selectAgents() {
          return [];
        },
      },
      async apply() {
        return { settled: true };
      },
    } as unknown as StepDefinition;
    const state = freshState([
      miningRow('plan-expand-abc-p3', 1, {
        status: 'failed',
        errorMessage: 'Provider rate limit or quota exhausted',
        userRetryRequestedAt: new Date(),
      }),
    ]);
    state.invocationRows = [
      {
        id: 'inv-plan-expand-abc-p3',
        prompt:
          '[User-attached files]\n  - brief.pdf\n\nexpand node abc\n\n## Response style\nBe concise.',
      },
    ];
    await run(withAttachments(state), recovering, []);

    const [prompt] = sentPrompts(state);
    expect(prompt).toContain('expand node abc');
    expect(count(prompt!, '[User-attached files]')).toBe(1);
    expect(count(prompt!, '## Response style')).toBe(1);
  });
});

/** A provider whose current model has already rejected an image. */
const blindProvider = (id: string): CliProviderRecord =>
  makeProvider({
    id,
    model: null,
    modelLimits: { model: '', vision: false, learnedAt: '2026-09-01T00:00:00.000Z' },
  });

describe('the dispatch a mining row records', () => {
  const asked = {
    roleKey: 'refuter:security',
    capabilities: ['vision'] as StepCapability[],
    preferVision: true,
  };
  const miningWrites = (state: MockState): Record<string, unknown>[] => [
    ...state.inserts.filter((i) => i.table === 'task_step_agent_minings').map((i) => i.row),
    ...state.updates.filter((u) => u.table === 'task_step_agent_minings'),
  ];

  /** Its second wave dispatches one agent carrying every override and one carrying none. */
  function overridingWave(): StepDefinition {
    return {
      metadata: {
        id: 'test-mining-step',
        workflowType: 'workflow',
        index: 0,
        title: 'wave',
        description: 'wave',
        requiresCli: true,
      },
      async detect() {
        return { foo: 'bar' };
      },
      form() {
        return null;
      },
      agentMining: {
        requiredCapabilities: [],
        async selectAgents() {
          return [{ agentId: 'peer-reviewer', agentTitle: 'peer-reviewer', prompt: 'review' }];
        },
      },
      async apply(_ctx, args) {
        const present = new Set((args.agentMiningResults ?? []).map((r) => r.agentId));
        if (!present.has('refute-abc') && !args.miningWaveExhausted) {
          throw new MiningWaveError([
            { agentId: 'refute-abc', agentTitle: 'refute-abc', prompt: 'refute abc', ...asked },
            { agentId: 'refute-def', agentTitle: 'refute-def', prompt: 'refute def' },
          ]);
        }
        return { settled: true };
      },
    };
  }

  /** It re-offers its one agent with every override, so a re-roll rebuilds the dispatch. */
  function overridingRetry(): StepDefinition {
    const step = noRetryMiningStep([]);
    step.agentMining!.selectAgents = async () => [
      { agentId: 'peer-reviewer', agentTitle: 'peer-reviewer', prompt: 'review', ...asked },
    ];
    return step;
  }

  const reRequested = () =>
    freshState([
      miningRow('peer-reviewer', 1, {
        status: 'failed',
        errorMessage: 'CLI process exceeded its time budget (30m).',
        userRetryRequestedAt: new Date(),
      }),
    ]);

  it('records what a fresh dispatch asked for beyond the step spec, and NULL for none', async () => {
    const state = freshState([miningRow('peer-reviewer', 1)]);
    await run(makeMockDb(state), overridingWave(), []);

    const rows = miningWrites(state);
    expect(rows.find((r) => r.agentId === 'refute-abc')).toMatchObject({
      ...asked,
      dispatchPrompt: 'refute abc',
    });
    expect(rows.find((r) => r.agentId === 'refute-def')).toMatchObject({
      roleKey: null,
      capabilities: null,
      preferVision: null,
      dispatchPrompt: 'refute def',
    });
  });

  it('records it again on a re-roll', async () => {
    const state = reRequested();
    await run(makeMockDb(state), overridingRetry(), []);
    expect(miningWrites(state).find((r) => r.status === 'pending')).toMatchObject({
      ...asked,
      dispatchPrompt: 'review',
    });
  });

  it('records it for an agent no provider could take', async () => {
    // Only a blind model is configured, so an agent that needs to SEE has no provider. The row
    // still says what was asked, which is what a later retry has to repeat.
    const fresh = freshState([miningRow('peer-reviewer', 1)]);
    await run(makeMockDb(fresh), overridingWave(), [], [blindProvider('prov-1')]);
    expect(miningWrites(fresh).find((r) => r.status === 'failed')).toMatchObject({
      ...asked,
      dispatchPrompt: 'refute abc',
    });

    const reroll = reRequested();
    await run(makeMockDb(reroll), overridingRetry(), [], [blindProvider('prov-1')]);
    expect(miningWrites(reroll).find((r) => r.status === 'failed')).toMatchObject({
      ...asked,
      dispatchPrompt: 'review',
    });
  });
});

describe('a recovered wave agent', () => {
  // selectAgents never authored a wave agent, so the retry has only the row and the prompt its
  // last run stored. Everything that run was dispatched WITH has to come off the row.
  function recoveringStep(): StepDefinition {
    return {
      metadata: { id: 'test-wave-step', title: 'wave', description: '', index: 0 },
      async detect() {
        return { foo: 'bar' };
      },
      form() {
        return null;
      },
      agentMining: {
        requiredCapabilities: [],
        async selectAgents() {
          return [];
        },
      },
      async apply() {
        return { settled: true };
      },
    } as unknown as StepDefinition;
  }
  const failedWave = (overrides: Partial<MiningRow>): MockState => {
    const state = freshState([
      miningRow('refute-abc', 1, {
        status: 'failed',
        errorMessage: 'Provider rate limit or quota exhausted',
        userRetryRequestedAt: new Date(),
        ...overrides,
      }),
    ]);
    state.invocationRows = [{ id: 'inv-refute-abc', prompt: 'refute abc' }];
    return state;
  };
  const dispatchedTo = (state: MockState): unknown =>
    state.inserts.find((i) => i.table === 'cli_invocations')?.row.cliProviderId;

  it('runs in the seat its last dispatch recorded', async () => {
    // 08c's refuters are one agent per finding; the stable seat is the lens. A person who put the
    // security lens on a second model gets that model on a retry too, not the task's default.
    const state = failedWave({ roleKey: 'refuter:security' });
    const db = makeMockDb(state) as unknown as { query: Record<string, unknown> };
    db.query.userStepCliRolePreferences = {
      findFirst: async () => ({ cliProviderId: 'prov-2', effortLevel: null }),
    };
    await run(
      db as unknown as Database,
      recoveringStep(),
      [],
      [makeProvider(), makeProvider({ id: 'prov-2' })],
    );
    expect(dispatchedTo(state)).toBe('prov-2');
  });

  it('still requires vision when its last dispatch did', async () => {
    const state = failedWave({ capabilities: ['vision'] });
    await run(
      makeMockDb(state),
      recoveringStep(),
      [],
      [blindProvider('prov-1'), makeProvider({ id: 'prov-2' })],
    );
    expect(dispatchedTo(state)).toBe('prov-2');
  });

  it('still prefers a model that can see when its last dispatch did', async () => {
    const state = failedWave({ preferVision: true });
    await run(
      makeMockDb(state),
      recoveringStep(),
      [],
      [blindProvider('prov-1'), makeProvider({ id: 'prov-2' })],
    );
    expect(dispatchedTo(state)).toBe('prov-2');
  });

  it('dispatches as before when its last dispatch recorded nothing', async () => {
    const state = failedWave({});
    await run(
      makeMockDb(state),
      recoveringStep(),
      [],
      [blindProvider('prov-1'), makeProvider({ id: 'prov-2' })],
    );
    expect(dispatchedTo(state)).toBe('prov-1');
  });
});

describe('a wave agent recovered from the prompt its step wrote', () => {
  // `cli_invocations.prompt` is what a run SENT: the step's text plus the attachments notice, the
  // ledger, the style directive and the adaptations for the provider it ran on. The row's own
  // `dispatch_prompt` is the step's text alone, so a retry built from it is augmented and adapted
  // once, for today and for the provider that takes it.
  function recoveringStep(retry?: { maxAttempts: number }): StepDefinition {
    return {
      metadata: { id: 'test-wave-step', title: 'wave', description: '', index: 0 },
      async detect() {
        return { foo: 'bar' };
      },
      form() {
        return null;
      },
      agentMining: {
        requiredCapabilities: [],
        ...(retry ? { retry } : {}),
        async selectAgents() {
          return [];
        },
      },
      async apply(_ctx: unknown, args: StepApplyArgs) {
        // Asks for its wave agent again while the runner says the attempt is not final — the
        // automatic re-roll a person never requested.
        if (retry && args.isFinalMiningAttempt === false) {
          throw new MiningRetryError(['plan-expand-abc-p3']);
        }
        return { settled: true };
      },
    } as unknown as StepDefinition;
  }
  const count = (text: string, needle: string): number => text.split(needle).length - 1;
  const sentPrompts = (state: MockState): string[] =>
    state.inserts.filter((i) => i.table === 'cli_invocations').map((i) => String(i.row.prompt));
  const miningWrites = (state: MockState): Record<string, unknown>[] => [
    ...state.inserts.filter((i) => i.table === 'task_step_agent_minings').map((i) => i.row),
    ...state.updates.filter((u) => u.table === 'task_step_agent_minings'),
  ];
  /** What provider A was sent: its surface and its no-vision boundary around the step's text. */
  const SENT_TO_A = `${MCP_SURFACE_MARKER}\nA's surface\n\n${MODEL_CAPABILITY_BOUNDARY_MARKER}\nA's boundary\n\nexpand node abc`;
  const failedWave = (overrides: Partial<MiningRow>): MockState => {
    const state = freshState([
      miningRow('plan-expand-abc-p3', 1, {
        status: 'failed',
        errorMessage: 'Provider rate limit or quota exhausted',
        userRetryRequestedAt: new Date(),
        dispatchPrompt: 'expand node abc',
        ...overrides,
      }),
    ]);
    state.invocationRows = [{ id: 'inv-plan-expand-abc-p3', prompt: SENT_TO_A }];
    return state;
  };
  /** An agent no provider could take: it never reached a CLI, so it has no invocation. */
  const neverDispatched = (overrides: Partial<MiningRow>): MockState =>
    freshState([
      miningRow('plan-expand-abc-p3', 1, {
        status: 'failed',
        errorMessage: 'no cli provider available: every provider is disabled',
        cliInvocationId: null,
        dispatchPrompt: 'expand node abc',
        ...overrides,
      }),
    ]);

  it('is adapted for the provider that takes it, not the one that ran it', async () => {
    const state = failedWave({});
    await run(makeMockDb(state), recoveringStep(), []);
    const [prompt] = sentPrompts(state);
    expect(prompt).toContain('expand node abc');
    expect(prompt).not.toContain("A's surface");
    expect(prompt).not.toContain("A's boundary");
    expect(count(prompt!, MCP_SURFACE_MARKER)).toBe(1);
    expect(count(prompt!, MODEL_CAPABILITY_BOUNDARY_MARKER)).toBe(0);
  });

  it("carries a blind provider's boundary once, its own and not the last run's", async () => {
    const state = failedWave({});
    await run(makeMockDb(state), recoveringStep(), [], [blindProvider('prov-1')]);
    const [prompt] = sentPrompts(state);
    expect(prompt).not.toContain("A's boundary");
    expect(count(prompt!, MODEL_CAPABILITY_BOUNDARY_MARKER)).toBe(1);
  });

  it('is assigned the persona its step named', async () => {
    // A sent prompt no longer carries the marker (the dispatcher rewrote it), so a verbatim replay
    // could never record which persona the agent was.
    const state = failedWave({
      dispatchPrompt: agentDefinitionGuidance(
        'code-reviewer',
        'Follow .claude/agents/code-reviewer.md to review node abc.',
      ),
    });
    const enqueued: CliExecJobPayload[] = [];
    await run(makeMockDb(state), recoveringStep(), enqueued);
    const spec = enqueued[0]?.spec as { assignedAgentIds?: string[] } | undefined;
    expect(spec?.assignedAgentIds).toContain('code-reviewer');
  });

  it('records the prompt it recovered from again, so the next retry has it too', async () => {
    const state = failedWave({});
    await run(makeMockDb(state), recoveringStep(), []);
    expect(miningWrites(state).find((w) => w.status === 'pending')).toMatchObject({
      dispatchPrompt: 'expand node abc',
    });
  });

  it('replays the last run verbatim, and records none, when its row recorded no prompt', async () => {
    const state = failedWave({ dispatchPrompt: null });
    state.invocationRows = [{ id: 'inv-plan-expand-abc-p3', prompt: 'expand node abc' }];
    await run(makeMockDb(state), recoveringStep(), []);
    expect(sentPrompts(state)).toHaveLength(1);
    // Recording that prompt would hand the next retry a sent prompt to augment a second time.
    expect(miningWrites(state).find((w) => w.status === 'pending')).toMatchObject({
      dispatchPrompt: null,
    });
  });

  it('re-dispatches an agent no provider could take, when a person asks', async () => {
    const state = neverDispatched({ userRetryRequestedAt: new Date() });
    const enqueued: CliExecJobPayload[] = [];
    await run(makeMockDb(state), recoveringStep(), enqueued);
    expect(enqueued).toHaveLength(1);
    expect(sentPrompts(state)[0]).toContain('expand node abc');
  });

  it('leaves it failed, charging nothing, while there is still no provider', async () => {
    const state = neverDispatched({ userRetryRequestedAt: new Date(), capabilities: ['vision'] });
    const enqueued: CliExecJobPayload[] = [];
    await run(makeMockDb(state), recoveringStep(), enqueued, [blindProvider('prov-1')]);
    expect(enqueued).toHaveLength(0);
    const failed = miningWrites(state).find((w) => w.status === 'failed');
    expect(String(failed?.errorMessage)).toContain('no cli provider available');
    expect(failed).not.toHaveProperty('attempts');
  });

  it('does not re-run an agent that never reached a CLI on an automatic re-roll', async () => {
    // Nobody asked: an automatic re-roll would meet the same missing provider, and no attempt is
    // charged for that, so only a person's Resume brings such an agent back.
    const state = neverDispatched({});
    const enqueued: CliExecJobPayload[] = [];
    await run(makeMockDb(state), recoveringStep({ maxAttempts: 2 }), enqueued);
    expect(enqueued).toHaveLength(0);
  });

  it('reads a prompt-sized column only for the rows it recovers', async () => {
    const state = failedWave({});
    await run(makeMockDb(state), recoveringStep(), []);
    const projections = state.miningProjections ?? [];
    expect(projections.length).toBeGreaterThan(0);
    for (const projection of projections) {
      // A bare select() reads every column of every row on every advance.
      expect(projection).toBeDefined();
      const keys = Object.keys(projection as object);
      if (keys.includes('dispatchPrompt')) expect(keys.sort()).toEqual(['dispatchPrompt', 'id']);
    }
  });

  it('leaves exactly the dispatch prompt out of the columns the hot reads select', () => {
    expect(Object.keys(MINING_ROW_COLUMNS).sort()).toEqual(
      Object.keys(getTableColumns(schema.taskStepAgentMinings))
        .filter((key) => key !== 'dispatchPrompt')
        .sort(),
    );
  });
});

/** Another pass took the first row: a fresh read sees it pending, while a read taken before
 *  still holds the row as it was, as a database snapshot would. */
const takenByAnotherPass = (state: MockState) => () => {
  state.miningRows = state.miningRows.map((r, i) => (i === 0 ? { ...r, status: 'pending' } : r));
};

/** Another pass took the first row and its run already finished: a fresh read sees it done. */
const finishedByAnotherPass = (state: MockState) => () => {
  state.miningRows = state.miningRows.map((r, i) =>
    i === 0
      ? {
          ...r,
          status: 'done',
          output: { fromTheOtherPass: true },
          errorMessage: null,
          cliInvocationId: 'inv-other-pass',
          userRetryRequestedAt: null,
        }
      : r,
  );
};

describe('a fan-out reserved before any agent is sent', () => {
  const miningLinks = (state: MockState) =>
    (state.miningUpdateLog ?? []).filter(
      (u) => u.set.status === 'pending' && u.set.cliInvocationId,
    );

  function runWith(
    db: Database,
    stepDef: StepDefinition,
    enqueue: (payload: CliExecJobPayload) => Promise<void>,
  ) {
    return advanceStep({
      db,
      taskId: 'task-1',
      userId: 'user-1',
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: 'prov-1',
      stepDef,
      providers: [makeProvider()],
      deps: { enqueueCliInvocation: enqueue },
    });
  }

  it('reserves every agent in one transaction before the first run is recorded', async () => {
    const state = freshState([miningRow('peer-reviewer', 1)]);
    const enqueued: CliExecJobPayload[] = [];
    await run(makeMockDb(state), waveStep([], ['refute-a', 'refute-b', 'refute-c']), enqueued);

    expect(state.transactions).toBe(1);
    expect(state.inserts.map((i) => i.table)).toEqual([
      'task_step_agent_minings',
      'task_step_agent_minings',
      'task_step_agent_minings',
      'cli_invocations',
      'cli_invocations',
      'cli_invocations',
    ]);
    const reserved = state.inserts.filter((i) => i.table === 'task_step_agent_minings');
    expect(
      reserved.map((i) => [i.row.status, i.row.cliInvocationId, i.row.dispatchPrompt]),
    ).toEqual([
      ['pending', undefined, 'refute refute-a'],
      ['pending', undefined, 'refute refute-b'],
      ['pending', undefined, 'refute refute-c'],
    ]);
    // Each is linked by a swap on the reserved state: its own id, still pending, still unlinked.
    const links = miningLinks(state);
    expect(links).toHaveLength(3);
    reserved.forEach((row, i) => {
      expect(conditionValues(links[i]!.where)).toEqual(
        expect.arrayContaining([row.row.id, 'pending']),
      );
    });
    expect(enqueued.map((e) => e.agentMiningId)).toEqual(reserved.map((r) => r.row.id));
  });

  it('reserves a wave larger than one statement in chunks, inside the one transaction', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `refute-${i}`);
    const state = freshState([miningRow('peer-reviewer', 1)]);
    const enqueued: CliExecJobPayload[] = [];
    await run(makeMockDb(state), waveStep([], ids), enqueued);

    expect(state.transactions).toBe(1);
    expect(state.miningInsertStatements).toBe(2);
    expect(enqueued).toHaveLength(51);
  });

  it('fails what it reserved or linked and did not queue when a dispatch throws', async () => {
    const state = freshState([miningRow('peer-reviewer', 1)]);
    let calls = 0;
    const outcome = await runWith(
      makeMockDb(state),
      waveStep([], ['refute-a', 'refute-b', 'refute-c']),
      async () => {
        calls += 1;
        if (calls === 2) throw new Error('redis refused the job');
      },
    ).catch((err: unknown) => err);

    const reserved = state.inserts
      .filter((i) => i.table === 'task_step_agent_minings')
      .map((i) => String(i.row.id));
    const [sentId, linkedId, untouchedId] = reserved;
    const failed = (id: string) =>
      writesTo(state, id).filter(
        (u) => u.set.status === 'failed' && String(u.set.errorMessage).includes('redis refused'),
      );
    // The first went out and is left alone; the second was linked and never queued; the third was
    // never reached. Neither of the last two may stay pending on a run nothing will start.
    expect(failed(sentId!)).toEqual([]);
    expect(failed(linkedId!)).toHaveLength(1);
    expect(failed(untouchedId!)).toHaveLength(1);
    const ended = state.updates.filter(
      (u) => u.table === 'cli_invocations' && String(u.errorMessage).includes('redis refused'),
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]!.endedAt).toBeInstanceOf(Date);
    // The dispatch's own error is what reaches the step.
    const message =
      outcome instanceof Error ? outcome.message : String((outcome as { error?: unknown }).error);
    expect(message).toContain('redis refused');
  });

  it('releases every reservation when the work after reserving throws before the first send', async () => {
    const state = freshState([miningRow('peer-reviewer', 1)]);
    // The step's learned budget is read after the reservation and before anything is sent.
    state.failSelect = (projection) =>
      !!projection && typeof projection === 'object' && 'learnedMs' in projection;
    await run(makeMockDb(state), waveStep([], ['refute-a', 'refute-b']), []).catch(() => undefined);

    const reserved = state.inserts
      .filter((i) => i.table === 'task_step_agent_minings')
      .map((i) => String(i.row.id));
    expect(reserved).toHaveLength(2);
    for (const id of reserved) {
      expect(writesTo(state, id).map((u) => u.set.status)).toEqual(['failed']);
    }
  });

  it('releases the agent it was working on when that agent throws before it is linked', async () => {
    const state = freshState([miningRow('peer-reviewer', 1)]);
    const db = makeMockDb(state) as unknown as { query: Record<string, unknown> };
    db.query.userStepCliPreferences = {
      findFirst: async () => {
        throw new Error('preferences unreadable');
      },
    };
    await run(db as unknown as Database, waveStep([], ['refute-a']), []).catch(() => undefined);

    const [reserved] = state.inserts.filter((i) => i.table === 'task_step_agent_minings');
    expect(writesTo(state, String(reserved!.row.id)).map((u) => u.set.status)).toEqual(['failed']);
  });

  it('sends a reserved agent its step still offers as the step offers it, personas included', async () => {
    const state = freshState([
      miningRow('refute-a', 1, {
        status: 'pending',
        cliInvocationId: null,
        dispatchPrompt: 'the prompt recorded at reservation',
      }),
    ]);
    const step = waveStep([], []);
    step.agentMining!.selectAgents = async () => [
      {
        agentId: 'refute-a',
        agentTitle: 'refute-a',
        prompt: 'the prompt the step offers now',
        personaIds: ['security-auditor'],
      },
    ];
    const enqueued: CliExecJobPayload[] = [];
    await run(makeMockDb(state), step, enqueued);

    const spec = enqueued[0]?.spec as { assignedAgentIds?: string[] } | undefined;
    expect(spec?.assignedAgentIds).toContain('security-auditor');
    const sent = state.inserts.find((i) => i.table === 'cli_invocations');
    expect(String(sent?.row.prompt)).toContain('the prompt the step offers now');
  });

  it('sends an agent a fan-out reserved and never sent, from its recorded prompt, uncharged', async () => {
    const state = freshState([
      miningRow('refute-a', 2, {
        status: 'pending',
        cliInvocationId: null,
        dispatchPrompt: 'refute refute-a',
      }),
    ]);
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), waveStep([], []), enqueued);

    expect(result.status).toBe('waiting_cli');
    expect(enqueued.map((e) => e.agentMiningId)).toEqual(['mining-refute-a']);
    const [link] = miningLinks(state);
    expect(link?.set.attempts).toBe(2);
    expect(conditionValues(link!.where)).toEqual(
      expect.arrayContaining(['mining-refute-a', 'pending']),
    );
    const sent = state.inserts.find((i) => i.table === 'cli_invocations');
    expect(String(sent?.row.prompt)).toContain('refute refute-a');
  });

  it('fails a reserved agent whose prompt is no longer recorded, rather than waiting on it', async () => {
    const state = freshState([
      miningRow('refute-a', 1, { status: 'pending', cliInvocationId: null, dispatchPrompt: null }),
    ]);
    const enqueued: CliExecJobPayload[] = [];
    await run(makeMockDb(state), waveStep([], []), enqueued);

    expect(enqueued).toEqual([]);
    expect(writesTo(state, 'mining-refute-a').map((u) => u.set.status)).toEqual(['failed']);
  });

  it('does not send an agent another pass took, and leaves the run it replaced to that pass', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1, {
        status: 'failed',
        errorMessage: 'API Error: Connection closed mid-response. The response may be incomplete.',
      }),
      miningRow('security-code-reviewer', 1),
    ]);
    state.miningCasLost = (set) => set.status === 'pending';
    state.onMiningCasLost = takenByAnotherPass(state);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), terminalFailureRetryStep(applyCalls), enqueued);

    expect(enqueued).toEqual([]);
    // Only this pass's own new run is superseded; the prior one is the winner's to replace.
    expect(
      state.updates.filter((u) => u.table === 'cli_invocations' && u.supersededAt),
    ).toHaveLength(1);
    // The agent is in flight on the other pass, so this one parks rather than settling.
    expect(result.status).toBe('waiting_cli');
    expect(applyCalls).toEqual([]);
  });

  it('parks on a wave another pass already sent, instead of settling without it', async () => {
    const state = freshState([miningRow('peer-reviewer', 1)]);
    state.miningInsertConflicts = true;
    const applyCalls: StepApplyArgs[] = [];
    const step = waveStep(applyCalls, ['refute-a']);
    const apply = step.apply;
    step.apply = async (ctx, args) => {
      // The other pass reserved and sent the wave while this one was applying.
      state.miningRows.push(miningRow('refute-a', 1, { status: 'pending' }));
      return apply(ctx, args);
    };
    const result = await run(makeMockDb(state), step, []);

    expect(result.status).toBe('waiting_cli');
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.miningWaveExhausted).not.toBe(true);
  });

  it('parks when another pass took the agents its unreadable output asked to re-roll', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1),
      miningRow('security-code-reviewer', 1),
    ]);
    state.miningCasLost = (set) => set.status === 'pending';
    state.onMiningCasLost = takenByAnotherPass(state);
    const applyCalls: StepApplyArgs[] = [];
    const result = await run(makeMockDb(state), miningStep(['peer-reviewer'], applyCalls), []);

    expect(result.status).toBe('waiting_cli');
    expect(applyCalls).toHaveLength(1);
  });

  it('parks when another pass took the agent a person asked to re-run', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1, {
        status: 'failed',
        errorMessage: 'CLI process exceeded its time budget (30m).',
        userRetryRequestedAt: new Date(),
      }),
    ]);
    state.miningCasLost = (set) => set.status === 'pending';
    state.onMiningCasLost = takenByAnotherPass(state);
    const applyCalls: StepApplyArgs[] = [];
    const result = await run(makeMockDb(state), noRetryMiningStep(applyCalls), []);

    expect(result.status).toBe('waiting_cli');
    expect(applyCalls).toEqual([]);
  });

  it('settles on the result another pass already finished, not on the failure it read', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1, {
        status: 'failed',
        errorMessage: 'API Error: Connection closed mid-response. The response may be incomplete.',
      }),
      miningRow('security-code-reviewer', 1),
    ]);
    state.miningCasLost = (set) => set.status === 'pending';
    state.onMiningCasLost = finishedByAnotherPass(state);
    const applyCalls: StepApplyArgs[] = [];
    const enqueued: CliExecJobPayload[] = [];
    const result = await run(makeMockDb(state), terminalFailureRetryStep(applyCalls), enqueued);

    expect(enqueued).toEqual([]);
    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(1);
    expect(
      applyCalls[0]!.agentMiningResults?.find((r) => r.agentId === 'peer-reviewer'),
    ).toMatchObject({ status: 'done', output: { fromTheOtherPass: true } });
  });

  it('hands apply the re-run another pass finished, not the failure a person asked to redo', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1, {
        status: 'failed',
        errorMessage: 'CLI process exceeded its time budget (30m).',
        userRetryRequestedAt: new Date(),
      }),
    ]);
    state.miningCasLost = (set) => set.status === 'pending';
    state.onMiningCasLost = finishedByAnotherPass(state);
    const applyCalls: StepApplyArgs[] = [];
    const result = await run(makeMockDb(state), noRetryMiningStep(applyCalls), []);

    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.agentMiningResults).toEqual([
      expect.objectContaining({
        agentId: 'peer-reviewer',
        status: 'done',
        output: { fromTheOtherPass: true },
      }),
    ]);
  });

  it('re-runs apply on a re-roll another pass already finished, instead of degrading', async () => {
    const state = freshState([
      miningRow('peer-reviewer', 1),
      miningRow('security-code-reviewer', 1),
    ]);
    state.miningCasLost = (set) => set.status === 'pending';
    state.onMiningCasLost = finishedByAnotherPass(state);
    const applyCalls: StepApplyArgs[] = [];
    await run(makeMockDb(state), miningStep(['peer-reviewer'], applyCalls), []);

    // The pass after the lost re-roll reads the reply the other pass wrote, still on budget.
    const second = applyCalls[1]!;
    expect(second.isFinalMiningAttempt).toBe(false);
    expect(second.agentMiningResults?.find((r) => r.agentId === 'peer-reviewer')).toMatchObject({
      output: { fromTheOtherPass: true },
    });
  });

  it('folds a wave another pass already sent and finished, instead of settling without it', async () => {
    const state = freshState([miningRow('peer-reviewer', 1)]);
    state.miningInsertConflicts = true;
    const applyCalls: StepApplyArgs[] = [];
    const step = waveStep(applyCalls, ['refute-a']);
    const apply = step.apply;
    step.apply = async (ctx, args) => {
      // The other pass sent the wave, and its agent finished, while this one was applying.
      if (applyCalls.length === 0) {
        state.miningRows = [...state.miningRows, miningRow('refute-a', 1, { output: 'refuted' })];
      }
      return apply(ctx, args);
    };
    const result = await run(makeMockDb(state), step, []);

    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(2);
    expect(applyCalls[1]!.miningWaveExhausted).not.toBe(true);
    expect(applyCalls[1]!.agentMiningResults?.map((r) => r.agentId)).toContain('refute-a');
  });

  it('settles a first fan-out another pass reserved and finished, rather than failing it', async () => {
    const state = freshState([]);
    state.miningInsertConflicts = true;
    const applyCalls: StepApplyArgs[] = [];
    const step = noRetryMiningStep(applyCalls);
    const select = step.agentMining!.selectAgents;
    step.agentMining!.selectAgents = async (args) => {
      // The other pass reserved both agents after this one read none, and both finished.
      state.miningRows = [
        miningRow('peer-reviewer', 1, { output: 'reviewed' }),
        miningRow('security-code-reviewer', 1, { output: 'audited' }),
      ];
      return select(args);
    };
    const result = await run(makeMockDb(state), step, []);

    expect(result.status).toBe('done');
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0]!.agentMiningResults?.map((r) => r.output)).toEqual([
      'reviewed',
      'audited',
    ]);
  });

  it('leaves an orphan another pass already re-rolled to that pass', async () => {
    const stuck = () => {
      const state = freshState([
        miningRow('peer-reviewer', 1, { status: 'pending' }),
        miningRow('security-code-reviewer', 1),
      ]);
      state.invocationRows = [
        {
          id: 'inv-peer-reviewer',
          prompt: 'review',
          errorMessage: 'CLI invocation orphaned by a worker restart (worker exited mid-run)',
          endedAt: new Date(),
          exitCode: null,
        },
      ];
      return state;
    };
    // Its failure is written only while the row still points at the ended run, still in flight.
    const settled = stuck();
    await run(makeMockDb(settled), terminalFailureRetryStep([]), []);
    const [failure] = writesTo(settled, 'mining-peer-reviewer').filter(
      (u) => u.set.status === 'failed',
    );
    expect(conditionValues(failure!.where)).toEqual(
      expect.arrayContaining(['inv-peer-reviewer', 'pending', 'running']),
    );

    const raced = stuck();
    raced.miningCasLost = (set) => set.status === 'failed';
    const enqueued: CliExecJobPayload[] = [];
    await run(makeMockDb(raced), terminalFailureRetryStep([]), enqueued);
    expect(enqueued).toEqual([]);
  });
});
