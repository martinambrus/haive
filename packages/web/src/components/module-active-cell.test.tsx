import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModuleDiffRow, ModuleState } from '@haive/shared/modularity';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { ModuleActiveCell } from './module-active-cell';

const SINCE = '2026-10-14T12:30:00.000Z';
const DOWN = '2026-10-14T13:45:00.000Z';
const GONE = '2026-10-14T15:00:00.000Z';
const row = (
  over: {
    rowVersion?: string | null;
    deactivatedAt?: string | null;
    drainingAt?: string | null;
    state?: ModuleState;
    tornDownAt?: string | null;
    missingAt?: string | null;
  } = {},
) => ({
  id: 'statistics',
  rowVersion: '0.1.0' as string | null,
  deactivatedAt: null as string | null,
  state: 'loaded' as ModuleState,
  tornDownAt: null as string | null,
  missingAt: null as string | null,
  ...over,
});
const render = (r = row(), busy = false) =>
  renderToStaticMarkup(
    <ModuleActiveCell
      row={r}
      busy={busy}
      onToggle={() => {}}
      onTeardown={() => {}}
      onPurge={() => {}}
    />,
  );

describe('ModuleActiveCell', () => {
  it('reads Active and offers Deactivate for an active recorded module', () => {
    const html = render();
    expect(html).toContain('>Active<');
    expect(html).not.toContain('Deactivated since');
    expect(html).toMatch(/<button[^>]*>Deactivate<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>Activate<\/button>/);
  });

  it('shows the structural drain and explicit cancel while keeping teardown hidden', () => {
    const html = render(row({ drainingAt: SINCE }));
    expect(html).toContain('Draining since');
    expect(html).toContain('View dependents');
    expect(html).toContain('Cancel drain');
    expect(html).not.toContain('Tear down');
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
    walk(
      ModuleActiveCell({
        row: off(),
        busy: false,
        onToggle,
        onTeardown,
        onPurge: () => {},
      }) as ReactElement,
    );
    found['Tear down statistics']!();
    expect([onToggle.mock.calls.length, onTeardown.mock.calls.length]).toEqual([0, 1]);
    found['Activate statistics']!();
    expect([onToggle.mock.calls.length, onTeardown.mock.calls.length]).toEqual([1, 1]);
  });
});

describe('ModuleActiveCell purge control', () => {
  const gone = (over: Parameters<typeof row>[0] = {}) =>
    row({ state: 'missing', missingAt: GONE, ...over });
  const NOT_MISSING: ModuleState[] = ['loaded', 'api-only', 'worker-only', 'unrecorded', 'unknown'];

  it('offers Purge data, named for the module, on a module the worker recorded as missing', () => {
    const html = render(gone());
    expect(html).toMatch(
      /<button[^>]*aria-label="Purge data of statistics"[^>]*>Purge data…<\/button>/,
    );
  });

  it.each(NOT_MISSING)('offers no Purge on a module in state %s', (state) => {
    expect(render(row({ state, missingAt: null }))).not.toContain('Purge');
    expect(render(row({ state, deactivatedAt: SINCE }))).not.toContain('Purge');
  });

  it('offers none on a row neither process loads that the worker has not yet stamped missing', () => {
    expect(render(gone({ missingAt: null }))).not.toContain('Purge');
  });

  it('offers none for a module with no recorded row', () => {
    expect(render(gone({ rowVersion: null }))).not.toContain('Purge');
  });

  it('keeps the rest of the cell for a missing module', () => {
    const html = render(gone({ deactivatedAt: SINCE, tornDownAt: DOWN }));
    expect(html).toContain(`Torn down ${new Date(DOWN).toLocaleString()}`);
    expect(html).toMatch(/<button[^>]*>Activate<\/button>/);
    expect(html).toContain('Purge data…');
  });

  it('disables Purge while a request is in flight', () => {
    expect(render(gone(), true)).toMatch(/<button[^>]*disabled=""[^>]*>Purge data…<\/button>/);
    expect(render(gone(), false)).not.toContain('disabled=""');
  });

  it('wires Purge to onPurge and to nothing else', () => {
    const calls = { toggle: 0, teardown: 0, purge: 0 };
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
    walk(
      ModuleActiveCell({
        row: gone(),
        busy: false,
        onToggle: () => void (calls.toggle += 1),
        onTeardown: () => void (calls.teardown += 1),
        onPurge: () => void (calls.purge += 1),
      }) as ReactElement,
    );
    found['Purge data of statistics']!();
    expect(calls).toEqual({ toggle: 0, teardown: 0, purge: 1 });
  });
});

