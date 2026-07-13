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
  const [needsReconnect, setNeedsReconnect] = useState(false);

  useEffect(() => {
    api
      .get<UsageAuthStatus>(`/cli-providers/${providerId}/usage-auth`)
      .then((s) => {
        setConnected(s.connected);
        setConnectedAt(s.connectedAt);
      })
      .catch(() => setConnected(false));
    // A stored token can still be DEAD — the poller marks it needs_reconnect on an
    // invalid_grant / 401 / 403. `connected` alone (token present) would show green for
    // a dead token, so cross-check the usage snapshot and surface the expired state.
    api
      .get<{ snapshots: { providerId: string; status: string }[] }>('/usage-window')
      .then((d) =>
        setNeedsReconnect(
          d.snapshots.some((s) => s.providerId === providerId && s.status === 'needs_reconnect'),
        ),
      )
      .catch(() => {});
  }, [providerId]);

  // This card mounts only after the parent page loads the provider, so the browser's
  // on-load `#usage-tracking` scroll (from the header chip's deep-link) has already
  // missed the anchor. Scroll it into view ourselves when the hash targets us.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash === '#usage-tracking') {
      document
        .getElementById('usage-tracking')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

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
      setNeedsReconnect(false);
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
      setNeedsReconnect(false);
      setAuthorizeUrl(null);
      setNotice('Usage tracking disconnected.');
    } catch (err) {
      setError((err as Error).message ?? 'Failed to disconnect');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="usage-tracking" className="scroll-mt-6">
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
      ) : connected && !authorizeUrl ? (
        <div className="flex flex-col gap-3">
          {needsReconnect ? (
            <p className="text-sm text-amber-400">
              ⚠ Token expired — reconnect to restore your usage meters. (If this is a duplicate of
              an account you already track elsewhere, Disconnect it instead.)
            </p>
          ) : (
            <p className="text-sm text-emerald-400">
              Connected{connectedAt ? ` · ${new Date(connectedAt).toLocaleString()}` : ''}
            </p>
          )}
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
