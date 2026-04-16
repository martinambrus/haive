'use client';

import { useEffect, useState } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  Input,
  Label,
  FormError,
} from '@/components/ui';

export default function IntegrationsPage() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [clientId, setClientId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ configured: boolean }>('/integrations/github')
      .then((data) => setConfigured(data.configured))
      .catch((err) => setError((err as ApiError).message ?? 'Failed to load status'));
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await api.put<{ ok: boolean }>('/integrations/github', { clientId });
      const trimmed = clientId.trim();
      setConfigured(trimmed.length > 0);
      setClientId('');
      setSuccess(
        trimmed.length > 0 ? 'GitHub OAuth Client ID saved.' : 'GitHub OAuth Client ID cleared.',
      );
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-neutral-50">Integrations</h2>
        <p className="text-sm text-neutral-400">
          Connect external services for repository access and authentication.
        </p>
      </div>

      <FormError message={error} />
      {success && (
        <div className="rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
          {success}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">GitHub OAuth</CardTitle>
            {configured === null ? (
              <Badge>loading</Badge>
            ) : configured ? (
              <Badge variant="success">configured</Badge>
            ) : (
              <Badge variant="warning">not configured</Badge>
            )}
          </div>
          <CardDescription>
            Required to clone private GitHub repositories via the OAuth device flow.
          </CardDescription>
        </CardHeader>
        <ol className="list-decimal pl-5 text-xs text-neutral-400 [&>li]:mb-1">
          <li>
            Go to github.com/settings/developers and create a new OAuth App (or open an existing
            one).
          </li>
          <li>
            Under &quot;Authorization callback URL&quot;, enter your Haive URL (e.g.
            http://localhost:3000). The device flow does not use this, but the field cannot be left
            blank.
          </li>
          <li>Check &quot;Enable Device Flow&quot; — this is required and off by default.</li>
          <li>Copy the Client ID and paste it below.</li>
        </ol>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="github-client-id">Client ID</Label>
            <Input
              id="github-client-id"
              type="password"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={configured ? '(saved — enter new value to replace)' : 'Ov23li...'}
              maxLength={256}
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
            {configured && (
              <Button
                size="sm"
                variant="destructive"
                disabled={saving}
                onClick={() => {
                  setClientId('');
                  void (async () => {
                    setSaving(true);
                    setError(null);
                    setSuccess(null);
                    try {
                      await api.put<{ ok: boolean }>('/integrations/github', { clientId: '' });
                      setConfigured(false);
                      setSuccess('GitHub OAuth Client ID cleared.');
                    } catch (err) {
                      setError((err as ApiError).message ?? 'Failed to clear');
                    } finally {
                      setSaving(false);
                    }
                  })();
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