describe('ModuleActiveCell runtime state', () => {
  type Props = ComponentProps<typeof ModuleActiveCell>;
  type Runtime = NonNullable<ModuleDiffRow['runtime']>;
  const REASON = 'schema migration 0007 refused: relation "x" is missing';
  const runtime = (state: Runtime['state'], reason: string | null = REASON): Runtime => ({
    state,
    schema: state === 'ready' ? 'ready' : 'failed',
    jobs: state === 'ready' ? 'running' : 'none',
    attempts: 3,
    reason,
  });
  const withRuntime = (r: Runtime, over: Parameters<typeof row>[0] = {}): Props['row'] => {
    const base: Props['row'] = row(over);
    return { ...base, runtime: r } as Props['row'];
  };
  const html = (r: Props['row'], busy = false) =>
    renderToStaticMarkup(
      <ModuleActiveCell
        row={r}
        busy={busy}
        onToggle={() => {}}
        onTeardown={() => {}}
        onPurge={() => {}}
        onRetry={() => {}}
      />,
    );
  const elements = (node: ReactNode): ReactElement<Record<string, unknown>>[] =>
    Array.isArray(node)
      ? node.flatMap(elements)
      : isValidElement<Record<string, unknown>>(node)
        ? [node, ...elements(node.props.children as ReactNode)]
        : [];
  const tree = (r: Props['row'], busy = false, extra: Partial<Props> = {}) =>
    elements(
      ModuleActiveCell({
        row: r,
        busy,
        onToggle: () => {},
        onTeardown: () => {},
        onPurge: () => {},
        ...extra,
      }) as ReactElement,
    );
  const reasonBodies = (r: Props['row']) =>
    tree(r)
      .filter((e) => e.type === InlineMarkdown)
      .map((e) => String(e.props.body));
  const RETRY_BUTTON = /<button[^>]*aria-label="Retry statistics"[^>]*>Retry<\/button>/;

  it('U1 marks an active module with a failed runtime Failed, with the reason and an explicit Retry beside Deactivate', () => {
    const out = html(withRuntime(runtime('failed')));
    expect(out).toContain('>Failed<');
    expect(out).toMatch(RETRY_BUTTON);
    expect(out).toMatch(/<button[^>]*>Deactivate<\/button>/);
    expect(reasonBodies(withRuntime(runtime('failed'))).some((b) => b.includes(REASON))).toBe(true);
    expect(reasonBodies(withRuntime(runtime('failed', null)))).toEqual([]);
    expect(html(withRuntime(runtime('failed', null)))).toMatch(RETRY_BUTTON);
  });

  it('U2 marks a pending runtime Starting, shows the reason and offers no Retry', () => {
    const out = html(withRuntime(runtime('pending')));
    expect(out).toContain('>Starting<');
    expect(out).not.toContain('Failed');
    expect(out).not.toContain('Retry');
    expect(reasonBodies(withRuntime(runtime('pending'))).some((b) => b.includes(REASON))).toBe(
      true,
    );
  });

  it('U3 guard: a ready runtime, no runtime and a null reason render exactly as the row does today', () => {
    const today = html(row());
    expect(html(withRuntime(runtime('ready', null)))).toBe(today);
    expect(html(withRuntime(runtime('ready')))).toBe(today);
    expect(html(row())).toBe(today);
    expect(today).not.toContain('Failed');
    expect(today).not.toContain('Starting');
    expect(today).not.toContain('Retry');
  });

  it('U4 guard: a deactivated row and a row with no recorded version ignore a failed runtime', () => {
    const off = { deactivatedAt: SINCE };
    expect(html(withRuntime(runtime('failed'), off))).toBe(html(row(off)));
    expect(html(withRuntime(runtime('failed'), { rowVersion: null }))).toBe(
      html(row({ rowVersion: null })),
    );
    for (const out of [
      html(withRuntime(runtime('failed'), off)),
      html(withRuntime(runtime('failed'), { rowVersion: null })),
    ]) {
      expect(out).not.toContain('Failed');
      expect(out).not.toContain('Retry');
    }
  });

  it('U5 keeps Failed, Retry and Cancel drain together on a draining module', () => {
    const out = html(withRuntime(runtime('failed'), { drainingAt: SINCE }));
    expect(out).toContain('>Failed<');
    expect(out).toMatch(RETRY_BUTTON);
    expect(out).toContain('Cancel drain');
    expect(out).toContain('Draining since');
  });

  it('U6 wires Retry to onRetry alone, disables it while busy, and renders without onRetry', () => {
    const calls = { toggle: 0, teardown: 0, purge: 0, retry: 0 };
    const r = withRuntime(runtime('failed'));
    const button = tree(r, false, {
      onToggle: () => void (calls.toggle += 1),
      onTeardown: () => void (calls.teardown += 1),
      onPurge: () => void (calls.purge += 1),
      onRetry: () => void (calls.retry += 1),
    }).find((e) => e.props['aria-label'] === 'Retry statistics');
    expect(button).toBeDefined();
    (button!.props.onClick as () => void)();
    expect(calls).toEqual({ toggle: 0, teardown: 0, purge: 0, retry: 1 });

    expect(html(r, true)).toMatch(/<button[^>]*disabled=""[^>]*>Retry<\/button>/);
    expect(html(r, false)).not.toContain('disabled=""');
    expect(() =>
      renderToStaticMarkup(
        <ModuleActiveCell
          row={r}
          busy={false}
          onToggle={() => {}}
          onTeardown={() => {}}
          onPurge={() => {}}
        />,
      ),
    ).not.toThrow();
  });
});
