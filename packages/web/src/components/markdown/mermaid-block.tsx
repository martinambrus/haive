'use client';

import { useEffect, useId, useState } from 'react';
import { repairFlowchartLabelParens, repairSequenceSemicolons } from './mermaid-repair';
import { renderMermaid } from './mermaid-loader';

type RenderState = { kind: 'pending' } | { kind: 'error' } | { kind: 'done'; svg: string };

export function MermaidBlock({ source }: { source: string }) {
  const [state, setState] = useState<RenderState>({ kind: 'pending' });
  // mermaid uses the id as a DOM id; React 19 useId contains delimiters
  // (e.g. «r1») that are invalid there — sanitize.
  const rawId = useId();
  const renderId = `mermaid-${rawId.replace(/[^A-Za-z0-9_-]/g, '')}`;

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'pending' });
    void (async () => {
      // A source that is refused or fails to parse becomes our plain-code
      // fallback instead of mermaid's error SVG injected into the document.
      let svg = await renderMermaid(renderId, source);
      // Targeted repair passes for the LLM authoring mistakes that abort the
      // strict parser: a bare `;` in a sequence message, raw parens in a
      // flowchart label. Each is gated to its own diagram type and retry-only,
      // so a diagram that already renders is never altered. See mermaid-repair.
      const repairs = [repairSequenceSemicolons, repairFlowchartLabelParens];
      for (let i = 0; svg === null && i < repairs.length; i++) {
        const repaired = repairs[i]!(source);
        if (repaired !== null) svg = await renderMermaid(`${renderId}-repaired-${i}`, repaired);
      }
      if (cancelled) return;
      setState(svg !== null ? { kind: 'done', svg } : { kind: 'error' });
    })();
    return () => {
      cancelled = true;
    };
  }, [source, renderId]);

  if (state.kind === 'done') {
    return (
      <div
        className="haive-mermaid my-2 overflow-x-auto rounded-md border border-neutral-800 bg-neutral-950 p-3"
        // SVG produced by mermaid.render under securityLevel: 'strict'.
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
    );
  }
  return (
    <div className="my-2">
      {state.kind === 'pending' && (
        <p className="text-[11px] text-neutral-500">rendering diagram…</p>
      )}
      <pre className="overflow-auto rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-400">
        {source}
      </pre>
    </div>
  );
}
