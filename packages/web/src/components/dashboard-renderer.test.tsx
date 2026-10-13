import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DashboardSpec } from '@haive/shared/modularity';
import type { HostApi } from '@haive/web-kit/host';
import { DashboardRenderer, fetchWidgetData, isModuleEndpoint } from './dashboard-renderer';

const BASE = 'http://localhost:3001';

describe('isModuleEndpoint', () => {
  it('accepts the module prefix and anything below it', () => {
    expect(isModuleEndpoint('acme', '/m/acme', BASE)).toBe(true);
    expect(isModuleEndpoint('acme', '/m/acme/load', BASE)).toBe(true);
    expect(isModuleEndpoint('acme', '/m/acme/load?range=7d', BASE)).toBe(true);
  });

  it('refuses another module, a core route and a prefix-sharing id', () => {
    expect(isModuleEndpoint('acme', '/m/other/load', BASE)).toBe(false);
    expect(isModuleEndpoint('acme', '/admin/users', BASE)).toBe(false);
    expect(isModuleEndpoint('acme', '/m/acmeevil/load', BASE)).toBe(false);
  });

  it('keeps the prefix under an api base that has a path of its own', () => {
    expect(isModuleEndpoint('acme', '/m/acme/load', 'https://host/api')).toBe(true);
    expect(isModuleEndpoint('acme', '/m/acme/%2e%2e/%2e%2e/admin', 'https://host/api')).toBe(false);
  });

  it('refuses a traversal the URL parser would resolve out of the prefix', () => {
    expect(isModuleEndpoint('acme', '/m/acme/%2e%2e/%2e%2e/admin/users', BASE)).toBe(false);
    expect(isModuleEndpoint('acme', '/m/acme/.%2E/other/x', BASE)).toBe(false);
    expect(isModuleEndpoint('acme', '/m/acme/../other/x', BASE)).toBe(false);
    expect(isModuleEndpoint('acme', '/m/acme/..\\admin', BASE)).toBe(false);
  });

  it('refuses an endpoint that leaves the api origin', () => {
    expect(isModuleEndpoint('acme', '@evil.example/m/acme/x', BASE)).toBe(false);
    expect(isModuleEndpoint('acme', '//evil.example/m/acme/x', BASE)).toBe(false);
  });
});

describe('fetchWidgetData', () => {
  const apiReturning = (value: unknown): HostApi & { get: ReturnType<typeof vi.fn> } =>
    ({ get: vi.fn().mockResolvedValue(value) }) as never;

  it('fetches a guarded endpoint and returns the validated response', async () => {
    const api = apiReturning({ value: 4, unit: 'ms' });
    await expect(fetchWidgetData(api, 'acme', 'kpi', '/m/acme/load', BASE)).resolves.toEqual({
      value: 4,
      unit: 'ms',
    });
    expect(api.get).toHaveBeenCalledWith('/m/acme/load');
  });

  it('rejects an invalid response', async () => {
    const api = apiReturning({ value: { nested: true } });
    await expect(fetchWidgetData(api, 'acme', 'kpi', '/m/acme/load', BASE)).rejects.toThrow(
      /invalid/i,
    );
  });

  it('never fetches an endpoint outside the module prefix', async () => {
    const api = apiReturning({ value: 1 });
    await expect(fetchWidgetData(api, 'acme', 'kpi', '/admin/users', BASE)).rejects.toThrow();
    await expect(
      fetchWidgetData(api, 'acme', 'kpi', '/m/acme/%2e%2e/admin/users', BASE),
    ).rejects.toThrow();
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('DashboardRenderer', () => {
  const api = { get: vi.fn() } as unknown as HostApi;
  const render = (spec: DashboardSpec) =>
    renderToStaticMarkup(<DashboardRenderer moduleId="acme" spec={spec} api={api} />);

  it('renders inline kpi, table, meter, markdown, status and chart widgets', () => {
    const html = render({
      title: 'Overview',
      widgets: [
        { type: 'kpi', label: 'Runs', value: 42, unit: 'jobs' },
        {
          type: 'table',
          title: 'Rows',
          columns: [
            { key: 'name', label: 'Name' },
            { key: 'n', label: 'Count' },
          ],
          rows: [{ name: 'alpha', n: 3 }],
        },
        { type: 'meter', label: 'Disk', value: 25, max: 100 },
        { type: 'markdown', body: '**bold** text' },
        { type: 'chart', kind: 'line', xKey: 'd', series: [{ key: 'v', label: 'V' }], data: [] },
        { type: 'status', title: 'Checks', endpoint: '/m/acme/checks' },
      ],
    });
    expect(html).toContain('Runs');
    expect(html).toContain('42');
    expect(html).toContain('jobs');
    expect(html).toContain('<table');
    expect(html).toContain('alpha');
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('Disk');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('Loading chart');
    expect(html).toContain('Checks');
  });

  it('shows the error inside a widget whose endpoint is outside the module', () => {
    const html = render({
      title: 'Bad',
      widgets: [
        { type: 'kpi', label: 'Ok', value: 1 },
        { type: 'kpi', label: 'Leak', endpoint: '/admin/users' },
      ],
    });
    expect(html).toContain('Ok');
    expect(html).toContain('Leak');
    expect(html).toContain('role="alert"');
  });
});
