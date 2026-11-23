import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveTaskTypeAvailability } from '../src/modularity/task-types.js';
import type { ComposableStepEntry } from '../src/modularity/contracts.js';
import type { ExecutionPredicateDeclaration } from '../src/modularity/execution-contract.js';

const producer = 'module.scan.producer';
const consumer = 'module.scan.consumer';
const report = 'module.scan.report';
const implement = '07-phase-2-implement';
const ids = [implement, producer, consumer, report];
const entry = (stepId: string, extra: Partial<ComposableStepEntry> = {}): ComposableStepEntry => ({
  stepId,
  label: stepId,
  group: 'test',
  dispatchesCli: false,
  requires: [],
  provides: [],
  ...extra,
});
const composable = new Map(
  [
    entry(implement),
    entry(producer, { fixConsumer: { version: 1 } }),
    entry(consumer, { loopTargetStepId: implement }),
    entry(report),
  ].map((e) => [e.stepId, e]),
);
const catalog = { stepIds: new Set(ids), composable };
const supplied = new Map<string, ExecutionPredicateDeclaration>([
  ['module.scan.planned', { argsSchema: z.strictObject({}) }],
]);
const span = {
  id: 'p',
  firstStepId: report,
  lastStepId: report,
  predicateId: 'module.scan.planned',
  args: {},
};
const entryFirst = { ...span, firstStepId: implement, lastStepId: consumer };
const fixTarget = { stepId: producer, capabilityVersion: 1 };

type Column = {
  name: string;
  strategy: 'static' | 'workflow_paths' | 'run_app_modes' | 'derived';
  catalogNull?: boolean;
  stepIdsNull?: boolean;
};
const columns: Column[] = [
  { name: 'static with catalog and step ids', strategy: 'static' },
  { name: 'static with catalog null', strategy: 'static', catalogNull: true },
  { name: 'static with step ids null', strategy: 'static', stepIdsNull: true },
  { name: 'workflow_paths', strategy: 'workflow_paths', stepIdsNull: true },
  { name: 'run_app_modes', strategy: 'run_app_modes', stepIdsNull: true },
  { name: 'derived', strategy: 'derived', stepIdsNull: true },
];

type Row = {
  name: string;
  pin: unknown;
  predicates: ReadonlyMap<string, ExecutionPredicateDeclaration>;
  admittedOnlyOnStatic: boolean;
};
const rows: Row[] = [
  {
    name: 'valid guarded, predicate supplied',
    pin: { version: 1, guardedSpans: [span] },
    predicates: supplied,
    admittedOnlyOnStatic: true,
  },
  {
    name: 'guarded without predicate',
    pin: { version: 1, guardedSpans: [span] },
    predicates: new Map(),
    admittedOnlyOnStatic: false,
  },
  {
    name: 'valid fixTarget',
    pin: { version: 1, guardedSpans: [], fixTarget },
    predicates: supplied,
    admittedOnlyOnStatic: true,
  },
  {
    name: 'invalid fixTarget',
    pin: { version: 1, guardedSpans: [], fixTarget: { stepId: 'off-list', capabilityVersion: 1 } },
    predicates: supplied,
    admittedOnlyOnStatic: false,
  },
  {
    name: 'guarded and fixTarget',
    pin: { version: 1, guardedSpans: [span], fixTarget },
    predicates: supplied,
    admittedOnlyOnStatic: true,
  },
  {
    name: 'entry at first index',
    pin: { version: 1, guardedSpans: [entryFirst] },
    predicates: supplied,
    admittedOnlyOnStatic: false,
  },
  { name: 'malformed', pin: { version: 99 }, predicates: supplied, admittedOnlyOnStatic: false },
];

function resolve(column: Column, pin: unknown, predicates: Row['predicates']) {
  return resolveTaskTypeAvailability({
    definition: {
      source: 'admin',
      enabled: true,
      selectable: true,
      runListStrategy: column.strategy,
      stepIds: column.stepIdsNull ? null : ids,
      requiresRepository: false,
      executionContract: pin,
    },
    switches: { customEnabled: true, moduleEnabled: true },
    modules: null,
    catalog: column.catalogNull ? null : catalog,
    generic: true,
    predicates,
    ...(column.strategy === 'derived'
      ? { derived: { stepIds: ids, dependencyStepIds: ids, valid: true } }
      : {}),
  });
}
const firstKind = (result: ReturnType<typeof resolve>) =>
  'issues' in result ? result.issues?.[0]?.kind : undefined;

describe('guarded contract availability matrix', () => {
  describe.each(rows)('$name', (row) => {
    it.each(columns)('$name', (column) => {
      const result = resolve(column, row.pin, row.predicates);
      const admitted = row.admittedOnlyOnStatic && column.name === columns[0]!.name;
      expect(result.available).toBe(admitted);
      if (!admitted) {
        expect(result).toMatchObject({ available: false, reason: 'invalid-composition' });
        expect(firstKind(result)).toBe('invalid-execution-contract');
      }
    });
  });
  describe.each([
    ['empty', { version: 1, guardedSpans: [] }],
    ['null', null],
  ])('%s pin', (_name, pin) => {
    it.each(columns)('$name', (column) => {
      expect(resolve(column, pin, supplied)).toEqual({ available: true });
    });
  });
});
