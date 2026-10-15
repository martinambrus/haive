'use client';

import { usePathname } from 'next/navigation';
import { TabNav } from '@/components/tabs';

const INTEGRATION_TABS = [
  { label: 'Connections', href: '/settings/integrations' },
  { label: 'Preferred by kind', href: '/settings/integrations/preferred' },
];

export default function IntegrationsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const active = INTEGRATION_TABS.find((tab) => tab.href === pathname)?.href;

  return (
    <div className="flex flex-col gap-6">
      {active && <TabNav items={INTEGRATION_TABS} active={active} variant="pill" />}
      {children}
    </div>
  );
}
