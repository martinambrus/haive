'use client';

import { notFound, useParams } from 'next/navigation';
import { moduleWebPages } from '@/generated/module-pages';
import { api } from '@/lib/api-client';
import { resolveModulePage } from '@/lib/module-pages';

export default function ModulePage() {
  const params = useParams<{ moduleId: string; page?: string[] }>();
  const path = params.page ?? [];
  const Page = resolveModulePage(moduleWebPages, params.moduleId, path);
  if (Page === null) notFound();
  return <Page moduleId={params.moduleId} path={path} api={api} />;
}
