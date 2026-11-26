// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { Editor } from '@tiptap/core';
import { MarkdownEditor } from './markdown-editor';

const body = '## House rule\n\nKeep **important** text.\n\n- First rule\n- Second rule';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([true, false])(
  'native fill selection during startup with autofocus=%s',
  async (autoFocus) => {
    const onChange = vi.fn();
    const { container } = render(
      <MarkdownEditor value={body} onChange={onChange} autoFocus={autoFocus} />,
    );
    const element = container.querySelector<HTMLElement>('[contenteditable="true"]')!;
    const editor = (element as HTMLElement & { editor: Editor }).editor;
    // ProseMirror scrolls after autofocus; jsdom has no layout.
    editor.view.setProps({ handleScrollToSelection: () => true });
    const selection = window.getSelection()!;
    const selectForFill = () => {
      // Playwright fill selects the DOM range, then sends Delete in a separate browser action.
      element.focus();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    expect(document.activeElement).not.toBe(element);
    selectForFill();
    expect(selection.toString()).toContain('First rule');
    await act(() => vi.advanceTimersByTimeAsync(0));
    // The scheduled TipTap focus transaction replaces that selection with its end caret.
    expect(selection.isCollapsed).toBe(autoFocus);
    expect(editor.getText()).toContain('First rule');

    await act(() => vi.advanceTimersByTimeAsync(16));
    expect(document.activeElement).toBe(element);
    selectForFill();
    await act(() => vi.advanceTimersByTimeAsync(16));
    expect(selection.toString()).toContain('First rule');
    // Once startup focus has completed, a normal select-all/delete serializes an empty draft.
    act(() => {
      editor.commands.selectAll();
      editor.commands.deleteSelection();
    });
    expect(onChange).toHaveBeenLastCalledWith('');
  },
);
