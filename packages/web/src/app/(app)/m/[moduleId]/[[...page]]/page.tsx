'use client';

import { useEffect, useState } from 'react';
import { notFound, useParams } from 'next/navigation';
import { FormError } from '@haive/web-kit/ui';
import { moduleWebPages } from '@/generated/module-pages';
import { DashboardRenderer } from '@/components/dashboard-renderer';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { api, getModules, type ModuleSummary } from '@/lib/api-client';
import { resolveModulePage, resolveModuleRoute } from '@/lib/module-pages';

export default function ModulePage() {
  const params = useParams<{ moduleId: string; page?: string[] }>();
  const path = params.page ?? [];
  const compiled = resolveModulePage(moduleWebPages, params.moduleId, path) !== null;
  const [modules, setModules] = useState<ModuleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (compiled) return;
    let live = true;
    getModules()
      .then((list) => live && setModules(list))
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'Failed to load modules.');
      });
    return () => {
      live = false;
    };
  }, [compiled]);

  const route = resolveModuleRoute(moduleWebPages, modules, params.moduleId, path);
  switch (route.kind) {
    case 'component':
      return <route.Page moduleId={params.moduleId} path={path} api={api} />;
    case 'not-found':
      notFound();
    case 'loading':
      if (error !== null) return <FormError message={error} />;
      return <div className="text-sm text-neutral-500">Loading...</div>;
    case 'dashboard':
      return (
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold text-neutral-50">{route.spec.title}</h1>
            {route.spec.description && <MarkdownView body={route.spec.description} />}
          </div>
          <DashboardRenderer moduleId={params.moduleId} spec={route.spec} api={api} />
        </div>
      );
  }
}
