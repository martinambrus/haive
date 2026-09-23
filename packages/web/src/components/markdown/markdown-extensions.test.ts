import { describe, expect, it } from 'vitest';
import { Editor, type JSONContent } from '@tiptap/core';
import type { MarkdownStorage } from 'tiptap-markdown';
import { markdownEditorExtensions } from './markdown-extensions';

// No element, so the editor never mounts: state and serializer only, which is
// all a save touches and all the web package can run without a DOM.
function serialize(content: JSONContent[]): string {
  const editor = new Editor({
    extensions: markdownEditorExtensions({}),
    content: { type: 'doc', content },
  });
  try {
    return (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
  } finally {
    editor.destroy();
  }
}

const para = (text: string): JSONContent => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});
const task = (text: string, checked = false): JSONContent => ({
  type: 'taskItem',
  attrs: { checked },
  content: [para(text)],
});
const bullet = (text: string): JSONContent => ({ type: 'listItem', content: [para(text)] });

describe('markdown editor lists', () => {
  it('writes a tight task list back tight, as it does a bullet list', () => {
    expect(
      serialize([{ type: 'taskList', content: [task('open task'), task('done task', true)] }]),
    ).toBe('- [ ] open task\n- [x] done task');
    expect(serialize([{ type: 'bulletList', content: [bullet('first'), bullet('second')] }])).toBe(
      '- first\n- second',
    );
  });

  it('keeps a task list the author wrote loose, loose', () => {
    expect(
      serialize([
        {
          type: 'taskList',
          attrs: { tight: false },
          content: [task('open task'), task('done task', true)],
        },
      ]),
    ).toBe('- [ ] open task\n\n- [x] done task');
  });
});
