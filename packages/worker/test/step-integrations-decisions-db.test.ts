import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, isUniqueViolation, schema, type Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
import type { ComposableStepEntry } from '@haive/shared/modularity';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { insertOwnedRun } from '../src/step-engine/step-ownership.js';
import {
  INTEGRATION_UNRESOLVED_REASON,
  insertStampedRun,
  resolveDispatchIntegrations,
  setComposableCatalog,
} from '../src/step-engine/step-integrations.js';
import {
  FORGE_READ,
  SIGNING_KEY,
  advisoryWaiters,
  deleteUsers,
  grantsOf,
  runValues,
  runsOf,
  seedProvider,
  seedStepRow,
  seedWorld,
  sleep,
} from './support/step-integrations-db.js';

const url = process.env.STEP_INTEGRATIONS_DECISIONS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/step_integrations_decisions_test'))
  throw new Error(
    'Use a dedicated step_integrations_decisions_test database for the decision tests',
  );

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
});

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: {
    get: async () => null,
    getFresh: async () => null,
    getNumber: async (_key: string, fallback = 0) => fallback,
    getBoolean: async (_key: string, fallback = false) => fallback,
  },
}));
vi.mock('../src/orchestrator/global-kb-context.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveGlobalKbContext: async () => ({
    digest: { entries: [], omitted: 0, scanSaturated: false },
    rules: [],
    refused: [],
    status: 'ok',
  }),
}));

import { advanceStep } from '../src/step-engine/step-runner.js';

const AGENTS = ['agent-a', 'agent-b', 'agent-c'];

