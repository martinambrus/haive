'use client';

import { useEffect } from 'react';

/** Client pages cannot export Next.js metadata, so they set document.title
 *  through this hook instead. Server pages use `export const metadata` with
 *  the root layout's title template. Pass null/undefined while data is
 *  loading to fall back to the bare app name. */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · Haive` : 'Haive';
  }, [title]);
}
