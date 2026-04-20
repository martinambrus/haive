'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api, type CliProvider, type CliProviderCatalogEntry } from '@/lib/api-client';
import { Card, CardDescription, CardHeader, CardTitle, FormError } from '@/components/ui';
import { CliProviderForm } from '@/components/cli-provider-form';
import { CliProviderTest } from '@/components/cli-provider-test';

export default function EditCliProviderPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [provider, setProvider] = useState<CliProvider | null>(null);
  const [meta, setMeta] = useState<CliProviderCatalogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testBlockMessage, setTestBlockMessage] = useState<string | null>(null);
  const [secretsReloadNonce, setSecretsReloadNonce] = useState(0);

  useEffect(() => {
    Promise.all([
      api.get<{ provider: CliProvider }>(`/cli-providers/${id}`),
      api.get<{ providers: CliProviderCatalogEntry[] }>('/cli-providers/catalog'),
    ])
      .then(([providerData, catalogData]) => {
        setProvider(providerData.provider);
        const found = catalogData.providers.find((p) => p.name === providerData.provider.name);
        setMeta(found ?? null);
      })
      .catch((err) => setError((err as Error).message ?? 'Failed to load provider'));
  }, [id]);

  if (error) return <FormError message={error} />;
  if (!provider || !meta) return <p className="text-sm text-neutral-500">Loading...</p>;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <Link
          href="/settings/cli-providers"
          className="text-xs text-neutral-500 hover:text-neutral-300"
        >
          Back to providers
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-neutral-50">{provider.label}</h1>
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
        <CliProviderForm
          mode="edit"
          provider={provider}
          metadata={meta}
          onTestBlockChange={setTestBlockMessage}
          secretsReloadNonce={secretsReloadNonce}
        />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Test connection</CardTitle>
          <CardDescription>
            Verify the CLI binary and/or API credentials respond correctly.
          </CardDescription>
        </CardHeader>
        <CliProviderTest
          providerId={provider.id}
          providerName={provider.name}
          providerLabel={provider.label}
          blockMessage={testBlockMessage}
          onLoginCompleted={() => setSecretsReloadNonce((n) => n + 1)}
        />
      </Card>
    </div>
  );
}
