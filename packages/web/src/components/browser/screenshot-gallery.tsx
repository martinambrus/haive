'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_BASE_URL } from '@/lib/api-client';
import { usePersistedToggle } from '@/lib/use-persisted-toggle';

/** Mirrors the worker's ScreenshotEntry (`_screenshots.ts`). Declared locally rather
 *  than imported from @haive/shared — the browser bundle must not pull the shared
 *  barrel in (it drags ioredis/dns with it). */
interface ScreenshotEntry {
  file: string;
  path: string;
  caption: string;
  testCase: string | null;
  result: 'pass' | 'fail' | 'info';
}

interface ScreenshotManifest {
  count: number;
  truncated: boolean;
  shots: ScreenshotEntry[];
}

interface ScreenshotGalleryProps {
  taskId: string;
  /** Absolute path of the manifest the browser tester wrote (from the step's output). */
  artifactPath: string;
  /** Stable id (the owning step id) used to persist the collapsed state per task. */
  persistId?: string;
}

const RESULT_CHIP: Record<ScreenshotEntry['result'], { label: string; cls: string }> = {
  pass: { label: 'PASS', cls: 'border-green-800 bg-green-950 text-green-300' },
  fail: { label: 'FAIL', cls: 'border-red-800 bg-red-950 text-red-300' },
  info: { label: 'INFO', cls: 'border-neutral-700 bg-neutral-900 text-neutral-400' },
};

function rawUrl(taskId: string, filePath: string): string {
  return `${API_BASE_URL}/tasks/${taskId}/files/raw?path=${encodeURIComponent(filePath)}`;
}

/**
 * Screenshot evidence the browser tester captured while it drove the app, shown as a
 * thumbnail grid with a full-screen overlay viewer. The point is to let a reviewer at
 * Gate 2 scan what the agent actually saw — next/prev without leaving the page —
 * instead of logging into the project and redoing the flow by hand.
 *
 * The images live in the task's worktree under `.haive/screenshots/` and are streamed by
 * `GET /tasks/:id/files/raw`, so they disappear with the worktree at task teardown.
 * Renders nothing when the manifest is missing, unreadable or empty: an absent gallery
 * must never look like a broken one.
 */
export function ScreenshotGallery({ taskId, artifactPath, persistId }: ScreenshotGalleryProps) {
  const [shots, setShots] = useState<ScreenshotEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // Collapsed by default: a task can carry several galleries (one per browser-testing
  // step) and an open thumbnail grid is tall, so opening them all pushes the rest of the
  // task page out of reach. Only the fallback changes — usePersistedToggle writes nothing
  // until the user toggles, so anyone who already opened one keeps it open.
  const [expanded, setExpanded] = usePersistedToggle(
    persistId ? `task-ui:${taskId}:screenshots:${persistId}` : null,
    false,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(rawUrl(taskId, artifactPath), { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as ScreenshotManifest;
        if (cancelled) return;
        setShots(Array.isArray(data.shots) ? data.shots : []);
        setTruncated(data.truncated === true);
      } catch {
        // A missing or unreadable manifest is the same outcome as no screenshots.
        if (!cancelled) setShots([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, artifactPath]);

  const step = useCallback(
    (delta: number) => {
      setOpenIndex((current) => {
        if (current === null || shots.length === 0) return current;
        return (current + delta + shots.length) % shots.length;
      });
    },
    [shots.length],
  );

  useEffect(() => {
    if (openIndex === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpenIndex(null);
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openIndex, step]);

  if (shots.length === 0) return null;
  const open = openIndex === null ? null : shots[openIndex];

  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-950 p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-300">
          Browser test screenshots
          <span className="ml-2 font-normal text-neutral-500">
            {shots.length} shot{shots.length === 1 ? '' : 's'}
            {truncated && ' (capped)'}
          </span>
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-indigo-400 underline"
        >
          {expanded ? 'Hide' : 'Show'} screenshots
        </button>
      </div>

      {expanded && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {shots.map((shot, i) => (
            <button
              key={shot.file}
              type="button"
              onClick={() => setOpenIndex(i)}
              className="flex flex-col gap-1 overflow-hidden rounded border border-neutral-800 bg-neutral-900 p-1 text-left hover:border-indigo-500"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={rawUrl(taskId, shot.path)}
                alt={shot.caption}
                loading="lazy"
                className="h-28 w-full rounded bg-black object-contain"
              />
              <span className="flex items-center gap-1">
                <span
                  className={`shrink-0 rounded border px-1 text-[10px] leading-4 ${RESULT_CHIP[shot.result].cls}`}
                >
                  {RESULT_CHIP[shot.result].label}
                </span>
                <span className="truncate text-[11px] text-neutral-400" title={shot.caption}>
                  {shot.caption}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {open && (
        // Overlay viewer: the reviewer moves through the whole run without ever
        // leaving the task page or opening a tab.
        <div
          className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4"
          onClick={() => setOpenIndex(null)}
        >
          <div className="flex items-start justify-between gap-4 text-neutral-200">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{open.caption}</p>
              <p className="truncate text-xs text-neutral-400">
                {open.testCase ? `${open.testCase} — ` : ''}
                <span className="font-mono">{open.file}</span>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3 text-xs">
              <span className={`rounded border px-1.5 py-0.5 ${RESULT_CHIP[open.result].cls}`}>
                {RESULT_CHIP[open.result].label}
              </span>
              <span className="text-neutral-400">
                {(openIndex ?? 0) + 1} / {shots.length}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenIndex(null);
                }}
                className="text-indigo-400 underline"
              >
                Close
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 items-center gap-3">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                step(-1);
              }}
              className="shrink-0 rounded bg-neutral-800/80 px-3 py-6 text-lg text-neutral-200 hover:bg-neutral-700"
              aria-label="Previous screenshot"
            >
              ‹
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={rawUrl(taskId, open.path)}
              alt={open.caption}
              onClick={(e) => e.stopPropagation()}
              className="max-h-full min-h-0 flex-1 object-contain"
            />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                step(1);
              }}
              className="shrink-0 rounded bg-neutral-800/80 px-3 py-6 text-lg text-neutral-200 hover:bg-neutral-700"
              aria-label="Next screenshot"
            >
              ›
            </button>
          </div>
          <p className="pt-2 text-center text-[11px] text-neutral-500">
            Arrow keys to move, Esc to close
          </p>
        </div>
      )}
    </div>
  );
}
