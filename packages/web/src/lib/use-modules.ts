'use client';

import { useEffect, useState } from 'react';
import { getModules, type ModuleSummary } from './api-client';

export function useModules(): { modules: ModuleSummary[] | null; error: string | null } {
  const [modules, setModules] = useState<ModuleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    getModules()
      .then((list) => live && setModules(list))
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'Failed to load modules.');
      });
    return () => {
      live = false;
    };
  }, []);

  return { modules, error };
}
