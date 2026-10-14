import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModuleState } from '@haive/shared/modularity';
import { ModuleActiveCell } from './module-active-cell';

const SINCE = '2026-10-14T12:30:00.000Z';
const DOWN = '2026-10-14T13:45:00.000Z';
const row = (
  over: {
    rowVersion?: string | null;
    deactivatedAt?: string | null;
    state?: ModuleState;
    tornDownAt?: string | null;
  } = {},
) => ({
  id: 'statistics',
  rowVersion: '0.1.0' as string | null,
  deactivatedAt: null as string | null,
  state: 'loaded' as ModuleState,
  tornDownAt: null as string | null,
  ...over,
});
const render = (r = row(), busy = false) =>
  renderToStaticMarkup(
    <ModuleActiveCell row={r} busy={busy} onToggle={() => {}} onTeardown={() => {}} />,
  );

describe('ModuleActiveCell', () => {
  it('reads Active and offers Deactivate for an active recorded module', () => {
    const html = render();
    expect(html).toContain('>Active<');
    expect(html).not.toContain('Deactivated since');
    expect(html).toMatch(/<button[^>]*>Deactivate<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>Activate<\/button>/);
  });

  it('reads Deactivated since the stamp and offers Activate for a deactivated one', () => {
    const html = render(row({ deactivatedAt: SINCE }));
    expect(html).toContain(`Deactivated since ${new Date(SINCE).toLocaleString()}`);
    expect(html).not.toContain('>Active<');
    expect(html).toMatch(/<button[^>]*>Activate<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>Deactivate<\/button>/);
  });

  it('offers nothing to flip for a module with no recorded row', () => {
    const html = render(row({ rowVersion: null }));
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Active');
    expect(html).not.toContain('Deactivated');
    expect(html).toContain('—');
  });

  it('keeps the button but disables it while a flip is in flight', () => {
    expect(render(row(), true)).toMatch(/<button[^>]*disabled=""[^>]*>Deactivate<\/button>/);
    expect(render(row({ deactivatedAt: SINCE }), true)).toMatch(
      /<button[^>]*disabled=""[^>]*>Activate<\/button>/,
    );
    expect(render(row(), false)).not.toContain('disabled=""');
  });

  it('names the module on the button, so a column of identical buttons is told apart', () => {
    expect(render()).toContain('aria-label="Deactivate statistics"');
    expect(render(row({ deactivatedAt: SINCE }))).toContain('aria-label="Activate statistics"');
  });
});

describe('ModuleActiveCell teardown control', () => {
  const off = (over: Parameters<typeof row>[0] = {}) => row({ deactivatedAt: SINCE, ...over });
  const NOT_LOADED: ModuleState[] = ['missing', 'api-only', 'worker-only', 'unrecorded', 'unknown'];

  it('offers Tear down, named for the module, on a deactivated module both processes loaded', () => {
    const html = render(off());
    expect(html).toMatch(/<button[^>]*aria-label="Tear down statistics"[^>]*>Tear down<\/button>/);
    expect(html).not.toContain('Torn down');
  });

  it('offers no Tear down on an active module', () => {
    for (const state of ['loaded', ...NOT_LOADED] as ModuleState[]) {
      const html = render(row({ state }));
      expect(html).not.toContain('Tear down');
      expect(html).not.toContain('Torn down');
    }
  });

  it.each(NOT_LOADED)('offers no Tear down on a deactivated module in state %s', (state) => {
    const html = render(off({ state }));
    expect(html).not.toContain('Tear down');
    expect(html).toMatch(/<button[^>]*>Activate<\/button>/);
  });

  it('reads Torn down with the time, and offers no second Tear down, once the teardown ran', () => {
    const html = render(off({ tornDownAt: DOWN }));
    expect(html).toContain(`Torn down ${new Date(DOWN).toLocaleString()}`);
    expect(html).not.toContain('>Tear down<');
    expect(html).toMatch(/<button[^>]*>Activate<\/button>/);
  });

  it.each(NOT_LOADED)('keeps reading Torn down when the module is %s', (state) => {
    expect(render(off({ state, tornDownAt: DOWN }))).toContain('Torn down');
  });

  it('offers nothing for a module with no recorded row, whatever else the row says', () => {
    const html = render(off({ rowVersion: null, tornDownAt: DOWN }));
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Torn down');
  });

  it('disables Tear down while a request is in flight', () => {
    expect(render(off(), true)).toMatch(/<button[^>]*disabled=""[^>]*>Tear down<\/button>/);
    expect(render(off(), false)).not.toContain('disabled=""');
  });

  it('wires Tear down to onTeardown and the flip button to onToggle, and no other way round', () => {
    const onToggle = vi.fn();
    const onTeardown = vi.fn();
    const found: Record<string, () => void> = {};
    const walk = (node: ReactNode) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!isValidElement(node)) return;
      const props = (node as ReactElement<Record<string, unknown>>).props;
      if (typeof props['aria-label'] === 'string') {
        found[props['aria-label']] = props.onClick as () => void;
      }
      walk(props.children as ReactNode);
    };
    walk(ModuleActiveCell({ row: off(), busy: false, onToggle, onTeardown }) as ReactElement);
    found['Tear down statistics']!();
    expect([onToggle.mock.calls.length, onTeardown.mock.calls.length]).toEqual([0, 1]);
    found['Activate statistics']!();
    expect([onToggle.mock.calls.length, onTeardown.mock.calls.length]).toEqual([1, 1]);
  });
});
