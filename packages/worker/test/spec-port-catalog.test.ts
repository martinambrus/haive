import { expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { SPEC_ROLES, STEP_ROLE_REGISTRY } from '@haive/shared/step-outputs';
import { composableStepEntrySchema } from '@haive/shared/modularity';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';
import { syncStepCatalog } from '../src/step-engine/step-catalog.js';
import type { StepRegistry } from '../src/step-engine/registry.js';

it('writes only base-compatible entries to the actual catalog persistence boundary', async () => {
  const writes: { stepId: string; entry: unknown }[] = [];
  const tx = {
    insert: () => ({
      values: (row: (typeof writes)[number]) => {
        writes.push(row);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
    delete: () => ({ where: async () => undefined }),
  };
  const db = { transaction: async (fn: (handle: typeof tx) => Promise<void>) => fn(tx) };
  const registry = {
    all: () =>
      Object.values(SPEC_ROLES).map((role) => ({
        metadata: {
          id: STEP_ROLE_REGISTRY[role].legacyStepId,
          workflowType: 'workflow',
          title: 'Spec',
          index: 4,
        },
      })),
  };
  await syncStepCatalog(db as unknown as Database, registry as unknown as StepRegistry);
  expect(writes).toHaveLength(3);
  for (const row of writes) {
    const source = CORE_COMPOSABLE_STEPS.find((e) => e.stepId === row.stepId)!;
    expect(row.entry).toEqual(composableStepEntrySchema.parse(source));
    expect(JSON.stringify(row.entry)).not.toContain('haive.spec.');
    expect(row.entry).not.toHaveProperty('outputContract');
    expect(row.entry).not.toHaveProperty('providesRoles');
    expect(row.entry).not.toHaveProperty('consumesRoles');
  }
});
