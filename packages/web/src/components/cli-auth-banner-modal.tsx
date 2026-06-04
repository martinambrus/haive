'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
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
  'amp',
  'antigravity',
]);

// Some CLIs (notably gemini in folder-trust mode) can swallow stdin before
// they print the OAuth URL, leaving the modal stuck on "Waiting for sign-in
// URL...". If the URL hasn't arrived after URL_WAIT_TIMEOUT_MS, we tear the
// WS down and reconnect, up to MAX_URL_WAIT_ATTEMPTS times. After that we
// surface a hard error with a manual retry button.
const MAX_URL_WAIT_ATTEMPTS = 3;
const URL_WAIT_TIMEOUT_MS = 30_000;

// Debug toggle: when true, antigravity's login modal renders agy's live TUI in
// an xterm. The normal flow is field-only (the server sizes the PTY so agy emits
// the OAuth URL without a client terminal). Set true only to inspect the TUI.
const ANTIGRAVITY_DEBUG_TERMINAL = false;

export function CliAuthBannerModal({
  open,
  providerId,
  providerLabel,
  providerName,
  onClose,
  onLoginComplete,
}: CliAuthBannerModalProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const termMountRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [savedResult, setSavedResult] = useState<CliProbeResult | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [urlAttempt, setUrlAttempt] = useState(1);

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
        case 'output':
          // antigravity debug terminal: write raw agy TUI output to the xterm.
          if (typeof msg.data === 'string') termRef.current?.write(msg.data);
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

  useEffect(() => {
    if (open) setUrlAttempt(1);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // antigravity is terminal-driven (agy's TUI needs a real interactive flow);
    // tearing down + reconnecting the WS every 30s restarts agy mid-init, so the
    // URL-wait auto-reconnect must not apply to it.
    if (providerName === 'antigravity') return;
    if (authUrl) return;
    if (phase !== 'awaiting-token' && phase !== 'awaiting-approval') return;
    const timer = setTimeout(() => {
      if (urlAttempt >= MAX_URL_WAIT_ATTEMPTS) {
        setPhase('error');
        setError(
          `Sign-in URL never arrived after ${MAX_URL_WAIT_ATTEMPTS} attempts. ` +
            `The CLI may be stuck waiting on stdin or printing the URL in an unrecognized format.`,
        );
        return;
      }
      setUrlAttempt((n) => n + 1);
      setRetryNonce((n) => n + 1);
    }, URL_WAIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [open, phase, authUrl, urlAttempt, providerName]);

  // antigravity debug terminal: render agy's TUI in an xterm bound to the same
  // banner WS the modal owns. 'output' frames are written to the term (see
  // ws.onmessage); keystrokes/resizes are sent back as 'input'/'resize'. Other
  // providers render no terminal (termRef stays null, the 'output' case no-ops).
  useEffect(() => {
    if (!open) return;
    if (providerName !== 'antigravity' || !ANTIGRAVITY_DEBUG_TERMINAL) return;
    const mount = termMountRef.current;
    if (!mount) return;

    const term = new XTerm({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 12,
      theme: { background: '#0a0a0a', foreground: '#e5e5e5', cursor: '#e5e5e5' },
      convertEol: true,
      scrollback: 5000,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new ClipboardAddon());
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (ev.ctrlKey && ev.shiftKey && (ev.key === 'V' || ev.key === 'v')) {
        void navigator.clipboard.readText().then((t) => {
          if (t) term.paste(t);
        });
        return false;
      }
      return true;
    });
    term.open(mount);
    termRef.current = term;

    const sendFrame = (frame: unknown) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    const fitAndResize = () => {
      try {
        fitAddon.fit();
        term.refresh(0, term.rows - 1);
      } catch {
        // ignore
      }
      const { rows, cols } = term;
      if (rows > 0 && cols > 0) sendFrame({ type: 'resize', rows, cols });
    };
    const inputDisposable = term.onData((data) => sendFrame({ type: 'input', data }));

    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        fitAndResize();
        term.focus();
      }),
    );
    const ro = new ResizeObserver(() => fitAndResize());
    ro.observe(mount);
    window.addEventListener('resize', fitAndResize);
    const t1 = setTimeout(fitAndResize, 300);
    const t2 = setTimeout(fitAndResize, 1200);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener('resize', fitAndResize);
      ro.disconnect();
      inputDisposable.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [open, providerName, retryNonce]);

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
  // Debug-only: render agy's live TUI in an xterm. The hidden field flow works
  // without it now that the server sizes the PTY itself; flip to true to debug.
  const showTerminal = providerName === 'antigravity' && ANTIGRAVITY_DEBUG_TERMINAL;
  const pasteItemLabel =
    providerName === 'gemini' || providerName === 'amp' || providerName === 'antigravity'
      ? 'code'
      : 'token';
  const pasteInputPlaceholder =
    providerName === 'gemini' || providerName === 'amp' || providerName === 'antigravity'
      ? 'Paste code here'
      : 'Paste token here';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-4 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-950 p-5 shadow-xl">
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

        {showTerminal && phase !== 'saved' && phase !== 'success' && (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-neutral-400">
              Antigravity sign-in (live terminal). Read the URL below, finish OAuth in your browser,
              then type or paste the code here (Ctrl+Shift+V to paste) and press Enter.
            </p>
            <div
              ref={termMountRef}
              className="h-72 w-full overflow-hidden rounded border border-neutral-800 bg-[#0a0a0a] p-2"
            />
          </div>
        )}

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
                  <span className="italic text-indigo-300">
                    Waiting for sign-in URL
                    {urlAttempt > 1 ? ` (attempt ${urlAttempt}/${MAX_URL_WAIT_ATTEMPTS})` : ''}...
                  </span>
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
                  <span className="italic text-indigo-300">
                    Waiting for sign-in URL
                    {urlAttempt > 1 ? ` (attempt ${urlAttempt}/${MAX_URL_WAIT_ATTEMPTS})` : ''}...
                  </span>
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
                      <Button
                        onClick={() => {
                          setUrlAttempt(1);
                          setRetryNonce((n) => n + 1);
                        }}
                      >
                        Retry
                      </Button>
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
