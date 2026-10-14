import { describe, expect, it } from 'vitest';
import {
  COMPOSABLE_STEP_GROUPS,
  CUSTOM_TASK_TYPE_SLUG_PATTERN,
  customTaskTypeCreateSchema,
  isCustomStepId,
  moduleIdsOfTaskType,
  publicTaskTypeSchema,
  resolveTaskTypeAvailability,
  taskTypeDefinitionSeedSchema,
  taskTypeUpdateSchema,
  validateTaskTypeDefaults,
  type ComposableStepEntry,
} from '../src/modularity/index.js';

function entry(
  stepId: string,
  opts: { needs?: string[]; provides?: string[]; loopBudget?: boolean } = {},
): ComposableStepEntry {
  return {
    stepId,
    label: stepId,
    group: 'test',
    dispatchesCli: false,
    requires: (opts.needs ?? []).map((needs) => ({ needs, reason: `${stepId} needs ${needs}` })),
    provides: opts.provides ?? [],
    ...(opts.loopBudget ? { loopBudgetEditable: true } : {}),
  };
}

const composable = new Map<string, ComposableStepEntry>([
  ['a', entry('a', { provides: ['t'] })],
  ['b', entry('b', { needs: ['t'], loopBudget: true })],
  ['c', entry('c', { needs: ['never'] })],
]);
const catalog = { stepIds: new Set(['a', 'b', 'c', 'legacy-step']), composable };
const on = { customEnabled: true, moduleEnabled: true };
const none: ReadonlySet<string> = new Set();

function definition(over: Record<string, unknown> = {}) {
  return {
    source: 'builtin',
    enabled: true,
    selectable: true,
    runListStrategy: 'static' as const,
    stepIds: ['a', 'b'] as string[] | null,
    requiresRepository: true,
    ...over,
  };
}

describe('resolveTaskTypeAvailability', () => {
  it('is available for a healthy admin type', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ source: 'admin' }),
        switches: on,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: true });
  });

  it('disabled', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ enabled: false }),
        switches: on,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: false, reason: 'disabled' });
  });

  it('not-selectable only on the generic route', () => {
    const input = {
      definition: definition({ selectable: false }),
      switches: on,
      deactivatedModules: none,
      catalog,
    };
    expect(resolveTaskTypeAvailability({ ...input, generic: true })).toEqual({
      available: false,
      reason: 'not-selectable',
    });
    expect(resolveTaskTypeAvailability({ ...input, generic: false })).toEqual({ available: true });
  });

  it('custom-types-off for admin source only', () => {
    const off = { customEnabled: false, moduleEnabled: true };
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ source: 'admin' }),
        switches: off,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: false, reason: 'custom-types-off' });
    expect(
      resolveTaskTypeAvailability({
        definition: definition(),
        switches: off,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: true });
  });

  it('module-types-off for module sources only', () => {
    const off = { customEnabled: true, moduleEnabled: false };
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ source: 'module:acme' }),
        switches: off,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: false, reason: 'module-types-off' });
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ source: 'admin' }),
        switches: off,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: true });
  });

  it('missing-step lists the steps absent from the catalog', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ stepIds: ['a', 'gone', 'b', 'gone2'] }),
        switches: on,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: false, reason: 'missing-step', stepIds: ['gone', 'gone2'] });
  });

  it('disabled beats missing-step', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ enabled: false, stepIds: ['gone'] }),
        switches: on,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: false, reason: 'disabled' });
  });

  it('precedence runs not-selectable, custom-types-off, module-types-off, missing-step', () => {
    const off = { customEnabled: false, moduleEnabled: false };
    const base = { switches: off, deactivatedModules: none, catalog, generic: true };
    expect(
      resolveTaskTypeAvailability({
        ...base,
        definition: definition({ source: 'admin', selectable: false, stepIds: ['gone'] }),
      }),
    ).toMatchObject({ reason: 'not-selectable' });
    expect(
      resolveTaskTypeAvailability({
        ...base,
        definition: definition({ source: 'admin', stepIds: ['gone'] }),
      }),
    ).toMatchObject({ reason: 'custom-types-off' });
    expect(
      resolveTaskTypeAvailability({
        ...base,
        definition: definition({ source: 'module:x', stepIds: ['gone'] }),
      }),
    ).toMatchObject({ reason: 'module-types-off' });
    expect(
      resolveTaskTypeAvailability({
        ...base,
        switches: on,
        definition: definition({ source: 'admin', stepIds: ['gone', 'c'] }),
      }),
    ).toMatchObject({ reason: 'missing-step' });
  });

  it('a null catalog skips missing-step and invalid-composition (unseeded builtin)', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ stepIds: ['not-in-any-catalog'] }),
        switches: on,
        catalog: null,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: true });
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ source: 'admin', stepIds: ['c'] }),
        switches: on,
        catalog: null,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: true });
  });

  it('a builtin with steps that are in the catalog but not composable is available', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ stepIds: ['legacy-step', 'a'] }),
        switches: on,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: true });
  });

  it('a dynamic strategy has no step list to check', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ runListStrategy: 'workflow_paths', stepIds: null }),
        switches: on,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: true });
  });

  it('an admin type with an invalid composition is unavailable with the issues', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ source: 'admin', stepIds: ['b', 'a'] }),
        switches: on,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({
      available: false,
      reason: 'invalid-composition',
      issues: [{ kind: 'unmet-need', index: 0, stepId: 'b', needs: 't', reason: 'b needs t' }],
    });
  });

  it('a module type skips invalid-composition', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ source: 'module:acme', stepIds: ['b', 'a'] }),
        switches: on,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: true });
  });

  it('a builtin skips invalid-composition', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ stepIds: ['b', 'a'] }),
        switches: on,
        catalog,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: true });
  });
});

