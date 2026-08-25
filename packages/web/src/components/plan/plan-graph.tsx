'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { loadMermaid } from '@/components/markdown/mermaid-loader';

/**
 * The impact graph: a mermaid flowchart with pan, zoom and click-through.
 *
 * The diagram source comes from the SERVER (`/plan/impact/:nodeId`) so the
 * traversal, its cycle guard and its caps live in one place rather than being
 * re-implemented for the browser.
 *
 * Pan/zoom is a CSS transform on a wrapper, not an SVG viewBox rewrite: mermaid
 * owns the SVG it produced, and re-writing its attributes fights whatever it
 * does on the next render. Click-through attaches listeners to the rendered
 * `[id^="flowchart-"]` groups after render — mermaid's `click` directive would
 * need securityLevel 'loose', which is never acceptable for an LLM-authored
 * diagram.
 */
export function PlanGraph({
  source,
  onNodeClick,
}: {
  source: string;
  /** Receives the plan node id encoded in the mermaid node id. */
  onNodeClick?: (nodeId: string) => void;
}) {
  const rawId = useId();
  const renderId = `planmermaid-${rawId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    void (async () => {
      try {
        const mermaid = await loadMermaid();
        await mermaid.parse(source);
        const out = await mermaid.render(renderId, source);
        if (!cancelled) setSvg(out.svg);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, renderId]);

  // Click-through. Re-attached on every render because the SVG is replaced
  // wholesale.
  //
  // The uuid is recovered from `pnode<32 hex>` — the token the SERVER put in the
  // diagram source — and NOT from mermaid's surrounding decoration. Mermaid
  // renders the element as `<renderId>-flowchart-<thisId>-<index>`, and that
  // shape is an internal convention: an earlier version of this matched
  // `^flowchart-` and silently bound zero handlers, because the id starts with
  // the render id. Matching our own token unanchored survives mermaid rewording
  // anything around it.
  useEffect(() => {
    if (!svg || !onNodeClick || !hostRef.current) return;
    const host = hostRef.current;
    const groups = host.querySelectorAll<SVGGElement>('g[id*="pnode"]');
    const cleanups: (() => void)[] = [];
    for (const g of groups) {
      const match = /pnode([0-9a-f]{32})/i.exec(g.id);
      if (!match) continue;
      const hex = match[1]!;
      const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      const handler = (): void => onNodeClick(uuid);
      g.style.cursor = 'pointer';
      g.addEventListener('click', handler);
      cleanups.push(() => g.removeEventListener('click', handler));
    }
    return () => cleanups.forEach((fn) => fn());
  }, [svg, onNodeClick]);

  if (failed) {
    return (
      <pre className="overflow-auto rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-400">
        {source}
      </pre>
    );
  }
  if (!svg) return <p className="text-[11px] text-neutral-500">rendering diagram…</p>;

  return (
    <div className="relative overflow-hidden rounded-md border border-neutral-800 bg-neutral-950">
      <div className="absolute right-2 top-2 z-10 flex gap-1">
        {(
          [
            ['−', () => setZoom((z) => Math.max(0.3, z - 0.2))],
            ['+', () => setZoom((z) => Math.min(3, z + 0.2))],
            [
              '⟲',
              () => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              },
            ],
          ] as [string, () => void][]
        ).map(([label, fn]) => (
          <button
            key={label}
            type="button"
            onClick={fn}
            className="h-6 w-6 rounded border border-neutral-700 bg-neutral-900 text-xs text-neutral-300"
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="h-[360px] cursor-grab active:cursor-grabbing"
        onWheel={(e) => {
          // Ctrl+wheel is the browser's own page zoom gesture; leave it alone.
          if (e.ctrlKey) return;
          setZoom((z) => Math.min(3, Math.max(0.3, z - e.deltaY * 0.001)));
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setPan({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        <div
          ref={hostRef}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: 'center center',
          }}
          className="flex h-full items-center justify-center"
          // SVG produced by mermaid.render under securityLevel: 'strict'.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}
