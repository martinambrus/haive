'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api-client';
import { BundleComposer, type BundleComposerEntry } from '@/components/bundle-composer';

interface RepositorySummary {
  id: string;
  name: string;
}

interface CredentialOption {
  id: string;
  label: string;
}

export default function ManageBundlesPage() {
  const params = useParams<{ id: string }>();
  const repositoryId = params.id;
  const [value, setValue] = useState<BundleComposerEntry[]>([]);
  const [repo, setRepo] = useState<RepositorySummary | null>(null);
  const [credentialOptions, setCredentialOptions] = useState<CredentialOption[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get<{ repository: RepositorySummary }>(`/repos/${repositoryId}`);
        if (!cancelled) setRepo(r.repository);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to load repository');
      }
    })();
    (async () => {
      try {
        const r = await api.get<{ credentials: CredentialOption[] }>('/repo-credentials');
        if (!cancelled) setCredentialOptions(r.credentials ?? []);
      } catch {
        // Optional — git bundles still work without credentials.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href="/repos" className="text-xs text-indigo-400 hover:underline">
          ← Back to repositories
        </Link>
      </div>
      <h1 className="text-2xl font-semibold text-neutral-100">
        Bundles{repo ? ` — ${repo.name}` : ''}
      </h1>
      <p className="text-sm text-neutral-400">
        Add, replace, or remove custom agent and skill bundles. ZIP bundles support direct archive
        replacement; git bundles can be re-synced against their upstream.
      </p>
      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}
      <BundleComposer
        repositoryId={repositoryId}
        initialBundles={[]}
        allowAddZip
        allowAddGit
        credentialOptions={credentialOptions}
        value={value}
        onChange={setValue}
      />
    </div>
  );
}
