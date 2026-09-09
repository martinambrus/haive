'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { LogOut, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { api, patchUiPrefs } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import {
  SIDEBAR_RAIL_PX,
  SIDEBAR_WIDTH_VAR,
  clampSidebarWidth,
  sidebarOffsetPx,
} from '@/lib/sidebar-geometry';
import { type SidebarTree } from '@/lib/sidebar-tree';
import { type TaskToneFilter } from '@/lib/task-tone';
import { isNavItemActive, navItemsFor } from '@/components/sidebar/nav-items';
import { SidebarResizer } from '@/components/sidebar/sidebar-resizer';
import { SidebarTasks } from '@/components/sidebar/sidebar-tasks';

interface SidebarNavProps {
  email: string;
  role: 'admin' | 'user';
  /** Read server-side in the layout, so the first paint is already the user's own width.
   *  A client fetch would paint the default and jump. */
  initialWidthPx: number;
  initialCollapsed: boolean;
  initialTree: SidebarTree;
  initialFilters: TaskToneFilter[];
}

export function SidebarNav({
  email,
  role,
  initialWidthPx,
  initialCollapsed,
  initialTree,
  initialFilters,
}: SidebarNavProps) {
  const navItems = useMemo(() => navItemsFor(role), [role]);
  const pathname = usePathname();
  const router = useRouter();

  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [width, setWidth] = useState(() => clampSidebarWidth(initialWidthPx));
  const [tree, setTree] = useState(initialTree);
  // Held HERE and not in SidebarTasks: collapsing unmounts that component, and a filter
  // that silently cleared itself every time the rail was folded would look like the list
  // resetting on its own.
  const [filters, setFilters] = useState<TaskToneFilter[]>(initialFilters);
  const asideRef = useRef<HTMLElement | null>(null);

  // Republish the left-edge offset on every change, drag frames included. Written to the
  // aside's PARENT — the app shell's flex row — which is the same element the layout seeds
  // server-side, so there is one owner of the value and no first-paint disagreement.
  // Anything `position: fixed` reads it from there through the cascade.
  useEffect(() => {
    asideRef.current?.parentElement?.style.setProperty(
      SIDEBAR_WIDTH_VAR,
      `${sidebarOffsetPx(collapsed, width)}px`,
    );
  }, [collapsed, width]);

  const persistTree = useCallback((next: SidebarTree) => {
    setTree(next);
    // A failed preference write must not break the page — the arrangement is still
    // correct on screen and the next edit retries.
    void patchUiPrefs({ sidebarTree: next }).catch(() => {});
  }, []);

  const toggleFilter = useCallback((tone: TaskToneFilter) => {
    setFilters((prev) => {
      const next = prev.includes(tone) ? prev.filter((t) => t !== tone) : [...prev, tone];
      void patchUiPrefs({ sidebarFilters: next }).catch(() => {});
      return next;
    });
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      void patchUiPrefs({ sidebarCollapsed: next }).catch(() => {});
      return next;
    });
  }, []);

  const commitWidth = useCallback((px: number) => {
    void patchUiPrefs({ sidebarWidthPx: px }).catch(() => {});
  }, []);

  /** What the back link on an opened task should say. Derived from the nav item the current
   *  page belongs to, so the label names a page the user was actually on; an unrecognised
   *  path records nothing and the task page keeps its own fallback.
   *
   *  The href is resolved at CLICK time, not here: the filters live in the query string and
   *  `useSearchParams` in the app shell would opt every page out of static rendering. */
  const originLabel = useMemo(() => {
    const item = navItems.find((i) => isNavItemActive(i, pathname ?? ''));
    return item ? `Back to ${item.label.toLowerCase()}` : null;
  }, [navItems, pathname]);

  async function handleLogout() {
    try {
      await api.post('/auth/logout');
    } catch {
      // ignore logout errors
    }
    router.push('/login');
    router.refresh();
  }

  return (
    <>
      {/* `sticky top-0` does two jobs. The DOCUMENT is what scrolls here — the row is
          `min-h-screen`, so <main> grows past the viewport and its own `overflow-y-auto`
          never engages — which left this column, `h-screen` and in normal flow, scrolling
          out of sight on any long page. An index you cannot see while reading is not an
          index. Sticky rather than locking the shell to `h-screen overflow-hidden` and
          letting <main> scroll: that would move the scroll container for the whole app,
          and Next scrolls the WINDOW on navigation, so every page would open at the
          previous page's offset. Being positioned, it also gives z-30 something to apply
          to, which is what makes an icon tooltip paint over <main> — a later flex sibling
          that would otherwise cover it at rail width. */}
      <aside
        ref={asideRef}
        style={{ width: collapsed ? SIDEBAR_RAIL_PX : width }}
        className="sticky top-0 z-30 flex h-screen shrink-0 flex-col border-r border-neutral-800 bg-neutral-950 px-2 py-3"
      >
        <div className="mb-3 flex items-start gap-1">
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-xl font-bold leading-none text-neutral-50">
                hAIv<sup className="text-[0.6em]">e</sup>
              </h1>
              <p className="mt-1 truncate text-xs text-neutral-500">Multi-CLI orchestration</p>
            </div>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className={cn(
              'shrink-0 rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200',
              collapsed && 'mx-auto',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* auto-fill against a 48px minimum, so the grid reflows as the column is dragged
            and becomes a single column on the rail with no second code path. */}
        <nav className="grid grid-cols-[repeat(auto-fill,minmax(48px,1fr))] gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isNavItemActive(item, pathname ?? '');
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group/nav relative flex aspect-square items-center justify-center rounded-md transition-colors',
                  active
                    ? 'bg-indigo-950/50 text-indigo-200'
                    : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100',
                )}
              >
                <Icon className="h-5 w-5" />
                {/* Not the native `title`: a ~1.5s browser delay on an icon-only nav means
                    the label arrives after the user has already guessed. */}
                <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 opacity-0 shadow-lg transition-opacity group-hover/nav:opacity-100">
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>

        {!collapsed && (
          <>
            <div className="mt-3 border-t border-neutral-800" />
            <SidebarTasks
              tree={tree}
              onTreeChange={persistTree}
              filters={filters}
              onToggleFilter={toggleFilter}
              originLabel={originLabel}
            />
          </>
        )}

        <div
          className={cn(
            'mt-auto flex flex-col gap-2 border-t border-neutral-800 pt-3',
            collapsed && 'items-center',
          )}
        >
          {!collapsed && (
            <div className="truncate text-xs text-neutral-400" title={email}>
              {email}
            </div>
          )}
          <button
            type="button"
            onClick={handleLogout}
            aria-label="Sign out"
            title={collapsed ? `Sign out (${email})` : undefined}
            className={cn(
              'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md border border-neutral-700 bg-neutral-800 text-sm font-medium text-neutral-100 transition-colors hover:bg-neutral-700',
              collapsed ? 'h-8 w-8' : 'h-8 px-3',
            )}
          >
            <LogOut className="h-4 w-4 shrink-0" />
            {!collapsed && 'Sign out'}
          </button>
        </div>
      </aside>
      {!collapsed && <SidebarResizer onResize={setWidth} onCommit={commitWidth} />}
    </>
  );
}
