import { afterEach, describe, expect, it } from 'vitest';
import { databaseName, installId, InvalidInstallIdError } from '../src/naming/index.js';
import {
  collectFieldIds,
  dashboardSpecSchema,
  dashboardWidgetSchema,
  moduleManifestSchema,
  chartResponseSchema,
  kpiResponseSchema,
  meterResponseSchema,
  statusResponseSchema,
  tableResponseSchema,
  widgetResponseSchema,
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
    expect(ok({ ...manifest, nav: [{ href: '/m/acme/%2e%2e/admin', label: 'x' }] })).toBe(false);
    expect(ok({ ...manifest, nav: [{ href: '/m/acme/a\\b', label: 'x' }] })).toBe(false);
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

describe('module id length', () => {
  const POSTGRES_IDENTIFIER_BYTES = 63;
  const LONGEST_INSTALL_ID = 'a'.repeat(32);
  const withId = (id: string) => ok({ id, name: 'A', version: '1', schemaVersion: 1 });
  const original = process.env.HAIVE_INSTALL_ID;

  afterEach(() => {
    if (original === undefined) delete process.env.HAIVE_INSTALL_ID;
    else process.env.HAIVE_INSTALL_ID = original;
  });

  it('is bounded by the longest install id installId accepts', () => {
    expect(installId({ HAIVE_INSTALL_ID: LONGEST_INSTALL_ID })).toBe(LONGEST_INSTALL_ID);
    expect(() => installId({ HAIVE_INSTALL_ID: `${LONGEST_INSTALL_ID}a` })).toThrow(
      InvalidInstallIdError,
    );
  });

  it('accepts exactly the ids whose module database name fits a Postgres identifier', () => {
    process.env.HAIVE_INSTALL_ID = LONGEST_INSTALL_ID;
    const bytes = (id: string) => Buffer.byteLength(databaseName('module', id));
    expect(bytes('a'.repeat(23))).toBe(POSTGRES_IDENTIFIER_BYTES);
    expect(bytes('a'.repeat(24))).toBe(POSTGRES_IDENTIFIER_BYTES + 1);
    expect(withId('a'.repeat(23))).toBe(true);
    expect(withId('a'.repeat(24))).toBe(false);
  });

  it('still accepts a dashed id of the longest length', () => {
    expect(withId('a-'.repeat(11) + 'a')).toBe(true);
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

describe('widget endpoint confinement', () => {
  const withEndpoint = (endpoint: string) =>
    ok({
      ...manifest,
      pages: { home: { title: 'H', widgets: [{ type: 'kpi', label: 'L', endpoint }] } },
    });

  it('accepts the module prefix and its sub-paths', () => {
    expect(withEndpoint('/m/acme')).toBe(true);
    expect(withEndpoint('/m/acme/load')).toBe(true);
    expect(withEndpoint('/m/acme/load?x=1')).toBe(true);
  });

  it.each([
    '/m/acme/%2e%2e/admin',
    '/m/acme/%2E%2E/%2e%2e/admin/users',
    '/admin/users',
    '/m/other/x',
    '/m/acmeX/x',
    '/m/acme\\..\\admin',
    '/m/acme/a\\b',
  ])('refuses %s', (endpoint) => {
    expect(withEndpoint(endpoint)).toBe(false);
  });

  it('refuses a status or chart endpoint outside the prefix', () => {
    const bad = (widget: unknown) =>
      ok({ ...manifest, pages: { p: { title: 'P', widgets: [widget] } } });
    expect(bad({ type: 'status', endpoint: '/admin/users' })).toBe(false);
    expect(
      bad({
        type: 'chart',
        kind: 'bar',
        xKey: 'x',
        series: [{ key: 'n', label: 'N' }],
        endpoint: '/m/other/x',
      }),
    ).toBe(false);
  });
});

describe('widget response schemas', () => {
  const pass = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
    schema.safeParse(v).success;

  it('kpi', () => {
    expect(pass(kpiResponseSchema, { value: 4 })).toBe(true);
    expect(pass(kpiResponseSchema, { value: 'high', unit: 'pcs' })).toBe(true);
    expect(pass(kpiResponseSchema, { value: null })).toBe(false);
    expect(pass(kpiResponseSchema, {})).toBe(false);
  });

  it('table', () => {
    expect(pass(tableResponseSchema, { rows: [{ a: 'x', b: null, c: 1 }] })).toBe(true);
    expect(pass(tableResponseSchema, { rows: [{ a: { nested: 1 } }] })).toBe(false);
    expect(pass(tableResponseSchema, { rows: 'x' })).toBe(false);
  });

  it('meter', () => {
    expect(pass(meterResponseSchema, { value: 3, max: 10 })).toBe(true);
    expect(pass(meterResponseSchema, { value: 3 })).toBe(false);
    expect(pass(meterResponseSchema, { value: '3', max: 10 })).toBe(false);
  });

  it('status', () => {
    expect(pass(statusResponseSchema, { items: [{ label: 'Tests', status: 'pass' }] })).toBe(true);
    expect(pass(statusResponseSchema, { items: [{ label: 'Tests', status: 'bogus' }] })).toBe(
      false,
    );
    expect(pass(statusResponseSchema, { items: [{ label: '', status: 'pass' }] })).toBe(false);
  });

  it('chart', () => {
    expect(pass(chartResponseSchema, { data: [{ day: 'mon', n: 1 }] })).toBe(true);
    expect(pass(chartResponseSchema, { data: [{ day: ['mon'] }] })).toBe(false);
    expect(pass(chartResponseSchema, { rows: [] })).toBe(false);
  });

  it('looks a schema up by widget type', () => {
    expect(widgetResponseSchema('kpi')).toBe(kpiResponseSchema);
    expect(widgetResponseSchema('table')).toBe(tableResponseSchema);
    expect(widgetResponseSchema('meter')).toBe(meterResponseSchema);
    expect(widgetResponseSchema('status')).toBe(statusResponseSchema);
    expect(widgetResponseSchema('chart')).toBe(chartResponseSchema);
  });
});

describe('collectFieldIds', () => {
  it('returns top-level and accordion field ids', () => {
    expect([...collectFieldIds(form as never)].sort()).toEqual(['apiUrl', 'group', 'nested']);
  });
});
