'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { AttentionKind } from './transitions';

export interface AttentionToast {
  /** `${taskId}:${status}` — dedupe key. */
  key: string;
  taskId: string;
  title: string;
  status: AttentionKind;
  message: string;
}

const TOAST_TINT: Record<AttentionKind, { border: string; label: string }> = {
  waiting_user: { border: 'border-amber-800/60', label: 'text-amber-300' },
  failed: { border: 'border-red-800/60', label: 'text-red-300' },
  completed: { border: 'border-emerald-800/60', label: 'text-emerald-300' },
  allowance_replenished: { border: 'border-emerald-800/60', label: 'text-emerald-300' },
};

/** Persistent attention toasts (no auto-dismiss): clicking the body opens the
 *  task, the X dismisses. Portaled to document.body; z-40 keeps the stack
 *  below modal overlays (z-50). */
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
        return (
          <div
            key={toast.key}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(toast)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onOpen(toast);
            }}
            className={cn(
              'flex cursor-pointer items-start gap-2 rounded-lg border bg-neutral-900 p-3 shadow-xl transition-colors hover:bg-neutral-800',
              tint.border,
            )}
          >
            <div className="min-w-0 flex-1">
              <p className={cn('text-xs font-semibold uppercase tracking-wider', tint.label)}>
                {toast.message}
              </p>
              <p className="truncate text-sm font-medium text-neutral-100">{toast.title}</p>
              <p className="text-xs text-neutral-500">Click to open the task</p>
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
