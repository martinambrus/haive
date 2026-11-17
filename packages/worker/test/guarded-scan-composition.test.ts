import { expect, it } from 'vitest';
import { z } from 'zod';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { SPEC_ROLES, STEP_ROLE_REGISTRY } from '@haive/shared/step-outputs';
import {
  validateComposition,
  executionContractPaths,
  moduleManifestSchema,
  type ComposableStepEntry,
  type ExecutionContract,
} from '@haive/shared/modularity';
import { dataPortNodes, dataRoleDraftIssues } from '@haive/shared/step-ports';
import { buildDataEdgePlan } from '@haive/shared/data-edge-plan';
import { CORE_COMPOSABLE_STEPS } from '../src/step-engine/composable-core.js';
import { FIX_LOOP_TARGET_STEP_ID } from '../src/step-engine/steps/workflow/_fix-loop.js';
import { syncTaskTypeDefinitions } from '../src/step-engine/task-type-seed.js';
import { StepRegistry } from '../src/step-engine/registry.js';
import type { LoadedWorkerModule } from '../src/modules/loader.js';

const moduleStep = (
  name: string,
  extra: Partial<ComposableStepEntry> = {},
): ComposableStepEntry => ({
  stepId: `module.scan.${name}`,
  label: name,
  group: 'scan',
  dispatchesCli: false,
  requires: [],
  provides: [],
  ...extra,
});
// The intended seed is a validation fixture only. No executable module/type is installed.
const steps = [
  ...[
    'scan-config',
    'scan-scope',
    'scan-analyze',
    'scan-verify',
    'scan-triage',
    'scan-plan-remediation',
  ].map((name) => moduleStep(name)),
  moduleStep('scan-remediate', {
    requires: [{ needs: 'worktree', reason: 'DAG integration tree' }],
    provides: ['implementation'],
  }),
  moduleStep('scan-fix', {
    requires: [{ needs: 'worktree', reason: 'Fix rounds edit integration tree' }],
    removes: ['clean-tree'],
    fixConsumer: { version: 1 },
  }),
  moduleStep('scan-report'),
];
const catalog = new Map([...CORE_COMPOSABLE_STEPS, ...steps].map((e) => [e.stepId, e]));
const ids = [
  ...steps.slice(0, 6).map((s) => s.stepId),
  '00a-sync-base',
  '01-worktree-setup',
  'module.scan.scan-remediate',
  'module.scan.scan-fix',
  '07b-phase-4-validate',
  '08b-test-management',
  '08-phase-5-verify',
  '08c-code-review',
  '09-gate-2-verify-approval',
  '10-gate-3-commit',
  '11-phase-8-learning',
  '11b-kb-commit',
  '12-worktree-cleanup',
  '12-no-change-cleanup',
  'module.scan.scan-report',
];
const predicates = new Map([
  [
    'module.scan.planned',
    {
      argsSchema: z.strictObject({
        producerStepId: z.literal('module.scan.scan-plan-remediation'),
      }),
    },
  ],
  [
    'module.scan.merged',
    { argsSchema: z.strictObject({ producerStepId: z.literal('module.scan.scan-remediate') }) },
  ],
]);
const executionContract: ExecutionContract = {
  version: 1,
  guardedSpans: [
    {
      id: 'planned',
      firstStepId: '00a-sync-base',
      lastStepId: 'module.scan.scan-remediate',
      predicateId: 'module.scan.planned',
      args: { producerStepId: 'module.scan.scan-plan-remediation' },
    },
    {
      id: 'merged',
      firstStepId: 'module.scan.scan-fix',
      lastStepId: '12-worktree-cleanup',
      predicateId: 'module.scan.merged',
      args: { producerStepId: 'module.scan.scan-remediate' },
      requiresSpan: 'planned',
    },
    {
      id: 'no-change',
      firstStepId: '12-no-change-cleanup',
      lastStepId: '12-no-change-cleanup',
      predicateId: 'module.scan.merged',
      args: { producerStepId: 'module.scan.scan-remediate' },
      when: false,
      requiresSpan: 'planned',
    },
  ],
  fixTarget: { stepId: 'module.scan.scan-fix', capabilityVersion: 1 },
};
it('accepts the real scan shape with both exclusive cleanup paths and an always reachable report', () => {
  expect(validateComposition(ids, catalog, { executionContract, predicates })).toEqual([]);
  expect(
    dataRoleDraftIssues([{ executionPath: null, stepIds: ids }], catalog, [], {
      executionContract,
      catalog,
      predicates,
    }),
  ).toEqual([]);
  const plan = buildDataEdgePlan(
    'static',
    [{ executionPath: null, nodes: dataPortNodes(ids, {}, catalog) }],
    undefined,
    { executionContract, catalog, predicates },
  );
  expect(plan.candidates[0]!.nodes.map((n) => n.id)).toEqual(ids);
  const paths = executionContractPaths(ids, catalog, executionContract, predicates);
  expect(paths).toHaveLength(3);
  expect(paths.every((p) => p.at(-1) === 'module.scan.scan-report')).toBe(true);
  expect(
    paths
      .filter((p) => p.includes('01-worktree-setup'))
      .map((p) => p.filter((id) => id.includes('cleanup'))),
  ).toEqual([['12-no-change-cleanup'], ['12-worktree-cleanup']]);
  // A blanket ban on guarded producers serving a different span would wrongly
  // reject setup -> no-change cleanup. requiresSpan proves that edge instead.
  expect(
    paths.some(
      (p) =>
        p.includes('12-no-change-cleanup') &&
        p.includes('01-worktree-setup') &&
        !p.includes('module.scan.scan-fix'),
    ),
  ).toBe(true);
});
it('rejects weakening either cleanup guard and retains the normal cleanup commit requirement', () => {
  for (const change of ['both-cleanups', 'independent-cleanup', 'missing-commit'] as const) {
    const c = structuredClone(executionContract);
    if (change === 'both-cleanups') c.guardedSpans[2]!.when = true;
    if (change === 'independent-cleanup') delete c.guardedSpans[2]!.requiresSpan;
    if (change === 'missing-commit') c.guardedSpans[1]!.lastStepId = '11b-kb-commit';
    expect(
      validateComposition(ids, catalog, { executionContract: c, predicates }),
      change,
    ).not.toEqual([]);
  }
});
it('pins the shared composition emitter target to the worker fix-loop constant', () => {
  const emitter = moduleStep('emit', { loopTargetStepId: FIX_LOOP_TARGET_STEP_ID });
  const target = moduleStep('target', { fixConsumer: { version: 1 } });
  expect(
    validateComposition(
      [target.stepId, emitter.stepId],
      new Map([target, emitter].map((e) => [e.stepId, e])),
      {
        executionContract: {
          version: 1,
          guardedSpans: [],
          fixTarget: { stepId: target.stepId, capabilityVersion: 1 },
        },
      },
    ),
  ).toEqual([]);
});

