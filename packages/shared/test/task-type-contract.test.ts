import { describe, expect, it } from 'vitest';
import {
  COMPOSABLE_STEP_GROUPS,
  CUSTOM_TASK_TYPE_SLUG_PATTERN,
  PUBLIC_TASK_TYPE_UNAVAILABLE_REASONS,
  TASK_TYPE_UNAVAILABLE_REASONS,
  customTaskTypeCreateSchema,
  isCustomStepId,
  moduleIdsOfTaskType,
  publicTaskTypeSchema,
  resolveTaskTypeAvailability,
  taskTypeDefinitionSeedSchema,
  taskTypeUpdateSchema,
  validateTaskTypeDefaults,
  type ComposableStepEntry,
  type TaskTypeModuleState,
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
const noRows: ReadonlyMap<string, TaskTypeModuleState> = new Map();
const moduleRow = (name: string, over: Partial<TaskTypeModuleState> = {}): TaskTypeModuleState => ({
  name,
  missing: false,
  deactivated: false,
  ...over,
});

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
        modules: noRows,
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
        modules: noRows,
      }),
    ).toEqual({ available: false, reason: 'disabled' });
  });

  it('not-selectable only on the generic route', () => {
    const input = {
      definition: definition({ selectable: false }),
      switches: on,
      modules: noRows,
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
        modules: noRows,
      }),
    ).toEqual({ available: false, reason: 'custom-types-off' });
    expect(
      resolveTaskTypeAvailability({
        definition: definition(),
        switches: off,
        catalog,
        generic: true,
        modules: noRows,
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
        modules: noRows,
      }),
    ).toEqual({ available: false, reason: 'module-types-off' });
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ source: 'admin' }),
        switches: off,
        catalog,
        generic: true,
        modules: noRows,
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
        modules: noRows,
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
        modules: noRows,
      }),
    ).toEqual({ available: false, reason: 'disabled' });
  });

  it('precedence runs not-selectable, custom-types-off, module-types-off, missing-step', () => {
    const off = { customEnabled: false, moduleEnabled: false };
    const base = { switches: off, modules: noRows, catalog, generic: true };
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
        modules: noRows,
      }),
    ).toEqual({ available: true });
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ source: 'admin', stepIds: ['c'] }),
        switches: on,
        catalog: null,
        generic: true,
        modules: noRows,
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
        modules: noRows,
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
        modules: noRows,
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
        modules: noRows,
      }),
    ).toEqual({
      available: false,
      reason: 'invalid-composition',
      issues: [{ kind: 'unmet-need', index: 0, stepId: 'b', needs: 't', reason: 'b needs t' }],
    });
  });

  describe('a module type', () => {
    const acme = new Map([['acme', moduleRow('Acme')]]);
    const resolve = (stepIds: string[], over: Record<string, unknown> = {}) =>
      resolveTaskTypeAvailability({
        definition: definition({ source: 'module:acme', stepIds, ...over }),
        switches: on,
        catalog,
        generic: true,
        modules: acme,
      });

    it('has its composition checked when every step has a composable entry', () => {
      expect(resolve(['b', 'a'])).toEqual({
        available: false,
        reason: 'invalid-composition',
        issues: [{ kind: 'unmet-need', index: 0, stepId: 'b', needs: 't', reason: 'b needs t' }],
      });
      expect(resolve(['a', 'b'])).toEqual({ available: true });
    });

    it('is not checked when a step is internal: in the catalog, with no composable entry', () => {
      expect(resolve(['b', 'a', 'legacy-step'])).toEqual({ available: true });
      expect(resolve(['legacy-step'])).toEqual({ available: true });
    });

    it('is checked against its own requiresRepository', () => {
      const cut = entry('cut', { provides: ['wt'] });
      const needy = {
        stepIds: new Set(['cut']),
        composable: new Map([
          ['cut', { ...cut, requires: [{ needs: 'repository', reason: 'cut needs repository' }] }],
        ]),
      };
      const check = (requiresRepository: boolean) =>
        resolveTaskTypeAvailability({
          definition: definition({
            source: 'module:acme',
            stepIds: ['cut'],
            requiresRepository,
          }),
          switches: on,
          catalog: needy,
          generic: true,
          modules: acme,
        });
      expect(check(true)).toEqual({ available: true });
      expect(check(false)).toMatchObject({ reason: 'invalid-composition' });
    });

    it('still reports a step missing from the catalog before any composition problem', () => {
      expect(resolve(['b', 'a', 'gone'])).toEqual({
        available: false,
        reason: 'missing-step',
        stepIds: ['gone'],
      });
    });
  });

  it('a builtin skips invalid-composition', () => {
    expect(
      resolveTaskTypeAvailability({
        definition: definition({ stepIds: ['b', 'a'] }),
        switches: on,
        catalog,
        generic: true,
        modules: noRows,
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
        modules: noRows,
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
        modules: noRows,
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
        modules: noRows,
      }),
    ).toEqual({ available: true });
  });
});

