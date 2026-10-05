'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, CircleAlert, X } from 'lucide-react';
import { api, type TaskEvent, type TaskStep } from '@/lib/api-client';
import {
  buildTaskHistory,
  historyDividerAfter,
  type HistoryTone,
  type TaskHistoryEntry,
} from '@/lib/task-history';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';

/** Shared by both header history buttons. The task poll supplies steps; only fetch the
 * sparse fix-loop events while the panel is open. No extra recap CLI calls. */
export function useTaskHistory(taskId: string, steps: TaskStep[]) {
  const [open, setIsOpen] = useState(false);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dividerAfterId, setDividerAfterId] = useState<string | null>(null);
  const previousOpenThrough = useRef<number | null>(null);
  const panelId = useId();
  // Preserve the visit timestamp already stored by the first version of the
  // panel. It now controls only the separator, with no read/unread states.
  const key = `haive:task-history-seen:${taskId}`;
  const entries = useMemo(() => buildTaskHistory(steps, events), [steps, events]);
  const current = useRef({ key, entries });
  current.current = { key, entries };

  // Stable identity matters: the panel's focus lifecycle must not run again
  // on every task poll. Snapshot the divider only on an explicit opening.
  const setOpen = useCallback((next: boolean) => {
    const { key, entries } = current.current;
    if (next) {
      setDividerAfterId(historyDividerAfter(entries, previousOpenThrough.current));
    } else {
      const timestamp = entries.at(-1)?.timestamp;
      if (timestamp) {
        const through = Date.parse(timestamp);
        previousOpenThrough.current = through;
        try {
          localStorage.setItem(key, String(through));
        } catch {
          /* storage is optional */
        }
      }
    }
    setIsOpen(next);
  }, []);

  useEffect(() => {
    setIsOpen(false);
    setDividerAfterId(null);
    setEvents([]);
    setError(null);
    const readPreviousVisit = () => {
      try {
        const stored = localStorage.getItem(key);
        const timestamp = stored === null ? null : Number(stored);
        previousOpenThrough.current =
          timestamp !== null && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
      } catch {
        previousOpenThrough.current = null;
      }
    };
    readPreviousVisit();
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) readPreviousVisit();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  const reload = useCallback(async () => {
    const result = await api.get<{ events: TaskEvent[] }>(
      `/tasks/${taskId}/events?type=fix_loop.requested`,
    );
    return result.events;
  }, [taskId]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let fetching = false;
    const poll = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const next = await reload();
        if (!cancelled) {
          setEvents(next);
          setError(null);
        }
      } catch {
        if (!cancelled) setError('Fix-round details could not be loaded. Retrying…');
      } finally {
        fetching = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, reload]);

  return {
    taskId,
    open,
    setOpen,
    panelId,
    entries,
    error,
    dividerAfterId,
  };
}

