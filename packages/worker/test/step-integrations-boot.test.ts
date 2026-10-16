import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { ComposableStepEntry, IntegrationRequirement } from '@haive/shared/modularity';
import type { StepDefinition } from '../src/step-engine/step-definition.js';
import { realStepIntegrations } from './support/step-integrations-contract.js';

vi.mock('../src/redis.js', () => ({ getRedis: () => ({ set: async () => 'OK' }) }));
vi.mock('../src/step-engine/task-type-seed.js', () => ({
  syncTaskTypeDefinitions: async () => ({}),
}));
vi.mock('../src/modules/intent.js', () => ({ syncModuleIntent: async () => undefined }));

const DECLARED: IntegrationRequirement[] = [
  { id: 'pull-requests', category: 'forge', access: 'read' },
  { id: 'tracker', category: 'issues', access: 'write', optional: true },
];

const catalogTx = {
  insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }),
  delete: () => Object.assign(Promise.resolve(), { where: async () => undefined }),
};
const fakeDb = {
  transaction: async (fn: (tx: unknown) => unknown) => fn(catalogTx),
} as unknown as Database;

const LLM = { requiredCapabilities: ['tool_use' as const], buildPrompt: () => 'prompt' };
const MINING = { requiredCapabilities: ['tool_use' as const], selectAgents: async () => [] };
const DAG = { requiredCapabilities: ['tool_use' as const], buildCoderPrompt: () => 'prompt' };

interface Shape {
  spec: Partial<StepDefinition>;
  dispatchesCli: boolean;
}

const step = (localId: string, spec: Partial<StepDefinition>): StepDefinition =>
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
    ...spec,
  }) as unknown as StepDefinition;

const UNDELIVERABLE: Record<string, Shape> = {
  'bad-no-phase': { spec: {}, dispatchesCli: false },
  'bad-llm-rag-only': { spec: { llm: { ...LLM, toolProfile: 'rag_only' } }, dispatchesCli: true },
  'bad-llm-none': { spec: { llm: { ...LLM, toolProfile: 'none' } }, dispatchesCli: true },
  'bad-mining-rag-only': {
    spec: { agentMining: { ...MINING, toolProfile: 'rag_only' } },
    dispatchesCli: true,
  },
  'bad-every-spec-narrowed': {
    spec: {
      llm: { ...LLM, toolProfile: 'rag_only' },
      agentMining: { ...MINING, toolProfile: 'none' },
    },
    dispatchesCli: true,
  },
  'bad-dag-only': { spec: { dagExecute: DAG }, dispatchesCli: true },
};

const DELIVERABLE: Record<string, Shape> = {
  'ok-llm': { spec: { llm: LLM }, dispatchesCli: true },
  'ok-mining': { spec: { agentMining: MINING }, dispatchesCli: true },
  'ok-llm-and-mining': { spec: { llm: LLM, agentMining: MINING }, dispatchesCli: true },
  'ok-one-spec-open': {
    spec: { llm: { ...LLM, toolProfile: 'rag_only' }, agentMining: MINING },
    dispatchesCli: true,
  },
};

const entry = (
  localId: string,
  dispatchesCli: boolean,
  integrations?: IntegrationRequirement[],
): ComposableStepEntry => ({
  stepId: localId,
  label: localId,
  group: 'g',
  dispatchesCli,
  requires: [],
  provides: [],
  ...(integrations === undefined ? {} : { integrations }),
});

interface BootCase {
  shapes: Record<string, Shape>;
  declare: readonly string[];
  core?: Record<string, IntegrationRequirement[]>;
}