describe('resolveTaskTypeAvailability repository token', () => {
  const needy = new Map<string, ComposableStepEntry>([
    [
      'cut',
      {
        ...entry('cut', { provides: ['wt'] }),
        requires: [{ needs: 'repository', reason: 'cut needs repository' }],
      },
    ],
    ['plain', entry('plain')],
  ]);
  const withRepo = { stepIds: new Set(['cut', 'plain']), composable: needy };

  it('lets a repo-requiring admin type use a repository step', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ source: 'admin', stepIds: ['cut'], requiresRepository: true }),
        switches: on,
        catalog: withRepo,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: true });
  });

  it('refuses a repository step on a repo-less admin type', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ source: 'admin', stepIds: ['cut'], requiresRepository: false }),
        switches: on,
        catalog: withRepo,
        generic: true,
        deactivatedModules: none,
      }),
    ).toMatchObject({
      available: false,
      reason: 'invalid-composition',
      issues: [{ kind: 'unmet-need', stepId: 'cut', needs: 'repository' }],
    });
  });

  it('accepts a repo-less admin type made of steps that need no repository', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ source: 'admin', stepIds: ['plain'], requiresRepository: false }),
        switches: on,
        catalog: withRepo,
        generic: true,
        deactivatedModules: none,
      }),
    ).toEqual({ available: true });
  });
});

