'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api, type CliProvider, type CliProviderCatalogEntry } from '@/lib/api-client';
import { Card, CardDescription, CardHeader, CardTitle, FormError } from '@/components/ui';
import { CliProviderForm } from '@/components/cli-provider-form';
import { CliProviderTest } from '@/components/cli-provider-test';
import { ClaudeUsageAuth } from '@/components/claude-usage-auth';
import { usePageTitle } from '@/lib/use-page-title';

export default function EditCliProviderPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [provider, setProvider] = useState<CliProvider | null>(null);
  const [meta, setMeta] = useState<CliProviderCatalogEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testBlockMessage, setTestBlockMessage] = useState<string | null>(null);
  const [secretsReloadNonce, setSecretsReloadNonce] = useState(0);
  /** This provider's usage token is dead. Reveals the Log in button below without a Test
   *  first, so the `#cli-login` deep-link the reconnect prompts use lands on a live control. */
  const [needsUsageReconnect, setNeedsUsageReconnect] = useState(false);
  usePageTitle(provider ? provider.label : 'CLI Provider');

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

  // Both cards mount only after the provider loads, so the browser's on-load scroll (from a
  // reconnect prompt's deep-link) has already missed the anchor. Mirrors what ClaudeUsageAuth
  // does for its own `#usage-tracking` anchor. `#secrets` is the credential textarea, where a
  // BYOK provider's dead usage token is replaced — focused as well as scrolled to, since for
  // that fix the field IS the repair and the user arrives with a key on the clipboard.
  useEffect(() => {
    if (!provider) return;
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    if (hash !== '#cli-login' && hash !== '#secrets') return;
    const target = document.getElementById(hash.slice(1));
    // The card carries `scroll-mt-6` and wants its top; the textarea has no such margin.
    target?.scrollIntoView({ behavior: 'smooth', block: hash === '#secrets' ? 'center' : 'start' });
    if (hash === '#secrets') (target as HTMLTextAreaElement | null)?.focus({ preventScroll: true });
  }, [provider]);

  // Separate from the load above so a usage-window failure never blocks the page: not knowing
  // the token is dead costs a hidden button, not the editor.
  useEffect(() => {
    api
      .get<{ snapshots: { providerId: string; status: string }[] }>('/usage-window')
      .then((d) =>
        setNeedsUsageReconnect(
          d.snapshots.some((s) => s.providerId === id && s.status === 'needs_reconnect'),
        ),
      )
      .catch(() => setNeedsUsageReconnect(false));
  }, [id, secretsReloadNonce]);

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

      {/* `#cli-login` is where every reconnect prompt for an interactive-login CLI points —
          this card owns the Log in button, so the anchor has to live on it. */}
      <Card id="cli-login" className="scroll-mt-6">
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
          needsUsageReconnect={needsUsageReconnect}
          onLoginCompleted={() => setSecretsReloadNonce((n) => n + 1)}
        />
      </Card>

      {provider.name === 'claude-code' && <ClaudeUsageAuth providerId={provider.id} />}
    </div>
  );
}
