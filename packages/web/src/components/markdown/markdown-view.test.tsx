import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownView } from './markdown-view';

const render = (body: string) =>
  renderToStaticMarkup(<MarkdownView body={body} enhanced={false} />);

describe('MarkdownView whole-body JSON', () => {
  it('renders a body that is one JSON object as the collapsible tree', () => {
    const html = render('\n{"version":1,"blocks":[{"id":"b1","text":"x"}],"complete":true}\n');
    expect(html).toContain('haive-json-tree');
    expect(html).toContain('3 keys');
    expect(html).toContain('version');
  });

  it('renders a body that is one JSON array as the tree', () => {
    expect(render('[1, 2, 3]')).toContain('haive-json-tree');
  });

  it('keeps markdown that starts with a bracket as markdown', () => {
    const html = render('[docs](https://example.test) explain it');
    expect(html).not.toContain('haive-json-tree');
    expect(html).toContain('<a');
  });

  it('keeps JSON followed by prose as markdown', () => {
    expect(render('{"a":1}\n\nDone.')).not.toContain('haive-json-tree');
  });

  it('keeps an incomplete JSON stream as markdown until it parses', () => {
    expect(render('{"version":1,"blocks":[')).not.toContain('haive-json-tree');
  });
});
