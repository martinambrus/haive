import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
import {
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
  resolveDispatchIntegrations,
  setComposableCatalog,
} from '../src/step-engine/step-integrations.js';
import {
  FORGE_READ,
  PINNED_GITHUB,
  SIGNING_KEY,
  deleteUsers,
  grantsOf,
  runValues,
  runsOf,
  seedBareWorld,
  seedProvider,
  seedStepRow,
  seedWorld,
} from './support/step-integrations-db.js';

const url = process.env.STEP_INTEGRATIONS_MODULE_EXECUTORS_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/step_integrations_module_executors_test'))
  throw new Error(
    'Use a dedicated step_integrations_module_executors_test database for the module executor dispatch tests',
  );

const h = vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'error';
  return { requests: [] as unknown[] };
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
      return actual.resolveTaskDispatch(...args);
    },
  };
});

import { advanceStep, type AdvanceStepResult } from '../src/step-engine/step-runner.js';

const MODULE_PROVIDER = 'module.fx.docs';
const MODULE_CATEGORY = 'module.fx.documents';
const READ_TOOL = 'get_doc';
const WRITE_TOOL = 'append_doc';
const AGENTS = ['agent-a', 'agent-b', 'agent-c'];

const DOCS_REQUIRED: IntegrationRequirement = {
  id: 'docs',
  category: MODULE_CATEGORY,
  access: 'read',
};
const DOCS_WRITE: IntegrationRequirement = { ...DOCS_REQUIRED, access: 'write' };
const DOCS_OPTIONAL: IntegrationRequirement = { ...DOCS_REQUIRED, optional: true };
const CORE_DOCS_REQUIRED: IntegrationRequirement = { ...DOCS_REQUIRED, category: 'rich-documents' };

type LoadedModule = Parameters<typeof registerModuleIntegrations>[0][number];

