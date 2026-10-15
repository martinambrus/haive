import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const calls: string[] = [];
const loaded = [{ manifest: { id: 'alpha' }, composable: [] }];
const taskTypes = { alpha: { seeded: [], conflicts: [] } };
let seedArgs: unknown[] = [];
let reportArgs: unknown[] = [];

vi.mock('../src/modules.generated.js', () => ({ moduleRegistry: [] }));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../src/step-engine/step-catalog.js', () => ({
  syncStepCatalog: async () => void calls.push('catalog'),
}));
vi.mock('../src/step-engine/task-type-seed.js', () => ({
  syncTaskTypeDefinitions: async (...args: unknown[]) => {
    calls.push('taskTypes');
    seedArgs = args;
    return taskTypes;
  },
}));
vi.mock('../src/modules/activation.js', () => ({
  deactivatedModuleIds: async () => new Set<string>(),
}));
vi.mock('../src/modules/intent.js', () => ({
  syncModuleIntent: async (_db: unknown, l: unknown) => {
    calls.push('intent');
    expect(l).toBe(loaded);
  },
}));
vi.mock('../src/modules/loader.js', () => ({
  registerModuleSteps: () => loaded,
  ensureModuleSchemas: async () => {
    calls.push('schemas');
    return {};
  },
  publishWorkerBootReport: async (...args: unknown[]) => {
    calls.push('report');
    reportArgs = args;
  },
}));

describe('bootStepEngine module intent', () => {
  beforeAll(async () => {
    await import('../src/step-engine/boot.js');
  }, 120_000);

  beforeEach(() => {
    calls.length = 0;
  });

  it('records module intent after the schemas are ensured and before the task types are seeded', async () => {
    const { bootStepEngine } = await import('../src/step-engine/boot.js');
    await bootStepEngine({} as Database);
    expect(calls).toEqual(['catalog', 'schemas', 'intent', 'taskTypes', 'report']);
  });

  it('seeds task types from the loaded modules and reports what they seeded', async () => {
    const { bootStepEngine } = await import('../src/step-engine/boot.js');
    await bootStepEngine({} as Database);
    expect(seedArgs[2]).toBe(loaded);
    expect(reportArgs[3]).toBe(taskTypes);
  });
});
