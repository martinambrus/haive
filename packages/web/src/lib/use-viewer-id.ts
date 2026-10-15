'use client';

import { useEffect, useState } from 'react';
import { api, type User } from '@/lib/api-client';

/** The signed-in user's id from /auth/me, read once per open; null until it answers or if it fails. */
export function useViewerId(active: boolean): string | null {
  const [viewerId, setViewerId] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let live = true;
    api
      .get<{ user?: Partial<User> | null } | null>('/auth/me')
      .then((me) => {
        const id = me?.user?.id;
        if (live) setViewerId(typeof id === 'string' && id !== '' ? id : null);
      })
      .catch(() => {
        if (live) setViewerId(null);
      });
    return () => {
      live = false;
      setViewerId(null);
    };
  }, [active]);

  return viewerId;
}
