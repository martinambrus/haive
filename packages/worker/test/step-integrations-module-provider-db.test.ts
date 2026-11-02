import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { TASK_JOB_NAMES, type CliExecJobPayload } from '@haive/shared';
import {
  lockTaskIntegrations,
  registerModuleIntegrations,
  resolveStepIntegrations,
  type IntegrationBinding,
} from '@haive/shared/integrations';
import type { ComposableStepEntry, IntegrationRequirement } from '@haive/shared/modularity';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
import type { DispatchRequest } from '../src/orchestrator/dispatcher.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import {
  insertStampedRun,
  invalidRequirementsFailure,
  resolveDispatchIntegrations,
  setComposableCatalog,
} from '../src/step-engine/step-integrations.js';
import {
  FORGE_OPTIONAL,
  FORGE_READ,
  PINNED_GITHUB,
  SIGNING_KEY,
  bindingsOf,
  deleteUsers,
  grantsOf,
  runValues,
  runsOf,
  seedBareWorld,
  seedConnection,
  seedProvider,
  seedStepRow,
  seedWorld,
} from './support/step-integrations-db.js';

const url = process.env.STEP_INTEGRATIONS_MODULE_PROVIDER_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/step_integrations_module_provider_test'))
  throw new Error(
    'Use a dedicated step_integrations_module_provider_test database for the module provider tests',
  );

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
  return {
    requests: [] as unknown[],
    parkJobs: [] as { name: string; data: unknown; opts: { delay?: number } }[],
    db: undefined as unknown,
    beforeRequest: null as null | (() => Promise<void>),
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
    resolveTaskDispatch: async (...args: Parameters<typeof actual.resolveTaskDispatch>) => {
      h.requests.push(args[2]);
      await h.beforeRequest?.();
      return actual.resolveTaskDispatch(...args);
    },
  };
});

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}), getRedis: () => ({}) }));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    async add(name: string, data: unknown, opts: { delay?: number }) {
      h.parkJobs.push({ name, data, opts });
    }
  },
}));
vi.mock('../src/sandbox/task-auth-volume.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cleanupTaskAuthVolumes: async () => ({ removed: [], failed: [] }),
  syncRefreshedAuthToUserVolumes: async () => undefined,
}));
vi.mock('../src/sandbox/sandbox-kill.js', () => ({
  killCliSandboxesForTask: async () => undefined,
  listCliSandboxesForTask: async () => [],
}));
vi.mock('../src/project-state/set-aside.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resyncAfterTaskEnd: async () => undefined,
}));

import { pinnedPromptStep } from './support/prompt-step-integrations.js';
import {
  parkForIntegrations,
  processTaskJob,
  setContainerCleanupRunner,
} from '../src/queues/task-queue.js';
import { reviveDeadTasks } from '../src/queues/dead-task-boot.js';
import { stepRegistry } from '../src/step-engine/registry.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';
import { advanceStep } from '../src/step-engine/step-runner.js';

const MODULE_PROVIDER = 'module.fx.crm';
const MODULE_CATEGORY = 'module.fx.docs';
const MODULE_TOOL = 'docs_list';
const AGENTS = ['agent-a', 'agent-b', 'agent-c'];

const DOCS_REQUIRED: IntegrationRequirement = {
  id: 'docs',
  category: MODULE_CATEGORY,
  access: 'read',
};
const DOCS_OPTIONAL: IntegrationRequirement = { ...DOCS_REQUIRED, optional: true };
const CORE_DOCS_REQUIRED: IntegrationRequirement = { ...DOCS_REQUIRED, category: 'rich-documents' };
const CORE_DOCS_OPTIONAL: IntegrationRequirement = { ...CORE_DOCS_REQUIRED, optional: true };

type LoadedModule = Parameters<typeof registerModuleIntegrations>[0][number];

const fxModule = (categories: string[]): LoadedModule => ({
  manifest: {
    id: 'fx',
    name: 'Module fx',
    categories: [{ id: MODULE_CATEGORY, label: 'Documents of fx' }],
    integrations: [
      {
        id: MODULE_PROVIDER,
        displayName: 'Provider of fx',
        categories,
        selfHosted: false,
        auth: [
          {
            kind: 'token',
            form: { title: 'Token', fields: [{ id: 'token', type: 'text', label: 'Token' }] },
            help: 'Create a token in the account settings.',
          },
        ],
        operations: [
          {
            opId: MODULE_TOOL,
            description: 'List documents',
            inputSchema: { type: 'object', properties: {} },
            access: 'read',
          },
        ],
        apiHosts: ['api.fx.example'],
      },
    ],
  },
});

const DOCS_CATEGORIES = [MODULE_CATEGORY, 'rich-documents'];

type LlmSpec = NonNullable<StepDefinition['llm']>;
type MiningSpec = NonNullable<StepDefinition['agentMining']>;

