'use client';

import { diffLines } from 'diff';
import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE_URL } from '@/lib/api-client';

// Mirrors the worker artifact shape written by _commit-diff.ts.
type CommitDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

interface CommitDiffFile {
  path: string;
  oldPath?: string;
  status: CommitDiffStatus;
  binary: boolean;
  truncated: boolean;
  oldContent: string;
  newContent: string;
}

interface CommitDiffArtifact {
  headSha: string | null;
  fileCount: number;
  truncated: boolean;
  files: CommitDiffFile[];
}

interface CommitDiffViewerProps {
  taskId: string;
  artifactPath: string;
}

const STATUS_META: Record<CommitDiffStatus, { label: string; cls: string }> = {
  added: { label: 'A', cls: 'border-green-800 bg-green-950 text-green-300' },
  modified: { label: 'M', cls: 'border-yellow-800 bg-yellow-950 text-yellow-300' },
  deleted: { label: 'D', cls: 'border-red-800 bg-red-950 text-red-300' },
  renamed: { label: 'R', cls: 'border-blue-800 bg-blue-950 text-blue-300' },
};

/** Splits a diff segment into lines, dropping the trailing '' that diffLines
 *  emits when the segment ends with a newline (mirrors DiffDisclosure). */
function splitNoTrail(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface InlineRow {
  kind: 'add' | 'remove' | 'context';
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

function toInlineRows(oldContent: string, newContent: string): InlineRow[] {
  const parts = diffLines(oldContent, newContent);
  const rows: InlineRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const part of parts) {
    const lines = splitNoTrail(part.value);
    if (part.added) {
      for (const text of lines) rows.push({ kind: 'add', text, oldNo: null, newNo: newNo++ });
    } else if (part.removed) {
      for (const text of lines) rows.push({ kind: 'remove', text, oldNo: oldNo++, newNo: null });
    } else {
      for (const text of lines)
        rows.push({ kind: 'context', text, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return rows;
}

interface SplitCell {
  no: number;
  text: string;
}
interface SplitRow {
  left: SplitCell | null;
  right: SplitCell | null;
  changed: boolean;
}

function toSplitRows(oldContent: string, newContent: string): SplitRow[] {
  const parts = diffLines(oldContent, newContent);
  const rows: SplitRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const lines = splitNoTrail(part.value);
    if (!part.added && !part.removed) {
      for (const text of lines) {
        rows.push({ left: { no: oldNo++, text }, right: { no: newNo++, text }, changed: false });
      }
      continue;
    }
    if (part.removed) {
      const next = parts[i + 1];
      if (next?.added) {
        // Pair a removed run with the following added run, line by line.
        const adds = splitNoTrail(next.value);
        const max = Math.max(lines.length, adds.length);
        for (let j = 0; j < max; j++) {
          const left = j < lines.length ? { no: oldNo++, text: lines[j] ?? '' } : null;
          const right = j < adds.length ? { no: newNo++, text: adds[j] ?? '' } : null;
          rows.push({ left, right, changed: true });
        }
        i++; // consumed the added part
      } else {
        for (const text of lines)
          rows.push({ left: { no: oldNo++, text }, right: null, changed: true });
      }
    } else if (part.added) {
      for (const text of lines)
        rows.push({ left: null, right: { no: newNo++, text }, changed: true });
    }
  }
  return rows;
}

function Gutter({ no }: { no: number | null }) {
  return (
    <span className="inline-block w-10 shrink-0 select-none border-r border-neutral-800 bg-neutral-900/40 px-1 text-right text-neutral-600">
      {no ?? ''}
    </span>
  );
}

function InlineDiff({ rows }: { rows: InlineRow[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-tight">
      {/* w-max sizes the inner block to the widest line so a line's full-width
          background (min-w-full) spans the whole horizontal scroll extent, not
          just the container's visible width — otherwise the add/remove tint
          clips at the right edge when the line overflows. Mirrors SplitDiff. */}
      <div className="w-max min-w-full">
        {rows.map((row, i) => {
          const cls =
            row.kind === 'add'
              ? 'bg-green-950/60 text-green-200'
              : row.kind === 'remove'
                ? 'bg-red-950/60 text-red-200'
                : 'text-neutral-400';
          const prefix = row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' ';
          return (
            <div key={i} className={`flex min-w-full ${cls}`}>
              <Gutter no={row.oldNo} />
              <Gutter no={row.newNo} />
              <span className="whitespace-pre px-2">{`${prefix} ${row.text}`}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SplitLine({
  cell,
  changed,
  side,
}: {
  cell: SplitCell | null;
  changed: boolean;
  side: 'left' | 'right';
}) {
  const tone = !cell
    ? 'bg-neutral-900/30'
    : changed
      ? side === 'left'
        ? 'bg-red-950/60 text-red-200'
        : 'bg-green-950/60 text-green-200'
      : 'text-neutral-400';
  return (
    <div className={`flex min-w-full ${tone}`}>
      {/* Sticky so the line number stays pinned to the left while only the file
          text scrolls horizontally. Opaque bg hides text scrolled under it. */}
      <span className="sticky left-0 z-10 w-10 shrink-0 select-none border-r border-neutral-800 bg-neutral-950 px-1 text-right text-neutral-600">
        {cell?.no ?? ' '}
      </span>
      {/* ' ' keeps blank/absent lines at one line-height so the two panes
          stay vertically aligned row-for-row. */}
      <span className="whitespace-pre px-2">{(cell?.text ?? '') || ' '}</span>
    </div>
  );
}

function SplitDiff({ rows }: { rows: SplitRow[] }) {
  // Two independent 50/50 panes (old | new) that always both stay visible:
  // grid-cols-2 (minmax(0,1fr) each) locks each side to half the container
  // regardless of content, and grid-rows-1 bounds their height. A long line
  // scrolls horizontally INSIDE its own pane — one scrollbar per side, not per
  // line, and the combined width never grows past the container. Both axes are
  // mirrored between the panes so the sides scroll together and rows stay
  // aligned; the syncing guard stops the mirror-set's own scroll event from
  // yanking the source pane back when the panes have different scroll widths.
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const sync = (from: 'l' | 'r') => () => {
    if (syncing.current) return;
    const a = (from === 'l' ? leftRef : rightRef).current;
    const b = (from === 'l' ? rightRef : leftRef).current;
    if (!a || !b) return;
    syncing.current = true;
    b.scrollTop = a.scrollTop;
    b.scrollLeft = a.scrollLeft;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  };
  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-1 font-mono text-[11px] leading-tight">
      <div ref={leftRef} onScroll={sync('l')} className="min-w-0 overflow-auto">
        <div className="w-max min-w-full">
          {rows.map((row, i) => (
            <SplitLine key={i} cell={row.left} changed={row.changed} side="left" />
          ))}
        </div>
      </div>
      <div
        ref={rightRef}
        onScroll={sync('r')}
        className="min-w-0 overflow-auto border-l border-neutral-800"
      >
        <div className="w-max min-w-full">
          {rows.map((row, i) => (
            <SplitLine key={i} cell={row.right} changed={row.changed} side="right" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function CommitDiffViewer({ taskId, artifactPath }: CommitDiffViewerProps) {
  const [artifact, setArtifact] = useState<CommitDiffArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'inline' | 'split'>('inline');
  const [maximized, setMaximized] = useState(false);
  const [leftPct, setLeftPct] = useState(30);
  const [isWide, setIsWide] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${API_BASE_URL}/tasks/${taskId}/files/raw?path=${encodeURIComponent(artifactPath)}`,
          { credentials: 'include' },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as CommitDiffArtifact;
        if (cancelled) return;
        setArtifact(data);
        setSelected(data.files[0]?.path ?? null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to load diff');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, artifactPath]);

  // Wide-screen gate for the resizable splitter (mirrors task-source.tsx).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 768px)');
    const update = (): void => setIsWide(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.max(20, Math.min(60, pct)));
    };
    const onUp = (): void => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Esc exits fullscreen.
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMaximized(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  const selectedFile = useMemo(
    () => artifact?.files.find((f) => f.path === selected) ?? null,
    [artifact, selected],
  );
  const renderable = selectedFile && !selectedFile.binary && !selectedFile.truncated;
  const inlineRows = useMemo(
    () => (renderable ? toInlineRows(selectedFile.oldContent, selectedFile.newContent) : []),
    [renderable, selectedFile],
  );
  const splitRows = useMemo(
    () =>
      renderable && view === 'split'
        ? toSplitRows(selectedFile.oldContent, selectedFile.newContent)
        : [],
    [renderable, view, selectedFile],
  );
  const added = inlineRows.filter((r) => r.kind === 'add').length;
  const removed = inlineRows.filter((r) => r.kind === 'remove').length;

  if (loading) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-500">
        Loading changes…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
        Could not load changes: {error}
      </div>
    );
  }
  if (!artifact || artifact.files.length === 0) {
    return (
      <div className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs text-neutral-500">
        No changes to show.
      </div>
    );
  }

  const paneHeight = maximized ? 'h-full' : 'max-h-[600px]';
  const bodyClass = maximized ? 'min-h-0 flex-1' : '';

  return (
    <div
      className={
        maximized
          ? 'fixed inset-0 z-50 flex flex-col gap-2 bg-neutral-950 p-3'
          : 'flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-950/40 p-2'
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-neutral-400">
          <span className="font-medium text-neutral-200">Changes</span>
          <span>
            {artifact.fileCount} file{artifact.fileCount === 1 ? '' : 's'}
          </span>
          {artifact.truncated && <span className="text-yellow-400">list truncated</span>}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded border border-neutral-800 text-xs">
            <button
              type="button"
              onClick={() => setView('inline')}
              className={`px-2 py-1 ${view === 'inline' ? 'bg-indigo-950 text-indigo-200' : 'text-neutral-400 hover:bg-neutral-900'}`}
            >
              Inline
            </button>
            <button
              type="button"
              onClick={() => setView('split')}
              className={`border-l border-neutral-800 px-2 py-1 ${view === 'split' ? 'bg-indigo-950 text-indigo-200' : 'text-neutral-400 hover:bg-neutral-900'}`}
            >
              Side-by-side
            </button>
          </div>
          <button
            type="button"
            onClick={() => setMaximized((v) => !v)}
            className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-900"
          >
            {maximized ? 'Exit fullscreen' : 'Maximize'}
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className={`grid gap-2 md:gap-0 ${bodyClass}`}
        style={{
          gridTemplateColumns: isWide ? `${leftPct}% 6px minmax(0,1fr)` : '1fr',
          // In maximized mode the body is flex-1 inside the fullscreen overlay,
          // so it has a definite height. A 1fr row makes that height resolvable
          // for the panes (h-full) so their inner overflow-auto can scroll.
          // Without it the implicit auto row grows to the diff content and the
          // pane never bounds, so nothing scrolls.
          gridTemplateRows: maximized ? 'minmax(0, 1fr)' : undefined,
        }}
      >
        <div
          className={`min-h-0 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950 ${paneHeight}`}
        >
          {artifact.files.map((file) => {
            const meta = STATUS_META[file.status];
            const isSelected = file.path === selected;
            return (
              <button
                key={file.path}
                type="button"
                onClick={() => setSelected(file.path)}
                className={`flex w-full items-center gap-2 border-b border-neutral-800 px-2 py-1.5 text-left text-xs last:border-b-0 ${
                  isSelected ? 'bg-indigo-950/50' : 'hover:bg-neutral-900'
                }`}
                title={file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}
              >
                <span
                  className={`shrink-0 rounded border px-1 text-[10px] font-medium ${meta.cls}`}
                >
                  {meta.label}
                </span>
                <span className="truncate text-neutral-200">{file.path}</span>
              </button>
            );
          })}
        </div>

        <div
          onMouseDown={startDrag}
          role="separator"
          aria-orientation="vertical"
          className="hidden cursor-col-resize bg-neutral-800 transition-colors hover:bg-indigo-500 md:block"
        />

        <div
          className={`flex min-h-0 min-w-0 flex-col rounded-md border border-neutral-800 bg-neutral-950 ${paneHeight}`}
        >
          {!selectedFile ? (
            <div className="p-4 text-xs text-neutral-500">
              Select a changed file to view its diff.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800 px-2 py-1.5 text-xs">
                <span className="truncate text-neutral-300" title={selectedFile.path}>
                  {selectedFile.oldPath
                    ? `${selectedFile.oldPath} -> ${selectedFile.path}`
                    : selectedFile.path}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-[10px]">
                  {renderable && (
                    <span className="text-neutral-500">
                      <span className="text-green-400">+{added}</span>{' '}
                      <span className="text-red-400">-{removed}</span>
                    </span>
                  )}
                  {selectedFile.binary && <span className="text-yellow-400">binary</span>}
                  {selectedFile.truncated && !selectedFile.binary && (
                    <span className="text-yellow-400">too large</span>
                  )}
                </span>
              </div>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {selectedFile.binary ? (
                  <div className="p-4 text-xs text-neutral-400">Binary file — diff not shown.</div>
                ) : selectedFile.truncated ? (
                  <div className="p-4 text-xs text-neutral-400">
                    File too large to diff here. Use the Source tab to view it.
                  </div>
                ) : inlineRows.length === 0 ? (
                  <div className="p-4 text-xs text-neutral-500">No content changes.</div>
                ) : view === 'inline' ? (
                  <InlineDiff rows={inlineRows} />
                ) : (
                  <SplitDiff rows={splitRows} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
