import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModuleTasksOpenDialog } from './module-tasks-open-dialog';

// The shared Dialog portals into document.body, which the server renderer has no equivalent of.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}));
beforeAll(() => vi.stubGlobal('document', { body: {} }));
afterAll(() => vi.unstubAllGlobals());

const tasks = [
  { id: 'task-1', title: 'Rebuild the <index>', status: 'running', ownerId: 'u1' },
  { id: 'task-2', title: 'Second task', status: 'waiting_user', ownerId: 'u2' },
];
const render = (blocked: Parameters<typeof ModuleTasksOpenDialog>[0]['blocked']) =>
  renderToStaticMarkup(<ModuleTasksOpenDialog blocked={blocked} onClose={() => {}} />);

describe('ModuleTasksOpenDialog', () => {
  it('renders nothing while no deactivation is refused', () => {
    expect(render(null)).toBe('');
  });

  it('names the module and lists each blocking task as a link to it, in order', () => {
    const html = render({ moduleId: 'statistics', tasks });
    expect(html).toContain('data-haive-dialog');
    expect(html).toContain('<code>statistics</code>');
    const links = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('href="/tasks/task-1"');
    expect(links[1]).toContain('href="/tasks/task-2"');
    expect(html.indexOf('Rebuild the')).toBeLessThan(html.indexOf('Second task'));
  });

  it('opens each task in a new tab that cannot reach back to the opener', () => {
    for (const tag of [...render({ moduleId: 'm', tasks }).matchAll(/<a [^>]*>/g)]) {
      expect(tag[0]).toContain('target="_blank"');
      expect(tag[0]).toContain('rel="noopener noreferrer"');
    }
  });

  it('shows each task status and escapes a title as text', () => {
    const html = render({ moduleId: 'm', tasks });
    expect(html).toContain('running');
    expect(html).toContain('waiting_user');
    expect(html).toContain('Rebuild the &lt;index&gt;');
    expect(html).not.toContain('<index>');
  });

  it('has a Close control', () => {
    expect(render({ moduleId: 'm', tasks })).toMatch(/<button[^>]*>Close<\/button>/);
  });
});
