import { describe, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  CODE_AUDIT_OUTPUT_CONTRACT as audit,
  CODE_REVIEW_OUTPUT_CONTRACT as review,
} from '@haive/shared/step-outputs';
import { composableStepEntrySchema, type ComposableStepEntry } from '@haive/shared/modularity';
import type { StepDefinition } from '@haive/shared/step';
import { registerModuleSteps, type WorkerModuleEntry } from '../src/modules/loader.js';
import { StepRegistry } from '../src/step-engine/registry.js';
import { syncStepCatalog } from '../src/step-engine/step-catalog.js';
import { codeReviewStep } from '../src/step-engine/steps/workflow/08c-code-review.js';
import { codeAuditStep } from '../src/step-engine/steps/workflow/08c2-code-audit.js';

const declaration = { outputContract: audit, replaces: ['08c2-code-audit'] as const };
const manifestEntry = (): ComposableStepEntry => ({
  stepId: 'audit',
  label: 'Audit',
  group: 'check',
  requires: [],
  provides: ['code-audit'],
  dispatchesCli: false,
  ...declaration,
  replaces: [...declaration.replaces],
});
const step = (): StepDefinition => ({
  metadata: {
    id: 'audit',
    title: 'Audit',
    description: '',
    index: 0,
    workflowType: 'fixture',
    requiresCli: false,
  },
  ...declaration,
  apply: async () => ({ audited: true, findings: [], coverage: null }),
});
function moduleEntry(
  entry: object = manifestEntry(),
  def: StepDefinition = step(),
): WorkerModuleEntry {
  return {
    packageName: '@haive/module-fx',
    manifest: {
      id: 'fx',
      name: 'Fixture',
      version: '1',
      schemaVersion: 1,
      composableSteps: [entry],
    },
    steps: [def],
  };
}
describe('contract declaration and catalog metadata', () => {
  it('serializes the exact executable/core/module references into existing catalog entries', async () => {
    const registry = new StepRegistry();
    registry.register(codeReviewStep);
    registry.register(codeAuditStep);
    const [loaded] = registerModuleSteps(registry, [moduleEntry()]);
    const fake = createFakeDb({ stepCatalog: schema.stepCatalog });
    await syncStepCatalog(
      fake.db as unknown as Database,
      registry,
      new Map(loaded!.composable.map((e) => [e.stepId, e])),
    );
    const entries = new Map(
      fake.rows(schema.stepCatalog).map((row) => [row.stepId, row.entry as ComposableStepEntry]),
    );
    expect(entries.get('08c-code-review')?.outputContract).toEqual(review);
    expect(entries.get('08c2-code-audit')?.outputContract).toEqual(audit);
    expect(entries.get('module.fx.audit')).toMatchObject({
      stepId: 'module.fx.audit',
      outputContract: audit,
      replaces: ['08c2-code-audit'],
    });
  });
  it.each([
    { id: audit.id, version: 2 },
    { id: 'module.fx.contract', version: 1 },
    { ...audit, validator: {} },
  ])(
    'refuses unknown or supplied validators in the executable and manifest: %#',
    (outputContract) => {
      expect(
        composableStepEntrySchema.safeParse({ ...manifestEntry(), outputContract }).success,
      ).toBe(false);
      expect(() =>
        new StepRegistry().register({ ...step(), outputContract } as StepDefinition),
      ).toThrow('step-output-contract-unknown');
    },
  );
  it.each([{ outputContract: review }, { outputContract: undefined }, { replaces: [] }])(
    'refuses executable/manifest disagreement: %#',
    (patch) => {
      expect(() =>
        registerModuleSteps(new StepRegistry(), [moduleEntry({ ...manifestEntry(), ...patch })]),
      ).toThrow('output declaration does not match its manifest');
    },
  );
  it('rejects an undeclared role or a mismatched role contract', () => {
    expect(() => new StepRegistry().register({ ...step(), outputContract: review })).toThrow(
      'step-output-contract-mismatch',
    );
    expect(() =>
      new StepRegistry().register({
        ...step(),
        replaces: ['09-gate-2-verify-approval'],
      } as unknown as StepDefinition),
    ).toThrow('step-output-role-invalid');
  });
});
