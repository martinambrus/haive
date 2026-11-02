'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CORE_INTEGRATION_CATEGORY_SPECS } from '@haive/shared/modularity';
import {
  getIntegrationCategories,
  getTaskTypeCatalog,
  listIntegrationProviders,
} from './api-client';
import type { ComposerIntegrationInfo } from './composer-integrations';

const EMPTY: ComposerIntegrationInfo = {
  status: 'loading',
  providers: [],
  categories: CORE_INTEGRATION_CATEGORY_SPECS,
  modules: [],
};

/** Metadata reads never apply a task-type row or reset the editable draft. */
export function useComposerIntegrations(scope: string | null) {
  const generation = useRef(0);
  const cancelRead = useRef<(() => void) | null>(null);
  const [snapshot, setSnapshot] = useState({ scope, info: EMPTY });
  const refresh = useCallback(async () => {
    const own = ++generation.current;
    cancelRead.current?.();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('Provider information timed out'));
      }, 15_000);
    });
    cancelRead.current = () => {
      clearTimeout(timeout);
      controller.abort();
    };
    setSnapshot((previous) => ({
      scope,
      info: { ...(previous.scope === scope ? previous.info : EMPTY), status: 'loading' },
    }));
    try {
      // Category authoring remains available even when the provider read fails or stays pending.
      const categoriesRead = getIntegrationCategories(controller.signal).then((reply) => {
        if (own === generation.current && !controller.signal.aborted) {
          setSnapshot((previous) => ({
            scope,
            info: { ...previous.info, categories: reply.categories },
          }));
        }
        return reply;
      });
      const [providers, categories, catalog] = await Promise.race([
        Promise.allSettled([
          listIntegrationProviders(controller.signal),
          categoriesRead,
          getTaskTypeCatalog(controller.signal),
        ]),
        deadline,
      ]);
      if (own !== generation.current) return;
      if (
        providers.status === 'rejected' ||
        categories.status === 'rejected' ||
        catalog.status === 'rejected'
      ) {
        throw new Error('Provider information unavailable');
      }
      setSnapshot({
        scope,
        info: {
          status: 'current',
          providers: providers.value.providers,
          categories: categories.value.categories,
          modules: catalog.value.modules,
        },
      });
    } catch {
      if (own !== generation.current) return;
      setSnapshot((previous) => ({
        scope,
        info: { ...previous.info, status: 'error', providers: [], modules: [] },
      }));
    } finally {
      clearTimeout(timeout!);
    }
  }, [scope]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
      cancelRead.current?.();
    };
  }, [refresh]);
  return { info: snapshot.scope === scope ? snapshot.info : EMPTY, refresh };
}
