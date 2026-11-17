import { customTaskTypeCreateSchema, taskTypeUpdateSchema } from '../src/modularity/task-types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateComposition } from '../src/modularity/composition.js';
import type { ComposableStepEntry } from '../src/modularity/contracts.js';
import {
  parseExecutionContract,
  assertExecutionContractSupported,
  ExecutionContractError,
  type ExecutionContract,
  MAX_EXECUTION_PREDICATES,
} from '../src/modularity/execution-contract.js';

const entry = (stepId: string, extra: Partial<ComposableStepEntry> = {}): ComposableStepEntry => ({
  stepId,
  label: stepId,
  group: 'test',
  dispatchesCli: false,
  requires: [],
  provides: [],
  ...extra,
});
const catalog = new Map(
  [
    entry('setup', { provides: ['worktree'] }),
    entry('fix', { fixConsumer: { version: 1 } }),
    entry('commit', { provides: ['commit'], loopTargetStepId: '07-phase-2-implement' }),
    entry('cleanup', { requires: [{ needs: 'commit', reason: 'cleanup needs a commit' }] }),
    entry('report'),
  ].map((e) => [e.stepId, e]),
);
const predicates = new Map([
  ['module.scan.planned', { argsSchema: z.strictObject({}) }],
  ['module.scan.merged', { argsSchema: z.strictObject({}) }],
]);
const span = (
  id: string,
  firstStepId: string,
  predicateId = 'module.scan.planned',
  lastStepId = firstStepId,
) => ({ id, firstStepId, lastStepId, predicateId, args: {} });
const contract = (guardedSpans: ExecutionContract['guardedSpans'] = []): ExecutionContract => ({
  version: 1,
  guardedSpans,
});
const check = (ids: string[], executionContract: unknown, cat = catalog) =>
  validateComposition(ids, cat, { executionContract, predicates });

