import Link from 'next/link';
import { cn } from '@/lib/cn';

/** `href` given -> the tab navigates (a section of the app); omitted -> it calls `onSelect`
 *  (a view within one page). Both render identically, which is the point: the user reads one
 *  control, not two. */
export interface TabItem {
  /** Identity for the active check and the React key. Defaults to `href`, since a route tab is
   *  identified by where it goes — spelling the same path twice is a way to get them out of sync. */
  key?: string;
  label: string;
  href?: string;
}

/** `underline` is the section bar — a full-width rule with the active tab sitting on it.
 *  `pill` is for a bar nested UNDER one of those: two identical underline rules stacked read
 *  as one broken rule, so the inner level is a segmented group instead. */
type TabVariant = 'underline' | 'pill';

const containerClass: Record<TabVariant, string> = {
  underline: 'flex flex-wrap gap-1 border-b border-neutral-800',
  pill: 'flex flex-wrap gap-1 self-start rounded-md border border-neutral-800 bg-neutral-900/50 p-1',
};

const itemClass: Record<TabVariant, string> = {
  underline: '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
  pill: 'rounded px-3 py-1.5 text-sm font-medium transition-colors',
};

const activeClass: Record<TabVariant, string> = {
  underline: 'border-indigo-500 text-indigo-200',
  pill: 'bg-neutral-800 text-neutral-100',
};

const inactiveClass: Record<TabVariant, string> = {
  underline: 'border-transparent text-neutral-400 hover:border-neutral-600 hover:text-neutral-200',
  pill: 'text-neutral-400 hover:text-neutral-200',
};

/** Takes `active` rather than reading the route itself, so the same component serves a layout
 *  keying on usePathname and a page keying on a search param — and stays hook-free. */
export function TabNav({
  items,
  active,
  onSelect,
  variant = 'underline',
  className,
}: {
  items: TabItem[];
  active: string;
  onSelect?: (key: string) => void;
  variant?: TabVariant;
  className?: string;
}) {
  return (
    <nav className={cn(containerClass[variant], className)}>
      {items.map((item) => {
        const id = item.key ?? item.href ?? item.label;
        const classes = cn(
          itemClass[variant],
          id === active ? activeClass[variant] : inactiveClass[variant],
        );
        return item.href ? (
          <Link key={id} href={item.href} className={classes}>
            {item.label}
          </Link>
        ) : (
          <button key={id} type="button" onClick={() => onSelect?.(id)} className={classes}>
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
