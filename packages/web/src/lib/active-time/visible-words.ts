/** A bounded heuristic. Only the numeric estimate leaves this function. */
export const VISIBLE_WORD_LIMITS = {
  nodes: 2000,
  work: 50000,
  characters: 48000,
  rectangles: 2048,
  chunk: 2048,
} as const;
type Limits = { [K in keyof typeof VISIBLE_WORD_LIMITS]: number };
type Box = { left: number; right: number; top: number; bottom: number };
const intersect = (a: Box, b: Box): Box => ({
  left: Math.max(a.left, b.left),
  right: Math.min(a.right, b.right),
  top: Math.max(a.top, b.top),
  bottom: Math.min(a.bottom, b.bottom),
});
const area = (r: Box) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);

/** null means overflow/unavailable geometry: use the base reading allowance. */
export function visibleWords(
  doc: Document = document,
  limits: Limits = VISIBLE_WORD_LIMITS,
): number | null {
  try {
    const win = doc.defaultView;
    if (!win || !doc.body || typeof doc.elementFromPoint !== 'function') return null;
    const viewport: Box = { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight };
    const clips = new WeakMap<Element, Box>();
    const clipFor = (el: Element): Box => {
      const cached = clips.get(el);
      if (cached) return cached;
      const style = win.getComputedStyle(el);
      let clip = el.parentElement ? clipFor(el.parentElement) : viewport;
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0' ||
        /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)
      ) {
        clip = { left: 0, right: 0, top: 0, bottom: 0 };
      } else {
        const x = style.overflowX || style.overflow;
        const y = style.overflowY || style.overflow;
        const rect = el.getBoundingClientRect();
        if (x && x !== 'visible')
          clip = {
            ...clip,
            left: Math.max(clip.left, rect.left),
            right: Math.min(clip.right, rect.right),
          };
        if (y && y !== 'visible')
          clip = {
            ...clip,
            top: Math.max(clip.top, rect.top),
            bottom: Math.min(clip.bottom, rect.bottom),
          };
      }
      clips.set(el, clip);
      return clip;
    };
    let inspected = 0;
    const walker = doc.createTreeWalker(doc.body, 1 | 4, {
      acceptNode(node) {
        // Rejected siblings also cost work. Abort inside the filter so nextNode
        // cannot scan an unbounded number of them before returning.
        if (++inspected > limits.work) throw new Error('Visible-word work limit');
        const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
        if (!el) return 2; // FILTER_REJECT prunes the entire subtree.
        const clip = clipFor(el);
        if (!area(clip)) return 2;
        const rect = el.getBoundingClientRect();
        // An offscreen wrapper can have fixed/positioned visible descendants.
        // Skip the wrapper itself, but prune only when its inherited clip is empty.
        if (area(rect) && !area(intersect(rect, clip))) return node.nodeType === 1 ? 3 : 2;
        return 1; // FILTER_ACCEPT: only these nodes consume the content budgets.
      },
    });
    const range = doc.createRange();
    let nodes = 0,
      characters = 0,
      rectangles = 0,
      words = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (++nodes > limits.nodes) return null;
      if (node.nodeType !== 3 || !node.parentElement) continue;
      const text = node.textContent ?? '';
      characters += text.length;
      if (characters > limits.characters) return null;
      if (!text.trim()) continue;
      const parent = node.parentElement;
      const clip = clipFor(parent);
      if (!area(clip)) continue;
      for (let start = 0; start < text.length; start += limits.chunk) {
        const end = Math.min(text.length, start + limits.chunk);
        const count = text.slice(start, end).match(/\S+/g)?.length ?? 0;
        range.setStart(node, start);
        range.setEnd(node, end);
        const rects = range.getClientRects();
        rectangles += rects.length;
        if (rectangles > limits.rectangles) return null;
        let total = 0,
          visible = 0;
        for (const rect of Array.from(rects)) {
          total += area(rect);
          const shown = intersect(rect, clip);
          if (!area(shown)) continue;
          const hit = doc.elementFromPoint(
            (shown.left + shown.right) / 2,
            (shown.top + shown.bottom) / 2,
          );
          if (hit && parent.contains(hit)) visible += area(shown);
        }
        // Sum rectangle areas before prorating: a multi-line node is counted once.
        if (total) words += count * Math.min(1, visible / total);
      }
    }
    return words;
  } catch {
    return null;
  }
}
