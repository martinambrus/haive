'use client';

import { useEffect, useState } from 'react';
import { api, linkRepositoryRemote } from '@/lib/api-client';
import { Button, FormError, Input, Label } from '@/components/ui';

interface CredentialRow {
  id: string;
  label: string;
  host: string;
}

/**
 * Point a repository with no origin at one.
 *
 * A repository created blank or by upload has a real checkout and no remote, so
 * nothing can leave it — including the committed plan snapshot, which is the
 * only way a plan reaches another Haive install. Before this the only route was
 * to delete the repository and re-add it from a URL, which throws away its plan,
 * its tasks and its knowledge base.
 *
 * Shared by the plan page and the repositories list because the same repository
 * is missing the same thing in both places; two copies of this form would drift
 * on the part that matters, which is what it says about credentials.
 */
export function LinkOriginDialog({
  repositoryId,
  currentUrl,
  onClose,
  onLinked,
}: {
  repositoryId: string;
  /** Set when re-pointing an existing origin rather than adding the first one. */
  currentUrl?: string | null;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [url, setUrl] = useState(currentUrl ?? '');
  const [credentialsId, setCredentialsId] = useState('');
  const [credentials, setCredentials] = useState<CredentialRow[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<{ credentials: CredentialRow[] }>('/repo-credentials')
      .then((r) => {
        if (!cancelled) setCredentials(r.credentials);
      })
      // A credential list that will not load must not block linking a PUBLIC
      // remote, which is the case that needs none.
      .catch(() => {
        if (!cancelled) setCredentials([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(): Promise<void> {
    const trimmed = url.trim();
    if (!trimmed) {
      setError('A remote URL is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await linkRepositoryRemote(repositoryId, {
        remoteUrl: trimmed,
        ...(credentialsId ? { credentialsId } : {}),
      });
      onLinked();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not link the remote');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-lg flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-5">
        <h2 className="text-base font-semibold text-neutral-100">
          {currentUrl ? 'Change the origin remote' : 'Link this repository to an origin'}
        </h2>
        <p className="text-xs text-neutral-500">
          Sets <code>origin</code> on the checkout. Nothing is pushed or pulled now — this only
          gives the repository somewhere to push to, and Save &amp; push does the rest.
        </p>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="origin-url">Remote URL</Label>
          <Input
            id="origin-url"
            type="text"
            autoFocus
            value={url}
            disabled={saving}
            placeholder="https://github.com/you/your-repo.git"
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="origin-cred">Credentials</Label>
          <select
            id="origin-cred"
            value={credentialsId}
            disabled={saving}
            onChange={(e) => setCredentialsId(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100"
          >
            <option value="">None — public remote, or SSH handled outside Haive</option>
            {(credentials ?? []).map((cred) => (
              <option key={cred.id} value={cred.id}>
                {cred.label} ({cred.host})
              </option>
            ))}
          </select>
          <p className="text-[11px] text-neutral-600">
            A private remote needs one, or the first push will fail. Add credentials on the
            repositories page.
          </p>
        </div>

        <FormError message={error} />

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void submit()}>
            {saving ? 'Linking…' : currentUrl ? 'Change remote' : 'Link remote'}
          </Button>
        </div>
      </div>
    </div>
  );
}
