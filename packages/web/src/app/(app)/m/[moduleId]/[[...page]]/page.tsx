'use client';

import { notFound, useParams } from 'next/navigation';
import { FormError } from '@haive/web-kit/ui';
import { moduleWebPages } from '@/generated/module-pages';
import { DashboardRenderer } from '@/components/dashboard-renderer';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { api } from '@/lib/api-client';
import { resolveModuleRoute } from '@/lib/module-pages';
import { useModules } from '@/lib/use-modules';

export default function ModulePage() {
  const params = useParams<{ moduleId: string; page?: string[] }>();
  const path = params.page ?? [];
  const { modules, error } = useModules();

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
