import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockingTaskTitle } from './blocking-task-title';

const VIEWER = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';

const render = (task: { id: string; title: string | null; ownerId: string | null }) =>
  renderToStaticMarkup(<BlockingTaskTitle task={task} viewerId={VIEWER} />);

describe('BlockingTaskTitle', () => {
  it("links the viewer's own task to its page", () => {
    const html = render({ id: 'task-1', title: 'Rebuild the index', ownerId: VIEWER });

    expect(html).toMatch(/<a [^>]*href="\/tasks\/task-1"[^>]*>Rebuild the index<\/a>/);
  });

  it("names another user's task without linking it", () => {
    const html = render({ id: 'task-2', title: 'Second task', ownerId: OTHER });

    expect(html).not.toContain('<a ');
    expect(html).toContain('Second task');
  });

  it('names a task whose owner is unknown without linking it', () => {
    const html = render({ id: 'task-3', title: 'Orphaned task', ownerId: null });

    expect(html).not.toContain('<a ');
    expect(html).toContain('Orphaned task');
  });

  it('shows the id of a task that has no title', () => {
    expect(render({ id: 'task-4', title: null, ownerId: OTHER })).toContain('task-4');
    expect(render({ id: 'task-5', title: '', ownerId: VIEWER })).toContain('>task-5</a>');
  });
});
