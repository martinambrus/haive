import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import type { CliExecJobPayload } from '@haive/shared';
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
    await db
      .insert(schema.integrationProviderConfigs)
      .values({ providerId: MODULE_PROVIDER, enabled: true })
      .onConflictDoUpdate({
        target: schema.integrationProviderConfigs.providerId,
        set: { enabled: true },
      });
  });

  afterAll(async () => {
    await deleteUsers(db, users);
    await db
      .delete(schema.integrationProviderConfigs)
      .where(eq(schema.integrationProviderConfigs.providerId, MODULE_PROVIDER));
    await db.$client.end({ timeout: 5 });
  });

  beforeEach(() => {
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
