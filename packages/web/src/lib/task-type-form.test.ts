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

  it('sends the composition for a custom row and drops answers for removed steps', () => {
    const body = buildUpdateBody(
      values,
      ADMIN_FIELDS,
      {
        stepIds: ['a'],
        loopLimits: { a: 2 },
        preAnswerDefaults: { a: { x: 1 }, gone: { y: 2 } },
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