describe.skipIf(!url)('a step whose requirement resolves to a module provider, on Postgres', () => {
  let db: Database;
  const users: string[] = [];
  const enqueued: CliExecJobPayload[] = [];
  let savedKey: string | undefined;
  let counter = 0;

  beforeAll(async () => {
    db = createDatabase(url as string);
    h.db = db;
    await db
      .insert(schema.modules)
      .values({
        moduleId: 'fx',
        packageName: '@haive/module-fx',
        name: 'Module fx',
        installedVersion: '1.0.0',
      })
      .onConflictDoNothing();
    await db
      .insert(schema.integrationProviderConfigs)
      .values({ providerId: MODULE_PROVIDER, enabled: true })
      .onConflictDoUpdate({
        target: schema.integrationProviderConfigs.providerId,
        set: { enabled: true },
      });
  });

  afterAll(async () => {
    setContainerCleanupRunner(null);
    await deleteUsers(db, users);
    await db
      .delete(schema.integrationProviderConfigs)
      .where(eq(schema.integrationProviderConfigs.providerId, MODULE_PROVIDER));
    await db.delete(schema.modules).where(eq(schema.modules.moduleId, 'fx'));
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    setContainerCleanupRunner(async () => 0);
    await db
      .update(schema.modules)
      .set({ deactivatedAt: null })
      .where(eq(schema.modules.moduleId, 'fx'));
    h.parkJobs.length = 0;
    h.beforeRequest = null;
    savedKey = process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY = SIGNING_KEY;
    enqueued.length = 0;
    h.requests.length = 0;
    registerModuleIntegrations([fxModule(DOCS_CATEGORIES)]);
  });

  afterEach(() => {
    registerModuleIntegrations([]);
    if (savedKey === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = savedKey;
  });

  async function seedModuleConnection(userId: string): Promise<string> {
    const [connection] = await db
      .insert(schema.integrationConnections)
      .values({
        providerId: MODULE_PROVIDER,
        scope: 'user',
        ownerUserId: userId,
        accountLabel: 'fx-account-5512',
        authMethod: 'token',
      })
      .returning({ id: schema.integrationConnections.id });
    return connection!.id;
  }

  /** A user whose only account is the module's, with a task and a CLI provider. */
  async function moduleWorld() {
    const w = await seedBareWorld(db);
    users.push(w.userId);
    return {
      ...w,
      moduleConnectionId: await seedModuleConnection(w.userId),
      claude: await seedProvider(db, w.userId, 'claude-code'),
    };
  }

  /** The module's account beside a GitHub one, so the forge requirement resolves and the docs one resolves to the module. */
  async function mixedWorld() {
    const w = await seedWorld(db);
    users.push(w.userId);
    return {
      ...w,
      moduleConnectionId: await seedModuleConnection(w.userId),
      claude: await seedProvider(db, w.userId, 'claude-code'),
    };
  }

  /** A module provider that lists the forge category too, with an account the repository can use, and the task choice on GitHub. */
  async function forgeChoiceWorld() {
    registerModuleIntegrations([fxModule([...DOCS_CATEGORIES, 'forge'])]);
    const w = await seedWorld(db);
    users.push(w.userId);
    const moduleConnectionId = await seedConnection(db, w.userId, {
      provider: MODULE_PROVIDER,
      label: 'fx-forge-account-5512',
    });
    await db.insert(schema.taskIntegrationChoices).values({
      taskId: w.taskId,
      categoryId: 'forge',
      providerId: 'github',
      connectionId: w.connectionId,
    });
    return { ...w, moduleConnectionId };
  }

  const chooseModuleAccount = (w: { taskId: string; moduleConnectionId: string }) =>
    db.transaction(async (tx) => {
      await lockTaskIntegrations(tx, w.taskId);
      await tx
        .update(schema.taskIntegrationChoices)
        .set({ providerId: MODULE_PROVIDER, connectionId: w.moduleConnectionId })
        .where(eq(schema.taskIntegrationChoices.taskId, w.taskId));
    });

  const resolvesToModule = async (
    w: { taskId: string; moduleConnectionId: string },
    requirements: IntegrationRequirement[],
  ) =>
    expect(
      await resolveStepIntegrations(db, { taskId: w.taskId }, requirements),
      'the fixture: the resolver resolves the module requirement to the module account',
    ).toMatchObject(
      requirements.map(() => ({
        status: 'resolved',
        providerId: MODULE_PROVIDER,
        connectionId: w.moduleConnectionId,
      })),
    );

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
          AGENTS.map((agentId) => ({ agentId, agentTitle: agentId, prompt: `Review ${agentId}.` })),
        ...mining,
      },
      async apply() {
        return {};
      },
    }) as unknown as StepDefinition;

  function declare(integrations: IntegrationRequirement[]): string {
    const stepId = `module.fx.audit-${(counter += 1)}`;
    const entry: ComposableStepEntry = {
      stepId,
      label: stepId,
      group: 'g',
      dispatchesCli: true,
      requires: [],
      provides: [],
      integrations,
    };
    setComposableCatalog(new Map([[stepId, entry]]));
    return stepId;
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

  const requestsOf = () =>
    h.requests as (DispatchRequest & { integrations?: IntegrationBinding[] })[];

  const moduleBinding = (
    connectionId: string,
    requirement: IntegrationRequirement,
  ): IntegrationBinding => ({
    requirementId: requirement.id,
    categoryId: requirement.category ?? null,
    providerId: MODULE_PROVIDER,
    connectionId,
    access: requirement.access,
  });

  const forgeBinding = (connectionId: string): IntegrationBinding => ({
    requirementId: FORGE_READ.id,
    categoryId: 'forge',
    providerId: 'github',
    connectionId,
    access: 'read',
  });

  describe('[J7] durable reconnect/provider waits', () => {
    const rowOf = async (taskId: string) =>
      (await db.select().from(schema.taskSteps).where(eq(schema.taskSteps.taskId, taskId)))[0]!;
    const taskOf = async (taskId: string) =>
      (await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)))[0]!;
    async function park(
      w: { taskId: string; userId: string },
      def: StepDefinition,
      result: Awaited<ReturnType<typeof advance>>,
    ) {
      expect(result.status).toBe('integration_blocked');
      if (result.status !== 'integration_blocked')
        throw new Error('expected typed integration block');
      await db
        .update(schema.tasks)
        .set({ currentStepId: def.metadata.id })
        .where(eq(schema.tasks.id, w.taskId));
      const ctx = {
        taskId: w.taskId,
        userId: w.userId,
        orchestrationEpoch: 0,
        currentStepId: def.metadata.id,
        currentRound: 0,
      } as ResolvedTaskContext;
      expect(await parkForIntegrations(db, ctx, def, result.row, result.block)).toBe(true);
      return ctx;
    }
    const expectNoDispatch = async (taskId: string) => {
      expect(await runsOf(db, taskId)).toEqual([]);
      expect(await grantsOf(db, taskId)).toEqual([]);
      expect(enqueued).toEqual([]);
    };

    it('parks the selected unhealthy account without fallback, then stamps the CURRENT override exactly once', async () => {
      const w = await moduleWorld();
      const second = await seedModuleConnection(w.userId);
      await db.insert(schema.taskIntegrationChoices).values({
        taskId: w.taskId,
        categoryId: MODULE_CATEGORY,
        providerId: MODULE_PROVIDER,
        connectionId: w.moduleConnectionId,
      });
      await db
        .update(schema.integrationConnections)
        .set({ status: 'needs_reauth' })
        .where(eq(schema.integrationConnections.id, w.moduleConnectionId));
      const id = declare([DOCS_REQUIRED]);
      const def = llmStep(id);
      const first = await advance(w, def);
      expect(first).toMatchObject({
        status: 'integration_blocked',
        block: {
          kind: 'wait',
          wait: {
            causes: [
              {
                connectionId: w.moduleConnectionId,
                providerId: MODULE_PROVIDER,
                reason: 'connection-unavailable',
              },
            ],
          },
        },
      });
      await expectNoDispatch(w.taskId);
      const ctx = await park(w, def, first);
      const parked = await rowOf(w.taskId);
      expect(parked.status).toBe('pending');
      expect(parked.waitingStartedAt).not.toBeNull();
      expect(parked.integrationWait?.causes[0]?.connectionId).toBe(w.moduleConnectionId);
      expect(h.parkJobs[0]?.opts.delay).toBe(30_000);
      if (first.status !== 'integration_blocked') throw new Error('block missing');
      await Promise.all([
        parkForIntegrations(db, ctx, def, first.row, first.block),
        parkForIntegrations(db, ctx, def, first.row, first.block),
      ]);
      expect((await rowOf(w.taskId)).waitingStartedAt).toEqual(parked.waitingStartedAt);
      expect((await rowOf(w.taskId)).carriedIdleMs).toBe(parked.carriedIdleMs);
      // The task-page choice owner may choose another account while parked. No captured account wins.
      await db.transaction(async (tx) => {
        await lockTaskIntegrations(tx, w.taskId);
        await tx
          .update(schema.taskIntegrationChoices)
          .set({ connectionId: second })
          .where(eq(schema.taskIntegrationChoices.taskId, w.taskId));
      });
      expect((await advance(w, def)).status).toBe('waiting_cli');
      expect((await rowOf(w.taskId)).integrationWait).toBeNull();
      expect((await runsOf(db, w.taskId))[0]?.integrations).toMatchObject([
        { connectionId: second },
      ]);
      await advance(w, def);
      expect(await runsOf(db, w.taskId)).toHaveLength(1);
      expect(enqueued).toHaveLength(1);
      expect(await parkForIntegrations(db, ctx, def, first.row, first.block)).toBe(false);
      expect(
        (
          await db
            .select()
            .from(schema.integrationConnections)
            .where(eq(schema.integrationConnections.id, w.moduleConnectionId))
        )[0]?.status,
      ).toBe('needs_reauth');
    });

    it('provider deactivation parks without changing auth health, and reactivation allows dispatch', async () => {
      const w = await moduleWorld();
      const id = declare([DOCS_REQUIRED]);
      const def = llmStep(id);
      await db
        .update(schema.modules)
        .set({ deactivatedAt: new Date() })
        .where(eq(schema.modules.moduleId, 'fx'));
      const result = await advance(w, def);
      expect(result).toMatchObject({
        status: 'integration_blocked',
        block: { kind: 'wait', wait: { causes: [{ reason: 'provider-deactivated' }] } },
      });
      await park(w, def, result);
      await expectNoDispatch(w.taskId);
      expect(
        (
          await db
            .select()
            .from(schema.integrationConnections)
            .where(eq(schema.integrationConnections.id, w.moduleConnectionId))
        )[0]?.status,
      ).toBe('connected');
      await db
        .update(schema.modules)
        .set({ deactivatedAt: null })
        .where(eq(schema.modules.moduleId, 'fx'));
      expect((await advance(w, def)).status).toBe('waiting_cli');
      expect(enqueued).toHaveLength(1);
    });

    it('rechecks provider state at the locked stamp boundary and retains reserved mining prompts for recovery', async () => {
      const w = await moduleWorld();
      const id = declare([DOCS_REQUIRED]);
      const def = miningStep(id);
      h.beforeRequest = async () => {
        await db
          .update(schema.modules)
          .set({ deactivatedAt: new Date() })
          .where(eq(schema.modules.moduleId, 'fx'));
      };
      const result = await advance(w, def);
      expect(result).toMatchObject({ status: 'integration_blocked', block: { kind: 'wait' } });
      await expectNoDispatch(w.taskId);
      await park(w, def, result);
      const rows = await db
        .select()
        .from(schema.taskStepAgentMinings)
        .where(eq(schema.taskStepAgentMinings.taskStepId, result.row.id));
      expect(rows).toHaveLength(AGENTS.length);
      // Attempts starts at 1 when reserved (schema default); a blocked dispatch must
      // neither link a run nor spend another attempt. Recovery keeps that same first attempt.
      expect(
        rows
          .map((r) => ({
            agentId: r.agentId,
            status: r.status,
            cliInvocationId: r.cliInvocationId,
            dispatchPrompt: r.dispatchPrompt,
            attempts: r.attempts,
          }))
          .sort((a, b) => a.agentId.localeCompare(b.agentId)),
      ).toEqual(
        AGENTS.map((agentId) => ({
          agentId,
          status: 'pending',
          cliInvocationId: null,
          dispatchPrompt: `Review ${agentId}.`,
          attempts: 1,
        })),
      );
      h.beforeRequest = null;
      await db
        .update(schema.modules)
        .set({ deactivatedAt: null })
        .where(eq(schema.modules.moduleId, 'fx'));
      expect((await advance(w, def)).status).toBe('waiting_cli');
      expect(enqueued).toHaveLength(AGENTS.length);
      expect(await runsOf(db, w.taskId)).toHaveLength(AGENTS.length);
      const recovered = await db
        .select()
        .from(schema.taskStepAgentMinings)
        .where(eq(schema.taskStepAgentMinings.taskStepId, result.row.id));
      expect(recovered.map((r) => r.attempts)).toEqual(rows.map((r) => r.attempts));
    });

    it('ordinary queue ticks park an admin prompt, respect pause, recheck current provider state and dispatch once after recovery', async () => {
      const w = await moduleWorld();
      const type = 'j7-queue-tick';
      const id = `custom.${type}.audit`;
      const { stored } = pinnedPromptStep([DOCS_REQUIRED], { id });
      await db
        .insert(schema.taskTypeDefinitions)
        .values({
          slug: type,
          displayName: type,
          source: 'admin',
          runListStrategy: 'static',
          stepIds: [id],
        })
        .onConflictDoNothing();
      try {
        await db
          .update(schema.repositories)
          .set({ localPath: '/var/tmp/haive-codex-332' })
          .where(eq(schema.repositories.id, w.repositoryId));
        await db
          .update(schema.tasks)
          .set({
            type,
            currentStepId: id,
            runListSnapshot: [id],
            customSteps: stored,
            cliProviderId: w.claude.id,
          })
          .where(eq(schema.tasks.id, w.taskId));
        await db
          .update(schema.integrationConnections)
          .set({ status: 'needs_reauth' })
          .where(eq(schema.integrationConnections.id, w.moduleConnectionId));
        let seq = 0;
        const tick = () =>
          processTaskJob(
            {
              id: `j7-tick-${++seq}`,
              name: TASK_JOB_NAMES.ADVANCE_STEP,
              data: { taskId: w.taskId, userId: w.userId, stepId: id, round: 0, epoch: 0 },
              timestamp: Date.now(),
            } as never,
            'test-token',
          );
        await tick();
        const parked = await rowOf(w.taskId);
        expect(parked).toMatchObject({
          status: 'pending',
          integrationWait: {
            causes: [{ reason: 'connection-unavailable', connectionId: w.moduleConnectionId }],
          },
        });
        expect(parked.waitingStartedAt).not.toBeNull();
        expect(
          h.parkJobs.filter((j) => j.name === TASK_JOB_NAMES.ADVANCE_STEP).at(-1)?.opts.delay,
        ).toBe(30_000);
        expect(await runsOf(db, w.taskId)).toEqual([]);
        // Reconnect is represented solely by the auth owner's status transition; a pause still wins.
        await db
          .update(schema.tasks)
          .set({ pausedAt: new Date() })
          .where(eq(schema.tasks.id, w.taskId));
        await db
          .update(schema.integrationConnections)
          .set({ status: 'connected' })
          .where(eq(schema.integrationConnections.id, w.moduleConnectionId));
        await tick();
        expect(await runsOf(db, w.taskId)).toEqual([]);
        expect((await rowOf(w.taskId)).waitingStartedAt).toEqual(parked.waitingStartedAt);
        // A different live structural block now applies; recovery may not trust the old account-only cause.
        await db.update(schema.tasks).set({ pausedAt: null }).where(eq(schema.tasks.id, w.taskId));
        await db
          .update(schema.modules)
          .set({ deactivatedAt: new Date() })
          .where(eq(schema.modules.moduleId, 'fx'));
        await tick();
        expect((await rowOf(w.taskId)).integrationWait?.causes[0]?.reason).toBe(
          'provider-deactivated',
        );
        expect(await runsOf(db, w.taskId)).toEqual([]);
        await db
          .update(schema.modules)
          .set({ deactivatedAt: null })
          .where(eq(schema.modules.moduleId, 'fx'));
        await tick();
        expect((await rowOf(w.taskId)).integrationWait).toBeNull();
        expect((await runsOf(db, w.taskId))[0]?.integrations).toMatchObject([
          { connectionId: w.moduleConnectionId },
        ]);
        await tick();
        expect(await runsOf(db, w.taskId)).toHaveLength(1);
      } finally {
        await db.delete(schema.tasks).where(eq(schema.tasks.id, w.taskId));
        await db
          .delete(schema.taskTypeDefinitions)
          .where(eq(schema.taskTypeDefinitions.slug, type));
      }
    });

    it('a saved wait with a newly invalid requirement fails by name even while its valid sibling still needs reconnecting', async () => {
      const w = await moduleWorld();
      const type = 'j7-invalid-wait';
      const id = `custom.${type}.audit`;
      const { stored, stepDef } = pinnedPromptStep(
        [DOCS_REQUIRED, { id: 'broken', category: MODULE_CATEGORY, access: 'admin' }],
        { id },
      );
      expect(invalidRequirementsFailure(stepDef)).toMatch(/^integration-requirement-invalid:/);
      await db
        .insert(schema.taskTypeDefinitions)
        .values({
          slug: type,
          displayName: type,
          source: 'admin',
          runListStrategy: 'static',
          stepIds: [id],
        })
        .onConflictDoNothing();
      try {
        await db
          .update(schema.repositories)
          .set({ localPath: '/var/tmp/haive-codex-332' })
          .where(eq(schema.repositories.id, w.repositoryId));
        await db
          .update(schema.tasks)
          .set({
            type,
            currentStepId: id,
            runListSnapshot: [id],
            customSteps: stored,
            cliProviderId: w.claude.id,
          })
          .where(eq(schema.tasks.id, w.taskId));
        await db
          .update(schema.integrationConnections)
          .set({ status: 'needs_reauth' })
          .where(eq(schema.integrationConnections.id, w.moduleConnectionId));
        const resolution = await resolveDispatchIntegrations(db, w.taskId, [DOCS_REQUIRED]);
        expect(resolution).toMatchObject({ ok: false, blocked: { kind: 'wait' } });
        if (resolution.ok || !resolution.blocked)
          throw new Error('fixture must have a reconnect-blocked valid sibling');
        await seedStepRow(db, w.taskId, {
          stepId: id,
          status: 'pending',
          waitingStartedAt: new Date(),
          integrationWait: resolution.blocked.wait,
        });
        await processTaskJob(
          {
            id: 'j7-invalid-wait',
            name: TASK_JOB_NAMES.ADVANCE_STEP,
            data: { taskId: w.taskId, userId: w.userId, stepId: id, round: 0, epoch: 0 },
            timestamp: Date.now(),
          } as never,
          'test-token',
        );
        expect(await rowOf(w.taskId)).toMatchObject({
          status: 'failed',
          integrationWait: null,
          errorMessage: expect.stringMatching(/^integration-requirement-invalid:/),
        });
        expect((await taskOf(w.taskId)).status).toBe('failed');
        expect(await runsOf(db, w.taskId)).toEqual([]);
        expect(h.parkJobs.filter((j) => j.name === TASK_JOB_NAMES.ADVANCE_STEP)).toEqual([]);
      } finally {
        await db.delete(schema.tasks).where(eq(schema.tasks.id, w.taskId));
        await db
          .delete(schema.taskTypeDefinitions)
          .where(eq(schema.taskTypeDefinitions.slug, type));
      }
    });

    it('a missing required provider is structurally dead until the current requirement resolves again', async () => {
      const w = await moduleWorld();
      const id = declare([DOCS_REQUIRED]);
      const def = llmStep(id);
      stepRegistry.register(def);
      registerModuleIntegrations([]);
      const result = await advance(w, def);
      expect(result).toMatchObject({ status: 'integration_blocked', block: { kind: 'dead' } });
      await park(w, def, result);
      expect((await taskOf(w.taskId)).deadAt).not.toBeNull();
      await expectNoDispatch(w.taskId);
      const recovery = {
        enqueueStart: vi.fn(async () => undefined),
        enqueueAdvance: vi.fn(async () => undefined),
        redriveRetryDelaysMs: [],
      };
      expect((await reviveDeadTasks(db, recovery)).revived).toBe(0);
      expect(recovery.enqueueAdvance).not.toHaveBeenCalled();
      registerModuleIntegrations([fxModule(DOCS_CATEGORIES)]);
      expect((await reviveDeadTasks(db, recovery)).revived).toBe(1);
      expect((await taskOf(w.taskId)).deadAt).toBeNull();
      expect(recovery.enqueueAdvance).toHaveBeenCalledTimes(1);
    });

    it.each(['failed', 'cancelled', 'completed'] as const)(
      'a %s task cannot be reparked or resurrected by a stale integration block',
      async (status) => {
        const w = await moduleWorld();
        const id = declare([DOCS_REQUIRED]);
        const def = llmStep(id);
        await db
          .update(schema.integrationConnections)
          .set({ status: 'needs_reauth' })
          .where(eq(schema.integrationConnections.id, w.moduleConnectionId));
        const result = await advance(w, def);
        expect(result.status).toBe('integration_blocked');
        if (result.status !== 'integration_blocked') return;
        await db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, w.taskId));
        const ctx = {
          taskId: w.taskId,
          userId: w.userId,
          orchestrationEpoch: 0,
          currentStepId: id,
          currentRound: 0,
        } as ResolvedTaskContext;
        expect(await parkForIntegrations(db, ctx, def, result.row, result.block)).toBe(false);
        expect((await taskOf(w.taskId)).status).toBe(status);
        expect((await rowOf(w.taskId)).integrationWait).toBeNull();
        expect(h.parkJobs).toHaveLength(0);
      },
    );
  });

  describe('[M1] resolveDispatchIntegrations', () => {
    it.each([
      ['a module category', DOCS_REQUIRED],
      ['a core category the module lists', CORE_DOCS_REQUIRED],
    ] as const)(
      '[M1] binds a required requirement of %s to the module account',
      async (_label, requirement) => {
        const w = await moduleWorld();
        await resolvesToModule(w, [requirement]);

        const result = await resolveDispatchIntegrations(db, w.taskId, [requirement]);

        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(result.bindings).toEqual([moduleBinding(w.moduleConnectionId, requirement)]);
        expect(result.resolutions.map((resolution) => resolution.requirementId)).toEqual([
          requirement.id,
        ]);
      },
    );

    it('[M1] binds the requirement that resolved to the module beside the one that resolved to GitHub', async () => {
      const w = await mixedWorld();
      await resolvesToModule(w, [DOCS_REQUIRED]);

      const result = await resolveDispatchIntegrations(db, w.taskId, [FORGE_READ, DOCS_REQUIRED]);

      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.bindings).toEqual([
        forgeBinding(w.connectionId),
        moduleBinding(w.moduleConnectionId, DOCS_REQUIRED),
      ]);
    });

    it('[M1] binds every required requirement that resolved to a module', async () => {
      const w = await moduleWorld();
      const mail: IntegrationRequirement = { id: 'mailbox', category: 'mail', access: 'read' };
      registerModuleIntegrations([fxModule([...DOCS_CATEGORIES, 'mail'])]);

      const result = await resolveDispatchIntegrations(db, w.taskId, [DOCS_REQUIRED, mail]);

      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.bindings).toEqual([
        moduleBinding(w.moduleConnectionId, DOCS_REQUIRED),
        moduleBinding(w.moduleConnectionId, mail),
      ]);
    });

    it.each([
      ['a module category', DOCS_OPTIONAL],
      ['a core category the module lists', CORE_DOCS_OPTIONAL],
    ] as const)(
      '[M1] binds an optional requirement of %s too, beside the rest',
      async (_label, optional) => {
        const w = await mixedWorld();
        await resolvesToModule(w, [optional]);

        const result = await resolveDispatchIntegrations(db, w.taskId, [FORGE_READ, optional]);

        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(result.bindings).toEqual([
          forgeBinding(w.connectionId),
          moduleBinding(w.moduleConnectionId, optional),
        ]);
      },
    );

    it('[M1] needs the signing key when the only requirement is an optional module one, since it binds it', async () => {
      const w = await moduleWorld();
      await resolvesToModule(w, [DOCS_OPTIONAL]);
      delete process.env.CONFIG_ENCRYPTION_KEY;

      const result = await resolveDispatchIntegrations(db, w.taskId, [DOCS_OPTIONAL]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.startsWith('integrations-no-signing-key: ')).toBe(true);
    });

    it('[M1] binds the required and the optional requirement when both resolve to the module', async () => {
      const w = await moduleWorld();
      const optional = { ...DOCS_OPTIONAL, id: 'nice-to-have' };
      const required = { ...DOCS_REQUIRED, id: 'must-have' };

      const result = await resolveDispatchIntegrations(db, w.taskId, [optional, required]);

      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.bindings).toEqual([
        moduleBinding(w.moduleConnectionId, optional),
        moduleBinding(w.moduleConnectionId, required),
      ]);
    });

    it('[M1] still refuses a requirement that pins the module provider as pinned (passes before and after)', async () => {
      const w = await moduleWorld();
      const pinned: IntegrationRequirement = {
        id: 'docs',
        provider: MODULE_PROVIDER,
        access: 'read',
      };

      const result = await resolveDispatchIntegrations(db, w.taskId, [pinned]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.startsWith('integration-provider-pinned: ')).toBe(true);
    });

    it('[M1] still binds a forge requirement to GitHub while a module provider is registered (passes before and after)', async () => {
      const w = await mixedWorld();

      const result = await resolveDispatchIntegrations(db, w.taskId, [FORGE_READ]);

      expect(result).toMatchObject({ ok: true, bindings: [forgeBinding(w.connectionId)] });
    });

    it('[M1] still refuses a pinned core provider as pinned (passes before and after)', async () => {
      const w = await mixedWorld();

      const result = await resolveDispatchIntegrations(db, w.taskId, [PINNED_GITHUB]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.startsWith('integration-provider-pinned: ')).toBe(true);
    });
  });

  describe('[M2] insertStampedRun', () => {
    it.each([
      ['a module category', DOCS_REQUIRED],
      ['a core category the module lists', CORE_DOCS_REQUIRED],
    ] as const)(
      '[M2] stamps the run with the module binding and records its grant for a required requirement of %s',
      async (_label, requirement) => {
        const w = await moduleWorld();
        const step = await seedStepRow(db, w.taskId);
        await resolvesToModule(w, [requirement]);

        const result = await insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [
          requirement,
        ]);

        expect(result, JSON.stringify(result)).not.toHaveProperty('failure');
        const runs = await runsOf(db, w.taskId);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.integrations).toEqual([moduleBinding(w.moduleConnectionId, requirement)]);
        expect(await grantsOf(db, w.taskId)).toEqual([
          { categoryId: requirement.category, connectionId: w.moduleConnectionId },
        ]);
      },
    );

    it('[M2] stamps the rest and the module binding, and records a grant for each, when an optional module requirement resolves', async () => {
      const w = await mixedWorld();
      const step = await seedStepRow(db, w.taskId);
      await resolvesToModule(w, [DOCS_OPTIONAL]);

      await insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [
        FORGE_READ,
        DOCS_OPTIONAL,
      ]);

      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual([
        forgeBinding(w.connectionId),
        moduleBinding(w.moduleConnectionId, DOCS_OPTIONAL),
      ]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.connectionId },
        { categoryId: MODULE_CATEGORY, connectionId: w.moduleConnectionId },
      ]);
    });

    it('[M2] stamps the module binding, and records its grant, when the only requirement is an optional module one', async () => {
      const w = await moduleWorld();
      const step = await seedStepRow(db, w.taskId);
      await resolvesToModule(w, [DOCS_OPTIONAL]);

      await insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [DOCS_OPTIONAL]);

      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual([moduleBinding(w.moduleConnectionId, DOCS_OPTIONAL)]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: MODULE_CATEGORY, connectionId: w.moduleConnectionId },
      ]);
    });

    it('[M2] stamps the module account, and records its grant, when the task choice moves to it after the dispatch resolved GitHub', async () => {
      const w = await forgeChoiceWorld();
      const step = await seedStepRow(db, w.taskId);
      const early = await resolveDispatchIntegrations(db, w.taskId, [FORGE_READ]);
      expect(early).toMatchObject({ ok: true, bindings: [forgeBinding(w.connectionId)] });
      await chooseModuleAccount(w);
      expect(
        await resolveStepIntegrations(db, { taskId: w.taskId }, [FORGE_READ]),
        'the fixture: the choice now resolves the forge requirement to the module account',
      ).toMatchObject([
        { status: 'resolved', providerId: MODULE_PROVIDER, connectionId: w.moduleConnectionId },
      ]);

      const result = await insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [
        FORGE_READ,
      ]);

      expect(result, JSON.stringify(result)).not.toHaveProperty('failure');
      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual([
        { ...moduleBinding(w.moduleConnectionId, FORGE_READ), categoryId: 'forge' },
      ]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.moduleConnectionId },
      ]);
    });

    it('[M2] stamps the module account, and records its grant, when an optional forge requirement moves to it', async () => {
      const w = await forgeChoiceWorld();
      const step = await seedStepRow(db, w.taskId);
      const early = await resolveDispatchIntegrations(db, w.taskId, [FORGE_OPTIONAL]);
      expect(early).toMatchObject({ ok: true, bindings: [forgeBinding(w.connectionId)] });
      await chooseModuleAccount(w);

      await insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [FORGE_OPTIONAL]);

      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual([
        { ...moduleBinding(w.moduleConnectionId, FORGE_OPTIONAL), categoryId: 'forge' },
      ]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.moduleConnectionId },
      ]);
    });

    it('[M2] still stamps a forge requirement with GitHub and records its grant while a module provider is registered (passes before and after)', async () => {
      const w = await mixedWorld();
      const step = await seedStepRow(db, w.taskId);
      const expected = bindingsOf(
        await resolveStepIntegrations(db, { taskId: w.taskId }, [FORGE_READ]),
      );
      expect(expected).toEqual([forgeBinding(w.connectionId)]);

      await insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [FORGE_READ]);

      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual(expected);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.connectionId },
      ]);
    });
  });

  describe('[M3] a dispatched step', () => {
    it('[M3] an llm step with a required module requirement waits on one run stamped with it, and its prompt names the module tool', async () => {
      const w = await moduleWorld();
      const stepId = declare([DOCS_REQUIRED]);
      await resolvesToModule(w, [DOCS_REQUIRED]);

      const result = await advance(w, llmStep(stepId));

      expect(result.status).toBe('waiting_cli');
      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual([moduleBinding(w.moduleConnectionId, DOCS_REQUIRED)]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: MODULE_CATEGORY, connectionId: w.moduleConnectionId },
      ]);
      expect(enqueued).toHaveLength(1);
      expect(requestsOf()).toHaveLength(1);
      expect(requestsOf()[0]!.integrations).toEqual([
        moduleBinding(w.moduleConnectionId, DOCS_REQUIRED),
      ]);
      expect(runs[0]!.prompt).toContain(MODULE_TOOL);
    }, 60_000);

    it('[M3] a fan-out stamps every agent with the module binding and records one grant', async () => {
      const w = await moduleWorld();
      const stepId = declare([DOCS_REQUIRED]);
      await resolvesToModule(w, [DOCS_REQUIRED]);

      const result = await advance(w, miningStep(stepId));

      expect(result.status).toBe('waiting_cli');
      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(AGENTS.length);
      for (const run of runs) {
        expect(run.integrations).toEqual([moduleBinding(w.moduleConnectionId, DOCS_REQUIRED)]);
      }
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: MODULE_CATEGORY, connectionId: w.moduleConnectionId },
      ]);
      expect(enqueued).toHaveLength(AGENTS.length);
      for (const request of requestsOf()) {
        expect(request.integrations).toEqual([moduleBinding(w.moduleConnectionId, DOCS_REQUIRED)]);
      }
    }, 60_000);

    it('[M3] an llm step is stamped with GitHub and the optional module requirement together', async () => {
      const w = await mixedWorld();
      const stepId = declare([FORGE_READ, DOCS_OPTIONAL]);
      await resolvesToModule(w, [DOCS_OPTIONAL]);

      const result = await advance(w, llmStep(stepId));

      expect(result.status).toBe('waiting_cli');
      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual([
        forgeBinding(w.connectionId),
        moduleBinding(w.moduleConnectionId, DOCS_OPTIONAL),
      ]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.connectionId },
        { categoryId: MODULE_CATEGORY, connectionId: w.moduleConnectionId },
      ]);
      expect(enqueued).toHaveLength(1);
      expect(requestsOf()).toHaveLength(1);
      expect(requestsOf()[0]!.integrations).toEqual([
        forgeBinding(w.connectionId),
        moduleBinding(w.moduleConnectionId, DOCS_OPTIONAL),
      ]);
      expect(runs[0]!.prompt).toContain('get_pull_request_state');
      expect(runs[0]!.prompt).toContain(MODULE_TOOL);
    }, 60_000);

    it('[M3] an llm step whose only requirement is an optional module one is stamped with it', async () => {
      const w = await moduleWorld();
      const stepId = declare([DOCS_OPTIONAL]);
      await resolvesToModule(w, [DOCS_OPTIONAL]);

      const result = await advance(w, llmStep(stepId));

      expect(result.status).toBe('waiting_cli');
      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual([moduleBinding(w.moduleConnectionId, DOCS_OPTIONAL)]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: MODULE_CATEGORY, connectionId: w.moduleConnectionId },
      ]);
      expect(enqueued).toHaveLength(1);
      expect(requestsOf()[0]!.integrations).toEqual([
        moduleBinding(w.moduleConnectionId, DOCS_OPTIONAL),
      ]);
      expect(runs[0]!.prompt).toContain(MODULE_TOOL);
    }, 60_000);

    it('[M3] a fan-out stamps every agent with GitHub and the optional module requirement', async () => {
      const w = await mixedWorld();
      const stepId = declare([FORGE_READ, DOCS_OPTIONAL]);
      await resolvesToModule(w, [DOCS_OPTIONAL]);

      const result = await advance(w, miningStep(stepId));

      expect(result.status).toBe('waiting_cli');
      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(AGENTS.length);
      const expected = [
        forgeBinding(w.connectionId),
        moduleBinding(w.moduleConnectionId, DOCS_OPTIONAL),
      ];
      for (const run of runs) expect(run.integrations).toEqual(expected);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.connectionId },
        { categoryId: MODULE_CATEGORY, connectionId: w.moduleConnectionId },
      ]);
      expect(enqueued).toHaveLength(AGENTS.length);
      for (const request of requestsOf()) expect(request.integrations).toEqual(expected);
    }, 60_000);

    it('[M3] a fan-out whose only requirement is an optional module one stamps every agent with it', async () => {
      const w = await moduleWorld();
      const stepId = declare([DOCS_OPTIONAL]);
      await resolvesToModule(w, [DOCS_OPTIONAL]);

      const result = await advance(w, miningStep(stepId));

      expect(result.status).toBe('waiting_cli');
      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(AGENTS.length);
      for (const run of runs) {
        expect(run.integrations).toEqual([moduleBinding(w.moduleConnectionId, DOCS_OPTIONAL)]);
      }
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: MODULE_CATEGORY, connectionId: w.moduleConnectionId },
      ]);
      expect(enqueued).toHaveLength(AGENTS.length);
      for (const request of requestsOf()) {
        expect(request.integrations).toEqual([moduleBinding(w.moduleConnectionId, DOCS_OPTIONAL)]);
      }
    }, 60_000);

    it('[M3] a step that needs only GitHub is stamped as before while a module provider is registered (passes before and after)', async () => {
      const w = await mixedWorld();
      const stepId = declare([FORGE_READ]);

      const result = await advance(w, llmStep(stepId));

      expect(result.status).toBe('waiting_cli');
      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual([forgeBinding(w.connectionId)]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.connectionId },
      ]);
    }, 60_000);
  });
});
