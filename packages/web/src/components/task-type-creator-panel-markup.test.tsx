import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskTypeCreatorPanel } from './task-type-creator-panel';

// The hook-slot harness of task-type-creator-panel.test.tsx replaces React's hooks; this file renders with the real ones.
describe('TaskTypeCreatorPanel rendered by React, with no browser storage to read', () => {
  const html = renderToStaticMarkup(
    <TaskTypeCreatorPanel slug={null} editorState={{}} onLoad={() => {}} />,
  );

  it('offers a message box and a Send that waits for a message', () => {
    expect(html).toMatch(/<textarea[^>]*aria-label="What the agent should draft"/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send<\/button>/);
  });

  it('says nothing is saved until Save, and offers neither End nor Load', () => {
    expect(html).toContain('nothing is saved until you press Save');
    expect(html).not.toContain('End conversation');
    expect(html).not.toContain('Load into editor');
  });
});
