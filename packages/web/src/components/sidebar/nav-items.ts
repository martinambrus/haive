import {
  ChartBar,
  FolderGit2,
  LayoutDashboard,
  ListChecks,
  Settings,
  ShieldCheck,
  SquareTerminal,
  type LucideIcon,
} from 'lucide-react';

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

export function navItemsFor(role: 'admin' | 'user'): NavItem[] {
  return role === 'admin' ? [...BASE_NAV_ITEMS, ADMIN_NAV_ITEM] : BASE_NAV_ITEMS;
}

export function isNavItemActive(item: NavItem, pathname: string): boolean {
  const section = item.section ?? item.href;
  return pathname === section || pathname.startsWith(`${section}/`);
}
