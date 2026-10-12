'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getModules, type ApiError, type ModuleSummary } from '@/lib/api-client';
import { usePageTitle } from '@/lib/use-page-title';
import { Card, CardDescription, CardHeader, CardTitle, FormError } from '@/components/ui';

export default function ModuleSettingsIndexPage() {
  usePageTitle('Module settings');
  const [modules, setModules] = useState<ModuleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getModules()
      .then((all) => setModules(all.filter((m) => m.hasGlobalSettings || m.hasAdminSettings)))
      .catch((err) => setError((err as ApiError).message ?? 'Failed to load modules'));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <FormError message={error} />
      {modules?.length === 0 && (
        <p className="text-sm text-neutral-400">No installed module has settings.</p>
      )}
      {modules?.map((m) => (
        <Link key={m.id} href={`/settings/m/${encodeURIComponent(m.id)}`}>
          <Card className="transition-colors hover:border-neutral-600">
            <CardHeader>
              <CardTitle>{m.name}</CardTitle>
              <CardDescription>Version {m.version}</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      ))}
    </div>
  );
}
