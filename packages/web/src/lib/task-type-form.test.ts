import { describe, expect, it } from 'vitest';
import {
  buildCreateBody,
  buildUpdateBody,
  compositionChanged,
  slugProblem,
  taskTypeFormSchema,
} from './task-type-form';

const ADMIN_FIELDS = [
  'displayName',
  'description',
  'stepIds',
  'preAnswerDefaults',
  'stepLoopLimitDefaults',
  'requiresRepository',
  'selectable',
  'enabled',
  'sortOrder',
];

describe('taskTypeFormSchema', () => {
  it('offers the slug on create only', () => {
    const ids = (mode: 'create' | 'edit') =>
      taskTypeFormSchema(ADMIN_FIELDS, mode).fields.map((f) => f.id);
    expect(ids('create')).toEqual([
      'slug',
      'displayName',
      'description',
      'requiresRepository',
      'enabled',
      'selectable',
      'sortOrder',
    ]);
    expect(ids('edit')).not.toContain('slug');
  });

  it('shows a built-in row only the fields the api lets it change', () => {
    const ids = taskTypeFormSchema(['displayName', 'description', 'sortOrder'], 'edit').fields.map(
      (f) => f.id,
    );
    expect(ids).toEqual(['displayName', 'description', 'sortOrder']);
  });
});

describe('slugProblem', () => {
  it('accepts a good slug and refuses a bad or reserved one', () => {
    expect(slugProblem('live-check-2')).toBeNull();
    expect(slugProblem('Bad Slug')).not.toBeNull();
    expect(slugProblem('-lead')).not.toBeNull();
    expect(slugProblem('new')).toContain('reserved');
    expect(slugProblem('catalog')).toContain('reserved');
  });
});

describe('buildCreateBody', () => {
  it('carries the steps and flat fields, leaving out an empty description and no limits', () => {
    expect(
      buildCreateBody(
        {
          slug: ' my-type ',
          displayName: ' My type ',
          description: '  ',
          requiresRepository: false,
          enabled: true,
          selectable: true,
          sortOrder: '',
        },
        { stepIds: ['a', 'b'], loopLimits: {} },
      ),
    ).toEqual({
      slug: 'my-type',
      displayName: 'My type',
      stepIds: ['a', 'b'],
      requiresRepository: false,
      selectable: true,
      enabled: true,
      sortOrder: 0,
    });
  });

  it('sends loop limits when set', () => {
    const body = buildCreateBody(
      { slug: 's', displayName: 'S', requiresRepository: true },
      { stepIds: ['a'], loopLimits: { a: 3 } },
    );
    expect(body.stepLoopLimitDefaults).toEqual({ a: 3 });
  });
});

describe('buildUpdateBody', () => {
  const values = {
    displayName: 'Renamed',
    description: 'd',
    requiresRepository: true,
    enabled: false,
    selectable: true,
    sortOrder: 4,
  };
  const SAVED = { requiresRepository: true };

  it('leaves an unchanged requiresRepository out of a flat edit, since the api re-checks the steps for it', () => {
    const body = buildUpdateBody(values, ADMIN_FIELDS, null, SAVED);
    expect(body).not.toHaveProperty('requiresRepository');
    expect(body.enabled).toBe(false);
  });

  it('sends only the fields that differ from the saved row, so a stale page cannot undo another edit', () => {
    const saved = {
      displayName: 'Old name',
      description: 'd',
      requiresRepository: true,
      enabled: false,
      selectable: true,
      sortOrder: 1,
    };
    const stale = { ...saved, sortOrder: 4 };
    expect(buildUpdateBody(stale, ADMIN_FIELDS, null, saved)).toEqual({ sortOrder: 4 });
  });

  it('sends requiresRepository when it changed', () => {
    const body = buildUpdateBody(values, ADMIN_FIELDS, null, { requiresRepository: false });
    expect(body.requiresRepository).toBe(true);
  });

  it('sends only editable fields for a built-in row', () => {
    expect(
      buildUpdateBody(values, ['displayName', 'description', 'sortOrder'], null, SAVED),
    ).toEqual({
      displayName: 'Renamed',
      description: 'd',
      sortOrder: 4,
    });
  });

  it("sends only the composition field that changed, so a stale page keeps another admin's order", () => {
    const body = buildUpdateBody(
      values,
      ADMIN_FIELDS,
      {
        stepIds: ['a', 'b'],
        loopLimits: { a: 3 },
        saved: {
          stepIds: ['a', 'b'],
          stepLoopLimitDefaults: { a: 2 },
          preAnswerDefaults: { a: { x: 1 } },
        },
      },
      SAVED,
    );
    expect(body.stepLoopLimitDefaults).toEqual({ a: 3 });
    expect(body).not.toHaveProperty('stepIds');
    expect(body).not.toHaveProperty('preAnswerDefaults');
  });

  it('leaves preset answers out of a reorder that removes no preset step', () => {
    const body = buildUpdateBody(
      values,
      ADMIN_FIELDS,
      {
        stepIds: ['b', 'a', 'c'],
        loopLimits: {},
        saved: {
          stepIds: ['a', 'b'],
          stepLoopLimitDefaults: {},
          preAnswerDefaults: { a: { x: 1 } },
        },
      },
      SAVED,
    );
    expect(body.stepIds).toEqual(['b', 'a', 'c']);
    expect(body).not.toHaveProperty('preAnswerDefaults');
  });

  it('sends the composition for a custom row and drops answers for removed steps', () => {
    const body = buildUpdateBody(
      values,
      ADMIN_FIELDS,
      {
        stepIds: ['a'],
        loopLimits: { a: 2 },
        saved: {
          stepIds: ['a', 'gone'],
          stepLoopLimitDefaults: {},
          preAnswerDefaults: { a: { x: 1 }, gone: { y: 2 } },
        },
      },
      SAVED,
    );
    expect(body.stepIds).toEqual(['a']);
    expect(body.stepLoopLimitDefaults).toEqual({ a: 2 });
    expect(body.preAnswerDefaults).toEqual({ a: { x: 1 } });
    expect(body.enabled).toBe(false);
  });
});

