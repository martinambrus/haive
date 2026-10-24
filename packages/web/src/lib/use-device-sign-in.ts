'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import { runDeviceSignIn, type DevicePoll, type DeviceStart } from '@/lib/device-sign-in';
import type { IntegrationConnection } from '@/lib/integrations';

export type DeviceSignInPhase =
  | { kind: 'idle' }
  | { kind: 'starting'; providerId: string }
  | { kind: 'waiting'; providerId: string; userCode: string; verificationUri: string }
  | { kind: 'failed'; providerId: string; message: string };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One sign-in at a time, started by a click; cancelling or starting again drops the one in flight. */
export function useDeviceSignIn(onConnected: (connection: IntegrationConnection) => void) {
  const [phase, setPhase] = useState<DeviceSignInPhase>({ kind: 'idle' });
  const attempt = useRef(0);
  const connected = useRef(onConnected);

  useEffect(() => {
    connected.current = onConnected;
  });
  useEffect(
    () => () => {
      attempt.current += 1;
    },
    [],
  );

  const cancel = useCallback(() => {
    attempt.current += 1;
    setPhase({ kind: 'idle' });
  }, []);

  const start = useCallback(async (providerId: string) => {
    attempt.current += 1;
    const mine = attempt.current;
    const live = () => attempt.current === mine;
    const base = `/integrations/providers/${encodeURIComponent(providerId)}/device`;
    setPhase({ kind: 'starting', providerId });
    try {
      const result = await runDeviceSignIn({
        start: () => api.post<DeviceStart>(`${base}/start`, {}),
        poll: (handle) => api.post<DevicePoll>(`${base}/poll`, { handle }),
        wait,
        now: Date.now,
        live,
        onWaiting: ({ userCode, verificationUri }) =>
          setPhase({ kind: 'waiting', providerId, userCode, verificationUri }),
      });
      if (!live()) return;
      if (result.kind === 'connected') {
        setPhase({ kind: 'idle' });
        connected.current(result.connection);
      } else if (result.kind === 'expired' && live()) {
        setPhase({ kind: 'failed', providerId, message: 'The code expired. Start again.' });
      }
    } catch (err) {
      if (live()) {
        setPhase({
          kind: 'failed',
          providerId,
          message: (err as ApiError).message ?? 'The sign-in failed',
        });
      }
    }
  }, []);

  return { phase, start, cancel };
}
