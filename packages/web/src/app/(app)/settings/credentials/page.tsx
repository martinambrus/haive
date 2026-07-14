'use client';

import { useEffect, useState } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import { Button, Card, CardHeader, CardTitle, CardDescription, FormError } from '@/components/ui';
import { CredentialModal } from '@/components/credential-modal';
import { usePageTitle } from '@/lib/use-page-title';

interface CredentialRow {
  id: string;
  label: string;
  host: string;
  provider?: string | null;
  apiBaseUrl?: string | null;
  gitName: string | null;
  gitEmail: string | null;
  createdAt: string;
}

export default function CredentialsPage() {
  usePageTitle('Git Credentials');
  const [credentials, setCredentials] = useState<CredentialRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [editing, setEditing] = useState<CredentialRow | null>(null);

  useEffect(() => {
    api
      .get<{ credentials: CredentialRow[] }>('/repo-credentials')
      .then((data) => setCredentials(data.credentials))
      .catch((err) => setError((err as ApiError).message ?? 'Failed to load credentials'));
  }, []);

  async function handleDelete(id: string) {
    setDeleting(id);
    try {
      await api.delete(`/repo-credentials/${id}`);
      setCredentials((prev) => prev?.filter((c) => c.id !== id) ?? null);
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to delete credential');
    } finally {
      setDeleting(null);
    }
  }

  if (credentials === null && !error) {
    return <p className="text-sm text-neutral-400">Loading credentials...</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-neutral-50">Git Credentials</h2>
          <p className="text-sm text-neutral-400">
            HTTPS credentials for cloning private repositories.
          </p>
        </div>
        <Button onClick={() => setModalOpen(true)}>Add credential</Button>
      </div>

      <FormError message={error} />

      {credentials && credentials.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">No credentials</CardTitle>
            <CardDescription>
              Add a credential to clone private repositories over HTTPS.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {credentials && credentials.length > 0 && (
        <div className="flex flex-col gap-2">
          {credentials.map((cred) => (
            <div
              key={cred.id}
              className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900/50 px-4 py-3"
            >
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-neutral-100">{cred.label}</span>
                <span className="text-xs text-neutral-400">{cred.host}</span>
                <span className="text-xs text-neutral-500">
                  {cred.gitName && cred.gitEmail
                    ? `commits as ${cred.gitName} <${cred.gitEmail}>`
                    : 'commits with your global git identity'}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-neutral-500">
                  {new Date(cred.createdAt).toLocaleDateString()}
                </span>
                <Button variant="secondary" size="sm" onClick={() => setEditing(cred)}>
                  Edit
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={deleting === cred.id}
                  onClick={() => handleDelete(cred.id)}
                >
                  {deleting === cred.id ? 'Deleting...' : 'Delete'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <CredentialModal
        open={modalOpen || editing !== null}
        credential={editing}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onCreated={(cred) => {
          setCredentials((prev) => [
            { ...cred, createdAt: new Date().toISOString() },
            ...(prev ?? []),
          ]);
        }}
        onUpdated={(cred) => {
          setCredentials(
            (prev) =>
              prev?.map((c) =>
                c.id === cred.id
                  ? {
                      ...c,
                      label: cred.label,
                      host: cred.host,
                      provider: cred.provider,
                      apiBaseUrl: cred.apiBaseUrl,
                      gitName: cred.gitName,
                      gitEmail: cred.gitEmail,
                    }
                  : c,
              ) ?? null,
          );
        }}
      />
    </div>
  );
}