describe('pinned execution contract', () => {
  it('keeps execution-contract authoring out of admin/editor payloads', () => {
    expect(
      customTaskTypeCreateSchema.safeParse({
        slug: 'test',
        displayName: 'Test',
        stepIds: ['report'],
        requiresRepository: false,
        executionContract: contract(),
      }).success,
    ).toBe(false);
    expect(taskTypeUpdateSchema.safeParse({ executionContract: contract() }).success).toBe(false);
  });
  it('strictly decodes version, fields and data; never accepts source as a predicate', () => {
    expect(parseExecutionContract(contract())).toEqual(contract());
    for (const raw of [
      { ...contract(), version: 2 },
      { ...contract(), js: 'return true' },
      { ...contract(), guardedSpans: [{ ...span('x', 'setup'), expression: '1=1' }] },
      { ...contract(), guardedSpans: [{ ...span('x', 'setup'), predicateId: '() => true' }] },
    ])
      expect(() => parseExecutionContract(raw)).toThrow('invalid-execution-contract');
  });
  it('accepts a registered guard from a module whose id starts with a digit', () => {
    const c = contract([span('x', 'setup', 'module.3scan.planned')]);
    expect(parseExecutionContract(c)).toEqual(c);
    expect(
      validateComposition(['setup', 'report'], catalog, {
        executionContract: c,
        predicates: new Map([['module.3scan.planned', { argsSchema: z.strictObject({}) }]]),
      }),
    ).toEqual([]);
  });
  it('refuses unknown predicates and invalid arguments by name', () => {
    expect(check(['setup'], contract([span('x', 'setup', 'module.scan.unknown')]))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'invalid-execution-contract',
          reason: expect.stringContaining('unknown-predicate'),
        }),
      ]),
    );
    expect(
      check(['setup'], contract([{ ...span('x', 'setup'), args: { sql: 'SELECT 1' } }])),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringContaining('predicate-args') }),
      ]),
    );
  });
  it.each([
    [span('x', 'missing')],
    [span('x', 'report', undefined, 'setup')],
    [span('x', 'setup', undefined, 'fix'), span('y', 'fix', undefined, 'report')],
    [span('x', 'setup', undefined, 'report'), span('y', 'fix')],
  ])('rejects missing/reversed endpoints and overlapping or nested spans', (...spans) => {
    expect(check(['setup', 'fix', 'report'], contract(spans))).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'invalid-execution-contract' })]),
    );
  });
  it.each(['unknown', 'later', 'self'])('refuses %s requiresSpan by name', (bad) => {
    const required = bad === 'self' ? 'a' : bad === 'later' ? 'b' : 'missing';
    const issues = check(
      ['setup', 'report'],
      contract([{ ...span('a', 'setup'), requiresSpan: required }, span('b', 'report')]),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: expect.stringContaining('requiresSpan') }),
      ]),
    );
  });
  it('rejects the zero-merge cleanup gap, without waiving commit', () => {
    const c = contract([
      span('planned', 'setup'),
      { ...span('merged', 'fix', 'module.scan.merged', 'commit'), requiresSpan: 'planned' },
      span('clean', 'cleanup'),
    ]);
    c.fixTarget = { stepId: 'fix', capabilityVersion: 1 };
    expect(check(['setup', 'fix', 'commit', 'cleanup', 'report'], c)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'unmet-need', stepId: 'cleanup', needs: 'commit' }),
      ]),
    );
  });
  it('requiresSpan excludes merged without planned; removing it rejects the composition', () => {
    const cat = new Map(
      [
        entry('setup', { provides: ['worktree'] }),
        entry('consume', { requires: [{ needs: 'worktree', reason: 'must exist' }] }),
        entry('report'),
      ].map((e) => [e.stepId, e]),
    );
    const c = contract([
      span('planned', 'setup'),
      { ...span('merged', 'consume', 'module.scan.merged'), requiresSpan: 'planned' },
    ]);
    expect(check(['setup', 'consume', 'report'], c, cat)).toEqual([]);
    delete c.guardedSpans[1]!.requiresSpan;
    expect(check(['setup', 'consume', 'report'], c, cat)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'unmet-need', stepId: 'consume' })]),
    );
  });
  it('uses one decision per predicate id across disjoint spans', () => {
    const cat = new Map(
      [
        entry('setup', { provides: ['worktree'] }),
        entry('consume', { requires: [{ needs: 'worktree', reason: 'same decision' }] }),
      ].map((e) => [e.stepId, e]),
    );
    expect(
      check(
        ['setup', 'consume', 'report'],
        contract([span('a', 'setup'), span('b', 'consume')]),
        new Map([...cat, ['report', entry('report')]]),
      ),
    ).toEqual([]);
  });
  it('rejects inconsistent args for a shared predicate identity', () => {
    const c = contract([span('a', 'setup'), { ...span('b', 'report'), args: { other: true } }]);
    expect(
      validateComposition(['setup', 'report'], catalog, {
        executionContract: c,
        predicates: new Map([
          ['module.scan.planned', { argsSchema: z.record(z.string(), z.json()) }],
        ]),
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'invalid-execution-contract',
          reason: expect.stringContaining('predicate-args-disagree'),
        }),
      ]),
    );
  });
  it('rejects a conditional path with no remaining steps', () => {
    expect(check(['report'], contract([span('a', 'report')]))).toEqual(
      expect.arrayContaining([{ kind: 'empty' }]),
    );
  });
  it('bounds independent predicate decisions at an injectable limit', () => {
    expect(MAX_EXECUTION_PREDICATES).toBe(8);
    expect(
      validateComposition(['setup', 'report'], catalog, {
        executionContract: contract([
          span('a', 'setup'),
          span('b', 'report', 'module.scan.merged'),
        ]),
        predicates,
        maxPredicates: 1,
      }),
    ).toEqual([
      expect.objectContaining({
        kind: 'invalid-execution-contract',
        reason: expect.stringContaining('predicate-count'),
      }),
    ]);
  });
  it('remaps core emitters only to a capable earlier target on every path', () => {
    const c = { ...contract(), fixTarget: { stepId: 'fix', capabilityVersion: 1 } };
    expect(check(['fix', 'commit'], c)).toEqual([]);
    expect(check(['commit', 'fix'], c)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'missing-loop-target', target: 'fix' }),
      ]),
    );
    c.guardedSpans = [span('a', 'fix')];
    expect(check(['fix', 'commit'], c)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'missing-loop-target', target: 'fix' }),
      ]),
    );
    for (const stepId of ['report', 'missing', 'custom.scan.prompt']) {
      expect(
        check(['report', 'commit'], { ...contract(), fixTarget: { stepId, capabilityVersion: 1 } }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'invalid-execution-contract',
            reason: expect.stringContaining('fix-target'),
          }),
        ]),
      );
    }
  });
  it('validates fix target capability without a predicate map', () => {
    // #1263 already enforces this at the planner boundary. The availability
    // fallback remains until the separate activation change opens its fence.
    const fixed = { ...contract(), fixTarget: { stepId: 'fix', capabilityVersion: 1 } };
    expect(validateComposition(['fix', 'commit'], catalog, { executionContract: fixed })).toEqual(
      [],
    );
    const incapable = new Map(catalog);
    incapable.set('fix', entry('fix'));
    expect(validateComposition(['fix', 'commit'], incapable, { executionContract: fixed })).toEqual(
      [{ kind: 'invalid-execution-contract', reason: expect.stringContaining('not capable') }],
    );
  });
  it('checks removal, provider ordering, entailment and closing on feasible paths', () => {
    const cat = new Map(
      [
        entry('setup', { provides: ['a', 'b'] }),
        entry('remove', { removes: ['a'], provides: ['b'] }),
        entry('consume', {
          requires: [{ needs: 'a', after: 'b', reason: 'ordered' }],
          entails: ['end'],
        }),
        entry('close', { closes: true }),
        entry('loop', { loopTargetStepId: 'setup' }),
      ].map((e) => [e.stepId, e]),
    );
    const issues = check(
      ['setup', 'remove', 'consume', 'close', 'loop'],
      contract([span('r', 'remove')]),
      cat,
    );
    expect(issues.map((i) => i.kind)).toEqual(
      expect.arrayContaining([
        'unmet-need',
        'need-out-of-order',
        'unfulfilled',
        'loop-after-closing',
      ]),
    );
  });
  describe('span entry position in the support assertion', () => {
    const fails = (raw: unknown, scope: Parameters<typeof assertExecutionContractSupported>[1]) => {
      try {
        assertExecutionContractSupported(raw, scope);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    const admitted = [
      [
        'entry at index 1',
        contract([span('a', 'entry')]),
        { staticPinnedList: true, stepIds: ['a', 'entry', 'b'] },
      ],
      ['entry position unknown', contract([span('a', 'entry')]), { staticPinnedList: true }],
      ['empty contract', contract(), { staticPinnedList: true, stepIds: ['entry', 'a'] }],
      ['null', null, { staticPinnedList: true, stepIds: ['entry', 'a'] }],
    ] as const;
    it.each(admitted)('admits %s', (_name, raw, scope) => {
      expect(fails(raw, scope)).toBeUndefined();
    });
    const refused = [
      [
        'entry at index 0',
        contract([span('a', 'entry')]),
        { staticPinnedList: true, stepIds: ['entry', 'a', 'b'] },
      ],
      [
        'entry absent from the list',
        contract([span('a', 'entry')]),
        { staticPinnedList: true, stepIds: ['a', 'b'] },
      ],
      [
        'first of two spans at index 0',
        contract([span('a', 'entry'), span('b', 'later', 'module.scan.merged')]),
        { staticPinnedList: true, stepIds: ['entry', 'x', 'later'] },
      ],
      [
        'second of two spans at index 0',
        contract([span('b', 'later', 'module.scan.merged'), span('a', 'entry')]),
        { staticPinnedList: true, stepIds: ['entry', 'x', 'later'] },
      ],
      [
        'valid entry outside a static pinned list',
        contract([span('a', 'entry')]),
        { staticPinnedList: false, stepIds: ['a', 'entry', 'b'] },
      ],
    ] as const;
    it.each(refused)('refuses %s', (_name, raw, scope) => {
      const error = fails(raw, scope);
      expect(error).toBeInstanceOf(ExecutionContractError);
      expect((error as ExecutionContractError).code).toBe('invalid-execution-contract');
    });
    it('puts the boundary between index 0 and index 1', () => {
      const raw = contract([span('a', 'entry')]);
      const at = (stepIds: string[]) => fails(raw, { staticPinnedList: true, stepIds });
      const atZero = at(['entry', 'a']);
      expect(atZero).toBeInstanceOf(ExecutionContractError);
      expect((atZero as ExecutionContractError).code).toBe('invalid-execution-contract');
      expect(at(['a', 'entry'])).toBeUndefined();
    });
  });
  it('admits guarded spans only for a static pinned list; fix targets and malformed pins always refuse', () => {
    const scopes = [{ staticPinnedList: true }, { staticPinnedList: false }] as const;
    for (const scope of scopes)
      for (const raw of [null, undefined, contract()])
        expect(() => assertExecutionContractSupported(raw, scope)).not.toThrow();
    const guardedPin = contract([span('x', 'setup')]);
    expect(() =>
      assertExecutionContractSupported(guardedPin, { staticPinnedList: true }),
    ).not.toThrow();
    const refusals = [
      [guardedPin, { staticPinnedList: false }],
      [{ ...contract(), fixTarget: { stepId: 'fix', capabilityVersion: 1 } }, scopes[0]],
      [{ ...contract(), fixTarget: { stepId: 'fix', capabilityVersion: 1 } }, scopes[1]],
      [{ ...guardedPin, fixTarget: { stepId: 'fix', capabilityVersion: 1 } }, scopes[0]],
      [{ version: 99 }, scopes[0]],
      [{ version: 99 }, scopes[1]],
    ] as const;
    for (const [raw, scope] of refusals) {
      let caught: unknown;
      try {
        assertExecutionContractSupported(raw, scope);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ExecutionContractError);
      expect(caught).toMatchObject({ code: 'invalid-execution-contract' });
    }
  });
});
