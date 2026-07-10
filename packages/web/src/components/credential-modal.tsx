'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import { Button, FormError, Input, Label } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';

interface CredentialRow {
  id: string;
  label: string;
  host: string;
  gitName: string | null;
  gitEmail: string | null;
}

const HOST_PRESETS = ['github.com', 'gitlab.com', 'bitbucket.org'];

interface CredentialModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (credential: CredentialRow) => void;
  // When set, the modal edits this credential instead of creating a new one.
  credential?: CredentialRow | null;
  onUpdated?: (credential: CredentialRow) => void;
}

export function CredentialModal({
  open,
  onClose,
  onCreated,
  credential = null,
  onUpdated,
}: CredentialModalProps) {
  const isEdit = credential !== null;
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [gitName, setGitName] = useState('');
  const [gitEmail, setGitEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Re-initialise each time the modal opens: pre-fill label/host and the commit
  // identity when editing (username/secret stay blank — the encrypted values are
  // never sent to the client, so blank means "keep current"); all blank when adding.
  useEffect(() => {
    if (!open) return;
    setLabel(credential?.label ?? '');
    setHost(credential?.host ?? '');
    setUsername('');
    setSecret('');
    setGitName(credential?.gitName ?? '');
    setGitEmail(credential?.gitEmail ?? '');
    setError(null);
    setPending(false);
  }, [open, credential]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // The API enforces this too; checking here saves a round-trip.
    const identity = { gitName: gitName.trim(), gitEmail: gitEmail.trim() };
    if (Boolean(identity.gitName) !== Boolean(identity.gitEmail)) {
      setError('Set both the commit name and email, or leave both empty.');
      return;
    }

    setPending(true);
    try {
      if (isEdit && credential) {
        const res = await api.put<{ credential: CredentialRow }>(
          `/repo-credentials/${credential.id}`,
          {
            label: label.trim(),
            host: host.trim(),
            username: username.trim(),
            secret,
            ...identity,
          },
        );
        onUpdated?.(res.credential);
      } else {
        const res = await api.post<{ credential: CredentialRow }>('/repo-credentials', {
          label: label.trim(),
          host: host.trim(),
          username: username.trim(),
          secret,
          ...identity,
        });
        onCreated(res.credential);
      }
      onClose();
    } catch (err) {
      setError((err as ApiError).message ?? `Failed to ${isEdit ? 'update' : 'create'} credential`);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit git credential' : 'Add git credential'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cred-label">Label</Label>
            <Input
              id="cred-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              required
              maxLength={255}
              placeholder="e.g. Work GitHub PAT"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cred-host">Host</Label>
            <div className="flex gap-2">
              <Input
                id="cred-host"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                required
                maxLength={255}
                placeholder="github.com"
              />
            </div>
            <div className="flex gap-1.5">
              {HOST_PRESETS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHost(h)}
                  className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                    host === h
                      ? 'border-indigo-600 bg-indigo-950/50 text-indigo-200'
                      : 'border-neutral-700 text-neutral-400 hover:border-neutral-600 hover:text-neutral-300'
                  }`}
                >
                  {h}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cred-username">Username</Label>
            <Input
              id="cred-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required={!isEdit}
              maxLength={255}
              placeholder={
                isEdit ? 'leave blank to keep current username' : 'git username or token name'
              }
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cred-secret">Secret / PAT</Label>
            <Input
              id="cred-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required={!isEdit}
              placeholder={
                isEdit ? 'leave blank to keep current secret' : 'personal access token or password'
              }
            />
          </div>

          <div className="flex flex-col gap-1.5 border-t border-neutral-800 pt-4">
            <Label htmlFor="cred-git-name">Commit identity (optional)</Label>
            <p className="text-xs text-neutral-400">
              Used to author commits in every repository bound to this credential. Leave both empty
              to use your global git identity.
            </p>
            <Input
              id="cred-git-name"
              value={gitName}
              onChange={(e) => setGitName(e.target.value)}
              maxLength={100}
              placeholder="Jane Doe"
            />
            <Input
              id="cred-git-email"
              type="email"
              value={gitEmail}
              onChange={(e) => setGitEmail(e.target.value)}
              maxLength={255}
              placeholder="jane@work.example.com"
            />
          </div>

          <FormError message={error} />

          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving...' : isEdit ? 'Save changes' : 'Save credential'}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