describe('resolveTaskTypeAvailability and deactivated modules', () => {
  const stepsOf = ['module.alpha.x', 'module.alpha.y', 'module.beta.z', 'module.gamma.q'];
  const withModules = {
    stepIds: new Set([...catalog.stepIds, ...stepsOf]),
    composable: new Map([...composable, ...stepsOf.map((id) => [id, entry(id)] as const)]),
  };
  const alphaOff = new Set(['alpha']);
  const resolve = (
    over: Record<string, unknown>,
    input: Partial<Parameters<typeof resolveTaskTypeAvailability>[0]> = {},
  ) =>
    resolveTaskTypeAvailability({
      definition: definition(over),
      switches: on,
      deactivatedModules: alphaOff,
      catalog: withModules,
      generic: true,
      ...input,
    });
  const unavailable = (...moduleIds: string[]) => ({
    available: false,
    reason: 'module-deactivated',
    moduleIds,
  });

  it('a type seeded by a deactivated module is unavailable, naming the module', () => {
    expect(resolve({ source: 'module:alpha', stepIds: ['a'] })).toEqual(unavailable('alpha'));
  });

  it('a type with a step of a deactivated module is unavailable, whoever wrote it', () => {
    for (const source of ['admin', 'builtin', 'module:beta']) {
      expect(resolve({ source, stepIds: ['a', 'module.alpha.x', 'b'] }), source).toEqual(
        unavailable('alpha'),
      );
    }
  });

  it('lists each deactivated module once, sorted', () => {
    expect(
      resolve(
        {
          source: 'module:gamma',
          stepIds: ['module.gamma.q', 'module.alpha.y', 'module.alpha.x', 'module.beta.z'],
        },
        { deactivatedModules: new Set(['gamma', 'alpha']) },
      ),
    ).toEqual(unavailable('alpha', 'gamma'));
  });

  it("leaves a type that uses only another module's steps available", () => {
    expect(resolve({ source: 'module:beta', stepIds: ['a', 'module.beta.z'] })).toEqual({
      available: true,
    });
    expect(resolve({ source: 'admin', stepIds: ['module.beta.z'] })).toEqual({ available: true });
  });

  it('leaves a core-only type available, with or without modules deactivated', () => {
    expect(resolve({ source: 'admin', stepIds: ['a', 'b'] })).toEqual({ available: true });
    expect(
      resolve({ source: 'builtin', stepIds: ['a', 'b'] }, { deactivatedModules: none }),
    ).toEqual({ available: true });
    expect(
      resolve({ source: 'module:beta', stepIds: ['a'] }, { deactivatedModules: none }),
    ).toEqual({ available: true });
  });

  it('needs no catalog, and reads a step list only on the static strategy', () => {
    expect(resolve({ source: 'builtin', stepIds: ['module.alpha.x'] }, { catalog: null })).toEqual(
      unavailable('alpha'),
    );
    expect(
      resolve({ source: 'module:alpha', runListStrategy: 'workflow_paths', stepIds: null }),
    ).toEqual(unavailable('alpha'));
    expect(
      resolve({
        source: 'builtin',
        runListStrategy: 'workflow_paths',
        stepIds: ['module.alpha.x'],
      }),
    ).toEqual({ available: true });
  });

  it('comes after disabled, not-selectable and the two switches, and before missing-step', () => {
    const uses = { source: 'module:alpha', stepIds: ['module.alpha.x', 'not-in-catalog'] };
    expect(resolve({ ...uses, enabled: false })).toEqual({ available: false, reason: 'disabled' });
    expect(resolve({ ...uses, selectable: false })).toEqual({
      available: false,
      reason: 'not-selectable',
    });
    expect(
      resolve(
        { ...uses, source: 'admin' },
        { switches: { customEnabled: false, moduleEnabled: true } },
      ),
    ).toEqual({ available: false, reason: 'custom-types-off' });
    expect(resolve(uses, { switches: { customEnabled: true, moduleEnabled: false } })).toEqual({
      available: false,
      reason: 'module-types-off',
    });
    expect(resolve(uses)).toEqual(unavailable('alpha'));
    expect(resolve(uses, { deactivatedModules: none })).toMatchObject({
      reason: 'missing-step',
      stepIds: ['not-in-catalog'],
    });
  });

  it('is a reason the public dto carries', () => {
    const dto = {
      slug: 'x',
      displayName: 'X',
      description: null,
      requiresRepository: true,
      sortOrder: 0,
      restoresDatabase: false,
      dispatchesCli: false,
      available: false,
      reason: 'module-deactivated',
    };
    expect(publicTaskTypeSchema.safeParse(dto).success).toBe(true);
  });
});