it('the actual seed path rejects independently skipped data producers and accepts requiresSpan', async () => {
  const role = SPEC_ROLES.draft;
  const contract = STEP_ROLE_REGISTRY[role].contract;
  const producer = moduleStep('producer', { providesRoles: [{ role, contract }] });
  const consumer = moduleStep('consumer', {
    consumesRoles: [{ input: 'spec', role, contract, optional: false }],
  });
  const report = moduleStep('report');
  const composable = [producer, consumer, report];
  const spans: ExecutionContract['guardedSpans'] = [
    {
      id: 'producer',
      firstStepId: producer.stepId,
      lastStepId: producer.stepId,
      predicateId: 'module.scan.planned',
      args: {},
    },
    {
      id: 'consumer',
      firstStepId: consumer.stepId,
      lastStepId: consumer.stepId,
      predicateId: 'module.scan.merged',
      args: {},
    },
  ];
  const seed = (slug: string, safe: boolean) => ({
    slug,
    displayName: slug,
    selectable: true,
    runListStrategy: 'static',
    stepIds: composable.map((e) => e.stepId),
    requiresRepository: false,
    executionContract: {
      version: 1,
      guardedSpans: spans.map((s) =>
        s.id === 'consumer' && safe ? { ...s, requiresSpan: 'producer' } : s,
      ),
    },
  });
  const loaded: LoadedWorkerModule = {
    packageName: '@haive/module-scan',
    stepIds: composable.map((e) => e.stepId),
    composable,
    manifest: moduleManifestSchema.parse({
      id: 'scan',
      name: 'Scan',
      version: '1.0.0',
      schemaVersion: 1,
      taskTypes: [seed('unsafe', false), seed('safe', true)],
    }),
    predicates: new Map(
      ['planned', 'merged'].map((name) => [
        `module.scan.${name}`,
        { argsSchema: z.strictObject({}), evaluate: async () => true },
      ]),
    ),
  };
  const fake = createFakeDb({ taskTypeDefinitions: schema.taskTypeDefinitions });
  // This control exercises validation before the first module INSERT. Upsert SQL
  // is covered on Postgres elsewhere; fake-db cannot parse excluded-column SQL.
  const db = {
    transaction: (run: (tx: unknown) => Promise<unknown>) =>
      fake.db.transaction((tx) =>
        run({
          ...tx,
          insert: (table: typeof schema.taskTypeDefinitions) => ({
            values: (row: typeof schema.taskTypeDefinitions.$inferInsert) => ({
              onConflictDoUpdate: (
                opts: Parameters<
                  ReturnType<ReturnType<typeof tx.insert>['values']>['onConflictDoUpdate']
                >[0],
              ) =>
                tx
                  .insert(table)
                  .values(row)
                  .onConflictDoUpdate({ ...opts, setWhere: undefined }),
            }),
          }),
        }),
      ),
  };
  const result = await syncTaskTypeDefinitions(db as never, new StepRegistry(), [loaded]);
  expect(result.scan).toMatchObject({
    seeded: ['scan__safe'],
    invalid: [
      {
        slug: 'scan__unsafe',
        issues: [
          expect.objectContaining({
            kind: 'invalid-data-role-binding',
            stepId: consumer.stepId,
            input: 'spec',
          }),
        ],
      },
    ],
  });
  expect(fake.rows(schema.taskTypeDefinitions).some((r) => r.slug === 'scan__unsafe')).toBe(false);
});
