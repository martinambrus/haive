import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { IntegrationRequirement } from '@haive/shared/modularity';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

const h = vi.hoisted(() => ({ deactivated: new Set<string>() }));

vi.mock('../src/redis.js', () => ({ getRedis: () => ({ set: async () => 'OK' }) }));
vi.mock('../src/step-engine/task-type-seed.js', () => ({
  syncTaskTypeDefinitions: async () => ({}),
}));
vi.mock('../src/modules/intent.js', () => ({ syncModuleIntent: async () => undefined }));
vi.mock('../src/modules/activation.js', () => ({
  deactivatedModuleIds: async () => h.deactivated,
}));

type Raw = Record<string, any>;

const CORE_STEP = '04-phase-0b-pre-planning';
const OAUTH = {
  kind: 'oauth2',
  authorizeUrl: 'https://login.fx.example/oauth/authorize',
  tokenUrl: 'https://login.fx.example/oauth/token',
  scopes: { read: ['docs.read'], write: ['docs.write'] },
  pkce: true,
  clientRegistration: ['preregistered'],
  userInfo: { url: 'https://api.fx.example/userinfo', idPointer: '/sub', labelPointer: '/email' },
};

const need = (target: Raw): IntegrationRequirement[] => [
  { id: 'need', access: 'read', ...target } as IntegrationRequirement,
];
const NEEDS_DOCS = need({ category: 'module.fx.docs' });
const NEEDS_CRM = need({ provider: 'module.fx.crm' });

const stepOf = (localId: string): StepDefinition =>
  ({
    metadata: {
      id: localId,
      workflowType: 'x',
      index: 0,
      title: localId,
      description: localId,
      requiresCli: false,
    },
    async detect() {
      return {};
    },
    async apply() {
      return {};
    },
    llm: { requiredCapabilities: ['tool_use'], buildPrompt: () => 'prompt' },
  }) as unknown as StepDefinition;

/** A module declaring `module.<id>.docs` and the provider `module.<id>.crm`, with one llm step per requirement list. */
function moduleOf(moduleId: string, steps: Record<string, IntegrationRequirement[]> = {}): Raw {
  return {
    packageName: `@haive/module-${moduleId}`,
    manifest: {
      id: moduleId,
      name: `Module ${moduleId}`,
      version: '1.0.0',
      schemaVersion: 1,
      categories: [{ id: `module.${moduleId}.docs`, label: `Documents of ${moduleId}` }],
      integrations: [
        {
          id: `module.${moduleId}.crm`,
          displayName: `Provider of ${moduleId}`,
          categories: [`module.${moduleId}.docs`, 'rich-documents'],
          selfHosted: false,
          auth: [OAUTH],
          operations: [
            {
              opId: 'docs_list',
              description: 'List documents',
              inputSchema: { type: 'object', properties: {} },
              access: 'read',
            },
          ],
          apiHosts: [`api.${moduleId}.example`],
        },
      ],
      composableSteps: Object.entries(steps).map(([stepId, integrations]) => ({
        stepId,
        label: stepId,
        group: 'g',
        dispatchesCli: true,
        requires: [],
        provides: [],
        integrations,
      })),
    },
    steps: Object.keys(steps).map(stepOf),
  };
}

const fakeDb = {
  transaction: async (fn: (tx: unknown) => unknown) =>
    fn({
      insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
      delete: () => Object.assign(Promise.resolve(), { where: async () => undefined }),
    }),
} as unknown as Database;

interface BootCase {
  modules?: Raw[];
  /** Requirements put on core composable entries, by step id. */
  core?: Record<string, IntegrationRequirement[]>;
  deactivated?: string[];
}

