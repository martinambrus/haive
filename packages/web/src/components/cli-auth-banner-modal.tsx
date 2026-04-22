'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, FormError } from '@/components/ui';
import { apiWebSocketUrl, type CliProbeResult, type CliProviderName } from '@/lib/api-client';

interface CliAuthBannerModalProps {
  open: boolean;
  providerId: string;
  providerLabel: string;
  providerName: CliProviderName;
  onClose: () => void;
  onLoginComplete?: (result: CliProbeResult) => void;
}

type Phase =
  | 'connecting'
  | 'starting'
  | 'awaiting-token'
  | 'awaiting-approval'
  | 'submitting'
  | 'success'
  | 'saved'
  | 'error';

const TOKEN_PASTE_PROVIDERS: ReadonlySet<CliProviderName> = new Set<CliProviderName>([
  'claude-code',
  'gemini',
]);

export function CliAuthBannerModal({
  open,
  providerId,
  providerLabel,
  providerName,
  onClose,
  onLoginComplete,
}: CliAuthBannerModalProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savedResult, setSavedResult] = useState<CliProbeResult | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!open) return;
    setPhase('connecting');
    setAuthUrl(null);
    setDeviceCode(null);
    setToken('');
    setError(null);
    setSavedResult(null);

    const ws = new WebSocket(apiWebSocketUrl(`/cli-login-banner/${providerId}`));
    wsRef.current = ws;

    const connectTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        setPhase('error');
        setError('Connection timed out. Close and try again.');
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }, 15_000);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
    };

    ws.onmessage = (ev) => {
      let msg: { type?: string; [k: string]: unknown } | null = null;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (!msg) return;
      switch (msg.type) {
        case 'phase':
          if (msg.phase === 'starting') setPhase('starting');
          else if (msg.phase === 'awaiting-token') setPhase('awaiting-token');
          else if (msg.phase === 'awaiting-approval') setPhase('awaiting-approval');
          else if (msg.phase === 'submitting') setPhase('submitting');
          break;
        case 'auth-url':
          if (typeof msg.url === 'string') setAuthUrl(msg.url);
          if (typeof msg.deviceCode === 'string') setDeviceCode(msg.deviceCode);
          if (!TOKEN_PASTE_PROVIDERS.has(providerName)) setPhase('awaiting-approval');
          else setPhase('awaiting-token');
          break;
        case 'auth-success':
          setPhase('success');
          break;
        case 'saved': {
          const probeResult = (msg.result as CliProbeResult | undefined) ?? null;
          setSavedResult(probeResult);
          setPhase('saved');
          if (probeResult && onLoginComplete) {
            onLoginComplete(probeResult);
          }
          break;
        }
        case 'error':
          setPhase('error');
          setError(typeof msg.message === 'string' ? msg.message : 'Login failed');
          break;
        case 'exit':
          setPhase((prev) =>
            prev === 'saved' || prev === 'success' || prev === 'error' ? prev : 'error',
          );
          break;
      }
    };

    ws.onerror = () => {
      setPhase('error');
      setError('WebSocket error');
    };

    ws.onclose = () => {
      clearTimeout(connectTimeout);
    };

    return () => {
      clearTimeout(connectTimeout);
      try {
        ws.close(1000, 'unmount');
      } catch {
        // ignore
      }
      wsRef.current = null;
    };
  }, [open, providerId, providerName, onLoginComplete, retryNonce]);

  const handleSubmitToken = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const trimmed = token.trim();
    if (!trimmed) return;
    setPhase('submitting');
    ws.send(JSON.stringify({ type: 'token-input', token: trimmed }));
  }, [token]);

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  if (!open) return null;

  const isTokenPaste = TOKEN_PASTE_PROVIDERS.has(providerName);
  const pasteItemLabel = providerName === 'gemini' ? 'authorization code' : 'token';
  const pasteInputPlaceholder = providerName === 'gemini' ? 'Paste code here' : 'Paste token here';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex w-full max-w-2xl flex-col gap-4 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-neutral-50">Sign in — {providerLabel}</h2>
            <p className="text-xs text-neutral-500">{providerName}</p>
          </div>
          {phase !== 'success' && (
            <button
              type="button"
              onClick={handleClose}
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
              aria-label="Close"
            >
              Close
            </button>
          )}
        </div>

        <FormError message={error} />

        {(phase === 'connecting' || phase === 'starting') && (
          <BannerRow tone="info">
            <Spinner />
            <span>{phase === 'connecting' ? 'Connecting...' : 'Starting login container...'}</span>
          </BannerRow>
        )}

        {(phase === 'awaiting-token' || phase === 'submitting') && isTokenPaste && (
          <div className="rounded-md border border-indigo-500/40 bg-indigo-950/30 p-3 text-sm text-indigo-100">
            <p className="font-medium">Complete sign-in:</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-indigo-200/90">
              <li>
                {authUrl ? (
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline hover:text-indigo-100"
                  >
                    Open the sign-in page
                  </a>
                ) : (
                  <span className="italic text-indigo-300">Waiting for sign-in URL...</span>
                )}{' '}
                and finish the OAuth flow.
              </li>
              <li>Copy the {pasteItemLabel} shown on the confirmation page.</li>
              <li>Paste it below and click Submit.</li>
            </ol>
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                placeholder={pasteInputPlaceholder}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSubmitToken();
                }}
                disabled={phase === 'submitting' || !authUrl}
                autoFocus
                className="flex-1 rounded border border-indigo-500/40 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-indigo-400 focus:outline-none disabled:opacity-50"
              />
              <Button
                onClick={handleSubmitToken}
                disabled={!token.trim() || phase === 'submitting' || !authUrl}
              >
                {phase === 'submitting' ? 'Verifying...' : 'Submit'}
              </Button>
            </div>
          </div>
        )}

        {(phase === 'awaiting-token' || phase === 'awaiting-approval') && !isTokenPaste && (
          <div className="rounded-md border border-indigo-500/40 bg-indigo-950/30 p-3 text-sm text-indigo-100">
            {providerName === 'codex' && (
              <div className="mb-3 rounded border border-amber-500/40 bg-amber-950/30 p-2 text-xs text-amber-100">
                <p className="font-medium">Before you start:</p>
                <p className="mt-1 text-amber-200/90">
                  Codex OAuth requires &quot;Device authorization&quot; enabled on your ChatGPT
                  account. Enable it at{' '}
                  <a
                    href="https://chatgpt.com/#settings/Security"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline hover:text-amber-50"
                  >
                    chatgpt.com/#settings/Security
                  </a>{' '}
                  (Security → Device authorization) before approving the device code below.
                </p>
              </div>
            )}
            <p className="font-medium">Complete sign-in:</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-indigo-200/90">
              <li>
                {authUrl ? (
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium underline hover:text-indigo-100"
                  >
                    Open the sign-in page
                  </a>
                ) : (
                  <span className="italic text-indigo-300">Waiting for sign-in URL...</span>
                )}
              </li>
              {deviceCode && (
                <li>
                  Enter this device code:{' '}
                  <code className="rounded bg-neutral-900 px-2 py-0.5 font-mono text-base font-bold text-indigo-50">
                    {deviceCode}
                  </code>
                </li>
              )}
              <li>Approve access and return here — we&apos;ll detect it automatically.</li>
            </ol>
            <div className="mt-3 flex items-center gap-3 text-xs text-indigo-200/80">
              <Spinner />
              <span>Waiting for approval...</span>
            </div>
          </div>
        )}

        {phase === 'success' && (
          <BannerRow tone="success">
            <Checkmark />
            <span>Authentication successful — saving credentials...</span>
          </BannerRow>
        )}

        {phase === 'saved' &&
          (() => {
            const authStatus = savedResult?.cli?.authStatus ?? 'unknown';
            const authMessage = savedResult?.cli?.authMessage;
            const probeVerified = authStatus === 'ok';
            return (
              <>
                {probeVerified ? (
                  <BannerRow tone="success">
                    <Checkmark />
                    <span>Signed in and verified.</span>
                  </BannerRow>
                ) : (
                  <div className="rounded-md border border-amber-500/40 bg-amber-950/30 p-3 text-sm text-amber-100">
                    <p className="font-medium">Credentials saved, but verification failed.</p>
                    <p className="mt-1 text-xs text-amber-200/90">
                      Probe status:{' '}
                      <code className="rounded bg-neutral-900 px-1 font-mono">{authStatus}</code>
                      {authMessage ? ` — ${authMessage}` : ''}
                    </p>
                    <p className="mt-1 text-xs text-amber-200/80">Try signing in again.</p>
                  </div>
                )}
                <div className="flex items-center justify-end gap-2 border-t border-neutral-800 pt-3">
                  {probeVerified ? (
                    <Button onClick={handleClose}>Done</Button>
                  ) : (
                    <>
                      <Button variant="ghost" onClick={handleClose}>
                        Close
                      </Button>
                      <Button onClick={() => setRetryNonce((n) => n + 1)}>Retry</Button>
                    </>
                  )}
                </div>
              </>
            );
          })()}

        {phase !== 'saved' && phase !== 'error' && phase !== 'success' && (
          <div className="flex items-center justify-end gap-2 border-t border-neutral-800 pt-3">
            <Button variant="ghost" onClick={handleClose}>
              Cancel
            </Button>
          </div>
        )}

        {phase === 'error' && (
          <div className="flex items-center justify-end gap-2 border-t border-neutral-800 pt-3">
            <Button variant="ghost" onClick={handleClose}>
              Close
            </Button>
            <Button onClick={() => setRetryNonce((n) => n + 1)}>Retry</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function BannerRow({ tone, children }: { tone: 'info' | 'success'; children: React.ReactNode }) {
  const color =
    tone === 'success'
      ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-100'
      : 'border-indigo-500/40 bg-indigo-950/30 text-indigo-100';
  return (
    <div className={`flex items-center gap-3 rounded-md border p-3 text-sm ${color}`}>
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-4 w-4 animate-spin text-current"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function Checkmark() {
  return (
    <svg
      className="h-4 w-4 text-current"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  );
}
