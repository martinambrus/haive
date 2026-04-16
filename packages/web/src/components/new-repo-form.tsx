'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api, type ApiError, type Repository } from '@/lib/api-client';
import {
  Button,
  Input,
  Label,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  FormError,
} from '@/components/ui';
import { CredentialModal } from './credential-modal';
import { FilesystemBrowser } from './filesystem-browser';

type Source = 'local_path' | 'git_https' | 'github_oauth' | 'upload';

interface CredentialRow {
  id: string;
  label: string;
  host: string;
}

type OauthPhase = 'idle' | 'awaiting_user' | 'polling' | 'error';

interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

type PollResponse =
  | { status: 'pending'; error: string }
  | { status: 'ok'; credential: { id: string; label: string; host: string } };

const SOURCE_OPTIONS: { value: Source; label: string }[] = [
  { value: 'local_path', label: 'Local directory' },
  { value: 'git_https', label: 'Git (HTTPS)' },
  { value: 'github_oauth', label: 'GitHub (OAuth device flow)' },
  { value: 'upload', label: 'Upload archive (zip/tar)' },
];

export function NewRepoForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [source, setSource] = useState<Source>('local_path');
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [credentialsId, setCredentialsId] = useState('');
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [oauthPhase, setOauthPhase] = useState<OauthPhase>('idle');
  const [oauthUserCode, setOauthUserCode] = useState('');
  const [oauthVerificationUri, setOauthVerificationUri] = useState('');
  const [oauthLabel, setOauthLabel] = useState<string | null>(null);
  const [credModalOpen, setCredModalOpen] = useState(false);
  const oauthCancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    api
      .get<{ credentials: CredentialRow[] }>('/repo-credentials')
      .then((data) => setCredentials(data.credentials))
      .catch(() => setCredentials([]));
  }, []);

  useEffect(() => {
    return () => {
      oauthCancelRef.current?.();
    };
  }, []);

  function resetOauthState() {
    oauthCancelRef.current?.();
    oauthCancelRef.current = null;
    setOauthPhase('idle');
    setOauthUserCode('');
    setOauthVerificationUri('');
    setOauthLabel(null);
  }

  async function startGithubOauth() {
    resetOauthState();
    setError(null);
    try {
      const start = await api.post<DeviceCodeStart>('/github-oauth/device-code', {});
      setOauthUserCode(start.userCode);
      setOauthVerificationUri(start.verificationUri);
      setOauthPhase('awaiting_user');

      let cancelled = false;
      oauthCancelRef.current = () => {
        cancelled = true;
      };
      const intervalMs = Math.max(start.interval, 5) * 1000;
      const deadline = Date.now() + start.expiresIn * 1000;

      setOauthPhase('polling');
      const tick = async () => {
        while (!cancelled && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, intervalMs));
          if (cancelled) return;
          try {
            const res = await api.post<PollResponse>('/github-oauth/poll', {
              deviceCode: start.deviceCode,
            });
            if (res.status === 'ok') {
              setCredentials((prev) => [res.credential, ...prev]);
              setCredentialsId(res.credential.id);
              setOauthLabel(res.credential.label);
              setOauthPhase('idle');
              setOauthUserCode('');
              setOauthVerificationUri('');
              oauthCancelRef.current = null;
              return;
            }
          } catch (err) {
            setError((err as ApiError).message ?? 'GitHub OAuth failed');
            setOauthPhase('error');
            oauthCancelRef.current = null;
            return;
          }
        }
        if (!cancelled) {
          setError('Device code expired. Start over.');
          setOauthPhase('error');
          oauthCancelRef.current = null;
        }
      };
      void tick();
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to start GitHub OAuth');
      setOauthPhase('error');
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (source === 'upload') {
        if (!uploadFile) throw new Error('Pick an archive file (.zip, .tar, .tar.gz)');
        const formData = new FormData();
        if (name.trim()) formData.append('name', name.trim());
        if (branch.trim()) formData.append('branch', branch.trim());
        formData.append('archive', uploadFile);
        const res = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'}/repos/upload`,
          {
            method: 'POST',
            credentials: 'include',
            body: formData,
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Upload failed (HTTP ${res.status})`);
        }
      } else {
        const body: Record<string, unknown> = { source };
        if (name.trim()) body.name = name.trim();
        if (source === 'local_path') {
          if (!localPath) throw new Error('Pick a local directory containing a .git folder');
          body.localPath = localPath;
        } else {
          if (!remoteUrl) throw new Error('Repository URL is required');
          if (source === 'github_oauth' && !credentialsId) {
            throw new Error('Complete GitHub sign-in before creating the repository');
          }
          body.remoteUrl = remoteUrl;
          if (credentialsId) body.credentialsId = credentialsId;
        }
        if (branch.trim()) body.branch = branch.trim();
        await api.post<{ repository: Repository }>('/repos', body);
      }
      router.push('/repos');
      router.refresh();
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message ?? 'Failed to create repository');
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Add a repository</CardTitle>
        <CardDescription>
          Pick a local checkout or clone from a remote. Both run in the background.
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repo-name">Display name (optional)</Label>
          <Input
            id="repo-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={255}
            placeholder="my-project"
          />
          <p className="text-xs text-neutral-500">
            Leave blank to derive from the repository URL or folder name.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repo-source">Source</Label>
          <select
            id="repo-source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value as Source);
              setLocalPath(null);
              setRemoteUrl('');
              resetOauthState();
              setCredentialsId('');
            }}
            className="h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
          >
            {SOURCE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {source === 'local_path' && (
          <div className="flex flex-col gap-1.5">
            <Label>Local directory</Label>
            {localPath && (
              <div className="rounded-md border border-indigo-900 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-200">
                Selected: <span className="font-mono">{localPath}</span>
              </div>
            )}
            <FilesystemBrowser onSelect={(p) => setLocalPath(p)} selectedPath={localPath} />
          </div>
        )}

        {(source === 'git_https' || source === 'github_oauth') && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="repo-url">Repository URL</Label>
              <Input
                id="repo-url"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                required
                placeholder="https://github.com/owner/repo.git"
              />
              <p className="text-xs text-neutral-500">
                Any HTTPS git URL — GitHub, GitLab, Bitbucket, self-hosted, etc.
              </p>
            </div>
            {source === 'github_oauth' ? (
              <div className="flex flex-col gap-1.5">
                <Label>GitHub sign-in</Label>
                {oauthLabel ? (
                  <div className="rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
                    Signed in — credential stored as <span className="font-mono">{oauthLabel}</span>
                  </div>
                ) : (
                  <>
                    {oauthPhase === 'idle' || oauthPhase === 'error' ? (
                      <Button type="button" onClick={() => void startGithubOauth()}>
                        Sign in with GitHub
                      </Button>
                    ) : null}
                    {(oauthPhase === 'awaiting_user' || oauthPhase === 'polling') && (
                      <div className="flex flex-col gap-2 rounded-md border border-indigo-900 bg-indigo-950/30 px-3 py-3 text-xs text-indigo-200">
                        <div>
                          Visit{' '}
                          <a
                            href={oauthVerificationUri}
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                          >
                            {oauthVerificationUri}
                          </a>{' '}
                          and enter this code:
                        </div>
                        <div className="font-mono text-lg tracking-widest text-indigo-100">
                          {oauthUserCode}
                        </div>
                        <div className="text-neutral-400">Waiting for GitHub to confirm...</div>
                        <button
                          type="button"
                          className="self-start text-neutral-400 underline"
                          onClick={() => resetOauthState()}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="repo-credentials">Credentials (optional)</Label>
                <div className="flex gap-2">
                  <select
                    id="repo-credentials"
                    value={credentialsId}
                    onChange={(e) => setCredentialsId(e.target.value)}
                    className="h-10 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
                  >
                    <option value="">(none — public repository)</option>
                    {credentials.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label} — {c.host}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setCredModalOpen(true)}
                  >
                    Add
                  </Button>
                </div>
                {credentials.length === 0 && (
                  <p className="text-xs text-neutral-500">
                    No credentials on file. Click Add to create one for private repositories.
                  </p>
                )}
              </div>
            )}
          </>
        )}

        {source === 'upload' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="repo-archive">Archive</Label>
            <input
              id="repo-archive"
              type="file"
              accept=".zip,.tar,.tar.gz,.tgz,application/zip,application/x-tar,application/gzip"
              onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm text-neutral-300 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-600 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-indigo-500"
            />
            <p className="text-xs text-neutral-500">
              Supports .zip, .tar, and .tar.gz. The archive is extracted server-side into the repo
              workspace. Max 100 MB.
            </p>
            {uploadFile && (
              <div className="rounded-md border border-indigo-900 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-200">
                Selected: <span className="font-mono">{uploadFile.name}</span> (
                {(uploadFile.size / 1024 / 1024).toFixed(1)} MB)
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repo-branch">Branch (optional)</Label>
          <Input
            id="repo-branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="main"
          />
        </div>

        <FormError message={error} />

        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Creating...' : 'Create repository'}
          </Button>
          <Button type="button" variant="secondary" onClick={() => router.push('/repos')}>
            Cancel
          </Button>
        </div>
      </form>
      <CredentialModal
        open={credModalOpen}
        onClose={() => setCredModalOpen(false)}
        onCreated={(cred) => {
          setCredentials((prev) => [cred, ...prev]);
          setCredentialsId(cred.id);
        }}
      />
    </Card>
  );
}
