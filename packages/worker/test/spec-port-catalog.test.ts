import { expect, it } from 'vitest';
import type { Database } from '@haive/database';
import {
  SPEC_ROLES,
  STEP_ROLE_REGISTRY,
  STEP_ROLES,
  CODE_REVIEW_OUTPUT_CONTRACT,
} from '@haive/shared/step-outputs';
import { composableStepEntrySchema } from '@haive/shared/modularity';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';
import { syncStepCatalog } from '../src/step-engine/step-catalog.js';
import { assertStepOutputDeclaration } from '../src/step-engine/step-output-contract.js';
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

it('preserves review/audit capability metadata at catalog sync for core and module producers', async () => {
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
  const moduleEntry = {
    stepId: 'module.demo.review',
    label: 'Review',
    group: 'review',
    dispatchesCli: false,
    requires: [],
    provides: ['review'],
    outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
    replaces: [STEP_ROLES.codeReview],
  };
  const defs = [
    { id: STEP_ROLES.codeReview, outputContract: CODE_REVIEW_OUTPUT_CONTRACT },
    {
      id: moduleEntry.stepId,
      outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
      replaces: [STEP_ROLES.codeReview],
    },
  ].map(({ id, ...fields }) => ({
    ...fields,
    metadata: { id, title: id, workflowType: 'workflow', index: 1 },
  }));
  await syncStepCatalog(
    { transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx) } as unknown as Database,
    { all: () => defs } as unknown as StepRegistry,
    new Map([[moduleEntry.stepId, moduleEntry]]),
  );
  expect(writes.find((w) => w.stepId === STEP_ROLES.codeReview)!.entry).toMatchObject({
    outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
  });
  expect(writes.find((w) => w.stepId === moduleEntry.stepId)!.entry).toMatchObject({
    outputContract: CODE_REVIEW_OUTPUT_CONTRACT,
    replaces: [STEP_ROLES.codeReview],
  });
  expect(() =>
    assertStepOutputDeclaration({ outputContract: STEP_ROLE_REGISTRY[SPEC_ROLES.draft].contract }),
  ).toThrow('step-output-contract-unknown');
});
