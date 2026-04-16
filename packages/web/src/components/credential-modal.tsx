'use client';

import { useState, type FormEvent } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import { Button, FormError, Input, Label } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';

interface CredentialRow {
  id: string;
  label: string;
  host: string;
}

const HOST_PRESETS = ['github.com', 'gitlab.com', 'bitbucket.org'];

interface CredentialModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (credential: CredentialRow) => void;
}

export function CredentialModal({ open, onClose, onCreated }: CredentialModalProps) {
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setLabel('');
    setHost('');
    setUsername('');
    setSecret('');
    setError(null);
    setPending(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await api.post<{ credential: CredentialRow }>('/repo-credentials', {
        label: label.trim(),
        host: host.trim(),
        username: username.trim(),
        secret,
      });
      onCreated(res.credential);
      reset();
      onClose();
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to create credential');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add git credential</DialogTitle>
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
              required
              maxLength={255}
              placeholder="git username or token name"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cred-secret">Secret / PAT</Label>
            <Input
              id="cred-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required
              placeholder="personal access token or password"
            />
          </div>

          <FormError message={error} />

          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving...' : 'Save credential'}
            </Button>
            <Button type="button" variant="secondary" onClick={handleClose}>
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