describe('resolveTaskTypeAvailability and module states', () => {
  const stepsOf = ['module.alpha.x', 'module.alpha.y', 'module.beta.z', 'module.gamma.q'];
  const withModules = {
    stepIds: new Set([...catalog.stepIds, ...stepsOf]),
    composable: new Map([...composable, ...stepsOf.map((id) => [id, entry(id)] as const)]),
  };
  const NAMES: Record<string, string> = { alpha: 'Alpha', beta: 'Beta', gamma: 'Gamma' };
  // A module given null has no row, as after a purge.
  const rowsOf = (over: Record<string, Partial<TaskTypeModuleState> | null> = {}) =>
    new Map(
      Object.entries(NAMES).flatMap(([id, name]) =>
        over[id] === null ? [] : [[id, moduleRow(name, over[id] ?? {})] as const],
      ),
    );
  const alphaOff = rowsOf({ alpha: { deactivated: true } });
  const alphaMissing = rowsOf({ alpha: { missing: true } });
  const resolve = (
    over: Record<string, unknown>,
    input: Partial<Parameters<typeof resolveTaskTypeAvailability>[0]> = {},
  ) =>
    resolveTaskTypeAvailability({
      definition: definition(over),
      switches: on,
      modules: alphaOff,
      catalog: withModules,
      generic: true,
      ...input,
    });
  const refs = (...ids: string[]) => ids.map((id) => ({ id, name: NAMES[id] ?? null }));
  const deactivated = (...ids: string[]) => ({
    available: false,
    reason: 'module-deactivated',
    modules: refs(...ids),
  });
  const missing = (...ids: string[]) => ({
    available: false,
    reason: 'module-missing',
    modules: refs(...ids),
  });

  describe('module-deactivated', () => {
    it('a type seeded by a deactivated module is unavailable, naming the module', () => {
      expect(resolve({ source: 'module:alpha', stepIds: ['a'] })).toEqual(deactivated('alpha'));
    });

    it('a type with a step of a deactivated module is unavailable, whoever wrote it', () => {
      for (const source of ['admin', 'builtin', 'module:beta']) {
        expect(resolve({ source, stepIds: ['a', 'module.alpha.x', 'b'] }), source).toEqual(
          deactivated('alpha'),
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
          { modules: rowsOf({ alpha: { deactivated: true }, gamma: { deactivated: true } }) },
        ),
      ).toEqual(deactivated('alpha', 'gamma'));
    });

    it("leaves a type that uses only another module's steps available", () => {
      expect(resolve({ source: 'module:beta', stepIds: ['a', 'module.beta.z'] })).toEqual({
        available: true,
      });
      expect(resolve({ source: 'admin', stepIds: ['module.beta.z'] })).toEqual({
        available: true,
      });
    });

    it('leaves a core-only type available, with or without module rows', () => {
      expect(resolve({ source: 'admin', stepIds: ['a', 'b'] })).toEqual({ available: true });
      expect(resolve({ source: 'builtin', stepIds: ['a', 'b'] }, { modules: noRows })).toEqual({
        available: true,
      });
      expect(resolve({ source: 'builtin', stepIds: ['a', 'b'] }, { modules: null })).toEqual({
        available: true,
      });
    });

    it('needs no catalog, and reads a step list only on the static strategy', () => {
      expect(
        resolve({ source: 'builtin', stepIds: ['module.alpha.x'] }, { catalog: null }),
      ).toEqual(deactivated('alpha'));
      expect(
        resolve({ source: 'module:alpha', runListStrategy: 'workflow_paths', stepIds: null }),
      ).toEqual(deactivated('alpha'));
      expect(
        resolve({
          source: 'builtin',
          runListStrategy: 'workflow_paths',
          stepIds: ['module.alpha.x'],
        }),
      ).toEqual({ available: true });
    });
  });

  describe('module-missing', () => {
    it('a type seeded by a missing module is unavailable, though every one of its steps is core', () => {
      expect(
        resolve({ source: 'module:alpha', stepIds: ['a', 'b'] }, { modules: alphaMissing }),
      ).toEqual(missing('alpha'));
    });

    it('reads a module with no row as missing, and has no name for it', () => {
      const purged = rowsOf({ alpha: null });
      expect(resolve({ source: 'module:alpha', stepIds: ['a'] }, { modules: purged })).toEqual({
        available: false,
        reason: 'module-missing',
        modules: [{ id: 'alpha', name: null }],
      });
      expect(
        resolve({ source: 'module:alpha', stepIds: ['a'] }, { modules: noRows }),
      ).toMatchObject({ reason: 'module-missing', modules: [{ id: 'alpha', name: null }] });
    });

    it('a step of a missing module is module-missing, not missing-step, whoever wrote the type', () => {
      const gone = { stepIds: catalog.stepIds, composable };
      for (const source of ['admin', 'builtin', 'module:beta']) {
        expect(
          resolve(
            { source, stepIds: ['a', 'module.alpha.x', 'b'] },
            { modules: alphaMissing, catalog: gone },
          ),
          source,
        ).toEqual(missing('alpha'));
      }
    });

    it('names the module when the step is still in the catalog', () => {
      expect(
        resolve({ source: 'admin', stepIds: ['module.alpha.x'] }, { modules: alphaMissing }),
      ).toEqual(missing('alpha'));
    });

    it('stays missing-step for a step the catalog lacks of a module that is present', () => {
      expect(
        resolve({ source: 'admin', stepIds: ['a', 'module.beta.gone'] }, { modules: rowsOf() }),
      ).toEqual({ available: false, reason: 'missing-step', stepIds: ['module.beta.gone'] });
      expect(
        resolve({ source: 'module:beta', stepIds: ['a', 'gone'] }, { modules: rowsOf() }),
      ).toEqual({ available: false, reason: 'missing-step', stepIds: ['gone'] });
    });

    it('lists each missing module once, sorted, naming the ones that have a row', () => {
      expect(
        resolve(
          {
            source: 'module:gamma',
            stepIds: ['module.gamma.q', 'module.alpha.y', 'module.alpha.x', 'module.beta.z'],
          },
          { modules: rowsOf({ alpha: null, gamma: { missing: true } }) },
        ),
      ).toEqual({
        available: false,
        reason: 'module-missing',
        modules: [
          { id: 'alpha', name: null },
          { id: 'gamma', name: 'Gamma' },
        ],
      });
    });

    it('reads a row that is both missing and deactivated as missing', () => {
      expect(
        resolve(
          { source: 'module:alpha', stepIds: ['a'] },
          { modules: rowsOf({ alpha: { missing: true, deactivated: true } }) },
        ),
      ).toEqual(missing('alpha'));
    });

    it('comes before module-deactivated, and the deactivated one shows once the missing one is back', () => {
      const uses = { source: 'admin', stepIds: ['module.alpha.x', 'module.beta.z'] };
      const both = rowsOf({ alpha: { missing: true }, beta: { deactivated: true } });
      expect(resolve(uses, { modules: both })).toEqual(missing('alpha'));
      expect(resolve(uses, { modules: rowsOf({ beta: { deactivated: true } }) })).toEqual(
        deactivated('beta'),
      );
    });

    it('needs no catalog, and reads a step list only on the static strategy', () => {
      expect(
        resolve(
          { source: 'builtin', stepIds: ['module.alpha.x'] },
          { modules: alphaMissing, catalog: null },
        ),
      ).toEqual(missing('alpha'));
      expect(
        resolve(
          { source: 'module:alpha', runListStrategy: 'run_app_modes', stepIds: null },
          { modules: alphaMissing },
        ),
      ).toEqual(missing('alpha'));
      expect(
        resolve(
          { source: 'builtin', runListStrategy: 'workflow_paths', stepIds: ['module.alpha.x'] },
          { modules: alphaMissing },
        ),
      ).toEqual({ available: true });
    });

    it('leaves a type whose modules are all present available', () => {
      expect(
        resolve(
          { source: 'module:alpha', stepIds: ['a', 'module.alpha.x', 'module.beta.z'] },
          { modules: rowsOf() },
        ),
      ).toEqual({ available: true });
    });

    it('is not decided without module rows: the step falls back to missing-step', () => {
      const gone = { stepIds: catalog.stepIds, composable };
      expect(
        resolve(
          { source: 'admin', stepIds: ['a', 'module.alpha.x'] },
          { modules: null, catalog: gone },
        ),
      ).toEqual({ available: false, reason: 'missing-step', stepIds: ['module.alpha.x'] });
      expect(resolve({ source: 'module:alpha', stepIds: ['a'] }, { modules: null })).toEqual({
        available: true,
      });
    });
  });

  it('runs disabled, not-selectable, the two switches, module-missing, module-deactivated, missing-step, invalid-composition', () => {
    const uses = { source: 'module:alpha', stepIds: ['module.alpha.x', 'not-in-catalog'] };
    const gone = rowsOf({ alpha: { missing: true, deactivated: true } });
    expect(resolve({ ...uses, enabled: false }, { modules: gone })).toEqual({
      available: false,
      reason: 'disabled',
    });
    expect(resolve({ ...uses, selectable: false }, { modules: gone })).toEqual({
      available: false,
      reason: 'not-selectable',
    });
    expect(
      resolve(
        { ...uses, source: 'admin' },
        { modules: gone, switches: { customEnabled: false, moduleEnabled: true } },
      ),
    ).toEqual({ available: false, reason: 'custom-types-off' });
    expect(
      resolve(uses, { modules: gone, switches: { customEnabled: true, moduleEnabled: false } }),
    ).toEqual({ available: false, reason: 'module-types-off' });
    expect(resolve(uses, { modules: gone })).toEqual(missing('alpha'));
    expect(resolve(uses, { modules: alphaOff })).toEqual(deactivated('alpha'));
    expect(resolve(uses, { modules: rowsOf() })).toMatchObject({
      reason: 'missing-step',
      stepIds: ['not-in-catalog'],
    });
    expect(resolve({ source: 'admin', stepIds: ['b', 'a'] }, { modules: rowsOf() })).toMatchObject({
      reason: 'invalid-composition',
    });
  });
});