const fxModule = (categories: string[]): LoadedModule => ({
  manifest: {
    id: 'fx',
    name: 'Module fx',
    categories: [{ id: MODULE_CATEGORY, label: 'Documents of fx' }],
    integrations: [
      {
        id: MODULE_PROVIDER,
        displayName: 'Documents of fx',
        categories,
        selfHosted: false,
        auth: [
          {
            kind: 'device',
            deviceCodeUrl: 'https://login.docs.example.test/device/code',
            tokenUrl: 'https://login.docs.example.test/token',
            scopes: { read: ['docs.read'], write: ['docs.write'] },
            userInfo: {
              url: 'https://docs.example.test/v1/me',
              idPointer: '/id',
              labelPointer: '/name',
            },
          },
        ],
        operations: [
          {
            opId: READ_TOOL,
            description: 'Read a document',
            inputSchema: { type: 'object', properties: {} },
            access: 'read',
          },
          {
            opId: WRITE_TOOL,
            description: 'Append text to a document',
            inputSchema: { type: 'object', properties: {} },
            access: 'write',
          },
        ],
        apiHosts: ['docs.example.test'],
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

  const setConfig = (enabled: boolean) =>
    db
      .insert(schema.integrationProviderConfigs)
      .values({ providerId: MODULE_PROVIDER, enabled })
      .onConflictDoUpdate({
        target: schema.integrationProviderConfigs.providerId,
        set: { enabled },
      });

  beforeAll(async () => {
    db = createDatabase(url as string);
    await setConfig(true);
  });

  afterAll(async () => {
    await deleteUsers(db, users);
    await db
      .delete(schema.integrationProviderConfigs)
      .where(eq(schema.integrationProviderConfigs.providerId, MODULE_PROVIDER));
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(async () => {
    savedKey = process.env.CONFIG_ENCRYPTION_KEY;
    process.env.CONFIG_ENCRYPTION_KEY = SIGNING_KEY;
    enqueued.length = 0;
    h.requests.length = 0;
    await setConfig(true);
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
        authMethod: 'device',
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

  /** The module's account beside a GitHub one. */
  async function mixedWorld() {
    const w = await seedWorld(db);
    users.push(w.userId);
    return {
      ...w,
      moduleConnectionId: await seedModuleConnection(w.userId),
      claude: await seedProvider(db, w.userId, 'claude-code'),
    };
  }

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

  function expectWaiting(result: AdvanceStepResult): void {
    const why = result.status === 'failed' ? result.error : result.row.errorMessage;
    expect(result.status, why ?? undefined).toBe('waiting_cli');
  }

  describe('[X13] resolveDispatchIntegrations', () => {
    it.each([
      ['a module category', DOCS_REQUIRED, MODULE_CATEGORY],
      ['a core category the module lists', CORE_DOCS_REQUIRED, 'rich-documents'],
    ] as const)(
      '[X13] binds a required requirement of %s to the module account',
      async (_label, requirement, category) => {
        const w = await moduleWorld();
        await resolvesToModule(w, [requirement]);

        const result = await resolveDispatchIntegrations(db, w.taskId, [requirement]);

        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(result.bindings).toEqual([
          { ...moduleBinding(w.moduleConnectionId, requirement), categoryId: category },
        ]);
      },
    );

    it('[X13] binds a write requirement with access write', async () => {
      const w = await moduleWorld();

      const result = await resolveDispatchIntegrations(db, w.taskId, [DOCS_WRITE]);

      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.bindings).toEqual([moduleBinding(w.moduleConnectionId, DOCS_WRITE)]);
    });

    it('[X13+] binds an optional requirement that resolves to the module account, where it used to leave it out', async () => {
      const w = await moduleWorld();
      await resolvesToModule(w, [DOCS_OPTIONAL]);

      const result = await resolveDispatchIntegrations(db, w.taskId, [DOCS_OPTIONAL]);

      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.bindings).toEqual([moduleBinding(w.moduleConnectionId, DOCS_OPTIONAL)]);
    });

    it('[X13+] binds the forge requirement and the module requirement of one step together', async () => {
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

    it('[X13] fails a required requirement whose provider no admin has switched on as unresolved (PIN)', async () => {
      const w = await moduleWorld();
      await setConfig(false);

      const result = await resolveDispatchIntegrations(db, w.taskId, [DOCS_REQUIRED]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.startsWith('integration-unresolved: ')).toBe(true);
    });

    it('[X13] still refuses a requirement that pins the module provider as pinned (PIN)', async () => {
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

    it('[X13] still binds a forge requirement to GitHub while a module provider is registered (PIN)', async () => {
      const w = await mixedWorld();

      const result = await resolveDispatchIntegrations(db, w.taskId, [FORGE_READ]);

      expect(result).toMatchObject({ ok: true, bindings: [forgeBinding(w.connectionId)] });
    });

    it('[X13] still refuses a pinned core provider as pinned (PIN)', async () => {
      const w = await mixedWorld();

      const result = await resolveDispatchIntegrations(db, w.taskId, [PINNED_GITHUB]);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.startsWith('integration-provider-pinned: ')).toBe(true);
    });
  });

  describe('[X13] insertStampedRun', () => {
    it.each([
      ['a module category', DOCS_REQUIRED],
      ['a core category the module lists', CORE_DOCS_REQUIRED],
    ] as const)(
      '[X13] stamps the run with the module binding and records the task grant for a required requirement of %s',
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
        expect(runs[0]!.integrations).toEqual([
          {
            ...moduleBinding(w.moduleConnectionId, requirement),
            categoryId: requirement.category,
          },
        ]);
        expect(await grantsOf(db, w.taskId)).toEqual([
          { categoryId: requirement.category, connectionId: w.moduleConnectionId },
        ]);
      },
    );

    it('[X13] stamps the forge and the module binding of one step, and records one grant for each', async () => {
      const w = await mixedWorld();
      const step = await seedStepRow(db, w.taskId);

      const result = await insertStampedRun(db, w.taskId, step.id, runValues(w.taskId, step.id), [
        FORGE_READ,
        DOCS_REQUIRED,
      ]);

      expect(result, JSON.stringify(result)).not.toHaveProperty('failure');
      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual([
        forgeBinding(w.connectionId),
        moduleBinding(w.moduleConnectionId, DOCS_REQUIRED),
      ]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.connectionId },
        { categoryId: MODULE_CATEGORY, connectionId: w.moduleConnectionId },
      ]);
    });
  });

  describe('[X13] a dispatched step', () => {
    it('[X13] an llm step waits on one CLI run stamped with the module binding, and its prompt names the module tool', async () => {
      const w = await moduleWorld();
      const stepId = declare([DOCS_REQUIRED]);
      await resolvesToModule(w, [DOCS_REQUIRED]);

      const result = await advance(w, llmStep(stepId));

      expectWaiting(result);
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
      expect(runs[0]!.prompt).toContain(READ_TOOL);
      expect(runs[0]!.prompt).not.toContain(WRITE_TOOL);
    }, 60_000);

    it('[X13] a fan-out stamps every agent with the module binding and records one grant', async () => {
      const w = await moduleWorld();
      const stepId = declare([DOCS_REQUIRED]);
      await resolvesToModule(w, [DOCS_REQUIRED]);

      const result = await advance(w, miningStep(stepId));

      expectWaiting(result);
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

    it('[X13] an llm step with a forge and a module requirement is stamped with both', async () => {
      const w = await mixedWorld();
      const stepId = declare([FORGE_READ, DOCS_REQUIRED]);

      const result = await advance(w, llmStep(stepId));

      expectWaiting(result);
      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual([
        forgeBinding(w.connectionId),
        moduleBinding(w.moduleConnectionId, DOCS_REQUIRED),
      ]);
      expect(runs[0]!.prompt).toContain('get_pull_request_state');
      expect(runs[0]!.prompt).toContain(READ_TOOL);
    }, 60_000);

    it('[X13+] an llm step whose only requirement is an optional module one is stamped with it', async () => {
      const w = await moduleWorld();
      const stepId = declare([DOCS_OPTIONAL]);
      await resolvesToModule(w, [DOCS_OPTIONAL]);

      const result = await advance(w, llmStep(stepId));

      expectWaiting(result);
      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual([moduleBinding(w.moduleConnectionId, DOCS_OPTIONAL)]);
      expect(runs[0]!.prompt).toContain(READ_TOOL);
    }, 60_000);

    it('[X13] a step that needs only GitHub is stamped as before while a module provider is registered (PIN)', async () => {
      const w = await mixedWorld();
      const stepId = declare([FORGE_READ]);

      const result = await advance(w, llmStep(stepId));

      expectWaiting(result);
      const runs = await runsOf(db, w.taskId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.integrations).toEqual([forgeBinding(w.connectionId)]);
      expect(await grantsOf(db, w.taskId)).toEqual([
        { categoryId: 'forge', connectionId: w.connectionId },
      ]);
      expect(runs[0]!.prompt).not.toContain(READ_TOOL);
    }, 60_000);
  });
});
