'use client';

import { usePathname } from 'next/navigation';
import { TabNav } from '@/components/tabs';
import { useModules } from '@/lib/use-modules';

const SETTINGS_TABS = [
  { label: 'Account', href: '/settings/account' },
  { label: 'Editor', href: '/settings/ide' },
  { label: 'Git Credentials', href: '/settings/credentials' },
  { label: 'Git Identity', href: '/settings/git-identity' },
  { label: 'Global KB', href: '/settings/global-kb' },
  { label: 'RAG Playground', href: '/settings/rag-playground' },
  { label: 'Integrations', href: '/settings/integrations' },
  { label: 'Notifications', href: '/settings/notifications' },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { modules } = useModules();
  const hasModuleSettings =
    modules?.some((m) => m.hasGlobalSettings || m.hasAdminSettings) === true;
  const tabs = hasModuleSettings
    ? [...SETTINGS_TABS, { label: 'Modules', href: '/settings/m' }]
    : SETTINGS_TABS;
  const active =
    tabs.find((tab) => pathname === tab.href || pathname.startsWith(`${tab.href}/`))?.href ?? '';

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-50">Settings</h1>
        <p className="text-sm text-neutral-400">
          Manage your account, editor, and git integrations.
        </p>
      </div>
      <TabNav items={tabs} active={active} />
      {children}
    </div>
  );
}
