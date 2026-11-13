'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api-client';
import { Button, Card, CardHeader, CardTitle, Input, Label } from '@/components/ui';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/dialog';
import { MarkdownView } from '@/components/markdown/markdown-view';

type MailSettings = {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  user: string;
  from: string;
  fromName: string;
};
type MailResponse = MailSettings & { passwordSet: boolean };
type TestResponse = { ok: true } | { ok: false; code: string; error: string };

export function AdminMailCard() {
  const [settings, setSettings] = useState<MailSettings | null>(null);
  const [port, setPort] = useState('587');
  const [passwordSet, setPasswordSet] = useState(false);
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [to, setTo] = useState('');
  const [testPending, setTestPending] = useState(false);
  const [testNotice, setTestNotice] = useState<string | null>(null);

  function apply({ passwordSet: present, ...values }: MailResponse) {
    setSettings(values);
    setPort(String(values.smtpPort));
    setPasswordSet(present);
  }
  useEffect(() => {
    let cancelled = false;
    api
      .get<MailResponse>('/admin/mail')
      .then((response) => {
        if (!cancelled) apply(response);
      })
      .catch((error: Error) => {
        if (!cancelled) setNotice(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!settings || pending) return;
    setPending(true);
    setNotice(null);
    try {
      const response = await api.put<MailResponse>('/admin/mail', {
        ...settings,
        smtpPort: Number(port),
        ...(password.trim() ? { password } : {}),
      });
      apply(response);
      setPassword('');
      setNotice('Mail settings saved.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save mail settings.');
    } finally {
      setPending(false);
    }
  }
  async function test(event: FormEvent) {
    event.preventDefault();
    if (testPending) return;
    setTestPending(true);
    setTestNotice(null);
    try {
      const result = await api.post<TestResponse>('/admin/mail/test', { to });
      setTestNotice(result.ok ? 'Test message sent.' : result.error);
    } catch (error) {
      setTestNotice(error instanceof Error ? error.message : 'Could not send test mail.');
    } finally {
      setTestPending(false);
    }
  }
  const textFields = [
    ['smtpHost', 'SMTP host'],
    ['user', 'SMTP user'],
    ['from', 'From address'],
    ['fromName', 'From name'],
  ] as const;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mail</CardTitle>
        <MarkdownView body="Configure the SMTP relay for outgoing Haive mail. Save changes before sending a test. Internal relays are allowed. Use port 465 with TLS, or STARTTLS when the relay offers it on other ports." />
      </CardHeader>
      {notice && (
        <div role="status">
          <MarkdownView body={notice} />
        </div>
      )}
      {settings && (
        <form onSubmit={save} className="space-y-4">
          <Label className="flex items-center gap-2">
            <Input
              type="checkbox"
              aria-label="Enable mail"
              className="h-4 w-4"
              checked={settings.enabled}
              onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
            />
            Enable mail
          </Label>
          {textFields.map(([key, label]) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`mail-${key}`}>{label}</Label>
              <Input
                id={`mail-${key}`}
                aria-label={label}
                value={settings[key]}
                type={key === 'from' ? 'email' : 'text'}
                required={settings.enabled && (key === 'smtpHost' || key === 'from')}
                onChange={(event) => setSettings({ ...settings, [key]: event.target.value })}
              />
            </div>
          ))}
          <div className="space-y-1">
            <Label htmlFor="mail-port">SMTP port</Label>
            <Input
              id="mail-port"
              aria-label="SMTP port"
              type="number"
              min={1}
              max={65535}
              required
              value={port}
              onChange={(event) => setPort(event.target.value)}
            />
          </div>
          <Label className="flex items-center gap-2">
            <Input
              type="checkbox"
              aria-label="TLS on connect"
              className="h-4 w-4"
              checked={settings.secure}
              onChange={(event) => setSettings({ ...settings, secure: event.target.checked })}
            />
            TLS on connect (port 465)
          </Label>
          <div className="space-y-1">
            <Label htmlFor="mail-password">SMTP password</Label>
            <Input
              id="mail-password"
              aria-label="SMTP password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <MarkdownView
              body={
                passwordSet
                  ? 'A password is stored. Leave blank to keep it.'
                  : 'No password is stored. Leave blank for a relay without authentication.'
              }
            />
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => {
                setTestNotice(null);
                setTestOpen(true);
              }}
            >
              Send test
            </Button>
          </div>
        </form>
      )}
      <Dialog open={testOpen} onOpenChange={setTestOpen} aria-label="Send test mail">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send test mail</DialogTitle>
          </DialogHeader>
          <MarkdownView body="Send a test message using the saved mail settings." />
          <form onSubmit={test} className="space-y-4">
            <Label htmlFor="mail-test-to">Test recipient</Label>
            <Input
              id="mail-test-to"
              aria-label="Test recipient"
              type="email"
              required
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
            {testNotice && (
              <div role="status">
                <MarkdownView body={testNotice} />
              </div>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="secondary" onClick={() => setTestOpen(false)}>
                Close
              </Button>
              <Button type="submit" disabled={testPending}>
                {testPending ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
