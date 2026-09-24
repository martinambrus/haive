import type { Element, ElementContent, Root } from 'hast';
import type { UrlTransform } from 'react-markdown';

/** Replaces every `img` with a link to it, so a body never makes the browser fetch an image.
 *  An image inside a link becomes its alt text, since a link cannot hold another link. */
export function rehypeImageLinks({ urlTransform }: { urlTransform: UrlTransform }) {
  return (tree: Root): void => {
    replaceImages(tree, false, urlTransform);
  };
}

function replaceImages(parent: Root | Element, inLink: boolean, urlTransform: UrlTransform): void {
  const { children } = parent;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child.type !== 'element') continue;
    if (child.tagName === 'img') children[i] = imageReplacement(child, inLink, urlTransform);
    else replaceImages(child, inLink || child.tagName === 'a', urlTransform);
  }
}

function imageReplacement(
  img: Element,
  inLink: boolean,
  urlTransform: UrlTransform,
): ElementContent {
  const alt = typeof img.properties.alt === 'string' ? img.properties.alt.trim() : '';
  if (inLink) return { type: 'text', value: alt || 'image' };
  const label: ElementContent = { type: 'text', value: alt ? `image: ${alt}` : 'image' };
  const href = urlTransform(String(img.properties.src ?? ''), 'src', img);
  if (!href) return label;
  return {
    type: 'element',
    tagName: 'a',
    properties: { href, target: '_blank', rel: ['noopener', 'noreferrer'] },
    children: [label],
  };
}
