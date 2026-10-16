import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
import type { ComposableStepEntry, IntegrationRequirement } from '@haive/shared/modularity';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import type { IntegrationBinding } from '@haive/shared/integrations';
import type { DispatchRequest } from '../src/orchestrator/dispatcher.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { realStepIntegrations } from './support/step-integrations-contract.js';
import {
  ACCOUNT_LABEL,
  FORGE_OPTIONAL,
  FORGE_READ,
  PINNED_GITHUB,
  SIGNING_KEY,
  deleteUsers,
  grantsOf,
  runsOf,
  seedBareWorld,
  seedProvider,
  seedStepRow,
  seedTask,
  seedWorld,
  sleep,
  stampIsSqlNull,
} from './support/step-integrations-db.js';

const url = process.env.STEP_INTEGRATIONS_DISPATCH_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/step_integrations_dispatch_test'))
  throw new Error(
    'Use a dedicated step_integrations_dispatch_test database for the dispatch tests',
  );

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
  return {
    resolveCalls: [] as unknown[][],
    stampCalls: [] as unknown[][],
    requests: [] as unknown[],
  };
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
vi.mock('../src/orchestrator/dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orchestrator/dispatcher.js')>();
  return {
    ...actual,
    resolveTaskDispatch: (...args: Parameters<typeof actual.resolveTaskDispatch>) => {
      h.requests.push(args[2]);
      return actual.resolveTaskDispatch(...args);
    },
  };
});
vi.mock('../src/step-engine/step-integrations.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, (...args: unknown[]) => unknown>>();
  return {
    ...actual,
    resolveDispatchIntegrations: (...args: unknown[]) => {
      h.resolveCalls.push(args);
      return actual.resolveDispatchIntegrations!(...args);
    },
    insertStampedRun: (...args: unknown[]) => {
      h.stampCalls.push(args);
      return actual.insertStampedRun!(...args);
    },
  };
});

import { advanceStep } from '../src/step-engine/step-runner.js';

const AMP_MCP_FAILURE = 'this step needs MCP servers and no enabled CLI provider can host them';
const AGENTS = ['agent-a', 'agent-b', 'agent-c'];
const ISSUES_REQUIRED: IntegrationRequirement = {
  id: 'tracker',
  category: 'issues',
  access: 'read',
};

type LlmSpec = NonNullable<StepDefinition['llm']>;
type MiningSpec = NonNullable<StepDefinition['agentMining']>;

