import { describe, expect, it } from 'vitest';
import { condenseDocument, DEFAULT_HEAD_LINES } from './_doc-view.js';

const heading = (n: number, text: string): string => `${'#'.repeat(n)} ${text}`;

describe('condenseDocument', () => {
  it('returns the input verbatim when nothing is trimmed', () => {
    const doc = ['# Title', 'one', 'two', '', '## Section', 'three'].join('\n');
    const out = condenseDocument(doc);
    expect(out.dropped).toBe(false);
    expect(out.text).toBe(doc);
  });

  it('keeps every heading and drops only section tails', () => {
    const body = Array.from({ length: 40 }, (_, i) => `body line ${i}`);
    const doc = [
      heading(1, 'Overview'),
      ...body,
      heading(2, 'Design'),
      ...body,
      heading(6, 'Deepest'),
      ...body,
    ].join('\n');

    const out = condenseDocument(doc);

    expect(out.dropped).toBe(true);
    for (const h of ['# Overview', '## Design', '###### Deepest']) {
      expect(out.text).toContain(h);
    }
    expect(out.text.length).toBeLessThan(doc.length);
  });

  it('honors the lead budget per section', () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const out = condenseDocument([heading(2, 'S'), ...body].join('\n'), { headLines: 3 });

    expect(out.dropped).toBe(true);
    expect(out.text).toBe(['## S', 'line 0', 'line 1', 'line 2'].join('\n'));
  });

  it('resets the lead budget at each heading', () => {
    const out = condenseDocument(
      [heading(2, 'A'), 'a0', 'a1', heading(2, 'B'), 'b0', 'b1'].join('\n'),
      { headLines: 2 },
    );
    // Both sections fit inside the budget, so nothing is dropped.
    expect(out.dropped).toBe(false);
  });

  it('defaults to DEFAULT_HEAD_LINES', () => {
    const body = Array.from({ length: DEFAULT_HEAD_LINES + 1 }, (_, i) => `l${i}`);
    const doc = [heading(1, 'T'), ...body].join('\n');
    expect(condenseDocument(doc).dropped).toBe(true);
    expect(condenseDocument(doc, { headLines: DEFAULT_HEAD_LINES + 1 }).dropped).toBe(false);
  });

  it('drops a leading body tail even before the first heading', () => {
    const out = condenseDocument(['x0', 'x1', 'x2'].join('\n'), { headLines: 2 });
    expect(out.dropped).toBe(true);
    expect(out.text).toBe(['x0', 'x1'].join('\n'));
  });

  it('does not treat a `#hashtag` or a fenced `#` comment line as a heading', () => {
    // The heading test requires whitespace after the hashes, matching markdown.
    const out = condenseDocument(['#nothing', 'a', 'b'].join('\n'), { headLines: 1 });
    expect(out.dropped).toBe(true);
    expect(out.text).toBe('#nothing');
  });
});
