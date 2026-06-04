'use client';

import { useCallback, type ReactNode } from 'react';
import { CliAuthBannerModal } from '@/components/cli-auth-banner-modal';
import { CliLoginContext, useCliLoginController } from '@/lib/use-cli-login';
import type { CliProbeResult } from '@/lib/api-client';

export function CliLoginProvider({ children }: { children: ReactNode }) {
  const controller = useCliLoginController();
  const { request, closeCliLogin } = controller;

  // Memoized so its identity is stable for a given login request. The modal's
  // WebSocket effect depends on onLoginComplete; an inline function here would
  // change every render and tear down + recreate the login container/WS.
  const handleComplete = useCallback(
    (result: CliProbeResult) => {
      request?.onComplete?.(result);
    },
    [request],
  );

  return (
    <CliLoginContext.Provider value={controller}>
      {children}
      <CliAuthBannerModal
        open={Boolean(request)}
        providerId={request?.providerId ?? ''}
        providerLabel={request?.providerLabel ?? ''}
        providerName={request?.providerName ?? 'claude-code'}
        onClose={closeCliLogin}
        onLoginComplete={handleComplete}
      />
    </CliLoginContext.Provider>
  );
}
