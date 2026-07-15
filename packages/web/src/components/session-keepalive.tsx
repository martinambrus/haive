'use client';

import { useEffect } from 'react';
import { refreshSession } from '@/lib/api-client';

/**
 * Keeps the access cookie fresh while the app is open.
 *
 * The access token has a short, deploy-configurable TTL. REST calls survive
 * expiry because api-client retries once behind a silent /auth/refresh, but
 * WebSocket connections (terminal, CLI streams, VNC) authenticate from the cookie
 * only at connect time and cannot silently refresh — so an expired cookie makes
 * every new or reconnecting socket 401 until a full page reload. Rotating the
 * cookie on an interval well under any sane TTL keeps all sockets connectable.
 *
 * 10 minutes is safe for any access TTL >= ~12m. Rotation is deduped with the
 * 401-retry path via refreshSession(), so the two never issue overlapping calls.
 */
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function SessionKeepAlive() {
  useEffect(() => {
    const id = setInterval(() => {
      void refreshSession();
    }, REFRESH_INTERVAL_MS);

    // Catch tabs that were backgrounded past the interval (laptop sleep, etc.)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshSession();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return null;
}
