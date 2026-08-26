'use client';

import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { Markdown, type MarkdownStorage } from 'tiptap-markdown';
import {
  Bold,
  Code,
  Columns3,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Quote,
  Redo2,
  Rows3,
  SquareSplitHorizontal,
  SquareSplitVertical,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { Editor } from '@tiptap/react';
import { cn } from '@/lib/cn';

/**
 * A WYSIWYG markdown editor for prose bodies.
 *
 * The contenteditable carries the `haive-md` class, so what the user sees while
 * editing IS the typography MarkdownView will render — parity by construction,
 * not imitation. Markdown is parsed on mount (tiptap-markdown) and serialized
 * back on every change; the parent only ever handles markdown strings.
 *
 * Uncontrolled by design: `value` is read at creation, `onUpdate` is the sole
 * writer of the parent's draft, and one guarded effect syncs EXTERNAL value
 * changes without clobbering the caret mid-typing. Hard resets (a different
 * node) are the parent's job via the `key` prop.
 */

/** tiptap-markdown does not augment @tiptap/core's Storage type, so this is the
 *  one place the cast lives. */
function getMarkdown(editor: Editor): string {
  return (editor.storage as unknown as { markdown: MarkdownStorage }).markdown.getMarkdown();
}

interface TBtnProps {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}

function TBtn({ label, onClick, active, disabled, children }: TBtnProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep the editor's selection
      onClick={onClick}
      className={cn(
        'rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-900',
        active && 'border-indigo-800 bg-indigo-500/20 text-indigo-200',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
      )}
    >
      {children}
    </button>
  );
}

export function MarkdownEditor({
  value,
  onChange,
  className,
  placeholder = '',
  minHeight = '16rem',
  breaks = false,
}: {
  value: string;
  onChange: (markdown: string) => void;
  className?: string;
  placeholder?: string;
  minHeight?: string;
  /** Mirror MarkdownView's own line-break policy: a body that does not look
   *  like markdown renders soft newlines as <br>, so the editor must serialize
   *  them as hard breaks or one edit would collapse its line structure. */
  breaks?: boolean;
}) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const lastEmitted = useRef(value);

  const editor = useEditor({
    content: value,
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, autolink: true },
        // Underline has no markdown representation — disabled so it can never
        // appear in the document and silently drop on save.
        underline: false,
      }),
      TableKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
      Markdown.configure({ html: true, tightLists: true, breaks, linkify: false }),
    ],
    autofocus: 'end',
    immediatelyRender: false,
    editorProps: {
      attributes: { class: 'haive-md', style: `min-height:${minHeight}` },
    },
    onUpdate: ({ editor: e }) => {
      const md = getMarkdown(e);
      lastEmitted.current = md;
      onChangeRef.current(md);
    },
  });

  // External value changes only (the parent resetting the draft). Our own
  // emissions are skipped, so this never re-enters while the user types.
  useEffect(() => {
    if (!editor || value === lastEmitted.current) return;
    lastEmitted.current = value;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [value, editor]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            strike: e.isActive('strike'),
            code: e.isActive('code'),
            h2: e.isActive('heading', { level: 2 }),
            h3: e.isActive('heading', { level: 3 }),
            bulletList: e.isActive('bulletList'),
            orderedList: e.isActive('orderedList'),
            taskList: e.isActive('taskList'),
            blockquote: e.isActive('blockquote'),
            link: e.isActive('link'),
            table: e.isActive('table'),
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
          }
        : null,
  });

  if (!editor || !state) return null;

  const chain = () => editor.chain().focus();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Formatting">
        <TBtn label="Bold" active={state.bold} onClick={() => chain().toggleBold().run()}>
          <Bold className="h-3.5 w-3.5" />
        </TBtn>
        <TBtn label="Italic" active={state.italic} onClick={() => chain().toggleItalic().run()}>
          <Italic className="h-3.5 w-3.5" />
        </TBtn>
        <TBtn
          label="Strikethrough"
          active={state.strike}
          onClick={() => chain().toggleStrike().run()}
        >
          <Strikethrough className="h-3.5 w-3.5" />
        </TBtn>
        <TBtn label="Inline code" active={state.code} onClick={() => chain().toggleCode().run()}>
          <Code className="h-3.5 w-3.5" />
        </TBtn>
        <TBtn
          label="Heading 2"
          active={state.h2}
          onClick={() => chain().toggleHeading({ level: 2 }).run()}
        >
          <Heading2 className="h-3.5 w-3.5" />
        </TBtn>
        <TBtn
          label="Heading 3"
          active={state.h3}
          onClick={() => chain().toggleHeading({ level: 3 }).run()}
        >
          <Heading3 className="h-3.5 w-3.5" />
        </TBtn>
        <TBtn
          label="Bullet list"
          active={state.bulletList}
          onClick={() => chain().toggleBulletList().run()}
        >
          <List className="h-3.5 w-3.5" />
        </TBtn>
        <TBtn
          label="Numbered list"
          active={state.orderedList}
          onClick={() => chain().toggleOrderedList().run()}
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </TBtn>
        <TBtn
          label="Task list"
          active={state.taskList}
          onClick={() => chain().toggleTaskList().run()}
        >
          <ListTodo className="h-3.5 w-3.5" />
        </TBtn>
        <TBtn
          label="Blockquote"
          active={state.blockquote}
          onClick={() => chain().toggleBlockquote().run()}
        >
          <Quote className="h-3.5 w-3.5" />
        </TBtn>
        <TBtn
          label="Link"
          active={state.link}
          onClick={() => {
            const href = window.prompt('Link URL', editor.getAttributes('link').href ?? '');
            if (href === null) return;
            if (!href) {
              chain().extendMarkRange('link').unsetLink().run();
              return;
            }
            chain().extendMarkRange('link').setLink({ href }).run();
          }}
        >
          <Link2 className="h-3.5 w-3.5" />
        </TBtn>
        {state.table ? (
          <>
            <TBtn label="Add row" onClick={() => chain().addRowAfter().run()}>
              <Rows3 className="h-3.5 w-3.5" />
            </TBtn>
            <TBtn label="Add column" onClick={() => chain().addColumnAfter().run()}>
              <Columns3 className="h-3.5 w-3.5" />
            </TBtn>
            <TBtn label="Delete row" onClick={() => chain().deleteRow().run()}>
              <SquareSplitHorizontal className="h-3.5 w-3.5" />
            </TBtn>
            <TBtn label="Delete column" onClick={() => chain().deleteColumn().run()}>
              <SquareSplitVertical className="h-3.5 w-3.5" />
            </TBtn>
            <TBtn label="Delete table" onClick={() => chain().deleteTable().run()}>
              <Trash2 className="h-3.5 w-3.5" />
            </TBtn>
          </>
        ) : (
          <TBtn
            label="Insert table"
            onClick={() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          >
            <TableIcon className="h-3.5 w-3.5" />
          </TBtn>
        )}
        <TBtn label="Undo" disabled={!state.canUndo} onClick={() => chain().undo().run()}>
          <Undo2 className="h-3.5 w-3.5" />
        </TBtn>
        <TBtn label="Redo" disabled={!state.canRedo} onClick={() => chain().redo().run()}>
          <Redo2 className="h-3.5 w-3.5" />
        </TBtn>
      </div>
      <EditorContent
        editor={editor}
        className={cn(
          'rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100',
          'focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500',
          className,
        )}
      />
    </div>
  );
}
