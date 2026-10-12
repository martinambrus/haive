import { describe, expect, it } from 'vitest';
import {
  collectFieldIds,
  dashboardSpecSchema,
  dashboardWidgetSchema,
  moduleManifestSchema,
} from '../src/modularity/index.js';

const form = {
  title: 'Settings',
  fields: [
    { id: 'apiUrl', type: 'text', label: 'API URL' },
    {
      id: 'group',
      type: 'accordion',
      label: 'Group',
      items: [{ title: 'Inner', fields: [{ id: 'nested', type: 'text', label: 'Nested' }] }],
    },
  ],
};

const step = {
  stepId: 'sync-data',
  label: 'Sync data',
  group: 'Data',
  dispatchesCli: false,
  requires: [],
  provides: [],
};

const taskType = {
  slug: 'sync',
  displayName: 'Sync',
  runListStrategy: 'static',
  stepIds: ['sync-data'],
  selectable: true,
  requiresRepository: false,
};

const manifest = {
  id: 'acme',
  name: 'Acme',
  version: '1.0.0',
  schemaVersion: 1,
  nav: [
    { href: '/m/acme', label: 'Home', icon: 'home', order: 1 },
    { href: '/m/acme/stats', label: 'Stats', adminOnly: true },
  ],
  pages: {
    home: {
      title: 'Home',
      description: 'Overview',
      widgets: [
        { type: 'kpi', label: 'Users', value: 4, unit: 'pcs' },
        { type: 'kpi', label: 'Load', endpoint: '/m/acme/load' },
        {
          type: 'table',
          columns: [{ key: 'a', label: 'A' }],
          rows: [{ a: 'x' }, { a: null }],
        },
        { type: 'meter', label: 'Disk', value: 3, max: 10 },
        { type: 'markdown', body: '# hi' },
        { type: 'status', endpoint: '/m/acme/status' },
        {
          type: 'chart',
          kind: 'line',
          xKey: 'day',
          series: [{ key: 'n', label: 'N' }],
          data: [{ day: 'mon', n: 1 }],
        },
      ],
    },
  },
  apiRequiresAdmin: true,
  globalSettings: { form, defaults: { apiUrl: 'x' } },
  adminSettings: { form, defaults: { nested: 'y' } },
  composableSteps: [step],
  taskTypes: [taskType],
  ownsDatabase: true,
  hasWebPages: true,
  entitlementId: 'acme-pro',
};

const ok = (v: unknown) => moduleManifestSchema.safeParse(v).success;
const widgetOk = (v: unknown) => dashboardWidgetSchema.safeParse(v).success;

