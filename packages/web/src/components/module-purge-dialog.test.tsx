import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModulePurgeDialog, modulePurgeArmed } from './module-purge-dialog';

// The shared Dialog portals into document.body, which the server renderer has no equivalent of.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
beforeAll(() => vi.stubGlobal('document', { body: {} }));
afterAll(() => vi.unstubAllGlobals());

const render = (target: { id: string; tornDown: boolean } | null) =>
  renderToStaticMarkup(<ModulePurgeDialog target={target} onClose={() => {}} onDone={() => {}} />);

describe('ModulePurgeDialog', () => {
  it('renders nothing while no purge is asked for', () => {
    expect(render(null)).toBe('');
  });

  it('names the module and says what goes: its database, its settings and the task types no task uses', () => {
    const html = render({ id: 'statistics', tornDown: true });
    expect(html).toContain('data-haive-dialog');
    expect(html).toContain('<code>statistics</code>');
    expect(html).toContain('its database');
    expect(html).toContain('its settings');
    expect(html).toContain('no task uses');
    expect(html).toContain('cannot be undone');
  });

  it('warns that the module teardown never ran, and stays quiet once it did', () => {
    expect(render({ id: 'statistics', tornDown: false })).toContain('teardown never ran');
    expect(render({ id: 'statistics', tornDown: true })).not.toContain('teardown never ran');
  });

  it('is an alert dialog with a Cancel and a Purge that stays disabled until the id is typed', () => {
    const html = render({ id: 'statistics', tornDown: true });
    expect(html).toContain('role="alertdialog"');
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Purge<\/button>/);
  });

  it('asks for the id in a box that is not autofilled or spell checked', () => {
    const html = render({ id: 'statistics', tornDown: true });
    expect(html).toMatch(/Type\s*<code[^>]*>statistics<\/code>\s*to confirm/);
    expect(html).toMatch(/<input[^>]*autoComplete="off"/i);
    expect(html).toMatch(/<input[^>]*spellCheck="false"/i);
    expect(html).toMatch(/<input[^>]*value=""/);
  });

  it('shows no error and no blocking task before anything was tried', () => {
    const html = render({ id: 'statistics', tornDown: true });
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('<ul');
  });
});

describe('modulePurgeArmed', () => {
  it('arms on the exact id and nothing else', () => {
    expect(modulePurgeArmed('statistics', 'statistics')).toBe(true);
    expect(modulePurgeArmed('statistic', 'statistics')).toBe(false);
    expect(modulePurgeArmed('statisticss', 'statistics')).toBe(false);
    expect(modulePurgeArmed('Statistics', 'statistics')).toBe(false);
    expect(modulePurgeArmed(' statistics', 'statistics')).toBe(false);
    expect(modulePurgeArmed('statistics ', 'statistics')).toBe(false);
    expect(modulePurgeArmed('', 'statistics')).toBe(false);
  });

  it('never arms when there is no id to type', () => {
    expect(modulePurgeArmed('', '')).toBe(false);
  });
});
