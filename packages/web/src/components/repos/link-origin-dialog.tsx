'use client';

import { useEffect, useState } from 'react';
import { api, linkRepositoryRemote } from '@/lib/api-client';
import { Button, FormError, Input, Label } from '@/components/ui';
import { Dialog } from '@/components/dialog';
import {
  GithubOauthConnect,
  findGithubOauthCredential,
  type RepoCredentialSummary as CredentialRow,
} from './github-oauth-connect';

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
  const [oauthLabel, setOauthLabel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .get<{ credentials: CredentialRow[] }>('/repo-credentials')
      .then((r) => {
        if (cancelled) return;
        setCredentials(r.credentials);
        // A flow run earlier (here or on the create-repository form) already left
        // a credential; preselect it rather than making the user find it, and say
        // so instead of offering a sign-in that would mint a second row.
        const existing = findGithubOauthCredential(r.credentials);
        if (existing) {
          setOauthLabel(existing.label);
          setCredentialsId((current) => current || existing.id);
        }
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
    // The shared Dialog rather than a hand-rolled overlay, so Escape closes this
    // the way it closes every other modal — it owns the key handling, the portal
    // and the backdrop.
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <div className="flex w-full flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-950 p-5">
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
            placeholder="https://github.com/you/your-repo.git  or  git@github.com:you/your-repo.git"
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
            A private <strong>https</strong> remote needs one, or the first push will fail. An ssh
            or <code>git@host:path</code> remote authenticates with a key outside Haive, so leave
            this as None.
          </p>
          {/* A blank repository has no credential yet, and the device flow used to
              live only on the create-repository form — so the dropdown above was
              empty with nowhere to go. Signing in here mints the row and selects
              it, which is the whole reason this dialog could not link a private
              GitHub remote. */}
          <GithubOauthConnect
            connectedLabel={oauthLabel}
            onError={setError}
            onConnected={(cred) => {
              setCredentials((prev) => [cred, ...(prev ?? [])]);
              setCredentialsId(cred.id);
              setOauthLabel(cred.label);
            }}
          />
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
    </Dialog>
  );
}
