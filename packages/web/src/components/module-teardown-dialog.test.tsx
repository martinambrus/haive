import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModuleTeardownDialog } from './module-teardown-dialog';

// The shared Dialog portals into document.body, which the server renderer has no equivalent of.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
beforeAll(() => vi.stubGlobal('document', { body: {} }));
afterAll(() => vi.unstubAllGlobals());

const render = (moduleId: string | null) =>
  renderToStaticMarkup(
    <ModuleTeardownDialog moduleId={moduleId} onClose={() => {}} onDone={() => {}} />,
  );

describe('ModuleTeardownDialog', () => {
  it('renders nothing while no teardown is asked for', () => {
    expect(render(null)).toBe('');
  });

  it('names the module and says what the teardown does, and what it does not promise', () => {
    const html = render('statistics');
    expect(html).toContain('data-haive-dialog');
    expect(html).toContain('<code>statistics</code>');
    expect(html).toContain('own cleanup');
    expect(html).toContain('up to the module');
    expect(html).toContain('cannot be undone');
  });

  it('is an alert dialog with a Cancel and a Tear down confirm', () => {
    const html = render('statistics');
    expect(html).toContain('role="alertdialog"');
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
    expect(html).toMatch(/<button[^>]*>Tear down<\/button>/);
    expect(html).not.toContain('disabled=""');
  });

  it('shows no error before anything was tried', () => {
    expect(render('statistics')).not.toContain('role="alert"');
  });
});
