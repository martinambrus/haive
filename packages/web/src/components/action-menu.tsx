'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronDown, LoaderCircle, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/cn';

export interface ActionMenuItem {
  key: string;
  /** May be dynamic — 'Zipping...', 'Queued...', 'Resume (keep 3 passes)'. */
  label: string;
  icon: LucideIcon;
  /** Rendered as a link; `onClick` still fires (origin breadcrumbs depend on it). */
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  /** Red row, sorted to the bottom. Also picks `destructive` for the single-item button. */
  danger?: boolean;
  title?: string;
  /** Spins this row's icon AND the trigger, so a run in flight is still visible once
   *  the menu is shut — which is the only place the old button's "Testing..." lived. */
  spin?: boolean;
}

/** Falsy entries are allowed so call sites keep reading like the conditional JSX they replace. */
type MaybeItem = ActionMenuItem | false | null | undefined;

const ROW_CLASS =
  'flex w-full items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-left text-sm text-neutral-100 transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50';
const DANGER_ROW_CLASS = 'text-red-400 hover:bg-red-950/40';

/** Row height (py-1.5 + a text-sm line box) plus the panel's own padding and border.
 *  Used to decide the drop direction BEFORE the panel exists, which keeps the open a
 *  single paint — measuring the mounted panel instead means either a visible jump or a
 *  useLayoutEffect that warns on every server render. Rows are `whitespace-nowrap`, so
 *  this stays exact; move it if ROW_CLASS's padding ever changes. */
const ROW_HEIGHT_PX = 32;
const PANEL_CHROME_PX = 10;
const SEPARATOR_PX = 9;

function ItemIcon({ item }: { item: ActionMenuItem }) {
  const Icon = item.spin ? LoaderCircle : item.icon;
  return (
    <Icon className={cn('h-4 w-4 shrink-0', item.spin && 'animate-spin')} aria-hidden="true" />
  );
}

export function ActionMenu({
  items,
  label = 'Actions',
  className,
}: {
  items: MaybeItem[];
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<(HTMLElement | null)[]>([]);

  const present = items.filter((i): i is ActionMenuItem => Boolean(i));
  // Stable order regardless of how a call site lists them: destructive last, behind a rule.
  const safe = present.filter((i) => !i.danger);
  const dangerous = present.filter((i) => i.danger);
  const ordered = [...safe, ...dangerous];
  const busy = ordered.some((i) => i.spin);

  // Close on an outside click — same pattern as components/cli-upgrade-all.tsx. The
  // trigger lives inside this ref, so clicking it is not "outside" and its own onClick
  // does the toggling.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Escape closes the menu and stops there. Registered on document and propagation
  // stopped for the reason components/dialog.tsx documents: without it one key press
  // closes this menu AND whatever window-level handler sits behind it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // The rows replace buttons that were all tab-reachable, so the menu has to hand focus
  // over rather than leave it on a trigger whose list nothing can reach by keyboard.
  useEffect(() => {
    if (open) rowRefs.current[0]?.focus();
  }, [open]);

  if (ordered.length === 0) return null;

  // One action is not a menu: it is that action. A `created` task shows "Start", not a
  // list of one.
  if (ordered.length === 1) {
    const only = ordered[0]!;
    const button = (
      <Button
        variant={only.danger ? 'destructive' : 'primary'}
        size="sm"
        title={only.title}
        disabled={only.disabled}
        onClick={only.href ? undefined : only.onClick}
      >
        <ItemIcon item={only} />
        {only.label}
      </Button>
    );
    return (
      <div className={className}>
        {only.href ? (
          <Link href={only.href} onClick={only.onClick}>
            {button}
          </Link>
        ) : (
          button
        )}
      </div>
    );
  }

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    // Decide the drop direction before opening. `main` in the app layout is a scroll
    // container, so a menu opened on the last card of a list would otherwise grow the
    // scroll height instead of showing itself. Only flip when there is genuinely MORE
    // room above: a panel taller than the viewport fits nowhere and belongs below,
    // where the page can at least scroll to it.
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) {
      const height =
        ordered.length * ROW_HEIGHT_PX +
        PANEL_CHROME_PX +
        (safe.length > 0 && dangerous.length > 0 ? SEPARATOR_PX : 0);
      const below = window.innerHeight - rect.bottom;
      setFlip(height > below && rect.top > below);
    }
    setOpen(true);
  }

  function onPanelKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const rows = rowRefs.current.filter((r): r is HTMLElement => r !== null);
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      rows[at < 0 || at === rows.length - 1 ? 0 : at + 1]!.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      rows[at <= 0 ? rows.length - 1 : at - 1]!.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      rows[0]!.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      rows[rows.length - 1]!.focus();
    }
  }

  rowRefs.current = [];

  return (
    <div ref={wrapRef} className={cn('relative', className)}>
      <Button
        variant="primary"
        size="sm"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {label}
        {busy ? (
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <ChevronDown
            className={cn('h-4 w-4 transition-transform', open && 'rotate-180')}
            aria-hidden="true"
          />
        )}
      </Button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={onPanelKeyDown}
          className={cn(
            'absolute right-0 z-40 min-w-[13rem] max-w-[calc(100vw-3rem)] rounded-md border border-neutral-700 bg-neutral-900 p-1 shadow-lg',
            flip ? 'bottom-full mb-1' : 'top-full mt-1',
          )}
        >
          {ordered.map((item, index) => {
            const separated = index > 0 && item.danger === true && !ordered[index - 1]!.danger;
            const body = (
              <>
                <ItemIcon item={item} />
                {item.label}
              </>
            );
            const rowClass = cn(ROW_CLASS, item.danger && DANGER_ROW_CLASS);
            const capture = (el: HTMLElement | null) => {
              rowRefs.current[index] = el;
            };
            return (
              <div key={item.key}>
                {separated && <div className="my-1 border-t border-neutral-800" />}
                {item.href ? (
                  <Link
                    ref={capture}
                    role="menuitem"
                    href={item.href}
                    title={item.title}
                    className={rowClass}
                    onClick={() => {
                      item.onClick?.();
                      setOpen(false);
                    }}
                  >
                    {body}
                  </Link>
                ) : (
                  <button
                    ref={capture}
                    role="menuitem"
                    type="button"
                    title={item.title}
                    disabled={item.disabled}
                    className={rowClass}
                    onClick={() => {
                      setOpen(false);
                      item.onClick?.();
                    }}
                  >
                    {body}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
