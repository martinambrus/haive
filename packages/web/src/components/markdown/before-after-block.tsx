'use client';

/** Side-by-side rendering for the spec's adjacent ```before / ```after fence
 *  pair convention (paired by segmentMarkdownBody). Never collapsed — the
 *  comparison IS the content. */
export function BeforeAfterBlock({ before, after }: { before: string; after: string }) {
  return (
    <div className="my-2 grid grid-cols-1 gap-2 md:grid-cols-2">
      <BeforeAfterPanel side="before" code={before} />
      <BeforeAfterPanel side="after" code={after} />
    </div>
  );
}

/** Single tinted panel; also used directly by PreBlock for an UNPAIRED
 *  before/after fence left in the markdown stream. */
export function BeforeAfterPanel({ side, code }: { side: 'before' | 'after'; code: string }) {
  const tint =
    side === 'before'
      ? 'border-red-900 bg-red-950/40 text-red-300'
      : 'border-green-900 bg-green-950/40 text-green-300';
  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-neutral-800">
      <div
        className={`border-b px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${tint}`}
      >
        {side}
      </div>
      <pre className="flex-1 overflow-auto bg-neutral-950 px-3 py-2 text-xs text-neutral-300">
        {code}
      </pre>
    </div>
  );
}
