import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModuleActiveCell } from './module-active-cell';

const SINCE = '2026-10-14T12:30:00.000Z';
const row = (over: { rowVersion?: string | null; deactivatedAt?: string | null } = {}) => ({
  id: 'statistics',
  rowVersion: '0.1.0' as string | null,
  deactivatedAt: null as string | null,
  ...over,
});
const render = (r = row(), busy = false) =>
  renderToStaticMarkup(<ModuleActiveCell row={r} busy={busy} onToggle={() => {}} />);

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
