'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/api-client';
import { Button } from '@/components/ui';

const BASE_NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/repos', label: 'Repositories' },
  { href: '/settings/cli-providers', label: 'Settings' },
];

const ADMIN_NAV_ITEM = { href: '/admin', label: 'Admin' };

interface SidebarNavProps {
  email: string;
  role: 'admin' | 'user';
}

export function SidebarNav({ email, role }: SidebarNavProps) {
  const navItems = role === 'admin' ? [...BASE_NAV_ITEMS, ADMIN_NAV_ITEM] : BASE_NAV_ITEMS;
  const pathname = usePathname();
  const router = useRouter();

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
    <aside className="flex h-screen w-64 flex-col border-r border-neutral-800 bg-neutral-950 p-4">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-neutral-50">Haive</h1>
        <p className="text-xs text-neutral-500">Multi-CLI orchestration</p>
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'bg-indigo-950/50 text-indigo-200'
                  : 'text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100'
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-2 border-t border-neutral-800 pt-4">
        <div className="truncate text-xs text-neutral-400" title={email}>
          {email}
        </div>
        <Button variant="secondary" size="sm" onClick={handleLogout}>
          Sign out
        </Button>
      </div>
    </aside>
  );
}
