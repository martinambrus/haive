'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import {
  clientUpdate,
  enabledLabel,
  precedenceNote,
  secretPlaceholder,
  usesOauthClient,
  type AdminIntegrationProvider,
  type AdminIntegrationUpdate,
  type IntegrationAuthKind,
} from '@/lib/admin-integrations';
import { usePageTitle } from '@/lib/use-page-title';
import { Badge, Button, Card, FormError, Input, Label } from '@/components/ui';

const AUTH_LABEL: Record<IntegrationAuthKind, string> = {
  oauth2: 'OAuth 2.0',
  device: 'Device flow',
  token: 'Token',
};

function ProviderCard({
  provider,
  onSaved,
}: {
  provider: AdminIntegrationProvider;
  onSaved: (saved: AdminIntegrationProvider) => void;
}) {
  const [clientId, setClientId] = useState(provider.oauthClientId ?? '');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const update = clientUpdate(provider, { clientId, secret });
  const note = precedenceNote(provider.precedence);

  async function save(
    body: AdminIntegrationUpdate,
    message: string,
  ): Promise<AdminIntegrationProvider | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.put<{ provider: AdminIntegrationProvider }>(
        `/admin/integrations/providers/${encodeURIComponent(provider.id)}`,
        body,
      );
      onSaved(res.provider);
      setNotice(message);
      return res.provider;
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to save');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveClient() {
    if (!update) return;
    const saved = await save(update, 'Client saved.');
    if (saved) {
      setClientId(saved.oauthClientId ?? '');
      setSecret('');
    }
  }

  async function clearSecret() {
    if (await save({ oauthClientSecret: '' }, 'Client secret cleared.')) setSecret('');
  }

  return (
    <Card className="flex flex-col gap-4 p-4" data-provider-id={provider.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-neutral-50">{provider.name}</h2>
            <Badge variant={provider.enabled ? 'success' : 'warning'}>
              {enabledLabel(provider)}
            </Badge>
          </div>
          <p className="font-mono text-[11px] text-neutral-500 [overflow-wrap:anywhere]">
            {provider.id}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {provider.categories.map((category) => (
              <Badge key={category} variant="info">
                {category}
              </Badge>
            ))}
            {provider.authKinds.map((kind) => (
              <Badge key={kind}>{AUTH_LABEL[kind]}</Badge>
            ))}
          </div>
        </div>
        <label className="flex min-h-11 items-center gap-2 text-sm text-neutral-200">
          <input
            type="checkbox"
            checked={provider.enabled}
            disabled={busy}
            onChange={(e) =>
              void save(
                { enabled: e.target.checked },
                `${provider.name} ${e.target.checked ? 'enabled' : 'disabled'}.`,
              )
            }
            className="h-4 w-4"
          />
          Enabled
        </label>
      </div>

      {usesOauthClient(provider) && (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium text-neutral-200">OAuth client</h3>
          {note && (
            <p
              className={
                note.tone === 'warning'
                  ? 'rounded-md border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-xs text-amber-200'
                  : 'text-xs text-neutral-400'
              }
            >
              {note.text}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`client-id-${provider.id}`}>Client ID</Label>
              <Input
                id={`client-id-${provider.id}`}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="not set"
                maxLength={256}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`client-secret-${provider.id}`}>Client secret</Label>
              <Input
                id={`client-secret-${provider.id}`}
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={secretPlaceholder(provider.hasClientSecret)}
                maxLength={4096}
                autoComplete="new-password"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`redirect-uri-${provider.id}`}>
              Redirect URI to register with {provider.name}
            </Label>
            <Input
              id={`redirect-uri-${provider.id}`}
              readOnly
              value={provider.redirectUri}
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || update === null} onClick={() => void saveClient()}>
              {busy ? 'Saving…' : 'Save client'}
            </Button>
            {provider.hasClientSecret && (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => void clearSecret()}
              >
                Clear secret
              </Button>
            )}
          </div>
        </div>
      )}

      <FormError message={error} />
      {notice && (
        <div
          role="status"
          className="rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200"
        >
          {notice}
        </div>
      )}
    </Card>
  );
}

export default function AdminIntegrationsPage() {
  usePageTitle('Integrations');

  const [providers, setProviders] = useState<AdminIntegrationProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ providers: AdminIntegrationProvider[] }>(
        '/admin/integrations/providers',
      );
      setProviders(res.providers);
      setError(null);
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to load the integration providers');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function replace(saved: AdminIntegrationProvider) {
    setProviders((rows) => rows?.map((row) => (row.id === saved.id ? saved : row)) ?? null);
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-3xl text-sm text-neutral-400">
        Every integration provider this install knows. Enabled providers are the ones users can
        connect. Where a provider signs users in through the vendor, register one OAuth client with
        it here. The client secret is write-only: it is stored encrypted and never shown again.
      </p>
      <FormError message={error} />
      {providers === null && !error && <p className="text-sm text-neutral-400">Loading…</p>}
      <div className="flex flex-col gap-3">
        {providers?.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} onSaved={replace} />
        ))}
      </div>
    </div>
  );
}
