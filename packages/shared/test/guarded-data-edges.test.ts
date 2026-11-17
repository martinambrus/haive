import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dataPortNodes, dataRoleDraftIssues } from '../src/step-engine/step-ports.js';
import {
  buildDataEdgePlan,
  parseDataEdgePlan,
  resolveDataInput,
} from '../src/step-engine/data-edge-plan.js';
import { SPEC_ROLES, STEP_ROLE_REGISTRY } from '../src/step-engine/output-contracts.js';
import { validateComposition } from '../src/modularity/composition.js';
import { resolveTaskTypeAvailability } from '../src/modularity/task-types.js';
import type { ComposableStepEntry } from '../src/modularity/contracts.js';
import type { ExecutionContract } from '../src/modularity/execution-contract.js';

const role = SPEC_ROLES.draft;
const contract = STEP_ROLE_REGISTRY[role].contract;
const entry = (stepId: string, extra: Partial<ComposableStepEntry> = {}): ComposableStepEntry => ({
  stepId,
  label: stepId,
  group: 'test',
  dispatchesCli: false,
  requires: [],
  provides: [],
  ...extra,
});
const producer = 'module.scan.producer';
const consumer = 'module.scan.consumer';
const report = 'module.scan.report';
const span = (
  id: string,
  stepId: string,
  predicateId = 'module.scan.planned',
): ExecutionContract['guardedSpans'][number] => ({
  id,
  firstStepId: stepId,
  lastStepId: stepId,
  predicateId,
  args: {},
});
const evaluate = vi.fn(() => {
  throw new Error('validation must not execute');
});
const predicates = new Map([
  ['module.scan.planned', { argsSchema: z.strictObject({}), evaluate }],
  ['module.scan.merged', { argsSchema: z.strictObject({}), evaluate }],
]);
function fixture(optional = false) {
  const ids = [producer, consumer, report];
  const catalog = new Map(
    [
      entry(producer, { providesRoles: [{ role, contract }] }),
      entry(consumer, { consumesRoles: [{ input: 'spec', role, contract, optional }] }),
      entry(report),
    ].map((e) => [e.stepId, e]),
  );
  return { ids, catalog, candidates: [{ executionPath: null, stepIds: ids }] };
}
const guarded = (guardedSpans: ExecutionContract['guardedSpans']): ExecutionContract => ({
  version: 1 as const,
  guardedSpans,
});