describe('moduleManifestSchema', () => {
  it('parses a full manifest', () => {
    expect(moduleManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('parses a minimal manifest', () => {
    expect(ok({ id: 'a', name: 'A', version: '1', schemaVersion: 1 })).toBe(true);
  });

  it('rejects a bad id, version, schemaVersion and page id', () => {
    expect(ok({ ...manifest, id: 'Acme' })).toBe(false);
    expect(ok({ ...manifest, id: '-a' })).toBe(false);
    expect(ok({ ...manifest, version: '' })).toBe(false);
    expect(ok({ ...manifest, schemaVersion: 0 })).toBe(false);
    expect(ok({ ...manifest, schemaVersion: 1.5 })).toBe(false);
    expect(ok({ ...manifest, pages: { 'Bad Id': manifest.pages.home } })).toBe(false);
  });

  it('rejects a nav href outside /m/<id>', () => {
    expect(ok({ ...manifest, nav: [{ href: '/m/other', label: 'x' }] })).toBe(false);
    expect(ok({ ...manifest, nav: [{ href: '/m/acmeX', label: 'x' }] })).toBe(false);
    expect(ok({ ...manifest, nav: [{ href: '/settings', label: 'x' }] })).toBe(false);
    expect(ok({ ...manifest, nav: [{ href: '/m/acme/a/b', label: 'x' }] })).toBe(true);
  });

  it('rejects a dotted or invalid composable step id', () => {
    expect(ok({ ...manifest, composableSteps: [{ ...step, stepId: 'module.acme.sync' }] })).toBe(
      false,
    );
    expect(ok({ ...manifest, composableSteps: [{ ...step, stepId: 'a.b' }] })).toBe(false);
  });

  it('rejects duplicate step ids and task type slugs', () => {
    expect(ok({ ...manifest, composableSteps: [step, step] })).toBe(false);
    expect(ok({ ...manifest, taskTypes: [taskType, taskType] })).toBe(false);
    expect(ok({ ...manifest, composableSteps: [step, { ...step, stepId: 'other-step' }] })).toBe(
      true,
    );
  });

  it('rejects a settings default for an unknown field', () => {
    expect(ok({ ...manifest, globalSettings: { form, defaults: { missing: 1 } } })).toBe(false);
    expect(ok({ ...manifest, adminSettings: { form, defaults: { missing: 1 } } })).toBe(false);
    expect(ok({ ...manifest, globalSettings: { form, defaults: {} } })).toBe(true);
  });
});

describe('dashboardSpecSchema', () => {
  it('needs a title and at least one widget', () => {
    expect(dashboardSpecSchema.safeParse({ title: 'T', widgets: [] }).success).toBe(false);
    expect(
      dashboardSpecSchema.safeParse({ widgets: [{ type: 'markdown', body: 'x' }] }).success,
    ).toBe(false);
  });
});

describe('dashboardWidgetSchema exactly-one rule', () => {
  const table = { type: 'table', columns: [{ key: 'a', label: 'A' }] };
  const chart = { type: 'chart', kind: 'bar', xKey: 'x', series: [{ key: 'y', label: 'Y' }] };

  it('kpi', () => {
    expect(widgetOk({ type: 'kpi', label: 'L', value: 1 })).toBe(true);
    expect(widgetOk({ type: 'kpi', label: 'L', value: 'ok' })).toBe(true);
    expect(widgetOk({ type: 'kpi', label: 'L', endpoint: '/a' })).toBe(true);
    expect(widgetOk({ type: 'kpi', label: 'L', value: 1, endpoint: '/a' })).toBe(false);
    expect(widgetOk({ type: 'kpi', label: 'L' })).toBe(false);
  });

  it('table', () => {
    expect(widgetOk({ ...table, rows: [] })).toBe(true);
    expect(widgetOk({ ...table, endpoint: '/a' })).toBe(true);
    expect(widgetOk({ ...table, rows: [], endpoint: '/a' })).toBe(false);
    expect(widgetOk(table)).toBe(false);
    expect(widgetOk({ type: 'table', columns: [], rows: [] })).toBe(false);
  });

  it('meter', () => {
    expect(widgetOk({ type: 'meter', label: 'L', value: 1, max: 2 })).toBe(true);
    expect(widgetOk({ type: 'meter', label: 'L', endpoint: '/a' })).toBe(true);
    expect(widgetOk({ type: 'meter', label: 'L', value: 1, max: 2, endpoint: '/a' })).toBe(false);
    expect(widgetOk({ type: 'meter', label: 'L', value: 1 })).toBe(false);
    expect(widgetOk({ type: 'meter', label: 'L', max: 2 })).toBe(false);
    expect(widgetOk({ type: 'meter', label: 'L' })).toBe(false);
  });

  it('chart', () => {
    expect(widgetOk({ ...chart, data: [] })).toBe(true);
    expect(widgetOk({ ...chart, endpoint: '/a' })).toBe(true);
    expect(widgetOk({ ...chart, data: [], endpoint: '/a' })).toBe(false);
    expect(widgetOk(chart)).toBe(false);
    expect(widgetOk({ ...chart, kind: 'radar', data: [] })).toBe(false);
    expect(widgetOk({ ...chart, series: [], data: [] })).toBe(false);
  });

  it('markdown and status', () => {
    expect(widgetOk({ type: 'markdown', body: '' })).toBe(true);
    expect(widgetOk({ type: 'status', endpoint: '/a' })).toBe(true);
    expect(widgetOk({ type: 'status' })).toBe(false);
    expect(widgetOk({ type: 'nope' })).toBe(false);
  });

  it('rejects bad endpoints', () => {
    for (const endpoint of ['http://x', '/a/../b', 'a/b', '/a b', '/a://b', '']) {
      expect(widgetOk({ type: 'kpi', label: 'L', endpoint })).toBe(false);
      expect(widgetOk({ type: 'status', endpoint })).toBe(false);
    }
    expect(widgetOk({ type: 'status', endpoint: '/m/acme/x?y=1' })).toBe(true);
  });
});

describe('collectFieldIds', () => {
  it('returns top-level and accordion field ids', () => {
    expect([...collectFieldIds(form as never)].sort()).toEqual(['apiUrl', 'group', 'nested']);
  });
});
