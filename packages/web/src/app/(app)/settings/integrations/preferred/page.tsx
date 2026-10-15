'use client';

import { PreferredByKind } from '@/components/integrations/preferred-by-kind';
import { usePageTitle } from '@/lib/use-page-title';

export default function PreferredIntegrationsPage() {
  usePageTitle('Preferred integrations');
  return <PreferredByKind />;
}
