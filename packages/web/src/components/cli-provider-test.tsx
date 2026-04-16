'use client';

import { useState } from 'react';
import { api, type CliProbePathResult, type CliProbeResult } from '@/lib/api-client';
import { Badge, Button, FormError } from '@/components/ui';

interface CliProviderTestProps {
  providerId: string;
  blockMessage?: string | null;
}

export function CliProviderTest({ providerId, blockMessage }: CliProviderTestProps) {
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<CliProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blocked = Boolean(blockMessage);

  async function handleTest() {
    setError(null);
    setResult(null);
    setTesting(true);
    try {
      const data = await api.post<{ result: CliProbeResult }>(`/cli-providers/${providerId}/test`);
      setResult(data.result);
    } catch (err) {
      setError((err as Error).message ?? 'Test failed');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <FormError message={error} />

      <p className="text-sm text-neutral-400">
        Runs a fast probe against this provider. For subscription mode it invokes the CLI binary
        with <code className="font-mono text-neutral-300">--version</code>; for API mode it sends a
        tiny ping through the SDK. Mixed mode tests both paths.
      </p>

      {blockMessage && (
        <div className="rounded-md border border-amber-500/40 bg-amber-950/30 p-3 text-xs text-amber-300">
          {blockMessage}
        </div>
      )}

      <div>
        <Button onClick={handleTest} disabled={testing || blocked}>
          {testing ? 'Testing...' : 'Test connection'}
        </Button>
      </div>

      {result && (
        <div className="flex flex-col gap-3 border-t border-neutral-800 pt-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-neutral-100">Overall:</span>
            <Badge variant={result.ok ? 'success' : 'error'}>{result.ok ? 'OK' : 'FAILED'}</Badge>
            <span className="text-xs text-neutral-500">mode: {result.targetMode}</span>
          </div>

          {result.cli && <PathResultRow label="CLI path" res={result.cli} />}
          {result.api && <PathResultRow label="API path" res={result.api} />}
        </div>
      )}
    </div>
  );
}

function PathResultRow({ label, res }: { label: string; res: CliProbePathResult }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-neutral-200">{label}</span>
        <Badge variant={res.ok ? 'success' : 'error'}>{res.ok ? 'OK' : 'FAIL'}</Badge>
        {typeof res.durationMs === 'number' && (
          <span className="text-xs text-neutral-500">{res.durationMs} ms</span>
        )}
      </div>
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
    </div>
  );
}
