// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleWords, VISIBLE_WORD_LIMITS } from './visible-words';

const box = (left = 0, top = 0, right = 100, bottom = 100) => ({ left, top, right, bottom });
function geometry(rects: (range: Range) => ReturnType<typeof box>[] = () => [box()]) {
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = new Range();
    range.getClientRects = () => rects(range) as unknown as DOMRectList;
    return range;
  });
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => document.querySelector('p')),
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
describe('visible words', () => {
  it('clips nested scrollers on both axes and prorates partial lines', () => {
    document.body.innerHTML =
      '<div style="overflow:auto"><section style="overflow:hidden"><p>one two three four</p></section></div>';
    vi.spyOn(document.querySelector('div')!, 'getBoundingClientRect').mockReturnValue(
      box(0, 0, 50, 100) as DOMRect,
    );
    vi.spyOn(document.querySelector('section')!, 'getBoundingClientRect').mockReturnValue(
      box(0, 0, 100, 50) as DOMRect,
    );
    geometry();
    expect(visibleWords()).toBe(1);
  });
  it('excludes text covered by another part of the page', () => {
    document.body.innerHTML = '<p>one two</p><aside></aside>';
    geometry();
    vi.mocked(document.elementFromPoint).mockReturnValue(document.querySelector('aside'));
    expect(visibleWords()).toBe(0);
  });
  it('accepts descendant hits in inline Markdown and counts a multiline node once', () => {
    document.body.innerHTML = '<p>one two <a>three <span>four</span></a></p>';
    geometry(() => [box(0, 0, 50, 10), box(0, 10, 50, 20)]);
    vi.mocked(document.elementFromPoint).mockReturnValue(document.querySelector('span'));
    expect(visibleWords()).toBe(4);
  });
  it('counts only the maximized dialog covering the page', () => {
    document.body.innerHTML = '<p>background words</p><dialog open>dialog words here</dialog>';
    geometry();
    vi.mocked(document.elementFromPoint).mockReturnValue(document.querySelector('dialog'));
    expect(visibleWords()).toBe(3);
  });
  it('bounds long code blocks in chunks and clips offscreen lines', () => {
    document.body.innerHTML = '<pre><code>' + 'word '.repeat(900) + '</code></pre>';
    geometry((range) =>
      range.startOffset === 0
        ? [box(0, 0, 100, 100), box(0, 1000, 100, 1100)]
        : [box(0, 1000, 100, 1100)],
    );
    vi.mocked(document.elementFromPoint).mockReturnValue(document.querySelector('code'));
    const words = visibleWords();
    expect(words).toBeGreaterThan(200);
    expect(words).toBeLessThan(210);
  });
  it('clips to the viewport and excludes hidden text', () => {
    document.body.innerHTML = '<p>one two</p><p style="display:none">hidden words</p>';
    geometry(() => [box(-100, 0, 100, 100)]);
    expect(visibleWords()).toBe(1);
  });
  it('prunes 20k offscreen and hidden descendants before visible-content budgets', () => {
    document.body.innerHTML =
      '<aside style=overflow:hidden></aside>' +
      '<section style=display:none></section><p>' +
      'word '.repeat(600) +
      '</p>';
    const offscreen = document.querySelector('aside')!;
    const hidden = document.querySelector('section')!;
    // Build the requested large-page regression once; each rejected root skips 10k nodes.
    offscreen.replaceChildren(
      ...Array.from({ length: 10000 }, () => document.createElement('span')),
    );
    hidden.replaceChildren(...Array.from({ length: 10000 }, () => document.createElement('span')));
    vi.spyOn(offscreen, 'getBoundingClientRect').mockReturnValue(
      box(0, 2000, 100, 2100) as DOMRect,
    );
    const styles = vi.spyOn(window, 'getComputedStyle');
    geometry();
    expect(visibleWords()).toBeCloseTo(600, -1);
    expect(styles.mock.calls.length).toBeLessThan(10);
  });
  it('bounds rejected siblings separately from visible content', () => {
    document.body.innerHTML = '<section hidden></section><section hidden></section><p>one two</p>';
    geometry();
    expect(visibleWords(document, { ...VISIBLE_WORD_LIMITS, work: 2 })).toBeNull();
    expect(visibleWords(document, { ...VISIBLE_WORD_LIMITS, nodes: 2, work: 4 })).toBe(2);
  });
  it('prunes offscreen elements even without an overflow style', () => {
    document.body.innerHTML = '<aside>offscreen words</aside><p>visible words</p>';
    vi.spyOn(document.querySelector('aside')!, 'getBoundingClientRect').mockReturnValue(
      box(0, 2000, 100, 2100) as DOMRect,
    );
    geometry();
    expect(visibleWords(document, { ...VISIBLE_WORD_LIMITS, nodes: 2 })).toBe(2);
  });
  it('keeps visible positioned descendants of an offscreen wrapper', () => {
    document.body.innerHTML = '<aside><p style=position:fixed>visible words</p></aside>';
    vi.spyOn(document.querySelector('aside')!, 'getBoundingClientRect').mockReturnValue(
      box(0, 2000, 100, 2100) as DOMRect,
    );
    geometry();
    expect(visibleWords(document, { ...VISIBLE_WORD_LIMITS, nodes: 2 })).toBe(2);
  });
  it('pins production budgets and returns fallback on each overflow', () => {
    expect(VISIBLE_WORD_LIMITS).toEqual({
      nodes: 2000,
      work: 50000,
      characters: 48000,
      rectangles: 2048,
      chunk: 2048,
    });
    document.body.innerHTML = '<p>one two</p>';
    geometry();
    for (const limit of ['nodes', 'work', 'characters', 'rectangles'] as const) {
      expect(visibleWords(document, { ...VISIBLE_WORD_LIMITS, [limit]: 0 })).toBeNull();
    }
  });
  it('returns fallback when geometry fails', () => {
    document.body.innerHTML = '<p>one two</p>';
    geometry(() => {
      throw new Error('geometry unavailable');
    });
    expect(visibleWords()).toBeNull();
  });
});
