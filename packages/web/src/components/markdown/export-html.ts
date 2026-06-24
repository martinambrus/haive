'use client';

/** Client-side "download this rendered doc as standalone HTML".
 *
 *  The markdown the user is reading is already in the DOM — mermaid diagrams as
 *  self-contained inline SVG, code as highlight.js token spans, tables, etc. So
 *  the faithful export is a clone of that subtree wrapped in a minimal HTML
 *  document. The styling is harvested live from the page's own stylesheets
 *  (the `.haive-md` prose rules and the hand-rolled `.hljs` token colors all
 *  live in app/globals.css) rather than duplicated here, so the export tracks
 *  the app theme with no drift. No API round-trip and no server-side re-render. */

/** Page frame the harvested `.haive-md` rules don't cover: the standalone
 *  document body and the centered reading column. `.haive-mermaid`'s border /
 *  padding is a Tailwind utility on the wrapper (not a `.haive-md` rule), so it
 *  is restated here to keep diagrams framed. */
const BASE_CSS = `
html { color-scheme: dark; }
body { margin: 0; background: rgb(10 10 10); color: rgb(212 212 212);
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
main.haive-md { max-width: 880px; margin: 0 auto; padding: 2rem 1.5rem; }
.haive-mermaid { overflow-x: auto; border: 1px solid rgb(38 38 38);
  border-radius: 0.375rem; background: rgb(10 10 10); padding: 0.75rem;
  margin: 0.5rem 0; }
`;

/** Collect every CSS rule that targets `.haive-md` / `.haive-mermaid` from the
 *  live stylesheets. Grouping rules (e.g. `@media`) are kept whole when they
 *  mention the markers so wrapped rules survive. Cross-origin sheets throw on
 *  `cssRules` access — those are skipped. */
function harvestHaiveMdCss(): string {
  const out: string[] = [];
  const matches = (text: string): boolean =>
    text.includes('.haive-md') || text.includes('.haive-mermaid');

  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin / not yet loaded
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        if (matches(rule.selectorText)) out.push(rule.cssText);
      } else if ('cssRules' in rule && matches(rule.cssText)) {
        // CSSMediaRule / CSSSupportsRule etc. — keep the wrapper intact.
        out.push(rule.cssText);
      }
    }
  }
  return out.join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'document';
}

function triggerDownload(filename: string, html: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Serialize the rendered markdown under `root` to a self-contained HTML file
 *  and start a browser download. `[data-md-export-skip]` nodes (the in-flow
 *  expand/collapse-all toolbar) are dropped from the capture. */
export function downloadMarkdownHtml(title: string, root: HTMLElement): void {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-md-export-skip]').forEach((n) => n.remove());

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}${harvestHaiveMdCss()}</style>
</head>
<body>
<main class="haive-md">${clone.innerHTML}</main>
</body>
</html>`;

  triggerDownload(`${slugify(title)}.html`, html);
}
