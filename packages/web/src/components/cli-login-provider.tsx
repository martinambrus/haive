'use client';

import type { ReactNode } from 'react';
import { CliAuthBannerModal } from '@/components/cli-auth-banner-modal';
import { CliLoginContext, useCliLoginController } from '@/lib/use-cli-login';
import type { CliProbeResult } from '@/lib/api-client';

export function CliLoginProvider({ children }: { children: ReactNode }) {
  const controller = useCliLoginController();
  const { request, closeCliLogin } = controller;

  const handleComplete = (result: CliProbeResult) => {
    request?.onComplete?.(result);
  };

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
