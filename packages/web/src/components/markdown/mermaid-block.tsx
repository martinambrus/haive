'use client';

import { useEffect, useId, useState } from 'react';

/** Module-level singleton so mermaid (a ~1.5MB chunk) loads once, lazily, and
 *  only on pages that actually render a diagram. The dynamic import keeps it
 *  out of the server bundle and the initial client chunk. */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
function loadMermaid() {
  mermaidPromise ??= import('mermaid').then((m) => {
    m.default.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
    return m.default;
  });
  return mermaidPromise;
}

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
      try {
        const mermaid = await loadMermaid();
        // Pre-validate so invalid syntax becomes our plain-code fallback
        // instead of mermaid's error SVG injected into the document.
        await mermaid.parse(source);
        const { svg } = await mermaid.render(renderId, source);
        if (!cancelled) setState({ kind: 'done', svg });
      } catch {
        if (!cancelled) setState({ kind: 'error' });
      }
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
