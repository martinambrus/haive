'use client';

import { useEffect, useRef, useState } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui';

export interface RepoCredentialSummary {
  id: string;
  label: string;
  host: string;
}

type OauthPhase = 'idle' | 'awaiting_user' | 'polling' | 'error';

interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

type PollResponse =
  { status: 'pending'; error: string } | { status: 'ok'; credential: RepoCredentialSummary };

/** The credential a completed device flow left behind, if there is one.
 *
 *  Keyed on the label the poll handler writes, which is the only signal there
 *  is: `repo_credentials.provider` names the forge to call for PRs and is left
 *  null by the OAuth insert. Both callers go through here so that when the row
 *  grows a real marker there is one place to change, rather than two spellings
 *  of a prefix drifting apart. */
export function findGithubOauthCredential(
  credentials: RepoCredentialSummary[],
): RepoCredentialSummary | undefined {
  return credentials.find((c) => c.host === 'github.com' && c.label.startsWith('GitHub OAuth '));
}

/**
 * Sign in to GitHub by device code, and hand the caller the credential it mints.
 *
 * Extracted from the new-repo form because linking an origin needs exactly the
 * same thing: a repository created blank or by upload has no credential to push
 * with, and the device flow used to be reachable ONLY from the create-repository
 * form. So a user who had configured GitHub OAuth still met an empty dropdown
 * here and had nowhere to go — the credential row a flow mints is what fills it,
 * and nothing on this screen could mint one.
 *
 * The caller owns which credential is SELECTED; this owns the flow and reports
 * the row it created. Polling is cancelled on unmount, so closing a dialog
 * mid-flow does not leave a timer running against a dead component.
 */
export function GithubOauthConnect({
  connectedLabel,
  onConnected,
  onError,
}: {
  /** Shown instead of the button when a credential already exists. */
  connectedLabel?: string | null;
  onConnected: (credential: RepoCredentialSummary) => void;
  /** Surfaced by the host form, which already has somewhere to put an error.
   *  Called with null when a new attempt starts, so a failed one does not leave
   *  its message sitting under a flow that is now running. */
  onError?: (message: string | null) => void;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<OauthPhase>('idle');
  const [userCode, setUserCode] = useState('');
  const [verificationUri, setVerificationUri] = useState('');
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<{ configured: boolean }>('/integrations/github')
      .then((data) => {
        if (!cancelled) setConfigured(data.configured);
      })
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      cancelRef.current?.();
    };
  }, []);

  function reset(): void {
    cancelRef.current?.();
    cancelRef.current = null;
    setPhase('idle');
    setUserCode('');
    setVerificationUri('');
  }

  function fail(message: string): void {
    setPhase('error');
    cancelRef.current = null;
    onError?.(message);
  }

  async function start(): Promise<void> {
    reset();
    onError?.(null);
    try {
      const begin = await api.post<DeviceCodeStart>('/github-oauth/device-code', {});
      setUserCode(begin.userCode);
      setVerificationUri(begin.verificationUri);
      setPhase('awaiting_user');

      let cancelled = false;
      cancelRef.current = () => {
        cancelled = true;
      };
      // GitHub rejects a device poll faster than its stated interval, and the
      // documented floor is 5s — so the interval is honoured, never shortened.
      const intervalMs = Math.max(begin.interval, 5) * 1000;
      const deadline = Date.now() + begin.expiresIn * 1000;
      setPhase('polling');

      const tick = async (): Promise<void> => {
        while (!cancelled && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, intervalMs));
          if (cancelled) return;
          try {
            const res = await api.post<PollResponse>('/github-oauth/poll', {
              deviceCode: begin.deviceCode,
            });
            if (res.status === 'ok') {
              reset();
              onConnected(res.credential);
              return;
            }
          } catch (err) {
            fail((err as ApiError).message ?? 'GitHub OAuth failed');
            return;
          }
        }
        if (!cancelled) fail('Device code expired. Start over.');
      };
      void tick();
    } catch (err) {
      fail((err as ApiError).message ?? 'Failed to start GitHub OAuth');
    }
  }

  if (configured === false) {
    return (
      <div className="rounded-md border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
        GitHub OAuth is not configured. Set it up in{' '}
        <a href="/settings/integrations" className="underline">
          Settings &gt; Integrations
        </a>
        .
      </div>
    );
  }

  if (connectedLabel) {
    return (
      <div className="rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
        Signed in — credential stored as <span className="font-mono">{connectedLabel}</span>
      </div>
    );
  }

  return (
    <>
      {phase === 'idle' || phase === 'error' ? (
        <Button type="button" onClick={() => void start()} disabled={configured === null}>
          {configured === null ? 'Checking...' : 'Sign in with GitHub'}
        </Button>
      ) : null}
      {(phase === 'awaiting_user' || phase === 'polling') && (
        <div className="flex flex-col gap-2 rounded-md border border-indigo-900 bg-indigo-950/30 px-3 py-3 text-xs text-indigo-200">
          <div>
            Visit{' '}
            <a href={verificationUri} target="_blank" rel="noreferrer" className="underline">
              {verificationUri}
            </a>{' '}
            and enter this code:
          </div>
          <div className="font-mono text-lg tracking-widest text-indigo-100">{userCode}</div>
          <div className="text-neutral-400">Waiting for GitHub to confirm...</div>
          <button
            type="button"
            className="self-start text-neutral-400 underline"
            onClick={() => reset()}
          >
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
