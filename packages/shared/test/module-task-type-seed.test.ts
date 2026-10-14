import { describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import {
  CUSTOM_TASK_TYPE_SLUG_PATTERN,
  moduleIdOfTaskTypeSlug,
  moduleManifestSchema,
  moduleTaskTypeSlug,
  taskTypeDefinitionSeedSchema,
} from '../src/modularity/index.js';

const seed = (over: Record<string, unknown> = {}) => ({
  slug: 'weekly',
  displayName: 'Weekly report',
  runListStrategy: 'static',
  stepIds: ['module.fx.report'],
  selectable: true,
  requiresRepository: false,
  ...over,
});

const manifest = (taskTypes: unknown[], id = 'fx') => ({
  id,
  name: 'Fixture',
  version: '1.0.0',
  schemaVersion: 1,
  taskTypes,
});

function problems(value: unknown): string[] {
  const parsed = moduleManifestSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('a module task type seed in a manifest', () => {
  it('accepts core step ids, its own module step ids, and both together', () => {
    for (const stepIds of [
      ['01-env-detect', '07-phase-2-implement'],
      ['module.fx.report', 'module.fx.send'],
      ['01-env-detect', 'module.fx.report', '12-worktree-cleanup'],
    ]) {
      expect(problems(manifest([seed({ stepIds })]))).toEqual([]);
    }
  });

  it.each(['workflow_paths', 'run_app_modes'])(
    'refuses the %s strategy and names the slug',
    (s) => {
      const found = problems(manifest([seed({ runListStrategy: s, stepIds: null })]));
      expect(found.length).toBeGreaterThan(0);
      expect(found.join('\n')).toContain('"weekly"');
      expect(found.join('\n')).toMatch(/static/);
    },
  );

  it('refuses a sort order that is not a whole number, as its integer column would', () => {
    expect(problems(manifest([seed({ sortOrder: 1.5 })])).length).toBeGreaterThan(0);
    expect(problems(manifest([seed({ sortOrder: 2 })]))).toEqual([]);
  });

  it('refuses a custom step id and names the slug and the id', () => {
    const found = problems(manifest([seed({ stepIds: ['01-env-detect', 'custom.mine.step'] })]));
    expect(found.length).toBeGreaterThan(0);
    expect(found.join('\n')).toContain('"weekly"');
    expect(found.join('\n')).toContain('custom.mine.step');
  });

  it("refuses another module's step id and names the slug and the id", () => {
    const found = problems(manifest([seed({ stepIds: ['module.gx.report'] })]));
    expect(found.length).toBeGreaterThan(0);
    expect(found.join('\n')).toContain('"weekly"');
    expect(found.join('\n')).toContain('module.gx.report');
  });

  it('reads the owner from the manifest id, not from the first module id it meets', () => {
    expect(problems(manifest([seed({ stepIds: ['module.gx.report'] })], 'gx'))).toEqual([]);
    expect(
      problems(manifest([seed({ stepIds: ['module.fx.report'] })], 'gx')).length,
    ).toBeGreaterThan(0);
  });

  it('allows a stored slug of 128 characters and refuses 129, naming the slug', () => {
    const fits = 'a'.repeat(128 - 'fx__'.length);
    const over = 'a'.repeat(129 - 'fx__'.length);
    expect(moduleTaskTypeSlug('fx', fits)).toHaveLength(128);
    expect(problems(manifest([seed({ slug: fits })]))).toEqual([]);
    const found = problems(manifest([seed({ slug: over })]));
    expect(found.length).toBeGreaterThan(0);
    expect(found.join('\n')).toContain(`"${over}"`);
  });

  it('counts the module id towards the length', () => {
    const id = 'm'.repeat(100);
    const local = 'a'.repeat(128 - id.length - 2);
    const core = ['01-env-detect'];
    expect(problems(manifest([seed({ slug: local, stepIds: core })], id))).toEqual([]);
    expect(
      problems(manifest([seed({ slug: `${local}a`, stepIds: core })], id)).length,
    ).toBeGreaterThan(0);
  });

  it('names every offending slug when several seeds are wrong', () => {
    const found = problems(
      manifest([
        seed({ slug: 'one', runListStrategy: 'workflow_paths', stepIds: null }),
        seed({ slug: 'two', stepIds: ['custom.mine.step'] }),
        seed({ slug: 'three' }),
      ]),
    );
    const text = found.join('\n');
    expect(text).toContain('"one"');
    expect(text).toContain('"two"');
    expect(text).not.toContain('"three"');
  });

  it('leaves the shared seed schema usable by built-ins: dynamic and custom ids still parse', () => {
    expect(
      taskTypeDefinitionSeedSchema.safeParse(
        seed({ runListStrategy: 'workflow_paths', stepIds: null }),
      ).success,
    ).toBe(true);
    expect(
      taskTypeDefinitionSeedSchema.safeParse(
        seed({ stepIds: ['custom.mine.step', 'module.gx.report'] }),
      ).success,
    ).toBe(true);
  });
});

describe('moduleTaskTypeSlug and moduleIdOfTaskTypeSlug', () => {
  const pairs: [string, string][] = [
    ['fx', 'weekly'],
    ['a', 'b'],
    ['acme-pro', 'sync-data'],
    ['m1', 'my_type'],
    ['fx', 'a__b'],
    ['fx', '0'],
    ['trailing-', 'x'],
  ];

  it('joins the module id and the local slug with two underscores', () => {
    expect(moduleTaskTypeSlug('fx', 'weekly')).toBe('fx__weekly');
  });

  it('reads the module id back from every pair it builds', () => {
    for (const [moduleId, local] of pairs) {
      expect(
        moduleIdOfTaskTypeSlug(moduleTaskTypeSlug(moduleId, local)),
        `${moduleId}/${local}`,
      ).toBe(moduleId);
    }
  });

  it('never reads a built-in or an admin slug as a module slug', () => {
    for (const slug of schema.workflowTypeEnum.enumValues) {
      expect(slug).not.toContain('__');
      expect(moduleIdOfTaskTypeSlug(slug), slug).toBeNull();
    }
    for (const slug of ['my-type', 'a', 'x'.repeat(64), 'a1-b2']) {
      expect(CUSTOM_TASK_TYPE_SLUG_PATTERN.test(slug)).toBe(true);
      expect(moduleIdOfTaskTypeSlug(slug), slug).toBeNull();
    }
  });

  it('returns null for a string that is not a module slug', () => {
    for (const slug of [
      '',
      'fx__',
      '__weekly',
      'fx___weekly',
      'Fx__weekly',
      'fx_weekly',
      'fx__.x',
    ]) {
      expect(moduleIdOfTaskTypeSlug(slug), slug).toBeNull();
    }
  });

  it('cannot collide with an admin slug or another module: no id and no admin slug holds an underscore', () => {
    expect(CUSTOM_TASK_TYPE_SLUG_PATTERN.test('fx__weekly')).toBe(false);
    expect(CUSTOM_TASK_TYPE_SLUG_PATTERN.test('fx_weekly')).toBe(false);
    expect(moduleManifestSchema.safeParse({ ...manifest([]), id: 'f_x' }).success).toBe(false);
    expect(moduleManifestSchema.safeParse({ ...manifest([]), id: 'fx__a' }).success).toBe(false);
    expect(moduleIdOfTaskTypeSlug('fx__a__b')).toBe('fx');
  });

  it('never stores a dot, which the web proxy would route around its checks', () => {
    for (const [moduleId, local] of pairs) {
      expect(moduleTaskTypeSlug(moduleId, local)).not.toContain('.');
    }
    expect(taskTypeDefinitionSeedSchema.safeParse(seed({ slug: 'a.b' })).success).toBe(false);
    expect(moduleManifestSchema.safeParse({ ...manifest([]), id: 'f.x' }).success).toBe(false);
  });
});