describe('compositionChanged', () => {
  const saved = { stepIds: ['a', 'b'], stepLoopLimitDefaults: { a: 2 } };

  it('is false for a list moved and moved back', () => {
    expect(compositionChanged({ stepIds: ['a', 'b'], loopLimits: { a: 2 } }, saved)).toBe(false);
  });

  it('is true for a new order or a new loop limit', () => {
    expect(compositionChanged({ stepIds: ['b', 'a'], loopLimits: { a: 2 } }, saved)).toBe(true);
    expect(compositionChanged({ stepIds: ['a', 'b'], loopLimits: { a: 3 } }, saved)).toBe(true);
    expect(compositionChanged({ stepIds: ['a', 'b'], loopLimits: {} }, saved)).toBe(true);
  });
});

describe('prompt steps in the bodies', () => {
  const step = (slug: string, template = 'Do it') => ({
    slug,
    title: `T ${slug}`,
    template,
    capabilities: [] as ('tool_use' | 'file_write' | 'vision')[],
    tools: [],
    timeoutMs: 300_000,
  });
  const values = {
    displayName: 'N',
    description: '',
    requiresRepository: true,
    enabled: true,
    selectable: true,
    sortOrder: 0,
  };
  const savedRow = (promptSteps: Record<string, ReturnType<typeof step>>, stepIds: string[]) => ({
    stepIds,
    stepLoopLimitDefaults: {},
    preAnswerDefaults: {},
    promptSteps,
  });
  const fields = [...ADMIN_FIELDS, 'promptSteps'];

  it('sends the listed prompt steps on create, and none when there are none', () => {
    const withStep = buildCreateBody(
      { slug: 't', displayName: 'T', requiresRepository: true },
      { stepIds: ['custom.t.a'], loopLimits: {}, promptSteps: { a: step('a'), z: step('z') } },
    );
    expect(withStep.promptSteps).toEqual({ a: step('a') });
    const without = buildCreateBody(
      { slug: 't', displayName: 'T', requiresRepository: true },
      { stepIds: ['x'], loopLimits: {} },
    );
    expect(without).not.toHaveProperty('promptSteps');
  });

  it('leaves promptSteps out when they did not change, however the list moved', () => {
    const body = buildUpdateBody(
      values,
      fields,
      {
        stepIds: ['x', 'custom.t.a'],
        loopLimits: {},
        promptSteps: { a: step('a') },
        typeSlug: 't',
        saved: savedRow({ a: step('a') }, ['custom.t.a', 'x']),
      },
      { ...values },
    );
    expect(body.stepIds).toEqual(['x', 'custom.t.a']);
    expect(body).not.toHaveProperty('promptSteps');
  });

  it('sends the whole set when a step was edited, added or removed', () => {
    const run = (
      now: Record<string, ReturnType<typeof step>>,
      ids: string[],
      was: Record<string, ReturnType<typeof step>>,
      wasIds: string[],
    ) =>
      buildUpdateBody(
        values,
        fields,
        {
          stepIds: ids,
          loopLimits: {},
          promptSteps: now,
          typeSlug: 't',
          saved: savedRow(was, wasIds),
        },
        { ...values },
      );
    expect(
      run({ a: step('a', 'Changed') }, ['custom.t.a'], { a: step('a') }, ['custom.t.a'])
        .promptSteps,
    ).toEqual({ a: step('a', 'Changed') });
    expect(
      run({ a: step('a'), b: step('b') }, ['custom.t.a', 'custom.t.b'], { a: step('a') }, [
        'custom.t.a',
      ]).promptSteps,
    ).toEqual({ a: step('a'), b: step('b') });
    const removed = run(
      { a: step('a'), b: step('b') },
      ['custom.t.a'],
      { a: step('a'), b: step('b') },
      ['custom.t.a', 'custom.t.b'],
    );
    expect(removed.promptSteps).toEqual({ a: step('a') });
    expect(removed.stepIds).toEqual(['custom.t.a']);
  });

  it('never sends promptSteps for a row the api does not let change them', () => {
    const body = buildUpdateBody(
      values,
      ADMIN_FIELDS,
      {
        stepIds: ['a'],
        loopLimits: {},
        promptSteps: { a: step('a') },
        typeSlug: 't',
        saved: savedRow({}, ['b']),
      },
      { ...values },
    );
    expect(body).not.toHaveProperty('promptSteps');
  });
});

describe('compositionChanged with prompt steps', () => {
  const step = {
    slug: 'a',
    title: 'A',
    template: 'x',
    capabilities: [] as [],
    tools: [],
    timeoutMs: 300_000,
  };
  const saved = { stepIds: ['custom.t.a'], stepLoopLimitDefaults: {}, promptSteps: { a: step } };

  it('is false for an unchanged set and true for an edited one', () => {
    const current = { stepIds: ['custom.t.a'], loopLimits: {} };
    expect(compositionChanged({ ...current, promptSteps: { a: { ...step } } }, saved)).toBe(false);
    expect(
      compositionChanged({ ...current, promptSteps: { a: { ...step, template: 'y' } } }, saved),
    ).toBe(true);
  });
});
