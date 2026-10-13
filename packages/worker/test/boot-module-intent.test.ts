import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';

const calls: string[] = [];
const loaded = [{ manifest: { id: 'alpha' }, composable: [] }];

vi.mock('../src/modules.generated.js', () => ({ moduleRegistry: [] }));
vi.mock('../src/redis.js', () => ({ getRedis: () => ({}) }));
vi.mock('../src/step-engine/step-catalog.js', () => ({
  syncStepCatalog: async () => void calls.push('catalog'),
}));
vi.mock('../src/step-engine/task-type-seed.js', () => ({
  syncTaskTypeDefinitions: async () => void calls.push('taskTypes'),
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
  publishWorkerBootReport: async () => void calls.push('report'),
}));

describe('bootStepEngine module intent', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('records module intent after the schemas are ensured and before the boot report', async () => {
    const { bootStepEngine } = await import('../src/step-engine/boot.js');
    await bootStepEngine({} as Database);
    expect(calls).toEqual(['catalog', 'taskTypes', 'schemas', 'intent', 'report']);
  });
});
