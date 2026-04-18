'use client';

import { useState } from 'react';
import {
  api,
  type CliAuthStatus,
  type CliProbePathResult,
  type CliProbeResult,
  type CliProviderName,
} from '@/lib/api-client';
import { Badge, Button, FormError } from '@/components/ui';
import { useCliLogin } from '@/lib/use-cli-login';

interface CliProviderTestProps {
  providerId: string;
  providerName: CliProviderName;
  providerLabel: string;
  blockMessage?: string | null;
}

const LOGIN_SUPPORTED: CliProviderName[] = ['claude-code', 'codex'];
const LOGIN_RECOVERABLE: CliAuthStatus[] = [
  'auth_expired',
  'auth_denied',
  'unknown_error',
  'timeout',
];

const AUTH_STATUS_LABEL: Record<CliAuthStatus, string> = {
  unknown: 'unknown',
  ok: 'authenticated',
  auth_expired: 'login expired',
  auth_denied: 'login denied',
  rate_limited: 'rate limited',
  network_error: 'network error',
  timeout: 'timeout',
  unknown_error: 'error',
};

function authBadgeVariant(status: CliAuthStatus): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'ok') return 'success';
  if (status === 'rate_limited' || status === 'network_error') return 'warning';
  if (status === 'unknown') return 'default';
  return 'error';
}

export function CliProviderTest({
  providerId,
  providerName,
  providerLabel,
  blockMessage,
}: CliProviderTestProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<CliProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blocked = Boolean(blockMessage);
  const { requireCliLogin } = useCliLogin();

  async function runTest() {
    setError(null);
    setTesting(true);
    try {
      const data = await api.post<{ result: CliProbeResult }>(`/cli-providers/${providerId}/test`);
      setResult(data.result);
      return data.result;
    } catch (err) {
      setError((err as Error).message ?? 'Test failed');
      return null;
    } finally {
      setTesting(false);
    }
  }

  async function handleTest() {
    setResult(null);
    await runTest();
  }

  function handleLogin() {
    requireCliLogin({
      providerId,
      providerLabel,
      providerName,
      onComplete: (res) => setResult(res),
    });
  }

  const cliAuthStatus = result?.cli?.authStatus;
  const showLogin =
    LOGIN_SUPPORTED.includes(providerName) &&
    cliAuthStatus !== undefined &&
    LOGIN_RECOVERABLE.includes(cliAuthStatus);

  return (
    <div className="flex flex-col gap-4">
      <FormError message={error} />

      <p className="text-sm text-neutral-400">
        Runs a fast probe against this provider. For subscription mode it invokes the CLI binary
        with <code className="font-mono text-neutral-300">--version</code> plus an auth probe; for
        API mode it sends a tiny ping through the SDK. Mixed mode tests both paths.
      </p>

      {blockMessage && (
        <div className="rounded-md border border-amber-500/40 bg-amber-950/30 p-3 text-xs text-amber-300">
          {blockMessage}
        </div>
      )}

      <div className="flex gap-2">
        <Button onClick={handleTest} disabled={testing || blocked}>
          {testing ? 'Testing...' : 'Test connection'}
        </Button>
        {showLogin && (
          <Button variant="secondary" onClick={handleLogin} disabled={testing}>
            Log in
          </Button>
        )}
      </div>

      {result && (
        <div className="flex flex-col gap-3 border-t border-neutral-800 pt-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-neutral-100">Overall:</span>
            <Badge variant={result.ok ? 'success' : 'error'}>{result.ok ? 'OK' : 'FAILED'}</Badge>
            <span className="text-xs text-neutral-500">mode: {result.targetMode}</span>
          </div>

          {result.cli && (
            <PathResultRow
              label="CLI path"
              res={result.cli}
              providerName={providerName}
              onLogin={handleLogin}
            />
          )}
          {result.api && (
            <PathResultRow
              label="API path"
              res={result.api}
              providerName={providerName}
              onLogin={handleLogin}
            />
          )}
        </div>
      )}
    </div>
  );
}

function PathResultRow({
  label,
  res,
  providerName,
  onLogin,
}: {
  label: string;
  res: CliProbePathResult;
  providerName: CliProviderName;
  onLogin: () => void;
}) {
  const loginPrompt =
    !res.ok &&
    res.authStatus &&
    LOGIN_SUPPORTED.includes(providerName) &&
    LOGIN_RECOVERABLE.includes(res.authStatus);
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-neutral-200">{label}</span>
        <Badge variant={res.ok ? 'success' : 'error'}>{res.ok ? 'OK' : 'FAIL'}</Badge>
        {res.authStatus && (
          <Badge variant={authBadgeVariant(res.authStatus)}>
            {AUTH_STATUS_LABEL[res.authStatus]}
          </Badge>
        )}
        {typeof res.durationMs === 'number' && (
          <span className="text-xs text-neutral-500">{res.durationMs} ms</span>
        )}
      </div>
      {loginPrompt ? (
        <p className="mt-2 text-sm text-amber-300">
          Not logged in. Click the{' '}
          <button
            type="button"
            onClick={onLogin}
            className="font-semibold text-amber-200 underline underline-offset-2 hover:text-amber-100"
          >
            Log in
          </button>{' '}
          button above to start an interactive login session.
        </p>
      ) : (
        <>
          {res.authMessage && (
            <p className="mt-2 text-xs text-neutral-400">
              <span className="font-semibold text-neutral-300">auth:</span> {res.authMessage}
            </p>
          )}
          {res.ok && res.detail && (
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-neutral-300">
              {res.detail}
            </pre>
          )}
          {!res.ok && res.error && (
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs text-red-400">
              {res.error}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
