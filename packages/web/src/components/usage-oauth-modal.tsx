'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api-client';
import { Button, FormError, Input, Label } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';

/** Re-authorization for a usage-OAuth provider (claude-code), run from wherever the dead-token
 *  prompt was clicked.
 *
 *  The prompt used to deep-link to the provider's edit page anchored at its Usage tracking
 *  card, which made "Reconnect" mean "open a settings form and find the real Reconnect
 *  button" — the same complaint that produced the CLI-login modal, one repair later. Opening
 *  the vendor's authorization page IS the repair, so this dialog starts it on mount and the
 *  click that opened it is the only one needed to reach Anthropic's sign-in.
 *
 *  `window.open` is deliberately fired in the `start` response handler rather than behind a
 *  second button: the POST is a local round-trip, so the browser's transient user activation
 *  from the click is still live when it lands. A blocked popup is not a dead end — the
 *  authorize URL is always rendered as a link too. */
type Phase = 'starting' | 'awaiting-code' | 'submitting' | 'done';

export function UsageOauthModal({
  open,
  providerId,
  providerLabel,
  onClose,
  onReconnected,
}: {
  open: boolean;
  providerId: string;
  providerLabel: string;
  onClose: () => void;
  onReconnected?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('starting');
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Bumped by "Try again" so the start effect re-runs after a failed start. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase('starting');
    setAuthorizeUrl(null);
    setCode('');
    setError(null);
    api
      .post<{ authorizeUrl: string }>(`/cli-providers/${providerId}/usage-auth/start`)
      .then(({ authorizeUrl: url }) => {
        // Under React StrictMode this effect runs twice; the first run is cancelled by its
        // cleanup before it gets here, so exactly one tab opens. The server keys the PKCE
        // verifier by (user, provider) and the second start overwrites the first, which is
        // why the cancelled run must not open a tab — its state is already gone.
        if (cancelled) return;
        setAuthorizeUrl(url);
        setPhase('awaiting-code');
        window.open(url, '_blank', 'noopener,noreferrer');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError((err as Error).message ?? 'Failed to start authorization');
        setPhase('awaiting-code');
      });
    return () => {
      cancelled = true;
    };
  }, [open, providerId, attempt]);

  async function complete() {
    const trimmed = code.trim();
    if (!trimmed) return;
    setPhase('submitting');
    setError(null);
    try {
      await api.post(`/cli-providers/${providerId}/usage-auth/complete`, { code: trimmed });
      setPhase('done');
      onReconnected?.();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to complete authorization');
      setPhase('awaiting-code');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reconnect usage tracking</DialogTitle>
          <p className="text-sm text-neutral-400">
            {providerLabel} — re-authorize the usage-scoped token so its 5-hour and weekly meters
            come back. This is separate from the login used to run the CLI.
          </p>
        </DialogHeader>

        {phase === 'done' ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-emerald-400">
              Usage tracking reconnected. The meters refill on the next poll (under a minute).
            </p>
            <div>
              <Button size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : phase === 'starting' ? (
          <p className="text-sm text-neutral-400">Opening the authorization page…</p>
        ) : (
          <div className="flex flex-col gap-3">
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-neutral-300">
              <li>
                An authorization page opened in a new tab.
                {authorizeUrl && (
                  <>
                    {' '}
                    If it didn&apos;t,{' '}
                    <a
                      href={authorizeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-400 underline"
                    >
                      open it here
                    </a>
                    .
                  </>
                )}
              </li>
              <li>Approve access, then copy the code the page shows.</li>
              <li>Paste it below and click Complete.</li>
            </ol>
            <div className="flex flex-col gap-1">
              <Label htmlFor="usage-oauth-code">Authorization code</Label>
              <Input
                id="usage-oauth-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="code#state"
                autoComplete="off"
              />
            </div>
            <FormError message={error} />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void complete()}
                disabled={phase === 'submitting' || !code.trim()}
              >
                {phase === 'submitting' ? 'Completing…' : 'Complete'}
              </Button>
              {!authorizeUrl && (
                <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
