import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { MODULES_LOADED_WORKER_KEY } from '@haive/shared/modularity';
import {
  publishWorkerBootReport,
  registerModuleSteps,
  type ModuleTaskTypeOutcome,
  type WorkerModuleEntry,
} from '../src/modules/loader.js';
import { StepRegistry } from '../src/step-engine/registry.js';
import type { StepDefinition } from '../src/step-engine/step-definition.js';

function step(id: string): StepDefinition {
  return { metadata: { id, workflowType: 'x', title: id } } as unknown as StepDefinition;
}

const seed = (stepIds: string[] | null, over: Record<string, unknown> = {}) => ({
  slug: 'weekly',
  displayName: 'Weekly report',
  runListStrategy: 'static',
  stepIds,
  selectable: true,
  requiresRepository: false,
  ...over,
});

function entryFor(taskTypes: unknown[], localSteps: string[] = ['report']): WorkerModuleEntry {
  return {
    packageName: '@haive/module-fx',
    manifest: { id: 'fx', name: 'Fixture', version: '1.0.0', schemaVersion: 1, taskTypes },
    steps: localSteps.map(step),
  };
}

const load = (entry: WorkerModuleEntry) => registerModuleSteps(new StepRegistry(), [entry]);

describe('module task type seeds at load', () => {
  it('fails the boot naming the module, the task type and the step when a seed names an own step the module did not register', () => {
    expect(() => load(entryFor([seed(['module.fx.report', 'module.fx.missing'])]))).toThrow(
      'Module fx task type "weekly" step "module.fx.missing" is not one of its steps',
    );
  });

  it('names the first of several seeds that is wrong', () => {
    expect(() =>
      load(entryFor([seed(['module.fx.report']), seed(['module.fx.gone'], { slug: 'daily' })])),
    ).toThrow(/Module fx task type "daily" step "module.fx.gone" is not one of its steps/);
  });

  it('loads a seed whose own steps are all registered, and keeps it on the manifest', () => {
    const [loaded] = load(
      entryFor([seed(['module.fx.report', 'module.fx.send'])], ['report', 'send']),
    );
    expect(loaded!.manifest.taskTypes?.map((t) => t.slug)).toEqual(['weekly']);
    expect(loaded!.stepIds).toEqual(['module.fx.report', 'module.fx.send']);
  });

  it('does not check a core id at boot: a renamed core step is not a crash', () => {
    const [loaded] = load(
      entryFor([seed(['01-env-detect', 'no-such-core-step', 'module.fx.report'])]),
    );
    expect(loaded!.manifest.taskTypes).toHaveLength(1);
  });

  it('loads a module that declares no task types', () => {
    const [loaded] = load({
      ...entryFor([]),
      manifest: { id: 'fx', name: 'F', version: '1', schemaVersion: 1 },
    });
    expect(loaded!.manifest.taskTypes).toBeUndefined();
  });

  it('refuses a seed the manifest forbids, naming the module and the slug', () => {
    expect(() => load(entryFor([seed(null, { runListStrategy: 'workflow_paths' })]))).toThrow(
      /Invalid manifest in module @haive\/module-fx: taskTypes\.0: task type "weekly"/,
    );
    expect(() => load(entryFor([seed(['module.gx.report'])]))).toThrow(
      /Invalid manifest in module @haive\/module-fx: .*"weekly".*module\.gx\.report/,
    );
    expect(() => load(entryFor([seed(['custom.mine.step'])]))).toThrow(
      /Invalid manifest in module @haive\/module-fx: .*"weekly".*custom\.mine\.step/,
    );
  });
});

describe('the worker boot report', () => {
  async function published(taskTypes: Record<string, ModuleTaskTypeOutcome>) {
    const writes: [string, string][] = [];
    const redis = {
      set: async (key: string, value: string) => void writes.push([key, value]),
    } as unknown as Redis;
    const loaded = registerModuleSteps(new StepRegistry(), [
      entryFor([seed(['module.fx.report'])]),
      {
        packageName: '@haive/module-gx',
        manifest: { id: 'gx', name: 'G', version: '1', schemaVersion: 1 },
      },
    ]);
    await publishWorkerBootReport(redis, loaded, { fx: 'none', gx: 'none' }, taskTypes);
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe(MODULES_LOADED_WORKER_KEY);
    return JSON.parse(writes[0]![1]) as {
      modules: { id: string; taskTypes: unknown }[];
    };
  }

  it("carries each module's seeded slugs and the slugs it could not take", async () => {
    const report = await published({
      fx: { seeded: ['fx__weekly'], conflicts: [{ slug: 'fx__daily', heldBy: 'admin' }] },
    });
    expect(report.modules.map((m) => m.id)).toEqual(['fx', 'gx']);
    expect(report.modules[0]!.taskTypes).toEqual({
      seeded: ['fx__weekly'],
      conflicts: [{ slug: 'fx__daily', heldBy: 'admin' }],
    });
  });

  it('carries the seeds the checks refused, with each problem', async () => {
    const invalid = [
      { slug: 'fx__bad', issues: [{ kind: 'unknown-step' as const, index: 0, stepId: 'gone' }] },
    ];
    const report = await published({ fx: { seeded: [], conflicts: [], invalid } });
    expect(report.modules[0]!.taskTypes).toEqual({ seeded: [], conflicts: [], invalid });
  });

  it('gives a module the seed said nothing about empty lists', async () => {
    const report = await published({ fx: { seeded: ['fx__weekly'], conflicts: [] } });
    expect(report.modules[1]!.taskTypes).toEqual({ seeded: [], conflicts: [] });
  });
});
