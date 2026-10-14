'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
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
  useEffect(() => setMounted(true), []);
  // Nothing is folded at three or fewer, so the next burst starts collapsed.
  if (expanded && toasts.length <= COLLAPSED_VISIBLE) setExpanded(false);
  if (!mounted || toasts.length === 0) return null;

  const shown = expanded ? toasts : toasts.slice(-COLLAPSED_VISIBLE);

  return createPortal(
    <div className="fixed bottom-4 right-4 z-40 flex max-h-[calc(50dvh-1rem)] w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
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
      <div className="-m-1 flex flex-col gap-2 overflow-y-auto overscroll-contain p-1">
        {shown.map((toast) => {
          const tint = TOAST_TINT[toast.status];
          const openable = Boolean(toast.taskId);
          return (
            <div
              key={toast.key}
              {...(openable
                ? {
                    role: 'button',
                    tabIndex: 0,
                    onClick: () => onOpen(toast),
                    onKeyDown: (e: KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') onOpen(toast);
                    },
                  }
                : {})}
              className={cn(
                'flex items-start gap-2 rounded-lg border bg-neutral-900 p-3 shadow-xl transition-colors',
                openable && 'cursor-pointer hover:bg-neutral-800',
                tint.border,
              )}
            >
              <div className="min-w-0 flex-1">
                <p className={cn('text-xs font-semibold uppercase tracking-wider', tint.label)}>
                  {toast.message}
                </p>
                {/* Task titles are user-supplied and unbounded, so they truncate. A
                    non-task toast carries its own short detail line and must show all
                    of it — truncating cut the reset time off the usage warning. */}
                <p
                  className={cn(
                    'text-sm font-medium text-neutral-100',
                    openable ? 'truncate' : 'text-pretty',
                  )}
                >
                  {toast.title}
                </p>
                {openable && <p className="text-xs text-neutral-500">Click to open the task</p>}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={(e) => {
                  e.stopPropagation();
                  onDismiss(toast.key);
                }}
                onKeyDown={(e) => e.stopPropagation()}
                className="rounded p-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
