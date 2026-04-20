'use client';

import { useEffect, useState } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  Input,
  Label,
  FormError,
} from '@/components/ui';

interface GitIdentity {
  gitName: string | null;
  gitEmail: string | null;
}

export default function GitIdentityPage() {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gitName, setGitName] = useState('');
  const [gitEmail, setGitEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<GitIdentity>('/user-settings/git-identity')
      .then((data) => {
        setGitName(data.gitName ?? '');
        setGitEmail(data.gitEmail ?? '');
        setLoaded(true);
      })
      .catch((err) => setLoadError((err as ApiError).message ?? 'Failed to load git identity'));
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      await api.put<{ ok: boolean }>('/user-settings/git-identity', { gitName, gitEmail });
      setSuccess('Git identity saved.');
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to save git identity');
    } finally {
      setSaving(false);
    }
  }

  if (!loaded && !loadError) {
    return <p className="text-sm text-neutral-400">Loading git identity...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-neutral-50">Git Identity</h2>
        <p className="text-sm text-neutral-400">
          Name and email used when the CLI agent commits on your behalf inside a task sandbox.
        </p>
      </div>

      <FormError message={loadError} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Commit author</CardTitle>
          <CardDescription>
            Injected into every CLI-agent sandbox as{' '}
            <code className="font-mono text-neutral-300">GIT_AUTHOR_NAME</code> /{' '}
            <code className="font-mono text-neutral-300">GIT_AUTHOR_EMAIL</code> (plus matching
            <code className="font-mono text-neutral-300"> GIT_COMMITTER_*</code>) so commits
            attribute to you. Leave both empty to fall back to the sandbox default.
          </CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="git-name">Name</Label>
            <Input
              id="git-name"
              value={gitName}
              onChange={(e) => setGitName(e.target.value)}
              placeholder="Jane Doe"
              maxLength={100}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="git-email">Email</Label>
            <Input
              id="git-email"
              type="email"
              value={gitEmail}
              onChange={(e) => setGitEmail(e.target.value)}
              placeholder="jane@example.com"
              maxLength={255}
            />
          </div>
          <FormError message={error} />
          {success && (
            <div className="rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-200">
              {success}
            </div>
          )}
          <div>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
