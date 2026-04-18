'use client';

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@/components/terminal/Terminal';
import { Button, FormError } from '@/components/ui';
import {
  api,
  type CliLoginStartResult,
  type CliProbeResult,
  type CliProviderName,
} from '@/lib/api-client';

interface CliLoginModalProps {
  open: boolean;
  providerId: string;
  providerLabel: string;
  providerName: CliProviderName;
  onClose: () => void;
  onLoginComplete?: (result: CliProbeResult) => void;
}

interface ProviderInstruction {
  headline: string;
  steps: string[];
}

const INSTRUCTIONS: Partial<Record<CliProviderName, ProviderInstruction>> = {
  'claude-code': {
    headline:
      'The Claude Code REPL will start. Type /login, follow the printed URL in your browser, then paste the code back into the terminal.',
    steps: [
      'Wait for the Claude Code prompt to appear in the terminal below.',
      'Type "/login" and press Enter.',
      'Open the printed URL in a browser and finish the OAuth flow.',
      'Paste the verification code back into the terminal and press Enter.',
      'Once you see the success message, click "Finish login" below.',
    ],
  },
  codex: {
    headline:
      'Codex will print a device-code URL. Open it, finish the OAuth flow, then paste the code back into the terminal.',
    steps: [
      'Wait for Codex to print the device-code URL in the terminal below.',
      'Open the URL in a browser and complete the login.',
      'Paste the verification code back into the terminal and press Enter.',
      'Once you see the success message, click "Finish login" below.',
    ],
  },
};

export function CliLoginModal({
  open,
  providerId,
  providerLabel,
  providerName,
  onClose,
  onLoginComplete,
}: CliLoginModalProps) {
  const [containerId, setContainerId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedProviderIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      startedProviderIdRef.current = null;
      setContainerId(null);
      setError(null);
      return;
    }
    if (startedProviderIdRef.current === providerId) return;
    startedProviderIdRef.current = providerId;
    let cancelled = false;
    (async () => {
      setStarting(true);
      setError(null);
      try {
        const res = await api.post<{ result: CliLoginStartResult }>(
          `/cli-providers/${providerId}/login/start`,
        );
        if (cancelled) return;
        setContainerId(res.result.containerId);
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message ?? 'Failed to start login container');
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, providerId]);

  const closeSession = (options: { notifyResult: boolean }) => {
    const cid = containerId;
    setContainerId(null);
    onClose();
    if (!cid) return;
    void (async () => {
      try {
        const res = await api.post<{ result: CliProbeResult }>(
          `/cli-providers/${providerId}/login/end`,
          { containerId: cid },
        );
        if (options.notifyResult && onLoginComplete) onLoginComplete(res.result);
      } catch (err) {
        console.warn('cli login end failed', err);
      }
    })();
  };

  const handleFinish = () => {
    closeSession({ notifyResult: true });
  };

  const handleCancel = () => {
    closeSession({ notifyResult: false });
  };

  if (!open) return null;

  const instruction = INSTRUCTIONS[providerName];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col gap-4 overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 p-5 shadow-xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-neutral-50">
              Interactive login — {providerLabel}
            </h2>
            <p className="text-xs text-neutral-500">{providerName}</p>
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
            aria-label="Close"
          >
            Close
          </button>
        </div>

        {instruction && (
          <div className="rounded-md border border-indigo-500/40 bg-indigo-950/30 p-3 text-xs text-indigo-100">
            <p className="font-medium">{instruction.headline}</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-indigo-200/90">
              {instruction.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </div>
        )}

        <FormError message={error} />

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {starting && <p className="text-sm text-neutral-400">Starting login container...</p>}
          {containerId && <Terminal containerId={containerId} fill />}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-neutral-800 pt-3">
          <Button variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleFinish} disabled={!containerId}>
            Finish login
          </Button>
        </div>
      </div>
    </div>
  );
}
