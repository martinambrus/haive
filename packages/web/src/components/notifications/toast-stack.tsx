'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { AttentionKind } from './transitions';

/** Toast kinds: the task-attention kinds, plus `usage_low` — a provider's
 *  subscription window nearing depletion, which belongs to no task. */
export type ToastKind = AttentionKind | 'usage_low';

export interface AttentionToast {
  /** `${taskId}:${status}` — dedupe key. */
  key: string;
  /** Absent for toasts that belong to no task (usage_low): those render as plain
   *  informational cards, not clickable, dismissable only via the X. */
  taskId?: string;
  title: string;
  status: ToastKind;
  message: string;
}

const TOAST_TINT: Record<ToastKind, { border: string; label: string }> = {
  waiting_user: { border: 'border-amber-800/60', label: 'text-amber-300' },
  failed: { border: 'border-red-800/60', label: 'text-red-300' },
  completed: { border: 'border-emerald-800/60', label: 'text-emerald-300' },
  allowance_replenished: { border: 'border-emerald-800/60', label: 'text-emerald-300' },
  auto_resumed: { border: 'border-indigo-800/60', label: 'text-indigo-300' },
  usage_low: { border: 'border-amber-800/60', label: 'text-amber-300' },
};

const COLLAPSED_VISIBLE = 3;

const CONTROL_CLASS =
  'rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100';

/** Persistent attention toasts (no auto-dismiss): clicking the body opens the
 *  task, the X dismisses. A toast with no taskId has nowhere to go, so it drops
 *  the click affordances entirely. Only the newest three show until the user
 *  expands the list; the stack is capped at half the viewport height and its
 *  cards scroll inside the cap. Portaled to document.body; z-40 keeps the
 *  stack below modal overlays (z-50). */
export function ToastStack({
  toasts,
  onOpen,
  onDismiss,
}: {
  toasts: AttentionToast[];
  onOpen: (toast: AttentionToast) => void;
  onDismiss: (key: string) => void;
}) {
  // Portal target only exists client-side; this component is rendered on the
  // server as part of the (app) layout, so wait for mount.
  const [mounted, setMounted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [seenKeys, setSeenKeys] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState({ id: 0, text: '' });
  useEffect(() => setMounted(true), []);
  // Nothing is folded at three or fewer, so the next burst starts collapsed.
  if (expanded && toasts.length <= COLLAPSED_VISIBLE) setExpanded(false);
  // A dismiss or an expand must not re-read the line, so only a key new to the list sets it.
  const keys = toasts.map((t) => t.key);
  if (keys.length !== seenKeys.length || keys.some((key, i) => key !== seenKeys[i])) {
    setSeenKeys(keys);
    const fresh = toasts.findLast((t) => !seenKeys.includes(t.key));
    if (fresh) {
      setAnnouncement((last) => ({ id: last.id + 1, text: `${fresh.message}: ${fresh.title}` }));
    }
  }
  if (!mounted) return null;

  const shown = expanded ? toasts : toasts.slice(-COLLAPSED_VISIBLE);

  return createPortal(
    <div className="fixed bottom-4 right-4 z-40 flex max-h-[calc(50dvh-1rem)] w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {/* Kept with no toast: a live region created with its first message is not announced. */}
      <p role="status" aria-live="polite" className="sr-only">
        {/* New key per line: an identical line (a returning toast) must still change the DOM. */}
        <span key={announcement.id}>{announcement.text}</span>
      </p>
      {toasts.length > 1 && (
        <div className="flex justify-end gap-2">
          {toasts.length > COLLAPSED_VISIBLE && (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              className={CONTROL_CLASS}
            >
              {expanded ? 'Show less' : `+${toasts.length - COLLAPSED_VISIBLE} more`}
            </button>
          )}
          <button
            type="button"
            onClick={() => toasts.forEach((t) => onDismiss(t.key))}
            className={CONTROL_CLASS}
          >
            Dismiss all
          </button>
        </div>
      )}
      {/* Padding offset by the margin: a focused card's ring would otherwise be clipped. */}
      {toasts.length > 0 && (
        <div className="-m-1 flex flex-col gap-2 overflow-y-auto overscroll-contain p-1">
          {shown.map((toast) => {
            const tint = TOAST_TINT[toast.status];
            const openable = Boolean(toast.taskId);
            const body = (
              <>
                <span
                  className={cn('block text-xs font-semibold uppercase tracking-wider', tint.label)}
                >
                  {toast.message}
                </span>
                {/* Task titles are user-supplied and unbounded, so they truncate. A
                    non-task toast carries its own short detail line and must show all
                    of it — truncating cut the reset time off the usage warning. */}
                <span
                  className={cn(
                    'block text-sm font-medium text-neutral-100',
                    openable ? 'truncate' : 'text-pretty',
                  )}
                >
                  {toast.title}
                </span>
                {openable && (
                  <span className="block text-xs text-neutral-500">Click to open the task</span>
                )}
              </>
            );
            return (
              <div
                key={toast.key}
                className={cn(
                  'relative flex items-start gap-2 rounded-lg border bg-neutral-900 p-3 shadow-xl transition-colors',
                  openable && 'hover:bg-neutral-800',
                  tint.border,
                )}
              >
                {/* The ::after stretches the open button over the card; the X sits above it. */}
                {openable ? (
                  <button
                    type="button"
                    onClick={() => onOpen(toast)}
                    className="min-w-0 flex-1 cursor-pointer text-left after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-indigo-400"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="min-w-0 flex-1">{body}</div>
                )}
                <button
                  type="button"
                  aria-label={`Dismiss notification: ${toast.title}`}
                  onClick={() => onDismiss(toast.key)}
                  className="relative z-10 rounded p-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>,
    document.body,
  );
}