async function boot(bootCase: BootCase): Promise<{ error: unknown }> {
  vi.resetModules();
  const names = Object.keys(bootCase.shapes);
  vi.doMock('../src/modules.generated.js', () => ({
    moduleRegistry:
      names.length === 0
        ? []
        : [
            {
              packageName: '@haive/module-fx',
              manifest: {
                id: 'fx',
                name: 'Fixture',
                version: '1.0.0',
                schemaVersion: 1,
                composableSteps: names.map((name) =>
                  entry(
                    name,
                    bootCase.shapes[name]!.dispatchesCli,
                    bootCase.declare.includes(name) ? DECLARED : undefined,
                  ),
                ),
              },
              steps: names.map((name) => step(name, bootCase.shapes[name]!.spec)),
            },
          ],
  }));
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
const namedStepStepDef = (id: string) =>
  ({ metadata: { id, workflowType: 'x', index: 0, title: id } }) as unknown as StepDefinition;

const CORE_UNDELIVERABLE = [
  ['no llm and no mining', '01-declare-deps'],
  ['only a merge fixer', '12-worktree-cleanup'],
  ['an llm narrowed to none', '10-gate-3-commit'],
  ['only a mining fan-out narrowed to rag_only', '11d-skill-sync'],
] as const;
const CORE_DELIVERABLE = [
  ['an open llm', '04-phase-0b-pre-planning'],
  ['an open llm beside a narrowed mining fan-out', '03-phase-0a-discovery'],
] as const;

describe('[D2] boot refuses a declaration no dispatch can carry', () => {
  it('[D2] the fixtures themselves boot when nothing declares anything', async () => {
    const { error } = await boot({
      shapes: { ...UNDELIVERABLE, ...DELIVERABLE },
      declare: [],
    });

    expect(error, messageOf(error)).toBeNull();
  }, 60_000);

  it.each(Object.keys(UNDELIVERABLE))(
    '[D2] refuses a module step declaring integrations on %s, naming the step',
    async (name) => {
      const withoutDeclaration = await boot({
        shapes: { [name]: UNDELIVERABLE[name]! },
        declare: [],
      });
      expect(withoutDeclaration.error, messageOf(withoutDeclaration.error)).toBeNull();

      const { error } = await boot({ shapes: { [name]: UNDELIVERABLE[name]! }, declare: [name] });

      expect(error, 'boot accepted the declaration').not.toBeNull();
      expect(messageOf(error)).toContain(name);
    },
    60_000,
  );

  it.each(CORE_UNDELIVERABLE)(
    '[D2] refuses a core entry declaring integrations on a step with %s, naming the step',
    async (_shape, stepId) => {
      const { error } = await boot({ shapes: {}, declare: [], core: { [stepId]: DECLARED } });

      expect(error, 'boot accepted the declaration').not.toBeNull();
      expect(messageOf(error)).toContain(stepId);
    },
    60_000,
  );

  it('[D2] boots when every declaration sits on a step that can carry it', async () => {
    const { error } = await boot({
      shapes: DELIVERABLE,
      declare: Object.keys(DELIVERABLE),
      core: Object.fromEntries(CORE_DELIVERABLE.map(([, stepId]) => [stepId, DECLARED])),
    });

    expect(error, messageOf(error)).toBeNull();
  }, 60_000);

  it('[D2] hands the declarations of the core and module entries it booted to the reader', async () => {
    const { error } = await boot({
      shapes: { ...DELIVERABLE, 'quiet-rag-only': UNDELIVERABLE['bad-llm-rag-only']! },
      declare: Object.keys(DELIVERABLE),
      core: Object.fromEntries(CORE_DELIVERABLE.map(([, stepId]) => [stepId, DECLARED])),
    });
    expect(error, messageOf(error)).toBeNull();

    const reader = await realStepIntegrations();
    for (const name of Object.keys(DELIVERABLE)) {
      expect(reader.stepIntegrationRequirements(namedStepStepDef(`module.fx.${name}`))).toEqual(
        DECLARED,
      );
    }
    for (const [, stepId] of CORE_DELIVERABLE) {
      expect(reader.stepIntegrationRequirements(namedStepStepDef(stepId))).toEqual(DECLARED);
    }
    expect(
      reader.stepIntegrationRequirements(namedStepStepDef('module.fx.quiet-rag-only')),
    ).toEqual([]);
    expect(reader.stepIntegrationRequirements(namedStepStepDef('01-declare-deps'))).toEqual([]);
  }, 60_000);
});
