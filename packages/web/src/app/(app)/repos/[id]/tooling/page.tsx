'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api-client';
import { Button, Card, FormError, Label } from '@/components/ui';
import { usePageTitle } from '@/lib/use-page-title';

interface LspOption {
  value: string;
  label: string;
  pinnable: boolean;
  versions: string[];
}

interface ToolingConfig {
  repositoryId: string;
  rtkEnabled: boolean;
  rtkVersion: string | null;
  rtkVersions: string[];
  chromeDevtoolsMcpVersion: string | null;
  chromeVersions: string[];
  browserTesting: boolean;
  lspServers: string[];
  lspServerVersions: Record<string, string | null>;
  lspOptions: LspOption[];
}

function VersionSelect({
  value,
  onChange,
  versions,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  versions: string[];
  disabled?: boolean;
}) {
  const latestLabel = versions[0] ? `Latest (${versions[0]})` : 'Latest';
  return (
    <select
      className="h-9 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-sm text-neutral-100 disabled:opacity-50"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{latestLabel}</option>
      {versions.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </select>
  );
}

export default function RepoToolingPage() {
  usePageTitle('Repository tooling');
  const params = useParams();
  const repositoryId = String(params.id);

  const [config, setConfig] = useState<ToolingConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [rtkEnabled, setRtkEnabled] = useState(false);
  const [rtkVersion, setRtkVersion] = useState('');
  const [chromeVersion, setChromeVersion] = useState('');
  const [lspChecked, setLspChecked] = useState<Set<string>>(new Set());
  const [lspVersions, setLspVersions] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api.get<ToolingConfig>(`/repositories/${repositoryId}/tooling-config`);
        if (cancelled) return;
        setConfig(cfg);
        setRtkEnabled(cfg.rtkEnabled);
        setRtkVersion(cfg.rtkVersion ?? '');
        setChromeVersion(cfg.chromeDevtoolsMcpVersion ?? '');
        setLspChecked(new Set(cfg.lspServers));
        const lv: Record<string, string> = {};
        for (const [k, v] of Object.entries(cfg.lspServerVersions)) if (v) lv[k] = v;
        setLspVersions(lv);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to load tooling config');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [repositoryId]);

  function markDirty() {
    setSaved(false);
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const lspServerVersions: Record<string, string> = {};
      for (const opt of config?.lspOptions ?? []) {
        if (lspChecked.has(opt.value) && opt.pinnable && lspVersions[opt.value]) {
          lspServerVersions[opt.value] = lspVersions[opt.value]!;
        }
      }
      await api.patch(`/repositories/${repositoryId}/tooling`, {
        rtkEnabled,
        rtkVersion: rtkVersion || null,
        chromeDevtoolsMcpVersion: chromeVersion || null,
        lspServers: [...lspChecked],
        lspServerVersions,
      });
      setSaved(true);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to save tooling');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link href="/repos" className="text-xs text-indigo-300 hover:underline">
          ← Back to repositories
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-neutral-50">Repository tooling</h1>
        <p className="text-sm text-neutral-400">
          Enable or disable RTK and LSP servers and pin their versions for this repository. Changes
          take effect when the repository&apos;s next task rebuilds its environment image.
        </p>
      </div>

      <FormError message={error} />

      {!config ? (
        <p className="text-sm text-neutral-500">Loading...</p>
      ) : (
        <>
          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">RTK proxy</h2>
            <div className="mt-3 flex items-center gap-2">
              <input
                id="rtkEnabled"
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
                checked={rtkEnabled}
                onChange={(e) => {
                  setRtkEnabled(e.target.checked);
                  markDirty();
                }}
              />
              <Label htmlFor="rtkEnabled">Enable RTK token-saving proxy</Label>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Label>Version</Label>
              <VersionSelect
                value={rtkVersion}
                versions={config.rtkVersions}
                disabled={!rtkEnabled}
                onChange={(v) => {
                  setRtkVersion(v);
                  markDirty();
                }}
              />
            </div>
            <p className="mt-2 text-xs text-neutral-500">
              Disabling RTK flips the repo flag; its{' '}
              <code className="font-mono">.claude/settings.json</code> hook is removed by the next
              workflow upgrade (the upgrade banner will surface it).
            </p>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">LSP servers</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Servers baked into the environment image. rust-analyzer and jdtls cannot be version
              pinned (they track the toolchain / latest snapshot).
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {config.lspOptions.map((opt) => {
                const checked = lspChecked.has(opt.value);
                return (
                  <div key={opt.value} className="flex flex-wrap items-center gap-2">
                    <input
                      id={`lsp-${opt.value}`}
                      type="checkbox"
                      className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
                      checked={checked}
                      onChange={(e) => {
                        setLspChecked((prev) => {
                          const n = new Set(prev);
                          if (e.target.checked) n.add(opt.value);
                          else n.delete(opt.value);
                          return n;
                        });
                        markDirty();
                      }}
                    />
                    <Label htmlFor={`lsp-${opt.value}`}>{opt.label}</Label>
                    {opt.pinnable ? (
                      <VersionSelect
                        value={lspVersions[opt.value] ?? ''}
                        versions={opt.versions}
                        disabled={!checked}
                        onChange={(v) => {
                          setLspVersions((prev) => ({ ...prev, [opt.value]: v }));
                          markDirty();
                        }}
                      />
                    ) : (
                      <span className="text-xs text-neutral-600">(not pinnable)</span>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">Chrome DevTools MCP</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Browser testing is enabled per task (currently{' '}
              {config.browserTesting ? 'active' : 'inactive'} for this repo&apos;s environment). Pin
              the version the agent launches here.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <Label>Version</Label>
              <VersionSelect
                value={chromeVersion}
                versions={config.chromeVersions}
                onChange={(v) => {
                  setChromeVersion(v);
                  markDirty();
                }}
              />
            </div>
          </Card>

          <div className="flex items-center gap-3">
            <Button onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : 'Save tooling'}
            </Button>
            {saved && (
              <span className="text-sm text-emerald-400">Saved. Rebuilds on next task.</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
