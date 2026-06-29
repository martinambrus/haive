'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import {
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/components/ui';

interface UsageAuthStatus {
  connected: boolean;
  connectedAt: string | null;
}

/**
 * Claude usage-tracking OAuth (PKCE). Mints a user:profile-scoped token — the one the
 * setup-token used to RUN claude lacks — so the task header can show 5h/weekly windows.
 * Pure browser round-trip: start -> authorize in a new tab -> paste back code#state.
 */
export function ClaudeUsageAuth({ providerId }: { providerId: string }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [connectedAt, setConnectedAt] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<UsageAuthStatus>(`/cli-providers/${providerId}/usage-auth`)
      .then((s) => {
        setConnected(s.connected);
        setConnectedAt(s.connectedAt);
      })
      .catch(() => setConnected(false));
  }, [providerId]);

  async function start() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { authorizeUrl: url } = await api.post<{ authorizeUrl: string }>(
        `/cli-providers/${providerId}/usage-auth/start`,
      );
      setAuthorizeUrl(url);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError((err as Error).message ?? 'Failed to start authorization');
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.post<{ connected: boolean; expiresAt: number }>(
        `/cli-providers/${providerId}/usage-auth/complete`,
        { code: code.trim() },
      );
      setConnected(true);
      setConnectedAt(new Date().toISOString());
      setAuthorizeUrl(null);
      setCode('');
      setNotice('Usage tracking connected.');
    } catch (err) {
      setError((err as Error).message ?? 'Failed to complete authorization');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.delete(`/cli-providers/${providerId}/usage-auth`);
      setConnected(false);
      setConnectedAt(null);
      setAuthorizeUrl(null);
      setNotice('Usage tracking disconnected.');
    } catch (err) {
      setError((err as Error).message ?? 'Failed to disconnect');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage tracking</CardTitle>
        <CardDescription>
          Authorize a usage-scoped (user:profile) token so the task header can show your Claude
          5-hour and weekly subscription windows. This is separate from the login used to run
          Claude, which can&apos;t read usage. The token auto-refreshes; revoke anytime.
        </CardDescription>
      </CardHeader>

      {connected === null ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : connected ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-emerald-400">
            Connected{connectedAt ? ` · ${new Date(connectedAt).toLocaleString()}` : ''}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => void start()} disabled={busy}>
              Reconnect
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void disconnect()}
              disabled={busy}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : !authorizeUrl ? (
        <Button size="sm" onClick={() => void start()} disabled={busy}>
          Connect usage tracking
        </Button>
      ) : (
        <div className="flex flex-col gap-3">
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-neutral-300">
            <li>
              A Claude authorization page opened in a new tab. If it didn&apos;t,{' '}
              <a
                href={authorizeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-400 underline"
              >
                open it here
              </a>
              .
            </li>
            <li>Approve access, then copy the code the page shows.</li>
            <li>Paste it below and click Complete.</li>
          </ol>
          <div className="flex flex-col gap-1">
            <Label htmlFor="usage-auth-code">Authorization code</Label>
            <Input
              id="usage-auth-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="code#state"
              autoComplete="off"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void complete()} disabled={busy || !code.trim()}>
              Complete
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setAuthorizeUrl(null);
                setCode('');
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      {notice && <p className="mt-3 text-sm text-emerald-400">{notice}</p>}
    </Card>
  );
}
