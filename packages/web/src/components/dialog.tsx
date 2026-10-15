'use client';

import { useEffect, useInsertionEffect, useRef, type HTMLAttributes } from 'react';
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

const TABBABLE =
  'a[href], button, input, select, textarea, [tabindex], summary, iframe, [contenteditable], audio[controls], video[controls], area[href]';
const openPanels: { panel: HTMLElement; opener: HTMLElement | null }[] = [];

const isRadio = (el: Element): el is HTMLInputElement => (el as HTMLInputElement).type === 'radio';
const inGroup = (a: HTMLInputElement, b: HTMLInputElement) =>
  !!a.name && a.name === b.name && a.form === b.form;
// An editing host reports tabIndex -1 although Tab reaches it, unless it carries a tabindex.
const isStop = (el: HTMLElement) =>
  el.tabIndex >= 0 || (el.isContentEditable && !el.hasAttribute('tabindex'));
const tabOrder = (el: HTMLElement) => (el.tabIndex > 0 ? el.tabIndex : Number.MAX_SAFE_INTEGER);

// Browser tab order: positive tabindex first, a radio group is one stop, `from`'s own is skipped.
function tabbables(panel: HTMLElement, from: Element | null) {
  const items = Array.from(panel.querySelectorAll<HTMLElement>(TABBABLE))
    .filter((el) => isStop(el) && !el.matches(':disabled') && el.getClientRects().length > 0)
    .sort((a, b) => tabOrder(a) - tabOrder(b));
  const radios = items.filter(isRadio);
  return items.filter(
    (el) =>
      !isRadio(el) ||
      (!(from && isRadio(from) && inGroup(from, el)) &&
        !radios.some((r) => r !== el && r.checked && inGroup(r, el))),
  );
}

function leavesPanel(panel: HTMLElement, stops: HTMLElement[], backwards: boolean) {
  const active = document.activeElement;
  const edge = backwards ? stops[0] : stops.at(-1);
  if (!edge || !active || active === edge || active === panel) return true;
  if (!panel.contains(active)) return true;
  // Tab order places a listed stop, not the document: positive tabindex reorders them.
  if (stops.some((stop) => stop === active)) return false;
  const beyond = backwards ? Node.DOCUMENT_POSITION_PRECEDING : Node.DOCUMENT_POSITION_FOLLOWING;
  return (edge.compareDocumentPosition(active) & beyond) !== 0;
}

export function Dialog({ open, onOpenChange, children, className }: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Insertion effects run before the layout phase, where a child's autoFocus takes focus.
  useInsertionEffect(() => {
    if (open) openerRef.current = document.activeElement as HTMLElement | null;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A dialog stacked above this one takes the key.
      const top = openPanels.at(-1);
      if (top && top.panel !== panelRef.current) return;
      // Stop here rather than let it reach window-level handlers. The
      // data-haive-dialog marker below is not enough on its own: React flushes
      // this close synchronously on a discrete event, so the portal is already
      // gone by the time a window listener looks for it, and one Escape closed
      // both the dialog and whatever was behind it. Immediate, so a lower dialog's
      // listener registered later on this document does not take the same key.
      e.stopImmediatePropagation();
      onOpenChange(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    const entry = { panel, opener: openerRef.current };
    if (!panel.contains(document.activeElement)) panel.focus();
    openPanels.push(entry);
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented || openPanels.at(-1) !== entry) return;
      const ahead = tabbables(panel, document.activeElement);
      if (!leavesPanel(panel, ahead, e.shiftKey)) return;
      const stops = tabbables(panel, null);
      e.preventDefault();
      ((e.shiftKey ? stops.at(-1) : stops[0]) ?? panel).focus();
    };
    document.addEventListener('keydown', onTab);
    return () => {
      document.removeEventListener('keydown', onTab);
      const at = openPanels.indexOf(entry);
      const wasTop = at === openPanels.length - 1;
      openPanels.splice(at, 1);
      // Still attached means Strict Mode's rehearsal, not a close.
      if (panel.isConnected) return;
      openerRef.current = null;
      // A dialog opened from inside this one gives focus back where this one would have.
      for (const above of openPanels.slice(at)) {
        if (above.opener && panel.contains(above.opener)) above.opener = entry.opener;
      }
      // A dialog still open above this one keeps the focus.
      if (wasTop && entry.opener?.isConnected) entry.opener.focus();
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
