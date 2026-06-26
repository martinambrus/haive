'use client';

import { useEffect, useState } from 'react';
import { api, type ApiError } from '@/lib/api-client';
import { usePageTitle } from '@/lib/use-page-title';
import { Button, Card, CardDescription, CardHeader, CardTitle, FormError } from '@/components/ui';

export default function IdeSettingsPage() {
  usePageTitle('Editor');
  const [settingsJson, setSettingsJson] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ settingsJson: string }>('/user-settings/ide')
      .then((r) => {
        setSettingsJson(r.settingsJson);
        setLoaded(true);
      })
      .catch((err) => setLoadError((err as ApiError).message ?? 'Failed to load editor settings'));
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    // Validate client-side for a friendly message before the round-trip.
    try {
      JSON.parse(settingsJson);
    } catch {
      setError('Not valid JSON.');
      setBusy(false);
      return;
    }
    try {
      await api.put('/user-settings/ide', { settingsJson });
      setSaved(true);
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold text-neutral-50">Editor</h2>
        <p className="text-sm text-neutral-400">
          Global VS Code settings applied to every task&apos;s in-task editor. Per-project overrides
          live in each repo&apos;s <code className="text-neutral-300">.vscode/settings.json</code>,
          which the editor layers on top. Extensions you install in the editor persist across all
          your tasks automatically.
        </p>
      </div>
      <FormError message={loadError} />
      {loaded && (
        <Card>
          <CardHeader>
            <CardTitle>settings.json</CardTitle>
            <CardDescription>
              Your personal VS Code <code>settings.json</code> (formatter, tab size, theme, …),
              seeded into every editor session you open. The extension marketplace is Open VSX.
            </CardDescription>
          </CardHeader>
          <div className="flex flex-col gap-3">
            <textarea
              value={settingsJson}
              onChange={(e) => {
                setSettingsJson(e.target.value);
                setSaved(false);
              }}
              spellCheck={false}
              rows={16}
              className="w-full rounded border border-neutral-800 bg-neutral-950 p-3 font-mono text-sm text-neutral-100"
            />
            <div className="flex items-center gap-3">
              <Button size="sm" disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
              {saved && (
                <span className="text-xs text-emerald-400">
                  Saved — applies to your next editor launch.
                </span>
              )}
            </div>
            <FormError message={error} />
          </div>
        </Card>
      )}
    </div>
  );
}