describe('guarded immutable data edges', () => {
  it.each([false, true])(
    'rejects a pinned producer that can skip independently (optional=%s)',
    (optional) => {
      const f = fixture(optional);
      const options = {
        executionContract: guarded([span('p', producer)]),
        catalog: f.catalog,
        predicates,
      };
      expect(dataRoleDraftIssues(f.candidates, f.catalog, [], options)).toEqual([
        expect.objectContaining({
          stepId: consumer,
          input: 'spec',
          message: expect.stringContaining('skip'),
        }),
      ]);
      expect(() =>
        buildDataEdgePlan(
          'static',
          [{ executionPath: null, nodes: dataPortNodes(f.ids, {}, f.catalog) }],
          undefined,
          options,
        ),
      ).toThrow('skip');
      expect(evaluate).not.toHaveBeenCalled();
    },
  );
  it('honours shared decisions and requiresSpan without recomputing the selected edge', () => {
    const f = fixture();
    const c = guarded([
      span('p', producer),
      { ...span('c', consumer, 'module.scan.merged'), requiresSpan: 'p' },
    ]);
    const options = { executionContract: c, catalog: f.catalog, predicates };
    const bindings = [
      { executionPath: null, consumerStepId: consumer, input: 'spec', producerStepId: producer },
    ];
    expect(dataRoleDraftIssues(f.candidates, f.catalog, bindings, options)).toEqual([]);
    delete c.guardedSpans[1]!.requiresSpan;
    expect(dataRoleDraftIssues(f.candidates, f.catalog, bindings, options)).not.toEqual([]);
    c.guardedSpans[1] = span('c', consumer);
    expect(dataRoleDraftIssues(f.candidates, f.catalog, bindings, options)).toEqual([]);
  });
  it('checks every feasible path and refuses unknown predicates and args without executable evaluation', () => {
    const f = fixture();
    for (const s of [
      span('p', producer, 'module.scan.unknown'),
      { ...span('p', producer), args: { sql: 'SELECT 1' } },
    ]) {
      expect(
        dataRoleDraftIssues(f.candidates, f.catalog, [], {
          executionContract: guarded([s]),
          catalog: f.catalog,
          predicates,
        }),
      ).not.toEqual([]);
    }
    expect(
      dataRoleDraftIssues(f.candidates, f.catalog, [], {
        executionContract: guarded([span('p', producer)]),
        catalog: f.catalog,
      }),
    ).not.toEqual([]);
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('does not reselect another producer on a guarded path or excuse an invalid explicit choice', () => {
    const f = fixture();
    f.ids.unshift('module.scan.alternative');
    f.catalog.set(f.ids[0]!, entry(f.ids[0]!, { providesRoles: [{ role, contract }] }));
    const bindings = [
      { executionPath: null, consumerStepId: consumer, input: 'spec', producerStepId: producer },
    ];
    const options = {
      executionContract: guarded([span('p', producer)]),
      catalog: f.catalog,
      predicates,
    };
    expect(dataRoleDraftIssues(f.candidates, f.catalog, bindings, options)).not.toEqual([]);
    expect(
      dataRoleDraftIssues(
        f.candidates,
        f.catalog,
        [{ ...bindings[0]!, producerStepId: report }],
        options,
      ),
    ).not.toEqual([]);
  });
  it('keeps optional absence and existing pin bytes after declarations change', () => {
    const f = fixture(true);
    const nodes = dataPortNodes([consumer, report], {}, f.catalog);
    const options = {
      executionContract: guarded([span('c', consumer)]),
      catalog: f.catalog,
      predicates,
    };
    const pin = buildDataEdgePlan('static', [{ executionPath: null, nodes }], undefined, options);
    const bytes = JSON.stringify(pin);
    f.catalog.set(producer, entry(producer, { providesRoles: [{ role, contract }] }));
    expect(resolveDataInput({ dataEdgePlan: pin }, consumer, 'spec').state).toBe('absent');
    expect(JSON.stringify(parseDataEdgePlan(pin))).toBe(bytes);
  });
  it('still rejects dangling required inputs even when their consumer is guarded', () => {
    const f = fixture();
    expect(
      dataRoleDraftIssues([{ executionPath: null, stepIds: [consumer, report] }], f.catalog, [], {
        executionContract: guarded([span('c', consumer)]),
        catalog: f.catalog,
        predicates,
      }),
    ).not.toEqual([]);
  });
  it('refuses an empty feasible data path, even with no required inputs', () => {
    const f = fixture();
    const options = {
      executionContract: guarded([span('r', report)]),
      catalog: f.catalog,
      predicates,
    };
    expect(() =>
      buildDataEdgePlan(
        'static',
        [{ executionPath: null, nodes: dataPortNodes([report], {}, f.catalog) }],
        undefined,
        options,
      ),
    ).toThrow('empty execution path');
  });
});

describe('contract-aware availability', () => {
  it('validates a selected capable target with trusted registration but still refuses runtime admission', () => {
    const f = fixture(true);
    f.catalog.set(producer, entry(producer, { fixConsumer: { version: 1 } }));
    f.catalog.set(consumer, entry(consumer, { loopTargetStepId: '07-phase-2-implement' }));
    const result = resolveTaskTypeAvailability({
      definition: {
        source: 'admin',
        enabled: true,
        selectable: true,
        runListStrategy: 'static',
        stepIds: f.ids,
        requiresRepository: false,
        executionContract: {
          version: 1,
          guardedSpans: [],
          fixTarget: { stepId: producer, capabilityVersion: 1 },
        },
      },
      switches: { customEnabled: true, moduleEnabled: true },
      modules: null,
      catalog: { stepIds: new Set(f.ids), composable: f.catalog },
      generic: true,
      predicates,
    });
    expect(result).toMatchObject({
      available: false,
      reason: 'invalid-composition',
      issues: [
        expect.objectContaining({
          kind: 'invalid-execution-contract',
          reason: expect.stringContaining('not yet supported'),
        }),
      ],
    });
  });
  it.each([true, false])(
    'keeps a structurally valid guarded contract fenced (trusted schemas=%s)',
    (trusted) => {
      const f = fixture();
      const c = guarded([span('p', producer), span('c', consumer)]);
      expect(
        resolveTaskTypeAvailability({
          definition: {
            source: 'admin',
            enabled: true,
            selectable: true,
            runListStrategy: 'static',
            stepIds: f.ids,
            requiresRepository: false,
            executionContract: c,
          },
          switches: { customEnabled: true, moduleEnabled: true },
          modules: null,
          catalog: { stepIds: new Set(f.ids), composable: f.catalog },
          generic: true,
          ...(trusted ? { predicates } : {}),
        }),
      ).toMatchObject({
        available: false,
        reason: 'invalid-composition',
        issues: [
          expect.objectContaining({
            kind: 'invalid-execution-contract',
            reason: expect.stringContaining('not yet supported'),
          }),
        ],
      });
    },
  );
  it('checks pinned data on guarded paths when trusted schemas are supplied', () => {
    const f = fixture();
    const result = resolveTaskTypeAvailability({
      definition: {
        source: 'admin',
        enabled: true,
        selectable: true,
        runListStrategy: 'static',
        stepIds: f.ids,
        requiresRepository: false,
        executionContract: guarded([span('p', producer)]),
      },
      switches: { customEnabled: true, moduleEnabled: true },
      modules: null,
      catalog: { stepIds: new Set(f.ids), composable: f.catalog },
      generic: true,
      predicates,
    });
    expect(result).toMatchObject({
      available: false,
      reason: 'invalid-composition',
      issues: expect.arrayContaining([
        expect.objectContaining({ kind: 'invalid-data-role-binding' }),
      ]),
    });
  });
  it('validates guarded token paths instead of the unconditional list', () => {
    const f = fixture(true);
    f.catalog.set(producer, entry(producer, { provides: ['needed'] }));
    f.catalog.set(consumer, entry(consumer, { requires: [{ needs: 'needed', reason: 'test' }] }));
    const result = resolveTaskTypeAvailability({
      definition: {
        source: 'admin',
        enabled: true,
        selectable: true,
        runListStrategy: 'static',
        stepIds: f.ids,
        requiresRepository: false,
        executionContract: guarded([span('p', producer)]),
      },
      switches: { customEnabled: true, moduleEnabled: true },
      modules: null,
      catalog: { stepIds: new Set(f.ids), composable: f.catalog },
      generic: true,
      predicates,
    });
    expect(result).toMatchObject({
      issues: expect.arrayContaining([expect.objectContaining({ kind: 'unmet-need' })]),
    });
  });
  it('the false branch of one predicate is correlated with its true branch', () => {
    const f = fixture(true);
    const c = guarded([span('p', producer), { ...span('c', consumer), when: false }]);
    expect(validateComposition(f.ids, f.catalog, { executionContract: c, predicates })).toEqual([]);
  });
});
