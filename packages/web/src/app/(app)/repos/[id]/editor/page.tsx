'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api, type Repository } from '@/lib/api-client';
import { EditorTab } from '@/components/editor/editor-tab';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { usePageTitle } from '@/lib/use-page-title';

export default function RepoEditorPage() {
  const { id: repositoryId } = useParams<{ id: string }>();
  const [repo, setRepo] = useState<Repository | null>(null);
  const [error, setError] = useState<string | null>(null);
  usePageTitle(repo ? `Editor — ${repo.name}` : 'Editor');

  useEffect(() => {
    let cancelled = false;
    setRepo(null);
    setError(null);
    void api
      .get<{ repository: Repository }>(`/repos/${repositoryId}`)
      .then(({ repository }) => {
        if (!cancelled) setRepo(repository);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message || 'Failed to load repository');
      });
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-3">
      <div>
        <Link href="/repos" className="text-xs text-indigo-400 hover:underline">
          ← Back to repositories
        </Link>
        <h1 className="mt-1 text-2xl font-semibold text-neutral-100 [overflow-wrap:anywhere]">
          Editor{repo ? ` — ${repo.name}` : ''}
        </h1>
      </div>
      <div className="min-h-0 flex-1">
        {error ? (
          <MarkdownView body={error} className="text-sm text-rose-300" />
        ) : repo ? (
          <EditorTab key={repositoryId} repositoryId={repositoryId} className="h-full w-full" />
        ) : (
          <p className="text-sm text-neutral-400">Loading repository…</p>
        )}
      </div>
    </div>
  );
}
