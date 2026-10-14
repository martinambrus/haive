'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { Button, FormError } from '@/components/ui';
import { isHttpsUrl } from '@/lib/integrations';
import type { DeviceSignInPhase } from '@/lib/use-device-sign-in';

export function DeviceSignInDialog({
  phase,
  providerName,
  onCancel,
  onRetry,
}: {
  phase: DeviceSignInPhase;
  providerName: string;
  onCancel: () => void;
  onRetry: (providerId: string) => void;
}) {
  return (
    <Dialog
      className="mx-4"
      open={phase.kind !== 'idle'}
      onOpenChange={(open) => !open && onCancel()}
    >
      <DialogContent role="dialog" aria-labelledby="device-sign-in-title">
        <DialogHeader>
          <DialogTitle id="device-sign-in-title">Sign in with {providerName}</DialogTitle>
        </DialogHeader>
        {phase.kind === 'starting' && (
          <p className="text-sm text-neutral-300">Asking {providerName} for a code...</p>
        )}
        {phase.kind === 'waiting' && (
          <div className="flex flex-col gap-3 text-sm text-neutral-300">
            <p className="[overflow-wrap:anywhere]">
              Open{' '}
              {isHttpsUrl(phase.verificationUri) ? (
                <a
                  href={phase.verificationUri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-indigo-300 underline hover:text-indigo-200"
                >
                  {phase.verificationUri}
                </a>
              ) : (
                <span className="font-mono">{phase.verificationUri}</span>
              )}{' '}
              and enter this code:
            </p>
            <div
              data-testid="device-user-code"
              className="rounded-md border border-indigo-900 bg-indigo-950/30 px-3 py-3 text-center font-mono text-2xl tracking-widest text-indigo-100 [overflow-wrap:anywhere]"
            >
              {phase.userCode}
            </div>
            <p className="text-xs text-neutral-400">
              Waiting for {providerName} to confirm. Keep this window open.
            </p>
          </div>
        )}
        {phase.kind === 'failed' && <FormError message={phase.message} />}
        <div className="mt-4 flex justify-end gap-2">
          {phase.kind === 'failed' && (
            <Button type="button" className="h-11" onClick={() => onRetry(phase.providerId)}>
              Try again
            </Button>
          )}
          <Button type="button" variant="secondary" className="h-11" onClick={onCancel}>
            {phase.kind === 'failed' ? 'Close' : 'Cancel'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
