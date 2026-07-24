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

/** Persistent attention toasts (no auto-dismiss): clicking the body opens the
 *  task, the X dismisses. A toast with no taskId has nowhere to go, so it drops
 *  the click affordances entirely. Portaled to document.body; z-40 keeps the
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
  useEffect(() => setMounted(true), []);
  if (!mounted || toasts.length === 0) return null;

  return createPortal(
    <div className="fixed bottom-4 right-4 z-40 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((toast) => {
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
              className="rounded p-0.5 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-200"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