describe('moduleIdsOfTaskType', () => {
  it('names the module that seeded the type and the owners of its static steps, sorted, once each', () => {
    expect(
      moduleIdsOfTaskType(
        definition({
          source: 'module:gamma',
          stepIds: ['a', 'module.beta.z', 'module.alpha.x', 'module.beta.y', 'module.gamma.q'],
        }),
      ),
    ).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('names none for a core-only type, an admin or builtin source, or a dynamic strategy', () => {
    expect(moduleIdsOfTaskType(definition({ source: 'admin', stepIds: ['a', 'b'] }))).toEqual([]);
    expect(moduleIdsOfTaskType(definition({ stepIds: null }))).toEqual([]);
    expect(
      moduleIdsOfTaskType(
        definition({ runListStrategy: 'run_app_modes', stepIds: ['module.alpha.x'] }),
      ),
    ).toEqual([]);
  });
});

describe('CUSTOM_TASK_TYPE_SLUG_PATTERN', () => {
  const accepted = ['a', '0', 'my-type', 'a-', 'x'.repeat(64), 'a1-b2'];
  const rejected = ['', 'my_type', 'my.type', '-lead', 'x'.repeat(65), 'UPPER', 'a b'];

  it('accepts and rejects', () => {
    for (const slug of accepted) expect(CUSTOM_TASK_TYPE_SLUG_PATTERN.test(slug)).toBe(true);
    for (const slug of rejected) expect(CUSTOM_TASK_TYPE_SLUG_PATTERN.test(slug)).toBe(false);
  });

  it('is a subset of the task type slug grammar', () => {
    const seed = (slug: string) =>
      taskTypeDefinitionSeedSchema.safeParse({
        slug,
        displayName: 'x',
        runListStrategy: 'static',
        stepIds: ['a'],
        selectable: true,
        requiresRepository: true,
      }).success;
    for (const slug of accepted) expect(seed(slug)).toBe(true);
  });

  it('agrees with the def segment of the custom step id grammar', () => {
    for (const slug of [...accepted, ...rejected].filter((s) => s.length <= 64)) {
      if (slug.length === 0 || /\s/.test(slug)) continue;
      expect(isCustomStepId(`custom.${slug}.step`), slug).toBe(
        CUSTOM_TASK_TYPE_SLUG_PATTERN.test(slug),
      );
    }
  });
});

describe('COMPOSABLE_STEP_GROUPS', () => {
  it('covers the eight groups of the core catalog, in order, with labels', () => {
    expect(COMPOSABLE_STEP_GROUPS.map((g) => g.id)).toEqual([
      'env',
      'setup',
      'runtime',
      'spec',
      'build',
      'check',
      'finish',
      'knowledge',
    ]);
    expect(COMPOSABLE_STEP_GROUPS.map((g) => g.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const g of COMPOSABLE_STEP_GROUPS) expect(g.label.length).toBeGreaterThan(0);
  });
});

describe('task type schemas', () => {
  const valid = {
    slug: 'my-type',
    displayName: 'My type',
    stepIds: ['a', 'b'],
    requiresRepository: true,
  };

  it('refuses a reserved slug', () => {
    expect(customTaskTypeCreateSchema.safeParse({ ...valid, slug: 'new' }).success).toBe(false);
    expect(customTaskTypeCreateSchema.safeParse({ ...valid, slug: 'catalog' }).success).toBe(false);
    expect(customTaskTypeCreateSchema.safeParse({ ...valid, slug: 'new-thing' }).success).toBe(
      true,
    );
  });

  it('accepts a minimal create body and the optional fields', () => {
    expect(customTaskTypeCreateSchema.safeParse(valid).success).toBe(true);
    expect(
      customTaskTypeCreateSchema.safeParse({
        ...valid,
        description: 'd',
        preAnswerDefaults: { a: { k: 1 } },
        stepLoopLimitDefaults: { b: 3 },
        sortOrder: 4,
      }).success,
    ).toBe(true);
  });

  it('rejects bad create bodies', () => {
    const bad = [
      { ...valid, slug: 'my_type' },
      { ...valid, displayName: '' },
      { ...valid, stepIds: [] },
      { ...valid, requiresRepository: undefined },
      { ...valid, stepLoopLimitDefaults: { b: 0 } },
      { ...valid, stepLoopLimitDefaults: { b: 51 } },
      { ...valid, stepLoopLimitDefaults: { b: 1.5 } },
      { ...valid, sortOrder: 1.5 },
    ];
    for (const body of bad) expect(customTaskTypeCreateSchema.safeParse(body).success).toBe(false);
  });

  it('update is partial and refuses a slug', () => {
    expect(taskTypeUpdateSchema.safeParse({}).success).toBe(true);
    expect(taskTypeUpdateSchema.safeParse({ displayName: 'x', sortOrder: 2 }).success).toBe(true);
    expect(taskTypeUpdateSchema.safeParse({ slug: 'other' }).success).toBe(false);
    expect(taskTypeUpdateSchema.safeParse({ stepIds: [] }).success).toBe(false);
  });

  it('carries prompt steps keyed by their slug on create and update', () => {
    const step = { slug: 'review', title: 'Review', template: 'Review it', timeoutMs: 300_000 };
    const withStep = {
      ...valid,
      stepIds: ['custom.my-type.review'],
      promptSteps: { review: step },
    };
    const parsed = customTaskTypeCreateSchema.safeParse(withStep);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.promptSteps?.review?.capabilities).toEqual([]);
    expect(taskTypeUpdateSchema.safeParse({ promptSteps: { review: step } }).success).toBe(true);
    expect(taskTypeUpdateSchema.safeParse({ promptSteps: {} }).success).toBe(true);
    for (const promptSteps of [
      { other: step },
      { review: { ...step, template: '' } },
      { review: { ...step, timeoutMs: 1 } },
      { 'bad slug': { ...step, slug: 'bad slug' } },
    ]) {
      expect(customTaskTypeCreateSchema.safeParse({ ...withStep, promptSteps }).success).toBe(
        false,
      );
      expect(taskTypeUpdateSchema.safeParse({ promptSteps }).success).toBe(false);
    }
  });

  it('public dto carries available and an optional reason', () => {
    const dto = {
      slug: 'workflow',
      displayName: 'Workflow',
      description: null,
      requiresRepository: true,
      sortOrder: 0,
      restoresDatabase: false,
      dispatchesCli: true,
      available: false,
      reason: 'missing-step',
    };
    expect(publicTaskTypeSchema.safeParse(dto).success).toBe(true);
    expect(publicTaskTypeSchema.safeParse({ ...dto, dispatchesCli: undefined }).success).toBe(
      false,
    );
    expect(publicTaskTypeSchema.safeParse({ ...dto, reason: undefined }).success).toBe(true);
    expect(publicTaskTypeSchema.safeParse({ ...dto, reason: 'nope' }).success).toBe(false);
  });
});

describe('validateTaskTypeDefaults', () => {
  const steps = new Map(composable);
  it('is clean for no defaults and for matching ones', () => {
    expect(validateTaskTypeDefaults({ stepIds: ['a', 'b'] }, steps)).toEqual([]);
    expect(
      validateTaskTypeDefaults(
        {
          stepIds: ['a', 'b'],
          preAnswerDefaults: { a: { k: 1 } },
          stepLoopLimitDefaults: { b: 2 },
        },
        steps,
      ),
    ).toEqual([]);
  });

  it('flags preAnswerDefaults keys outside stepIds', () => {
    expect(
      validateTaskTypeDefaults({ stepIds: ['a'], preAnswerDefaults: { zz: {} } }, steps),
    ).toEqual([{ kind: 'default-key-not-in-steps', field: 'preAnswerDefaults', stepId: 'zz' }]);
  });

  it('flags stepLoopLimitDefaults keys outside stepIds', () => {
    expect(
      validateTaskTypeDefaults({ stepIds: ['a'], stepLoopLimitDefaults: { b: 2 } }, steps),
    ).toEqual([{ kind: 'default-key-not-in-steps', field: 'stepLoopLimitDefaults', stepId: 'b' }]);
  });

  it('flags a loop limit on a step that is not loopBudgetEditable or not in the catalog', () => {
    expect(
      validateTaskTypeDefaults(
        { stepIds: ['a', 'legacy-step'], stepLoopLimitDefaults: { a: 2, 'legacy-step': 2 } },
        steps,
      ),
    ).toEqual([
      { kind: 'loop-limit-not-editable', stepId: 'a' },
      { kind: 'loop-limit-not-editable', stepId: 'legacy-step' },
    ]);
  });
});
