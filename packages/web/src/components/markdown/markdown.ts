import { createElement, type ReactElement } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Options } from 'react-markdown';
import { rehypeImageLinks } from './rehype-image-links';

/** The one way this app renders markdown: react-markdown with `rehypeImageLinks` run last.
 *  Written without JSX so the web package's vitest, which cannot parse JSX, renders it. */
export function Markdown({ rehypePlugins, ...options }: Options): ReactElement {
  const urlTransform = options.urlTransform ?? defaultUrlTransform;
  return createElement(ReactMarkdown, {
    ...options,
    rehypePlugins: [...(rehypePlugins ?? []), [rehypeImageLinks, { urlTransform }]],
  });
}
