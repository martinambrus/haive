import type { RagSearchHit } from './search.js';

/** The human-readable tool response. Self-contained so the dependency-free MCP
 * script can embed this same function without importing a server package. */
export function formatRagHits(hits: RagSearchHit[]): string {
  return hits
    .map((h, i) => {
      const scope = h.scope === 'global' ? '[global] ' : h.scope === 'local' ? '[local] ' : '';
      const loc = scope + h.sourcePath + (h.sectionId ? ' #' + h.sectionId : '');
      const score = typeof h.rrf === 'number' ? h.rrf.toFixed(4) : '?';
      return (
        '### ' +
        (i + 1) +
        '. ' +
        loc +
        '  (rrf=' +
        score +
        ', dense=' +
        (typeof h.denseSim === 'number' ? h.denseSim.toFixed(3) : '?') +
        ')\n' +
        (h.content || '')
      );
    })
    .join('\n\n---\n\n');
}