describe.skipIf(!url)('the stamp transaction of a dispatch that carries integrations', () => {
  let db: Database;
  const users: string[] = [];
  const enqueued: CliExecJobPayload[] = [];
  let savedKey: string | undefined;
  let counter = 0;

  beforeAll(() => {
    db = createDatabase(url as string);
  });

  afterAll(async () => {
    await deleteUsers(db, users);
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(() => {
    savedKey = process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY = SIGNING_KEY;
    enqueued.length = 0;
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = savedKey;
  });

  async function world() {
    const w = await seedWorld(db);
    users.push(w.userId);
    return { ...w, claude: await seedProvider(db, w.userId, 'claude-code') };
  }

  const metadata = (id: string) => ({
    id,
    workflowType: 'workflow',
    index: 0,
    title: id,
    description: id,
    requiresCli: true,
  });

  const llmStep = (id: string): StepDefinition =>
    ({
      metadata: metadata(id),
      async detect() {
        return {};
      },
      llm: { requiredCapabilities: ['tool_use'], buildPrompt: () => 'Audit the repository.' },
      async apply() {
        return {};
      },
    }) as unknown as StepDefinition;

  const miningStep = (id: string): StepDefinition =>
    ({
      metadata: metadata(id),
      async detect() {
        return {};
      },
      agentMining: {
        requiredCapabilities: ['tool_use'],
        selectAgents: async () =>
          AGENTS.map((agentId) => ({ agentId, agentTitle: agentId, prompt: `Review ${agentId}.` })),
      },
      async apply() {
        return {};
      },
    }) as unknown as StepDefinition;

  function declare(stepId: string) {
    const entry: ComposableStepEntry = {
      stepId,
      label: stepId,
      group: 'g',
      dispatchesCli: true,
      requires: [],
      provides: [],
      integrations: [FORGE_READ],
    };
    setComposableCatalog(new Map([[stepId, entry]]));
  }

  const nextStepId = () => `module.fx.lost-${(counter += 1)}`;

  const loseAccount = (connectionId: string) =>
    db
      .delete(schema.integrationConnections)
      .where(eq(schema.integrationConnections.id, connectionId));

  /** Runs `dispatch` until it waits for the task lock, loses the account while it waits, then lets it go on. */
  async function loseAccountMidDispatch<T>(
    w: { taskId: string; connectionId: string },
    dispatch: () => Promise<T>,
  ): Promise<T> {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`task-integrations:${w.taskId}`}, 0))`,
      );
      held.resolve();
      await release.promise;
    });
    await held.promise;

    try {
      const pending = dispatch();
      for (let waited = 0; (await advisoryWaiters(db)) < 1; waited += 1) {
        if (waited > 300) throw new Error('the dispatch never reached the task lock');
        await sleep(100);
      }
      await loseAccount(w.connectionId);
      release.resolve();
      await holder;
      return await pending;
    } finally {
      release.resolve();
      await holder.catch(() => undefined);
    }
  }

  function advance(
    w: { userId: string; taskId: string; claude: CliProviderRecord },
    stepDef: StepDefinition,
  ) {
    return advanceStep({
      db,
      taskId: w.taskId,
      userId: w.userId,
      repoPath: '/tmp',
      workspacePath: '/tmp',
      cliProviderId: w.claude.id,
      stepDef,
      providers: [w.claude],
      deps: { enqueueCliInvocation: async (payload) => void enqueued.push(payload) },
      runSeq: 0,
      epoch: 0,
      moduleDeactivation: null,
    });
  }

  async function expectNothingWritten(taskId: string) {
    expect(await runsOf(db, taskId), 'cli_invocations rows').toEqual([]);
    expect(await grantsOf(db, taskId), 'task grants').toEqual([]);
    expect(enqueued, 'enqueues').toEqual([]);
  }

  const stepRow = async (taskId: string) => {
    const [row] = await db
      .select()
      .from(schema.taskSteps)
      .where(eq(schema.taskSteps.taskId, taskId));
    return row!;
  };

  it('[Decision 1] insertStampedRun writes nothing and names the requirement once the account is gone', async () => {
    const w = await world();
    const step = await seedStepRow(db, w.taskId);
    expect(await resolveDispatchIntegrations(db, w.taskId, [FORGE_READ])).toMatchObject({
      ok: true,
    });
    await loseAccount(w.connectionId);

    const result = await insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [
      FORGE_READ,
    ]);

    expect(result, 'the run was stamped without its required requirement').toHaveProperty(
      'failure',
    );
    const failure = (result as { failure: string }).failure;
    expect(failure.startsWith(`${INTEGRATION_UNRESOLVED_REASON}: ${FORGE_READ.id} (forge): `)).toBe(
      true,
    );
    expect(failure).toMatch(/no[- ]connection/);
    await expectNothingWritten(w.taskId);
  }, 60_000);

  it('a dispatch that loses the live-run race writes no grant and fails as a unique violation', async () => {
    const w = await world();
    const step = await seedStepRow(db, w.taskId);
    await insertOwnedRun(db, step.id, runValues(w.taskId, step.id));

    const err = await insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [
      FORGE_READ,
    ]).then(
      () => null,
      (error: unknown) => error,
    );

    expect(isUniqueViolation(err), 'the loser was not refused by the live-run index').toBe(true);
    expect(await grantsOf(db, w.taskId)).toEqual([]);
    expect(await runsOf(db, w.taskId)).toHaveLength(1);
  }, 60_000);

  it('[Decision 1] an llm step fails with the same text when the account is lost after its early resolution', async () => {
    const w = await world();
    const stepId = nextStepId();
    declare(stepId);

    const result = await loseAccountMidDispatch(w, () => advance(w, llmStep(stepId)));

    expect(result.status).toBe('failed');
    const row = await stepRow(w.taskId);
    expect(row.status).toBe('failed');
    expect(
      row.errorMessage?.startsWith(`${INTEGRATION_UNRESOLVED_REASON}: ${FORGE_READ.id} `),
    ).toBe(true);
    await expectNothingWritten(w.taskId);
  }, 60_000);

  it('[Decision 1] a fan-out refuses every target with that text when the account is lost after its early resolution', async () => {
    const w = await world();
    const stepId = nextStepId();
    declare(stepId);

    const result = await loseAccountMidDispatch(w, () => advance(w, miningStep(stepId)));

    expect(result.status).toBe('failed');
    const row = await stepRow(w.taskId);
    expect(
      row.errorMessage?.startsWith(
        `agent mining dispatched no agents: ${INTEGRATION_UNRESOLVED_REASON}: ${FORGE_READ.id} `,
      ),
    ).toBe(true);
    const rows = await db
      .select()
      .from(schema.taskStepAgentMinings)
      .where(eq(schema.taskStepAgentMinings.taskStepId, row.id));
    expect(rows).toHaveLength(AGENTS.length);
    for (const mining of rows) {
      expect(mining.status).toBe('failed');
      expect(mining.errorMessage?.startsWith(`${INTEGRATION_UNRESOLVED_REASON}: `)).toBe(true);
    }
    await expectNothingWritten(w.taskId);
  }, 60_000);
});
