import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RefreshFailures } from './refresh-failures';

it('keeps nested failure markdown inline and inherits the red alert styling', () => {
  const html = renderToStaticMarkup(
    <RefreshFailures
      result={{ ok: false, refreshed: [], errors: [{ name: 'fx', error: 'feed **unreachable**' }] }}
    />,
  );
  expect(html).toContain('text-red-300');
  expect(html).toContain('haive-md-inherit');
  expect(html).not.toContain('max-h-96');
  expect(html).not.toContain('overflow-auto');
  expect(html).toMatch(/fx<\/span> — /);
  expect(html).toContain('<strong>unreachable</strong>');
});
