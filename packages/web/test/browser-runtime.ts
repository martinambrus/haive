import { Editor } from '@tiptap/core';
import type { MarkdownStorage } from 'tiptap-markdown';
import { markdownEditorExtensions } from '../src/components/markdown/markdown-extensions.js';
import { renderMermaid } from '../src/components/markdown/mermaid-loader.js';

// Dependencies resolve from the web workspace, just as they do in the product.
const output = document.querySelector<HTMLElement>('#output')!;
Object.assign(window, {
  runtimeFixture: {
    editor(markdown: string) {
      output.replaceChildren();
      const editor = new Editor({
        element: output,
        extensions: markdownEditorExtensions({}),
        content: markdown,
      });
      const result = {
        html: editor.getHTML(),
        json: editor.getJSON(),
        markdown: (
          editor.storage as unknown as { markdown: MarkdownStorage }
        ).markdown.getMarkdown(),
      };
      editor.destroy();
      // Inspect the resulting DOM after the editor lifecycle, too.
      output.innerHTML = result.html;
      return result;
    },
    async mermaid(source: string) {
      output.replaceChildren();
      const svg = await renderMermaid('runtime-diagram', source);
      if (svg) output.innerHTML = svg;
      return svg;
    },
  },
});
