'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, type CliProviderMetadata, type CliProviderName } from '@/lib/api-client';
import { Card, CardDescription, CardHeader, CardTitle, FormError } from '@/components/ui';
import { CliProviderForm } from '@/components/cli-provider-form';

export default function NewCliProviderPage() {
  const router = useRouter();
  const params = useSearchParams();
  const name = params.get('name') as CliProviderName | null;

  const [meta, setMeta] = useState<CliProviderMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!name) {
      router.replace('/settings/cli-providers');
      return;
    }
    api
      .get<{ providers: CliProviderMetadata[] }>('/cli-providers/catalog')
      .then((data) => {
        const found = data.providers.find((p) => p.name === name);
        if (!found) {
          setError(`Unknown provider: ${name}`);
        } else {
          setMeta(found);
        }
      })
      .catch((err) => setError((err as Error).message ?? 'Failed to load catalog'));
  }, [name, router]);

  if (error) return <FormError message={error} />;
  if (!meta) return <p className="text-sm text-neutral-500">Loading...</p>;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-50">Add {meta.displayName}</h1>
        <p className="text-sm text-neutral-400">{meta.description}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>
            Default executable:{' '}
            <code className="font-mono text-neutral-300">{meta.defaultExecutable}</code>
          </CardDescription>
        </CardHeader>
        <CliProviderForm mode="create" metadata={meta} />
      </Card>
    </div>
  );
}
