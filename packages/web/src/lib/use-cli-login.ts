'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { CliProbeResult, CliProviderName } from '@/lib/api-client';

export interface RequireCliLoginArgs {
  providerId: string;
  providerLabel: string;
  providerName: CliProviderName;
  onComplete?: (result: CliProbeResult) => void;
}

export interface CliLoginRequest extends RequireCliLoginArgs {
  requestId: number;
}

interface CliLoginContextValue {
  request: CliLoginRequest | null;
  requireCliLogin: (args: RequireCliLoginArgs) => void;
  closeCliLogin: () => void;
}

export const CliLoginContext = createContext<CliLoginContextValue | null>(null);

export function useCliLoginController() {
  const [request, setRequest] = useState<CliLoginRequest | null>(null);

  const requireCliLogin = useCallback((args: RequireCliLoginArgs) => {
    setRequest({ ...args, requestId: Date.now() });
  }, []);

  const closeCliLogin = useCallback(() => {
    setRequest(null);
  }, []);

  return useMemo(
    () => ({ request, requireCliLogin, closeCliLogin }),
    [request, requireCliLogin, closeCliLogin],
  );
}

export function useCliLogin(): CliLoginContextValue {
  const ctx = useContext(CliLoginContext);
  if (!ctx) {
    throw new Error('useCliLogin must be used inside <CliLoginProvider>');
  }
  return ctx;
}
