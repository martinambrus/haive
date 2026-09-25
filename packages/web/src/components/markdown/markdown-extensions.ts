import { Extension, Node, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from 'tiptap-markdown';
import { imageLabel } from './rehype-image-links';

/** tiptap-markdown 0.9 gives only bullet and ordered lists the `tight` attribute its
 *  list writer reads, so every save wrote a tight task list back with blank lines
 *  between its items. The same attribute and parse rule, for the list type it left out. */
const TightTaskLists = Extension.create({
  name: 'tightTaskLists',
  addGlobalAttributes() {
    return [
      {
        types: ['taskList'],
        attributes: {
          tight: {
            default: true,
            parseHTML: (element) =>
              element.getAttribute('data-tight') === 'true' || !element.querySelector('p'),
            renderHTML: (attributes) => ({
              class: attributes.tight ? 'tight' : null,
              'data-tight': attributes.tight ? 'true' : null,
            }),
          },
        },
      },
    ];
  },
});

/** Without a node named `image` the editor dropped an image on load, and a save wrote the body back
 *  without it. tiptap-markdown serializes this one as `![alt](src)`; it renders a label, never an img. */
const ImageLabel = Node.create({
  name: 'image',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    const attr = (name: string, fallback: string | null) => ({
      default: fallback,
      parseHTML: (element: HTMLElement) =>
        element.getAttribute(name) ?? element.getAttribute(`data-${name}`),
      renderHTML: (attributes: Record<string, unknown>) =>
        attributes[name] ? { [`data-${name}`]: attributes[name] } : {},
    });
    return { src: attr('src', ''), alt: attr('alt', ''), title: attr('title', null) };
  },
  parseHTML() {
    return [{ tag: 'img[src]' }, { tag: 'span[data-md-image]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', { ...HTMLAttributes, 'data-md-image': '' }, imageLabel(node.attrs.alt)];
  },
});

/** The markdown editor's schema and serializer, apart from React so a DOM-free
 *  test can build the same editor the page does. */
export function markdownEditorExtensions({
  placeholder = '',
  breaks = false,
}: {
  placeholder?: string;
  breaks?: boolean;
}): Extensions {
  return [
    StarterKit.configure({
      link: { openOnClick: false, autolink: true },
      // Underline has no markdown representation — disabled so it can never
      // appear in the document and silently drop on save.
      underline: false,
    }),
    TableKit,
    TaskList,
    TightTaskLists,
    TaskItem.configure({ nested: true }),
    ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
    ImageLabel,
    Markdown.configure({ html: true, tightLists: true, breaks, linkify: false }),
  ];
}
