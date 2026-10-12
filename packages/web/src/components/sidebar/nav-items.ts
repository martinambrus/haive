import {
  ChartBar,
  Database,
  FolderGit2,
  LayoutDashboard,
  ListChecks,
  Puzzle,
  Settings,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';
import type { ModuleSummary } from '@/lib/api-client';

/** `section` is the prefix that lights the item up, for a link whose target is one page of a
 *  larger section — without it Settings highlights on /settings/account alone and goes dark on
 *  the other six tabs. Defaults to `href`, which is the whole section for every other item. */
export interface NavItem {
  href: string;
  label: string;
  section?: string;
  icon: LucideIcon;
}

export const BASE_NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/tasks', label: 'Tasks', icon: ListChecks },
  { href: '/repos', label: 'Repositories', icon: FolderGit2 },
  { href: '/cli-providers', label: 'CLI Providers', icon: SquareTerminal },
  { href: '/stats', label: 'Statistics', icon: ChartBar },
  { href: '/settings/account', label: 'Settings', section: '/settings', icon: Settings },
];

export const ADMIN_NAV_ITEM: NavItem = { href: '/admin', label: 'Admin', icon: ShieldCheck };

const MODULE_ICONS: Record<string, LucideIcon> = {
  chartbar: ChartBar,
  database: Database,
  foldergit2: FolderGit2,
  layoutdashboard: LayoutDashboard,
  listchecks: ListChecks,
  puzzle: Puzzle,
  settings: Settings,
  shieldcheck: ShieldCheck,
  squareterminal: SquareTerminal,
};

function moduleIcon(name: string | undefined): LucideIcon {
  return MODULE_ICONS[(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')] ?? Puzzle;
}

function moduleNavItems(modules: readonly ModuleSummary[]): NavItem[] {
  return modules
    .flatMap((m) => m.nav)
    .sort((a, b) => {
      const [ao, bo] = [a.order ?? Infinity, b.order ?? Infinity];
      return ao === bo ? a.label.localeCompare(b.label) : ao < bo ? -1 : 1;
    })
    .map((item) => ({ href: item.href, label: item.label, icon: moduleIcon(item.icon) }));
}

export function navItemsFor(
  role: 'admin' | 'user',
  modules: readonly ModuleSummary[] = [],
): NavItem[] {
  const items = [...BASE_NAV_ITEMS, ...moduleNavItems(modules)];
  return role === 'admin' ? [...items, ADMIN_NAV_ITEM] : items;
}

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  const section = item.section ?? item.href;
  return pathname === section || pathname.startsWith(`${section}/`);
}
