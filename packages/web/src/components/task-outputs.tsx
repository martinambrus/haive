'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type TaskFileContent,
  type TaskFileEntry,
  type TaskFileListing,
} from '@/lib/api-client';

interface TaskOutputsProps {
  taskId: string;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function TaskOutputs({ taskId }: TaskOutputsProps) {
  const [path, setPath] = useState<string | null>(null);
  const [listing, setListing] = useState<TaskFileListing | null>(null);
  const [listingError, setListingError] = useState<string | null>(null);
  const [listingLoading, setListingLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [selectedFile, setSelectedFile] = useState<TaskFileEntry | null>(null);
  const [content, setContent] = useState<TaskFileContent | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [leftPct, setLeftPct] = useState(33);
  const [isWide, setIsWide] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Track wide-screen mode; the resizable splitter only renders at md+ where
  // the layout is side-by-side. Below md the panes stack and the splitter is
  // a no-op.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 768px)');
    const update = (): void => setIsWide(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Global mouse listeners — bound once, gated by `draggingRef` so they cost
  // nothing when no drag is active.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (!draggingRef.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.max(25, Math.min(75, pct)));
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

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  const loadListing = useCallback(
    async (target?: string) => {
      setListingLoading(true);
      setListingError(null);
      try {
        const query = target ? `?path=${encodeURIComponent(target)}` : '';
        const data = await api.get<TaskFileListing>(`/tasks/${taskId}/files${query}`);
        setListing(data);
        if (!path) setPath(data.path);
      } catch (err) {
        setListingError((err as Error).message ?? 'Failed to load directory');
      } finally {
        setListingLoading(false);
      }
    },
    [taskId, path],
  );

  useEffect(() => {
    void loadListing(path ?? undefined);
  }, [loadListing, path]);

  async function openFile(entry: TaskFileEntry) {
    setSelectedFile(entry);
    setContentLoading(true);
    setContentError(null);
    setContent(null);
    try {
      const data = await api.get<TaskFileContent>(
        `/tasks/${taskId}/files/content?path=${encodeURIComponent(entry.path)}`,
      );
      setContent(data);
    } catch (err) {
      setContentError((err as Error).message ?? 'Failed to load file');
    } finally {
      setContentLoading(false);
    }
  }

  function refresh() {
    void loadListing(path ?? undefined);
    if (selectedFile) void openFile(selectedFile);
  }

  if (listingError) {
    return (
      <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
        {listingError}
      </div>
    );
  }

  const visible = listing ? listing.entries.filter((e) => showHidden || !e.hidden) : [];

  return (
    <div
      ref={containerRef}
      className="grid gap-4 md:gap-0"
      style={{
        gridTemplateColumns: isWide ? `${leftPct}% 6px minmax(0,1fr)` : '1fr',
      }}
    >
      <div className="flex min-w-0 flex-col gap-2 md:pr-4">
        <div className="flex items-center justify-between gap-2">
          <div className="truncate text-xs text-neutral-400" title={listing?.path ?? ''}>
            {listing?.path ?? 'Loading...'}
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1 text-xs text-neutral-400">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
              />
              Hidden
            </label>
            <button type="button" onClick={refresh} className="text-xs text-indigo-400 underline">
              Refresh
            </button>
          </div>
        </div>
        <div className="max-h-[600px] overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950">
          {listing?.parent && (
            <button
              type="button"
              onClick={() => setPath(listing.parent)}
              className="flex w-full items-center gap-2 border-b border-neutral-800 px-3 py-2 text-left text-sm text-neutral-300 hover:bg-neutral-900"
            >
              <span className="text-neutral-500">..</span>
              <span>Parent directory</span>
            </button>
          )}
          {listing && visible.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-neutral-500">(empty directory)</div>
          )}
          {visible.map((entry) => {
            const isSelected = !entry.isDirectory && selectedFile?.path === entry.path;
            return (
              <button
                key={entry.path}
                type="button"
                onClick={() => (entry.isDirectory ? setPath(entry.path) : void openFile(entry))}
                className={`flex w-full items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2 text-left text-sm last:border-b-0 ${
                  isSelected ? 'bg-indigo-950/50' : 'hover:bg-neutral-900'
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="w-8 shrink-0 text-neutral-500">
                    {entry.isDirectory ? 'dir' : 'file'}
                  </span>
                  <span className="truncate text-neutral-200">{entry.name}</span>
                </div>
                {!entry.isDirectory && entry.size !== null && (
                  <span className="shrink-0 text-[10px] text-neutral-500">
                    {formatSize(entry.size)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {listingLoading && <div className="text-xs text-neutral-500">Loading...</div>}
      </div>
      <div
        onMouseDown={startDrag}
        role="separator"
        aria-orientation="vertical"
        className="hidden cursor-col-resize bg-neutral-800 transition-colors hover:bg-indigo-500 md:block"
      />
      <div className="flex min-h-[200px] min-w-0 flex-col gap-2 md:pl-4">
        {!selectedFile && (
          <div className="rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-500">
            Select a file on the left to preview its contents.
          </div>
        )}
        {selectedFile && (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="truncate text-xs text-neutral-400" title={selectedFile.path}>
                {selectedFile.name}
              </div>
              {content && (
                <div className="flex items-center gap-2 text-[10px] text-neutral-500">
                  <span>{formatSize(content.size)}</span>
                  {content.truncated && <span className="text-yellow-400">truncated</span>}
                  {content.binary && <span className="text-yellow-400">binary</span>}
                </div>
              )}
            </div>
            {contentError && (
              <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
                {contentError}
              </div>
            )}
            {contentLoading && <div className="text-xs text-neutral-500">Loading...</div>}
            {content && content.binary && (
              <div className="rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-400">
                Binary file. Preview not available.
              </div>
            )}
            {content && !content.binary && content.content !== null && (
              <pre className="max-h-[600px] overflow-auto rounded-md border border-neutral-800 bg-neutral-950 p-3 text-[11px] leading-relaxed text-neutral-200">
                {content.content}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
