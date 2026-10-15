'use client';

import { useEffect, useRef, type HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** Override the centered wrapper's sizing (default `max-w-lg`). Merged with
   *  tailwind-merge, so e.g. `w-[95vw] max-w-6xl` widens it for a large modal. */
  className?: string;
}

const TABBABLE = 'a[href], button, input, select, textarea, [tabindex]';
const openPanels: HTMLElement[] = [];

function tabbables(panel: HTMLElement) {
  return Array.from(panel.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0,
  );
}

function leavesPanel(panel: HTMLElement, edge: HTMLElement | undefined, backwards: boolean) {
  const active = document.activeElement;
  if (!edge || !active || active === edge || active === panel) return true;
  if (!panel.contains(active)) return true;
  const beyond = backwards ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  return (edge.compareDocumentPosition(active) & beyond) !== 0;
}

export function Dialog({ open, onOpenChange, children, className }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null | undefined>(undefined);
  // Read while rendering: a child with autoFocus takes focus before any effect runs.
  if (open && openerRef.current === undefined) {
    openerRef.current = document.activeElement as HTMLElement | null;
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A dialog stacked above this one takes the key.
      const top = openPanels.at(-1);
      if (top && top !== panelRef.current) return;
      // Stop here rather than let it reach window-level handlers. The
      // data-haive-dialog marker below is not enough on its own: React flushes
      // this close synchronously on a discrete event, so the portal is already
      // gone by the time a window listener looks for it, and one Escape closed
      // both the dialog and whatever was behind it.
      e.stopPropagation();
      onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const opener = openerRef.current;
    if (!panel.contains(document.activeElement)) panel.focus();
    openPanels.push(panel);
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented || openPanels.at(-1) !== panel) return;
      const items = tabbables(panel);
      const first = items[0];
      const last = items.at(-1);
      if (!leavesPanel(panel, e.shiftKey ? first : last, e.shiftKey)) return;
      e.preventDefault();
      ((e.shiftKey ? last : first) ?? panel).focus();
    };
    document.addEventListener('keydown', onTab);
    return () => {
      document.removeEventListener('keydown', onTab);
      const wasTop = openPanels.at(-1) === panel;
      openPanels.splice(openPanels.indexOf(panel), 1);
      // Still attached means Strict Mode's rehearsal, not a close.
      if (panel.isConnected) return;
      openerRef.current = undefined;
      // A dialog still open above this one keeps the focus.
      if (wasTop && opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    // Marked so page-level Escape handlers can tell a dialog is on top and
    // leave the key to it: without that, one Escape closes the dialog AND
    // whatever was behind it.
    <div data-haive-dialog="" className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn('relative z-10 w-full max-w-lg outline-none', className)}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function DialogContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl', className)}
      {...props}
    />
  );
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col gap-1', className)} {...props} />;
}

export function DialogTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-lg font-semibold text-neutral-50', className)} {...props} />;
}
