'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

const SETTINGS_TABS = [
  { href: '/settings/account', label: 'Account' },
  { href: '/settings/cli-providers', label: 'CLI Providers' },
  { href: '/settings/credentials', label: 'Git Credentials' },
  { href: '/settings/git-identity', label: 'Git Identity' },
  { href: '/settings/integrations', label: 'Integrations' },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-50">Settings</h1>
        <p className="text-sm text-neutral-400">
          Manage your account, CLI providers, and git integrations.
        </p>
      </div>
      <nav className="flex gap-1 border-b border-neutral-800">
        {SETTINGS_TABS.map((tab) => {
          const isActive = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'border-indigo-500 text-indigo-200'
                  : 'border-transparent text-neutral-400 hover:border-neutral-600 hover:text-neutral-200',
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