export function TaskHistoryBell({ history }: { history: ReturnType<typeof useTaskHistory> }) {
  return (
    <button
      type="button"
      aria-label="Implementation history"
      aria-expanded={history.open}
      aria-controls={history.panelId}
      aria-haspopup="dialog"
      title="Implementation history"
      data-task-history-bell
      onClick={() => history.setOpen(!history.open)}
      className="relative flex h-8 w-9 shrink-0 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
    >
      <History className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

const TONES: Record<HistoryTone, string> = {
  success: 'border-emerald-500/20 bg-emerald-500/5',
  warning: 'border-amber-500/20 bg-amber-500/5',
  error: 'border-rose-500/20 bg-rose-500/5',
  neutral: 'border-neutral-700 bg-neutral-800/60',
};

function HistoryItem({
  entry,
  roundLabel,
  onSelect,
}: {
  entry: TaskHistoryEntry;
  roundLabel?: string;
  onSelect: () => void;
}) {
  const date = new Date(entry.timestamp);
  return (
    <li className="border-b border-neutral-800 px-4 py-4 last:border-0">
      <div className="mb-2 flex items-start gap-2 text-xs text-neutral-400">
        <time
          dateTime={entry.timestamp}
          title={date.toLocaleString()}
          className="shrink-0 tabular-nums"
        >
          {date.toLocaleTimeString(undefined, {
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit',
          })}
        </time>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          onClick={onSelect}
          className="text-left font-medium text-neutral-200 hover:text-indigo-300 hover:underline"
        >
          {entry.title}
          {roundLabel && <span className="ml-1 font-normal text-amber-400">({roundLabel})</span>}
        </button>
      </div>
      <div className={`rounded-xl rounded-tl-sm border px-3 py-2.5 ${TONES[entry.tone]}`}>
        <InlineMarkdown
          body={entry.message}
          className="break-words text-sm leading-relaxed text-neutral-200"
        />
      </div>
    </li>
  );
}

export function TaskHistoryPanel({
  history,
  roundLabels,
  onSelectStep,
}: {
  history: ReturnType<typeof useTaskHistory>;
  roundLabels: ReadonlyMap<number, string>;
  onSelectStep: (id: string) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, { top: number; atBottom: boolean }>());
  const { open, setOpen } = history;
  const rememberScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el)
      positions.current.set(history.taskId, {
        top: el.scrollTop,
        atBottom: el.scrollHeight - el.clientHeight - el.scrollTop <= 8,
      });
  }, [history.taskId]);
  const close = useCallback(() => {
    // Read synchronously before unmounting, including a keyboard close that
    // arrives before the browser delivers its pending scroll event.
    rememberScroll();
    setOpen(false);
  }, [rememberScroll, setOpen]);

  // The portal unmounts when closed. Restore before paint, and keep a reader
  // who was at the end at the end as later outcomes arrive. Earlier readers
  // retain their position instead of being pulled down by live updates.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const saved = positions.current.get(history.taskId);
    if (!open || !scroller || !saved) return;
    scroller.scrollTop = saved.atBottom ? scroller.scrollHeight : saved.top;
  }, [open, history.taskId, history.entries]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
      if (event.key !== 'Tab') return;
      const targets = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]') ?? [],
      );
      const first = targets[0];
      const last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Scrolling can exchange the two bells while the panel is open.
      const bell = previous?.isConnected
        ? previous
        : document.querySelector<HTMLElement>('[data-task-history-bell]');
      bell?.focus({ preventScroll: true });
    };
  }, [open, close]);

  if (!open) return null;
  let previousDay = '';
  return createPortal(
    <div data-haive-dialog="" className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/30" onClick={close} />
      <section
        ref={panelRef}
        id={history.panelId}
        role="dialog"
        aria-modal="true"
        aria-label="Implementation history"
        className="absolute bottom-3 right-3 top-14 flex w-[min(28rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl md:bottom-auto md:right-8 md:max-h-[calc(100dvh-5rem)]"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-4 py-3">
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-neutral-100">Implementation history</h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              Implementation and verification · first to last
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            className="rounded p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            aria-label="Close implementation history"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {history.error && (
          <div
            role="status"
            className="flex gap-2 border-b border-neutral-800 px-4 py-2 text-xs text-amber-400"
          >
            <CircleAlert className="h-4 w-4 shrink-0" />
            {history.error}
          </div>
        )}
        <div
          ref={scrollRef}
          onScroll={rememberScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          tabIndex={0}
          role="region"
          aria-label="Finished step history"
        >
          {history.entries.length === 0 ? (
            <p className="p-6 text-center text-sm text-neutral-400">
              No implementation outcomes yet. Their outcomes will appear here as the task
              progresses.
            </p>
          ) : (
            <ol>
              {history.entries.map((entry) => {
                const day = new Date(entry.timestamp).toLocaleDateString(undefined, {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                });
                const showDay = day !== previousDay;
                previousDay = day;
                return (
                  <HistoryItemWithDate key={entry.id} day={showDay ? day : null}>
                    <HistoryItem
                      entry={entry}
                      roundLabel={roundLabels.get(entry.round)}
                      onSelect={() => {
                        close();
                        onSelectStep(entry.id);
                      }}
                    />
                    {entry.id === history.dividerAfterId && (
                      <li className="px-4 py-2">
                        <hr
                          aria-label="New outcomes since your last visit"
                          className="border-t border-indigo-500/60"
                        />
                      </li>
                    )}
                  </HistoryItemWithDate>
                );
              })}
            </ol>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}

function HistoryItemWithDate({ day, children }: { day: string | null; children: React.ReactNode }) {
  return (
    <>
      {day && (
        <li className="bg-neutral-950/40 px-4 py-2 text-xs font-medium text-neutral-500">{day}</li>
      )}
      {children}
    </>
  );
}
