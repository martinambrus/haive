'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  FormError,
  Input,
  Label,
} from '@/components/ui';
import {
  canClearGithubClient,
  describeGithubClientSource,
  type GithubClientSource,
} from '@/lib/integrations';

export interface GithubClientStatus {
  configured: boolean;
  source: GithubClientSource;
}

export function GithubClientForm({
  status,
  clientId,
  saving,
  error,
  success,
  onClientIdChange,
  onSave,
  onClear,
}: {
  status: GithubClientStatus | null;
  clientId: string;
  saving: boolean;
  error: string | null;
  success: string | null;
  onClientIdChange: (value: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  const source = describeGithubClientSource(status?.source ?? null);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">GitHub OAuth</CardTitle>
          {status === null ? (
            <Badge>loading</Badge>
          ) : status.configured ? (
            <>
              <Badge variant="success">configured</Badge>
              {source && <Badge>source: {source.label}</Badge>}
            </>
          ) : (
            <Badge variant="warning">not configured</Badge>
          )}
        </div>
        <CardDescription>
          Required to clone private GitHub repositories via the OAuth device flow.
        </CardDescription>
        {source && <p className="text-xs text-neutral-400">{source.text}</p>}
      </CardHeader>
      <ol className="list-decimal pl-5 text-xs text-neutral-400 [&>li]:mb-1">
        <li>
          Go to{' '}
          <a
            href="https://github.com/settings/developers"
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-400 underline hover:text-indigo-300"
          >
            github.com/settings/developers
          </a>{' '}
          and create a new OAuth App (or open an existing one).
        </li>
        <li>
          Under &quot;Authorization callback URL&quot;, enter your Haive URL (e.g.
          http://localhost:3000). The device flow does not use this, but the field cannot be left
          blank.
        </li>
        <li>Check &quot;Enable Device Flow&quot; — this is required and off by default.</li>
        <li>Copy the Client ID and paste it below.</li>
      </ol>
      <FormError message={error} />
      {success && (
        <div
          role="status"
          className="mt-3 rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200"
        >
          {success}
        </div>
      )}
      <div className="mt-3 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="github-client-id">Client ID</Label>
          <Input
            id="github-client-id"
            type="password"
            value={clientId}
            onChange={(e) => onClientIdChange(e.target.value)}
            placeholder={
              status?.source === 'user' ? '(saved — enter new value to replace)' : 'Ov23li...'
            }
            maxLength={256}
          />
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={saving || clientId.trim() === ''} onClick={onSave}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
          {canClearGithubClient(status?.source ?? null) && (
            <Button size="sm" variant="destructive" disabled={saving} onClick={onClear}>
              Clear
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export function GithubClientCard({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<GithubClientStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.get<GithubClientStatus>('/integrations/github'));
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to load status');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(value: string, done: string, failed: string) {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await api.put<{ ok: boolean }>('/integrations/github', { clientId: value });
      setClientId('');
      setSuccess(done);
      await refresh();
      onChanged();
    } catch (err) {
      setError((err as ApiError).message ?? failed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <GithubClientForm
      status={status}
      clientId={clientId}
      saving={saving}
      error={error}
      success={success}
      onClientIdChange={setClientId}
      onSave={() => void save(clientId, 'GitHub OAuth Client ID saved.', 'Failed to save')}
      onClear={() => void save('', 'GitHub OAuth Client ID cleared.', 'Failed to clear')}
    />
  );
}
