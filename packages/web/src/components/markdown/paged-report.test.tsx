import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PagedMarkdownReport } from './paged-report';
describe('durable Markdown report reader', () => {
  it('keeps the last page readable with Markdown and image containment after form completion', () => {
    const html = renderToStaticMarkup(
      <PagedMarkdownReport
        report={{
          title: 'Insight summary',
          body: '**minor**; not_selected\n\n![outside](https://example.test/track)',
          offset: 30,
          total: 31,
          pageSize: 30,
        }}
        onPage={() => {}}
      />,
    );
    expect(html).toContain('<strong>minor</strong>');
    expect(html).toContain('https://example.test/track');
    expect(html).not.toContain('<img');
    expect(html).toContain('31–31 of 31 entries');
    expect(html).toMatch(/disabled=""[^>]*>Next/);
    expect(html).not.toMatch(/disabled=""[^>]*>Previous/);
  });
  it('retains a next-page action at the first page', () => {
    const html = renderToStaticMarkup(
      <PagedMarkdownReport
        report={{ title: 'Report', body: 'Page one', offset: 0, total: 31, pageSize: 30 }}
        onPage={() => {}}
      />,
    );
    expect(html).toMatch(/disabled=""[^>]*>Previous/);
    expect(html).not.toMatch(/disabled=""[^>]*>Next/);
  });
});
