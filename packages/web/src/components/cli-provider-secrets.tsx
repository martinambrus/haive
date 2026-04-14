'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, type CliProviderSecret } from '@/lib/api-client';
import { Badge, Button, FormError, Input, Label } from '@/components/ui';

interface CliProviderSecretsProps {
  providerId: string;
  apiKeyEnvName?: string | null;
}

export function CliProviderSecrets({ providerId, apiKeyEnvName }: CliProviderSecretsProps) {
  const [secrets, setSecrets] = useState<CliProviderSecret[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secretName, setSecretName] = useState(apiKeyEnvName ?? '');
  const [secretValue, setSecretValue] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function reload() {
    try {
      const data = await api.get<{ secrets: CliProviderSecret[] }>(
        `/cli-providers/${providerId}/secrets`,
      );
      setSecrets(data.secrets);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load secrets');
    }
  }

  useEffect(() => {
    void reload();
  }, [providerId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.post(`/cli-providers/${providerId}/secrets`, {
        secretName,
        value: secretValue,
      });
      setSecretName(apiKeyEnvName ?? '');
      setSecretValue('');
      await reload();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to save secret');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete secret ${name}?`)) return;
    try {
      await api.delete(`/cli-providers/${providerId}/secrets/${encodeURIComponent(name)}`);
      await reload();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to delete secret');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <FormError message={error} />

      {secrets === null && <p className="text-sm text-neutral-500">Loading...</p>}
      {secrets && secrets.length === 0 && (
        <p className="text-sm text-neutral-500">No secrets stored.</p>
      )}
      {secrets && secrets.length > 0 && (
        <ul className="flex flex-col gap-2">
          {secrets.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-neutral-100">{s.secretName}</span>
                {s.fingerprint && <Badge>{s.fingerprint}</Badge>}
              </div>
              <Button variant="destructive" size="sm" onClick={() => handleDelete(s.secretName)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 border-t border-neutral-800 pt-4"
      >
        <div>
          <Label htmlFor="secretName">Secret name</Label>
          <Input
            id="secretName"
            value={secretName}
            onChange={(e) => setSecretName(e.target.value)}
            placeholder={apiKeyEnvName ?? 'SECRET_NAME'}
            required
          />
        </div>
        <div>
          <Label htmlFor="secretValue">Value</Label>
          <Input
            id="secretValue"
            type="password"
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
            required
          />
        </div>
        <div>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving...' : 'Save secret'}
          </Button>
        </div>
      </form>
    </div>
  );
}
