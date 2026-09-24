import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fencedCode } from './fenced-code';
import { Markdown } from './markdown';

describe('fencedCode', () => {
  it('uses three backticks when the content has none', () => {
    expect(fencedCode('a = 1', 'py')).toBe('```py\na = 1\n```');
  });

  it('outruns the longest backtick run in the content', () => {
    expect(fencedCode('x\n```\ny')).toBe('````\nx\n```\ny\n````');
    expect(fencedCode('`````')).toBe('``````\n`````\n``````');
  });

  it('keeps content with its own fence inside one code block', () => {
    const content = '```\n# not a heading\n[not a link](https://x.example)\n```';
    const html = renderToStaticMarkup(createElement(Markdown, { children: fencedCode(content) }));
    expect(html.match(/<pre>/g)).toHaveLength(1);
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<a');
  });
});