async function boot(bootCase: BootCase = {}): Promise<{ error: unknown }> {
  vi.resetModules();
  h.deactivated = new Set(bootCase.deactivated ?? []);
  vi.doMock('../src/modules.generated.js', () => ({ moduleRegistry: bootCase.modules ?? [] }));
  const core = await import('../src/step-engine/composable-core.js');
  for (const [stepId, integrations] of Object.entries(bootCase.core ?? {})) {
    const target = core.CORE_COMPOSABLE_STEPS.find((candidate) => candidate.stepId === stepId);
    if (!target) throw new Error(`fixture: ${stepId} is not a core composable step`);
    (target as { integrations?: IntegrationRequirement[] }).integrations = integrations;
  }
  const { bootStepEngine } = await import('../src/step-engine/boot.js');
  try {
    await bootStepEngine(fakeDb);
    return { error: null };
  } catch (error) {
    return { error };
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

describe('boot and the integrations a step requires from a module', () => {
  it('[K6] refuses a core step requiring a module category no loaded module declares, naming the step, and boots once one does', async () => {
    const declared = await boot({ modules: [moduleOf('fx')], core: { [CORE_STEP]: NEEDS_DOCS } });
    expect(declared.error, messageOf(declared.error)).toBeNull();

    const undeclared = await boot({ modules: [], core: { [CORE_STEP]: NEEDS_DOCS } });

    expect(undeclared.error, 'boot accepted the requirement').not.toBeNull();
    expect(messageOf(undeclared.error)).toContain(CORE_STEP);
  }, 60_000);

  it('[K6] refuses it when only another module is loaded', async () => {
    const { error } = await boot({
      modules: [moduleOf('gx')],
      core: { [CORE_STEP]: NEEDS_DOCS },
    });

    expect(error, 'boot accepted the requirement').not.toBeNull();
    expect(messageOf(error)).toContain(CORE_STEP);
  }, 60_000);

  it('[K6+] refuses a core step pinning a module provider no loaded module declares, and boots once one does', async () => {
    const declared = await boot({ modules: [moduleOf('fx')], core: { [CORE_STEP]: NEEDS_CRM } });
    expect(declared.error, messageOf(declared.error)).toBeNull();

    const undeclared = await boot({ modules: [moduleOf('gx')], core: { [CORE_STEP]: NEEDS_CRM } });

    expect(undeclared.error, 'boot accepted the requirement').not.toBeNull();
    expect(messageOf(undeclared.error)).toContain(CORE_STEP);
  }, 60_000);

  it('[K6+] names the category or provider it could not find', async () => {
    const category = await boot({ core: { [CORE_STEP]: NEEDS_DOCS } });
    const provider = await boot({ core: { [CORE_STEP]: NEEDS_CRM } });

    expect(category.error, 'boot accepted the category').not.toBeNull();
    expect(messageOf(category.error)).toContain('module.fx.docs');
    expect(provider.error, 'boot accepted the provider').not.toBeNull();
    expect(messageOf(provider.error)).toContain('module.fx.crm');
  }, 60_000);

  it('[K6+] refuses a module step requiring a category its own module does not declare', async () => {
    const { error } = await boot({
      modules: [moduleOf('fx', { 'sync-docs': need({ category: 'module.fx.nothing' }) })],
    });

    expect(error, 'boot accepted the requirement').not.toBeNull();
    expect(messageOf(error)).toContain('fx');
  }, 60_000);

  it('[K6] registers the providers and categories of the modules it loaded', async () => {
    const { error } = await boot({ modules: [moduleOf('fx'), moduleOf('gx')] });
    expect(error, messageOf(error)).toBeNull();

    const registry = await import('@haive/shared/integrations');

    expect(registry.getIntegrationProvider('module.fx.crm')).toMatchObject({ id: 'module.fx.crm' });
    expect(registry.getIntegrationProvider('module.gx.crm')).toMatchObject({ id: 'module.gx.crm' });
    expect(registry.listIntegrationCategories().map((category) => category.id)).toEqual(
      expect.arrayContaining(['module.fx.docs', 'module.gx.docs']),
    );
  }, 60_000);

  it('[K0] boots a module whose own step requires a category and a provider the module declares', async () => {
    const { error } = await boot({
      modules: [moduleOf('fx', { 'sync-docs': NEEDS_DOCS, 'sync-crm': NEEDS_CRM })],
    });

    expect(error, messageOf(error)).toBeNull();
  }, 60_000);

  it('[K0] boots a core step requiring a core category, with a provider or with none', async () => {
    const { error } = await boot({
      core: {
        [CORE_STEP]: need({ category: 'forge' }),
        '03-phase-0a-discovery': need({ category: 'issues' }),
      },
    });

    expect(error, messageOf(error)).toBeNull();
  }, 60_000);

  it('[K0] counts the category of a deactivated module as declared', async () => {
    const { error } = await boot({
      modules: [moduleOf('fx')],
      core: { [CORE_STEP]: NEEDS_DOCS },
      deactivated: ['fx'],
    });

    expect(error, messageOf(error)).toBeNull();
  }, 60_000);
});
