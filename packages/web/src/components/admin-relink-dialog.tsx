'use client';

import { useState } from 'react';
import { api, type AdminUser, type AdminRelinkResponse } from '@/lib/api-client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { Button, Input, Label } from '@/components/ui';

export function AdminRelinkDialog({
  user,
  onClose,
  onRelinked,
}: {
  user: AdminUser;
  onClose: () => void;
  onRelinked: () => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdminRelinkResponse | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<AdminRelinkResponse>('/admin/users/' + user.id + '/relink', {
        email: email.trim(),
      });
      setResult(response);
      await onRelinked();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Relink failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      aria-label="Relink account"
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Relink account</DialogTitle>
        </DialogHeader>
        {result ? (
          <div className="flex flex-col gap-3">
            {result.delivery === 'mailed' ? (
              <MarkdownView body="Reset link emailed" />
            ) : (
              <>
                <MarkdownView
                  body={
                    result.delivery === 'failed'
                      ? 'Mail delivery failed. Copy this reset link and pass it to the account holder securely. It is shown once and expires in 30 minutes.'
                      : 'Copy this reset link and pass it to the account holder securely. It is shown once and expires in 30 minutes.'
                  }
                />
                <code className="block break-all text-xs">{result.link}</code>
                <Button
                  variant="secondary"
                  onClick={() => {
                    void navigator.clipboard?.writeText(result.link).then(
                      () => setCopied(true),
                      () => setCopied(false),
                    );
                  }}
                >
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
              </>
            )}
            <Button onClick={onClose}>Close</Button>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
            <MarkdownView body="Enter the account holder's email. Relinking replaces the unreadable address, ends their sessions, and sends a link to choose a new password. When mail is disabled or delivery fails, you receive the link to pass on." />
            <div className="text-sm text-neutral-400">{user.name ?? user.gitName ?? user.id}</div>
            <Label htmlFor="relink-email">Email</Label>
            <Input
              id="relink-email"
              type="email"
              required
              autoFocus
              value={email}
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
            />
            {error && (
              <div
                role="alert"
                className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2"
              >
                <MarkdownView body={error} />
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !email.trim()}>
                {busy ? 'Relinking…' : 'Relink account'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