describe('publicTaskTypeSchema', () => {
  const dto = {
    slug: 'x',
    displayName: 'X',
    description: null,
    requiresRepository: true,
    sortOrder: 0,
    restoresDatabase: false,
    dispatchesCli: false,
    available: false,
  };

  it('carries a module reason with the modules it names', () => {
    for (const reason of ['module-missing', 'module-deactivated']) {
      const parsed = publicTaskTypeSchema.safeParse({
        ...dto,
        reason,
        modules: [
          { id: 'alpha', name: 'Alpha' },
          { id: 'beta', name: null },
        ],
      });
      expect(parsed.success, reason).toBe(true);
      expect(parsed.success && parsed.data.modules).toEqual([
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: null },
      ]);
    }
  });

  it('carries the steps a missing-step reason names', () => {
    const parsed = publicTaskTypeSchema.safeParse({
      ...dto,
      reason: 'missing-step',
      stepIds: ['gone', 'gone2'],
    });
    expect(parsed.success && parsed.data.stepIds).toEqual(['gone', 'gone2']);
    expect(
      publicTaskTypeSchema.safeParse({ ...dto, reason: 'missing-step', stepIds: [1] }).success,
    ).toBe(false);
  });

  it('refuses the two reasons the public list filters out before it asks', () => {
    for (const reason of ['disabled', 'not-selectable']) {
      expect(publicTaskTypeSchema.safeParse({ ...dto, reason }).success, reason).toBe(false);
    }
  });

  it('accepts every other reason the resolver can give', () => {
    expect([...PUBLIC_TASK_TYPE_UNAVAILABLE_REASONS]).toEqual(
      TASK_TYPE_UNAVAILABLE_REASONS.filter((r) => r !== 'disabled' && r !== 'not-selectable'),
    );
    for (const reason of PUBLIC_TASK_TYPE_UNAVAILABLE_REASONS) {
      expect(publicTaskTypeSchema.safeParse({ ...dto, reason }).success, reason).toBe(true);
    }
  });

  it('lists module-missing right before module-deactivated', () => {
    const at = (reason: string) =>
      (TASK_TYPE_UNAVAILABLE_REASONS as readonly string[]).indexOf(reason);
    expect(at('module-missing')).toBeGreaterThan(at('module-types-off'));
    expect(at('module-deactivated')).toBe(at('module-missing') + 1);
    expect(at('missing-step')).toBe(at('module-deactivated') + 1);
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