describe.skipIf(!url)(
  'a step that declares integrations is dispatched with them, on Postgres',
  () => {
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
      h.resolveCalls.length = 0;
      h.stampCalls.length = 0;
      h.requests.length = 0;
    });

    afterEach(() => {
      if (savedKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
      else process.env.CONFIG_ENCRYPTION_KEY = savedKey;
    });

    const metadata = (id: string) => ({
      id,
      workflowType: 'workflow',
      index: 0,
      title: id,
      description: id,
      requiresCli: true,
    });

    const llmStep = (id: string, llm: Partial<LlmSpec> = {}): StepDefinition =>
      ({
        metadata: metadata(id),
        async detect() {
          return {};
        },
        llm: {
          requiredCapabilities: ['tool_use'],
          buildPrompt: () => 'Audit the repository.',
          ...llm,
        },
        async apply(_ctx: unknown, args: { llmOutput?: unknown }) {
          return { llmOutput: args.llmOutput };
        },
      }) as unknown as StepDefinition;

    const miningStep = (id: string, mining: Partial<MiningSpec> = {}): StepDefinition =>
      ({
        metadata: metadata(id),
        async detect() {
          return {};
        },
        agentMining: {
          requiredCapabilities: ['tool_use'],
          selectAgents: async () =>
            AGENTS.map((agentId) => ({
              agentId,
              agentTitle: agentId,
              prompt: `Review ${agentId}.`,
            })),
          ...mining,
        },
        async apply() {
          return {};
        },
      }) as unknown as StepDefinition;

    const nextStepId = () => `module.fx.audit-${(counter += 1)}`;

    const entryOf = (
      stepId: string,
      integrations: IntegrationRequirement[],
    ): ComposableStepEntry => ({
      stepId,
      label: stepId,
      group: 'g',
      dispatchesCli: true,
      requires: [],
      provides: [],
      integrations,
    });

    async function declare(
      stepId: string,
      integrations: IntegrationRequirement[],
      also: Record<string, IntegrationRequirement[]> = {},
    ) {
      const mod = await realStepIntegrations();
      const all = { [stepId]: integrations, ...also };
      mod.setComposableCatalog(
        new Map(Object.entries(all).map(([id, list]) => [id, entryOf(id, list)])),
      );
      return mod;
    }

    async function world(connected = true) {
      const w = connected
        ? await seedWorld(db)
        : { ...(await seedBareWorld(db)), connectionId: null };
      users.push(w.userId);
      const claude = await seedProvider(db, w.userId, 'claude-code');
      return { ...w, claude };
    }

    function advance(
      w: { userId: string; taskId: string },
      stepDef: StepDefinition,
      providers: CliProviderRecord[],
      preferred: CliProviderRecord | null = providers[0] ?? null,
    ) {
      return advanceStep({
        db,
        taskId: w.taskId,
        userId: w.userId,
        repoPath: '/tmp',
        workspacePath: '/tmp',
        cliProviderId: preferred?.id ?? null,
        stepDef,
        providers,
        deps: { enqueueCliInvocation: async (payload) => void enqueued.push(payload) },
        runSeq: 0,
        epoch: 0,
        moduleDeactivation: null,
      });
    }

    const requestsOf = () =>
      h.requests as (DispatchRequest & { integrations?: IntegrationBinding[] })[];
    const miningRows = (taskStepId: string) =>
      db
        .select()
        .from(schema.taskStepAgentMinings)
        .where(eq(schema.taskStepAgentMinings.taskStepId, taskStepId));
    const stepRow = async (taskId: string) => {
      const [row] = await db
        .select()
        .from(schema.taskSteps)
        .where(eq(schema.taskSteps.taskId, taskId));
      return row!;
    };

    /** The same world refuses a required requirement, so a test that lets an optional one go shows the two are told apart. */
    async function expectRequiredStillFails(
      w: { userId: string; repositoryId: string; claude: CliProviderRecord },
      stepId: string,
    ) {
      const task = await seedTask(db, w.userId, w.repositoryId);
      const result = await advance(
        { userId: w.userId, taskId: task },
        llmStep(`${stepId}-required`),
        [w.claude],
      );
      expect(result.status, 'a required requirement that does not resolve was let through').toBe(
        'failed',
      );
    }

    async function expectNothingWritten(taskId: string) {
      expect(await runsOf(db, taskId), 'cli_invocations rows').toEqual([]);
      expect(await grantsOf(db, taskId), 'task grants').toEqual([]);
      expect(enqueued, 'enqueues').toEqual([]);
    }

    describe('[D0] a step that declares nothing keeps its dispatch (passes before and after)', () => {
      it('[D0] an llm step parks on one queued run with no stamp and no grant', async () => {
        const w = await world();
        const stepId = nextStepId();

        const result = await advance(w, llmStep(stepId), [w.claude]);

        expect(result.status).toBe('waiting_cli');
        const runs = await runsOf(db, w.taskId);
        expect(runs).toHaveLength(1);
        expect(await stampIsSqlNull(db, runs[0]!.id)).toBe(true);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]).toMatchObject({
          invocationId: runs[0]!.id,
          cliProviderId: w.claude.id,
        });
        expect(await grantsOf(db, w.taskId)).toEqual([]);
      }, 60_000);

      it('[D0] a fan-out sends one unstamped run per agent', async () => {
        const w = await world();
        const stepId = nextStepId();

        const result = await advance(w, miningStep(stepId), [w.claude]);

        expect(result.status).toBe('waiting_cli');
        const runs = await runsOf(db, w.taskId);
        expect(runs.map((run) => run.mode)).toEqual(AGENTS.map(() => 'agent_mining'));
        for (const run of runs) expect(await stampIsSqlNull(db, run.id)).toBe(true);
        expect(enqueued).toHaveLength(AGENTS.length);
        expect(await miningRows((await stepRow(w.taskId)).id)).toHaveLength(AGENTS.length);
      }, 60_000);

      it.each([
        ['an llm step', (id: string) => llmStep(id), 1],
        ['a fan-out', (id: string) => miningStep(id), AGENTS.length],
      ] as const)(
        '[D0+] %s that declares nothing is not held up by the integrations lock of its task',
        async (_label, stepOf, runCount) => {
          const w = await world();
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
            const result = await Promise.race([
              advance(w, stepOf(nextStepId()), [w.claude]),
              sleep(5000).then(() => null),
            ]);

            expect(result?.status, 'the dispatch waited for the lock').toBe('waiting_cli');
            expect(await runsOf(db, w.taskId)).toHaveLength(runCount);
          } finally {
            release.resolve();
            await holder;
          }
        },
        60_000,
      );

      it('[D0] an llm step fails with the dispatcher reason when no provider takes it', async () => {
        const w = await world();
        const stepId = nextStepId();

        const result = await advance(w, llmStep(stepId), []);

        expect(result.status).toBe('failed');
        expect((await stepRow(w.taskId)).errorMessage).toBe(
          'no cli provider available: no enabled cli providers',
        );
        await expectNothingWritten(w.taskId);
      }, 60_000);

      it('[D0] a fan-out refuses every target with the dispatcher reason when no provider takes it', async () => {
        const w = await world();
        const stepId = nextStepId();

        const result = await advance(w, miningStep(stepId), []);

        expect(result.status).toBe('failed');
        const row = await stepRow(w.taskId);
        expect(row.errorMessage).toBe(
          'agent mining dispatched no agents: no cli provider available: no enabled cli providers',
        );
        const rows = await miningRows(row.id);
        expect(rows.map((mining) => mining.status)).toEqual(AGENTS.map(() => 'failed'));
        await expectNothingWritten(w.taskId);
      }, 60_000);
    });

    describe('[D3] an llm step with a requirement that resolves', () => {
      it('[D3] queues one run stamped with the bindings, records the grant, and tells the agent what it has', async () => {
        const w = await world();
        const stepId = nextStepId();
        await declare(stepId, [FORGE_READ]);

        const result = await advance(w, llmStep(stepId), [w.claude]);

        expect(result.status).toBe('waiting_cli');
        const expected = [
          {
            requirementId: FORGE_READ.id,
            categoryId: 'forge',
            providerId: 'github',
            connectionId: w.connectionId,
            access: 'read',
          },
        ];
        const runs = await runsOf(db, w.taskId);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.integrations).toEqual(expected);
        expect(await grantsOf(db, w.taskId)).toEqual([
          { categoryId: 'forge', connectionId: w.connectionId },
        ]);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0]).toMatchObject({ invocationId: runs[0]!.id });
        expect(requestsOf()).toHaveLength(1);
        expect(requestsOf()[0]!.integrations).toEqual(expected);
        expect(runs[0]!.prompt).toContain('GitHub');
        expect(runs[0]!.prompt).toContain('get_pull_request_state');
        expect(runs[0]!.prompt).not.toContain('open_pull_request');
        expect(runs[0]!.prompt).not.toContain(ACCOUNT_LABEL);
      }, 60_000);

      it('[D3+] resolves the requirements once for the dispatch', async () => {
        const w = await world();
        const stepId = nextStepId();
        await declare(stepId, [FORGE_READ]);

        await advance(w, llmStep(stepId), [w.claude]);

        expect(h.resolveCalls).toHaveLength(1);
        expect(h.resolveCalls[0]![1]).toBe(w.taskId);
        expect(h.resolveCalls[0]![2]).toEqual([FORGE_READ]);
      }, 60_000);
    });

    describe('[D4] a requirement that does not resolve', () => {
      it('[D4] fails the step naming the requirement, its category and why, and writes nothing', async () => {
        const w = await world(false);
        const stepId = nextStepId();
        const mod = await declare(stepId, [FORGE_READ]);

        const result = await advance(w, llmStep(stepId), [w.claude]);

        expect(result.status).toBe('failed');
        const row = await stepRow(w.taskId);
        expect(row.status).toBe('failed');
        expect(row.errorMessage?.startsWith(`${mod.INTEGRATION_UNRESOLVED_REASON}: `)).toBe(true);
        expect(row.errorMessage).toContain(FORGE_READ.id);
        expect(row.errorMessage).toContain('forge');
        expect(row.errorMessage).toMatch(/no[- ]connection/);
        await expectNothingWritten(w.taskId);
      }, 60_000);

      it('[D4+] fails an optional llm step too, since the integrations are not the llm', async () => {
        const w = await world(false);
        const stepId = nextStepId();
        await declare(stepId, [FORGE_READ]);

        const result = await advance(w, llmStep(stepId, { optional: true }), [w.claude]);

        expect(result.status).toBe('failed');
        await expectNothingWritten(w.taskId);
      }, 60_000);

      it('[D4] goes on without a requirement marked optional, and stamps nothing', async () => {
        const w = await world(false);
        const stepId = nextStepId();
        await declare(stepId, [FORGE_OPTIONAL], { [`${stepId}-required`]: [FORGE_READ] });

        const result = await advance(w, llmStep(stepId), [w.claude]);

        expect(result.status).toBe('waiting_cli');
        const runs = await runsOf(db, w.taskId);
        expect(runs).toHaveLength(1);
        expect(await stampIsSqlNull(db, runs[0]!.id)).toBe(true);
        expect(await grantsOf(db, w.taskId)).toEqual([]);
        expect(enqueued).toHaveLength(1);
        expect(requestsOf()[0]!.integrations ?? []).toEqual([]);
        await expectRequiredStillFails(w, stepId);
      }, 60_000);

      it('[D4] names the requirement that failed when another one resolved', async () => {
        const w = await world();
        const stepId = nextStepId();
        await declare(stepId, [FORGE_READ, ISSUES_REQUIRED]);

        const result = await advance(w, llmStep(stepId), [w.claude]);

        expect(result.status).toBe('failed');
        const row = await stepRow(w.taskId);
        expect(row.errorMessage).toContain('tracker');
        await expectNothingWritten(w.taskId);
      }, 60_000);
    });

    describe('[D5] a requirement that pins a provider', () => {
      it('[D5] is refused with its own reason, though an account would resolve it, and writes nothing', async () => {
        const w = await world();
        const stepId = nextStepId();
        const mod = await declare(stepId, [PINNED_GITHUB]);

        const result = await advance(w, llmStep(stepId), [w.claude]);

        expect(result.status).toBe('failed');
        const row = await stepRow(w.taskId);
        expect(row.errorMessage?.startsWith(`${mod.INTEGRATION_PROVIDER_PINNED_REASON}: `)).toBe(
          true,
        );
        await expectNothingWritten(w.taskId);
      }, 60_000);
    });

    describe('[D13] a dispatch that cannot be given its bindings', () => {
      it('[D13] fails with the signing-key reason when CONFIG_ENCRYPTION_KEY is not set', async () => {
        const w = await world();
        const stepId = nextStepId();
        const mod = await declare(stepId, [FORGE_READ]);
        delete process.env.CONFIG_ENCRYPTION_KEY;

        const result = await advance(w, llmStep(stepId), [w.claude]);

        expect(result.status).toBe('failed');
        const row = await stepRow(w.taskId);
        expect(row.errorMessage?.startsWith(`${mod.INTEGRATIONS_NO_SIGNING_KEY_REASON}: `)).toBe(
          true,
        );
        await expectNothingWritten(w.taskId);
      }, 60_000);

      it('[D13] fails with the unlistable reason when the tool names break the grammar', async () => {
        const w = await world();
        const stepId = nextStepId();
        const mod = await declare(stepId, [
          { id: '1st-forge', category: 'forge', access: 'read' },
          { id: '2nd-forge', category: 'forge', access: 'read' },
        ]);

        const result = await advance(w, llmStep(stepId), [w.claude]);

        expect(result.status).toBe('failed');
        const row = await stepRow(w.taskId);
        expect(row.errorMessage?.startsWith(`${mod.INTEGRATION_TOOLS_UNLISTABLE_REASON}: `)).toBe(
          true,
        );
        await expectNothingWritten(w.taskId);
      }, 60_000);
    });

    describe('[D6] a fan-out of agents', () => {
      it('[D6] resolves once for all of them and stamps every row alike', async () => {
        const w = await world();
        const stepId = nextStepId();
        await declare(stepId, [FORGE_READ]);

        const result = await advance(w, miningStep(stepId), [w.claude]);

        expect(result.status).toBe('waiting_cli');
        expect(h.resolveCalls, 'resolutions for 3 agents').toHaveLength(1);
        const expected = [
          {
            requirementId: FORGE_READ.id,
            categoryId: 'forge',
            providerId: 'github',
            connectionId: w.connectionId,
            access: 'read',
          },
        ];
        const runs = await runsOf(db, w.taskId);
        expect(runs).toHaveLength(AGENTS.length);
        for (const run of runs) {
          expect(run.mode).toBe('agent_mining');
          expect(run.integrations).toEqual(expected);
        }
        expect(await grantsOf(db, w.taskId)).toEqual([
          { categoryId: 'forge', connectionId: w.connectionId },
        ]);
        expect(enqueued).toHaveLength(AGENTS.length);
        for (const request of requestsOf()) expect(request.integrations).toEqual(expected);
      }, 60_000);

      it('[D6] refuses every target with the named reason, and fails the step with it', async () => {
        const w = await world(false);
        const stepId = nextStepId();
        const mod = await declare(stepId, [FORGE_READ]);

        const result = await advance(w, miningStep(stepId), [w.claude]);

        expect(result.status).toBe('failed');
        expect(h.resolveCalls, 'resolutions for 3 agents').toHaveLength(1);
        const row = await stepRow(w.taskId);
        expect(
          row.errorMessage?.startsWith(
            `agent mining dispatched no agents: ${mod.INTEGRATION_UNRESOLVED_REASON}: `,
          ),
        ).toBe(true);
        const rows = await miningRows(row.id);
        expect(rows).toHaveLength(AGENTS.length);
        for (const mining of rows) {
          expect(mining.status).toBe('failed');
          expect(mining.errorMessage?.startsWith(`${mod.INTEGRATION_UNRESOLVED_REASON}: `)).toBe(
            true,
          );
        }
        await expectNothingWritten(w.taskId);
      }, 60_000);

      it('[D6] refuses a pinned requirement for every target with its own reason', async () => {
        const w = await world();
        const stepId = nextStepId();
        const mod = await declare(stepId, [PINNED_GITHUB]);

        const result = await advance(w, miningStep(stepId), [w.claude]);

        expect(result.status).toBe('failed');
        const row = await stepRow(w.taskId);
        expect(
          row.errorMessage?.startsWith(
            `agent mining dispatched no agents: ${mod.INTEGRATION_PROVIDER_PINNED_REASON}: `,
          ),
        ).toBe(true);
        await expectNothingWritten(w.taskId);
      }, 60_000);

      it('[D6] sends every agent unstamped when the only requirement is optional and unresolved', async () => {
        const w = await world(false);
        const stepId = nextStepId();
        await declare(stepId, [FORGE_OPTIONAL], { [`${stepId}-required`]: [FORGE_READ] });

        const result = await advance(w, miningStep(stepId), [w.claude]);

        expect(result.status).toBe('waiting_cli');
        const runs = await runsOf(db, w.taskId);
        expect(runs).toHaveLength(AGENTS.length);
        for (const run of runs) expect(await stampIsSqlNull(db, run.id)).toBe(true);
        expect(enqueued).toHaveLength(AGENTS.length);
        expect(await grantsOf(db, w.taskId)).toEqual([]);
        await expectRequiredStillFails(w, stepId);
      }, 60_000);
    });

    describe('[D7] dispatches that carry no integrations', () => {
      const declaredOrNot = [
        ['nothing declared, passes before and after', false],
        ['integrations declared', true],
      ] as const;

      /** Declares the step and a sibling that is dispatched in the ordinary way as a witness that the declaration is live. */
      const declareWithWitness = (stepId: string) =>
        declare(stepId, [FORGE_READ], { [`${stepId}-witness`]: [FORGE_READ] });

      async function expectWitnessStamped(w: Awaited<ReturnType<typeof world>>, stepId: string) {
        const task = await seedTask(db, w.userId, w.repositoryId);
        const result = await advance(
          { userId: w.userId, taskId: task },
          llmStep(`${stepId}-witness`),
          [w.claude],
        );
        expect(result.status).toBe('waiting_cli');
        const [run] = await runsOf(db, task);
        expect(
          run!.integrations,
          'the declaration is not live: the witness step was not stamped',
        ).toEqual([
          {
            requirementId: FORGE_READ.id,
            categoryId: 'forge',
            providerId: 'github',
            connectionId: w.connectionId,
            access: 'read',
          },
        ]);
      }

      async function expectUnstamped(taskId: string, runCount: number) {
        const runs = await runsOf(db, taskId);
        expect(runs).toHaveLength(runCount);
        for (const run of runs) expect(await stampIsSqlNull(db, run.id)).toBe(true);
        expect(await grantsOf(db, taskId)).toEqual([]);
        expect(h.resolveCalls).toEqual([]);
        expect(h.stampCalls).toEqual([]);
        for (const request of requestsOf()) expect(request.integrations ?? []).toEqual([]);
        return runs;
      }

      describe.each(['rag_only', 'none'] as const)(
        'an llm step with toolProfile %s',
        (toolProfile) => {
          it.each(declaredOrNot)(
            '[D7] resolves nothing and stamps nothing (%s)',
            async (_label, declared) => {
              const w = await world();
              const stepId = nextStepId();
              if (declared) await declareWithWitness(stepId);

              const result = await advance(w, llmStep(stepId, { toolProfile }), [w.claude]);

              expect(result.status).toBe('waiting_cli');
              await expectUnstamped(w.taskId, 1);
              expect(enqueued).toHaveLength(1);
              if (declared) await expectWitnessStamped(w, stepId);
            },
            60_000,
          );
        },
      );

      it.each(declaredOrNot)(
        '[D7] a mining fan-out with toolProfile rag_only resolves nothing and stamps nothing (%s)',
        async (_label, declared) => {
          const w = await world();
          const stepId = nextStepId();
          if (declared) await declareWithWitness(stepId);

          const result = await advance(w, miningStep(stepId, { toolProfile: 'rag_only' }), [
            w.claude,
          ]);

          expect(result.status).toBe('waiting_cli');
          await expectUnstamped(w.taskId, AGENTS.length);
          expect(enqueued).toHaveLength(AGENTS.length);
          if (declared) await expectWitnessStamped(w, stepId);
        },
        60_000,
      );

      it.each(declaredOrNot)(
        '[D7] the AI-fix agent of a step resolves nothing and stamps nothing (%s)',
        async (_label, declared) => {
          const w = await world();
          const stepId = nextStepId();
          if (declared) await declareWithWitness(stepId);
          await seedStepRow(db, w.taskId, {
            stepId,
            status: 'pending',
            aiFixContext: { priorError: 'the step failed once', priorOutput: 'its output' },
          });

          const result = await advance(w, llmStep(stepId), [w.claude]);

          expect(result.status).toBe('waiting_cli');
          const runs = await expectUnstamped(w.taskId, 1);
          expect(runs[0]!.prompt).toContain('A workflow step just failed');
          if (declared) await expectWitnessStamped(w, stepId);
        },
        60_000,
      );

      it.each(declaredOrNot)(
        '[D7] the recap of a finished step resolves nothing and is stamped NULL (%s)',
        async (_label, declared) => {
          const w = await world();
          const stepId = nextStepId();
          if (declared) await declareWithWitness(stepId);
          const step = llmStep(stepId);
          expect((await advance(w, step, [w.claude])).status).toBe('waiting_cli');
          const [run] = await runsOf(db, w.taskId);
          await db
            .update(schema.cliInvocations)
            .set({
              startedAt: new Date(),
              endedAt: new Date(),
              exitCode: 0,
              rawOutput: 'All good.',
            })
            .where(eq(schema.cliInvocations.id, run!.id));
          const resolvedBefore = h.resolveCalls.length;
          const grantsBefore = await grantsOf(db, w.taskId);

          expect((await advance(w, step, [w.claude])).status).toBe('done');

          const recaps = (await runsOf(db, w.taskId)).filter((r) => r.summaryForStepId !== null);
          expect(recaps).toHaveLength(1);
          expect(await stampIsSqlNull(db, recaps[0]!.id)).toBe(true);
          expect(h.resolveCalls).toHaveLength(resolvedBefore);
          expect(await grantsOf(db, w.taskId)).toEqual(grantsBefore);
          expect((enqueued.at(-1) as { purpose?: string }).purpose).toBe('step_summary');
          expect(requestsOf().at(-1)!.integrations ?? []).toEqual([]);
          if (declared) await expectWitnessStamped(w, stepId);
        },
        60_000,
      );

      it('[D7] a step that declares nothing resolves nothing though the catalog holds another declaration', async () => {
        const w = await world();
        const stepId = nextStepId();
        await declareWithWitness('module.fx.someone-else');

        const result = await advance(w, llmStep(stepId), [w.claude]);

        expect(result.status).toBe('waiting_cli');
        await expectUnstamped(w.taskId, 1);
        await expectWitnessStamped(w, 'module.fx.someone-else');
      }, 60_000);
    });

    describe('[D8] a stamped dispatch needs a provider that can host MCP servers', () => {
      it('[D8] goes to the next MCP-capable provider when amp is preferred', async () => {
        const w = await world();
        const amp = await seedProvider(db, w.userId, 'amp');
        const stepId = nextStepId();
        await declare(stepId, [FORGE_READ]);

        const result = await advance(w, llmStep(stepId), [amp, w.claude], amp);

        expect(result.status).toBe('waiting_cli');
        const runs = await runsOf(db, w.taskId);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.cliProviderId).toBe(w.claude.id);
        expect(enqueued[0]).toMatchObject({ cliProviderId: w.claude.id });
      }, 60_000);

      it('[D8] fails with the existing MCP reason, and writes nothing, when amp is the only provider', async () => {
        const w = await world();
        const amp = await seedProvider(db, w.userId, 'amp');
        const stepId = nextStepId();
        await declare(stepId, [FORGE_READ]);

        const result = await advance(w, llmStep(stepId), [amp], amp);

        expect(result.status).toBe('failed');
        const row = await stepRow(w.taskId);
        expect(row.errorMessage).toContain(AMP_MCP_FAILURE);
        await expectNothingWritten(w.taskId);
      }, 60_000);

      it('[D8] keeps amp for a step whose only requirement was dropped, since nothing needs MCP', async () => {
        const w = await world(false);
        const amp = await seedProvider(db, w.userId, 'amp');
        const stepId = nextStepId();
        const live = await world();
        const liveAmp = await seedProvider(db, live.userId, 'amp');
        await declare(stepId, [FORGE_OPTIONAL], { [`${stepId}-live`]: [FORGE_READ] });

        const result = await advance(w, llmStep(stepId), [amp, w.claude], amp);

        expect(result.status).toBe('waiting_cli');
        const runs = await runsOf(db, w.taskId);
        expect(runs[0]!.cliProviderId).toBe(amp.id);
        await advance(live, llmStep(`${stepId}-live`), [liveAmp, live.claude], liveAmp);
        const [stamped] = await runsOf(db, live.taskId);
        expect(stamped!.cliProviderId, 'a stamped dispatch kept amp').toBe(live.claude.id);
      }, 60_000);

      it('[D8] keeps amp for a step that declares nothing', async () => {
        const w = await world();
        const amp = await seedProvider(db, w.userId, 'amp');
        const stepId = nextStepId();

        const result = await advance(w, llmStep(stepId), [amp, w.claude], amp);

        expect(result.status).toBe('waiting_cli');
        const runs = await runsOf(db, w.taskId);
        expect(runs[0]!.cliProviderId).toBe(amp.id);
      }, 60_000);
    });
  },
);
