import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import remarkGfm from 'remark-gfm';
import { describe, expect, it } from 'vitest';
import { Markdown } from './markdown';

const render = (body: string): string =>
  renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm], children: body }));

describe('Markdown images', () => {
  it('renders an image as a link to it, never as an img', () => {
    const html = render('see ![build log](https://img.example/log.png)');
    expect(html).not.toContain('<img');
    expect(html).toBe(
      '<p>see <a href="https://img.example/log.png" target="_blank" rel="noopener noreferrer">image: build log</a></p>',
    );
  });

  it('renders an image inside a link as its alt text, so links never nest', () => {
    expect(render('[![ci](https://img.example/badge.svg)](https://ci.example/run)')).toBe(
      '<p><a href="https://ci.example/run">ci</a></p>',
    );
    expect(render('[![](https://img.example/badge.svg)](https://ci.example/run)')).toBe(
      '<p><a href="https://ci.example/run">image</a></p>',
    );
  });

  it('resolves a reference-style image to the same link', () => {
    expect(render('![logo][l]\n\n[l]: https://img.example/logo.png')).toBe(
      '<p><a href="https://img.example/logo.png" target="_blank" rel="noopener noreferrer">image: logo</a></p>',
    );
  });

  it('renders an image whose URL the transform blanks as plain text', () => {
    expect(render('![x](javascript:alert(1))')).toBe('<p>image: x</p>');
    expect(render('![](data:image/png;base64,AAAA)')).toBe('<p>image</p>');
  });

  it('keeps raw HTML as text', () => {
    expect(render('<img src="https://img.example/raw.png">')).not.toContain('<img');
  });
});

describe('markdown rendering', () => {
  it('goes through Markdown everywhere', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const wrapper = path.join('components', 'markdown', 'markdown.ts');
    const offenders: string[] = [];
    for (const rel of readdirSync(src, { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(rel) || rel.includes('.test.') || rel === wrapper) continue;
      const source = readFileSync(path.join(src, rel), 'utf8');
      const imports = source.matchAll(
        /\b(?:import|export)\s+(type\s+)?[^;]*?from\s*['"]react-markdown['"]|import\(\s*['"]react-markdown['"]/g,
      );
      for (const m of imports) if (!m[1]) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
