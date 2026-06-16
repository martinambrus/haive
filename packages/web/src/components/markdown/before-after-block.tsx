'use client';

import { buildDiffRows, type DiffCell } from './before-after-diff';

/** Side-by-side LINE DIFF for the spec's adjacent ```before / ```after fence pair
 *  (paired by segmentMarkdownBody). Removed lines (left, red) and added lines
 *  (right, green) are highlighted and aligned so file changes are directly visible,
 *  rather than two opaque columns of code. Never collapsed — the diff IS the content. */
export function BeforeAfterBlock({ before, after }: { before: string; after: string }) {
  const rows = buildDiffRows(before, after);
  return (
    <div className="my-2 overflow-hidden rounded-md border border-neutral-800 text-xs">
      <div className="grid grid-cols-2">
        <div className="border-b border-r border-red-900 bg-red-950/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-red-300">
          before
        </div>
        <div className="border-b border-green-900 bg-green-950/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-green-300">
          after
        </div>
      </div>
      <div className="overflow-auto bg-neutral-950 font-mono">
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-2">
            <DiffHalf cell={row.left} side="before" />
            <DiffHalf cell={row.right} side="after" />
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffHalf({ cell, side }: { cell: DiffCell; side: 'before' | 'after' }) {
  const divider = side === 'before' ? 'border-r border-neutral-900' : '';
  if (cell.kind === 'empty') {
    return <div className={`select-none bg-neutral-900/30 ${divider}`}>&nbsp;</div>;
  }
  const tint =
    cell.kind === 'remove'
      ? 'bg-red-950/40 text-red-200'
      : cell.kind === 'add'
        ? 'bg-green-950/40 text-green-200'
        : 'text-neutral-300';
  const marker = cell.kind === 'remove' ? '-' : cell.kind === 'add' ? '+' : ' ';
  return (
    <div className={`flex ${divider} ${tint}`}>
      <span className="w-8 shrink-0 select-none px-1 text-right text-neutral-600">{cell.num}</span>
      <span className="w-3 shrink-0 select-none text-center text-neutral-500">{marker}</span>
      <pre className="flex-1 overflow-x-auto whitespace-pre px-1">{cell.text || ' '}</pre>
    </div>
  );
}

/** Single tinted panel; used by PreBlock for an UNPAIRED before/after fence left
 *  in the markdown stream (no counterpart to diff against). */
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
