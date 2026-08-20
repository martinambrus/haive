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
  secretMaskEnabled: boolean;
  secretMaskAllow: string[];
  secretMaskDenyExtend: string[];
  appAuth: {
    enabled: boolean;
    loginUrl: string;
    usernameSelector: string;
    passwordSelector: string;
    submitSelector: string;
    successCondition: { type: string; value: string };
  } | null;
  appAuthCredentialsSet: boolean;
  prWorkflowEnabled: boolean;
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
  const [secretMaskEnabled, setSecretMaskEnabled] = useState(true);
  const [secretMaskAllow, setSecretMaskAllow] = useState('');
  const [secretMaskDenyExtend, setSecretMaskDenyExtend] = useState('');
  const [appAuthEnabled, setAppAuthEnabled] = useState(false);
  const [appAuthLoginUrl, setAppAuthLoginUrl] = useState('');
  const [appAuthUserSel, setAppAuthUserSel] = useState('');
  const [appAuthPassSel, setAppAuthPassSel] = useState('');
  const [appAuthSubmitSel, setAppAuthSubmitSel] = useState('');
  const [appAuthCondType, setAppAuthCondType] = useState('url_contains');
  const [appAuthCondValue, setAppAuthCondValue] = useState('');
  const [appAuthUsername, setAppAuthUsername] = useState('');
  const [appAuthPassword, setAppAuthPassword] = useState('');
  const [appAuthCredsSet, setAppAuthCredsSet] = useState(false);
  const [prWorkflowEnabled, setPrWorkflowEnabled] = useState(false);

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
        setSecretMaskEnabled(cfg.secretMaskEnabled);
        setSecretMaskAllow((cfg.secretMaskAllow ?? []).join('\n'));
        setSecretMaskDenyExtend((cfg.secretMaskDenyExtend ?? []).join('\n'));
        setAppAuthEnabled(cfg.appAuth?.enabled ?? false);
        setAppAuthLoginUrl(cfg.appAuth?.loginUrl ?? '');
        setAppAuthUserSel(cfg.appAuth?.usernameSelector ?? '');
        setAppAuthPassSel(cfg.appAuth?.passwordSelector ?? '');
        setAppAuthSubmitSel(cfg.appAuth?.submitSelector ?? '');
        setAppAuthCondType(cfg.appAuth?.successCondition?.type ?? 'url_contains');
        setAppAuthCondValue(cfg.appAuth?.successCondition?.value ?? '');
        setAppAuthCredsSet(cfg.appAuthCredentialsSet ?? false);
        setPrWorkflowEnabled(cfg.prWorkflowEnabled);
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
        secretMaskEnabled,
        secretMaskAllow: secretMaskAllow
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        secretMaskDenyExtend: secretMaskDenyExtend
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        prWorkflowEnabled,
        appAuth: {
          enabled: appAuthEnabled,
          loginUrl: appAuthLoginUrl,
          usernameSelector: appAuthUserSel,
          passwordSelector: appAuthPassSel,
          submitSelector: appAuthSubmitSel,
          successCondition: { type: appAuthCondType, value: appAuthCondValue },
        },
        // Sent only when retyped: an untouched field must not wipe a stored credential.
        ...(appAuthUsername ? { appAuthUsername } : {}),
        ...(appAuthPassword ? { appAuthPassword } : {}),
      });
      if (appAuthUsername || appAuthPassword) setAppAuthCredsSet(true);
      setAppAuthUsername('');
      setAppAuthPassword('');
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

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">Secret file protection</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Hides files that look like secrets (.env, keys, credentials, database dumps, …) from
              AI CLI agents by mounting empty files over them in the sandbox. The running app still
              sees the real files. Covers untracked files only — committed secrets are not masked.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <input
                id="secretMaskEnabled"
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
                checked={secretMaskEnabled}
                onChange={(e) => {
                  setSecretMaskEnabled(e.target.checked);
                  markDirty();
                }}
              />
              <Label htmlFor="secretMaskEnabled">Mask secret files from agents</Label>
            </div>
            <div className="mt-4 flex flex-col gap-1.5">
              <Label htmlFor="secretMaskAllow">Allow (un-mask) — one glob per line</Label>
              <textarea
                id="secretMaskAllow"
                className="min-h-20 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 disabled:opacity-50"
                placeholder={'**/.env.shared'}
                value={secretMaskAllow}
                disabled={!secretMaskEnabled}
                onChange={(e) => {
                  setSecretMaskAllow(e.target.value);
                  markDirty();
                }}
              />
              <p className="text-xs text-neutral-600">
                Files matching these globs stay readable even if they match the deny list.
              </p>
            </div>
            <div className="mt-4 flex flex-col gap-1.5">
              <Label htmlFor="secretMaskDenyExtend">Also mask — one glob per line</Label>
              <textarea
                id="secretMaskDenyExtend"
                className="min-h-20 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 disabled:opacity-50"
                placeholder={'**/*.sql'}
                value={secretMaskDenyExtend}
                disabled={!secretMaskEnabled}
                onChange={(e) => {
                  setSecretMaskDenyExtend(e.target.value);
                  markDirty();
                }}
              />
              <p className="text-xs text-neutral-600">
                Extra globs to mask on top of the built-in deny list (e.g. SQL files if your repo
                uses them as dumps rather than schema/migrations).
              </p>
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">App login (browser testing)</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Logs the task&apos;s browser into your app once, before any agent tests it, so browser
              testing reaches what is behind the login instead of stopping at it. The login runs as
              plain code inside the runner — the username and password are stored encrypted and are
              never put in a prompt, so they never reach a CLI provider. Form logins only: SSO,
              2FA/TOTP and magic-link flows are not supported.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <input
                id="appAuthEnabled"
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
                checked={appAuthEnabled}
                onChange={(e) => {
                  setAppAuthEnabled(e.target.checked);
                  markDirty();
                }}
              />
              <Label htmlFor="appAuthEnabled">Log in before browser testing</Label>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {(
                [
                  [
                    'appAuthLoginUrl',
                    'Login page URL',
                    appAuthLoginUrl,
                    setAppAuthLoginUrl,
                    'https://myapp.ddev.site/login',
                  ],
                  [
                    'appAuthUserSel',
                    'Username field selector',
                    appAuthUserSel,
                    setAppAuthUserSel,
                    '#email',
                  ],
                  [
                    'appAuthPassSel',
                    'Password field selector',
                    appAuthPassSel,
                    setAppAuthPassSel,
                    '#password',
                  ],
                  [
                    'appAuthSubmitSel',
                    'Submit button selector',
                    appAuthSubmitSel,
                    setAppAuthSubmitSel,
                    'button[type="submit"]',
                  ],
                ] as const
              ).map(([id, label, value, setter, placeholder]) => (
                <div key={id} className="flex flex-col gap-1.5">
                  <Label htmlFor={id}>{label}</Label>
                  <input
                    id={id}
                    className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 disabled:opacity-50"
                    placeholder={placeholder}
                    value={value}
                    disabled={!appAuthEnabled}
                    onChange={(e) => {
                      setter(e.target.value);
                      markDirty();
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="appAuthCondType">Confirm the login worked by</Label>
                <select
                  id="appAuthCondType"
                  className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 disabled:opacity-50"
                  value={appAuthCondType}
                  disabled={!appAuthEnabled}
                  onChange={(e) => {
                    setAppAuthCondType(e.target.value);
                    markDirty();
                  }}
                >
                  <option value="url_contains">URL contains</option>
                  <option value="element_present">Element is present</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="appAuthCondValue">
                  {appAuthCondType === 'url_contains' ? 'URL fragment' : 'Selector'}
                </Label>
                <input
                  id="appAuthCondValue"
                  className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 disabled:opacity-50"
                  placeholder={appAuthCondType === 'url_contains' ? '/dashboard' : '.avatar'}
                  value={appAuthCondValue}
                  disabled={!appAuthEnabled}
                  onChange={(e) => {
                    setAppAuthCondValue(e.target.value);
                    markDirty();
                  }}
                />
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="appAuthUsername">Username</Label>
                <input
                  id="appAuthUsername"
                  autoComplete="off"
                  className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 disabled:opacity-50"
                  placeholder={appAuthCredsSet ? '•••••• (stored)' : 'test user'}
                  value={appAuthUsername}
                  disabled={!appAuthEnabled}
                  onChange={(e) => {
                    setAppAuthUsername(e.target.value);
                    markDirty();
                  }}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="appAuthPassword">Password</Label>
                <input
                  id="appAuthPassword"
                  type="password"
                  autoComplete="new-password"
                  className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 disabled:opacity-50"
                  placeholder={appAuthCredsSet ? '•••••• (stored)' : ''}
                  value={appAuthPassword}
                  disabled={!appAuthEnabled}
                  onChange={(e) => {
                    setAppAuthPassword(e.target.value);
                    markDirty();
                  }}
                />
              </div>
            </div>
            <p className="mt-2 text-xs text-neutral-600">
              {appAuthCredsSet
                ? 'Credentials are stored. Leave both blank to keep them; type to replace.'
                : "Credentials are stored encrypted, separately from this repository's settings."}
            </p>
          </Card>

          <Card>
            <h2 className="text-lg font-semibold text-neutral-100">Pull-request close-out</h2>
            <p className="mt-1 text-xs text-neutral-500">
              Adds a &quot;create a pull request&quot; option at task close, alongside the local
              merge. The task opens a PR on this repo&apos;s forge and waits for it to merge instead
              of merging locally. Requires the global PR-workflow switch (admin settings) and a
              repository credential with its forge provider set. Applies to workflow tasks only.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <input
                id="prWorkflowEnabled"
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500"
                checked={prWorkflowEnabled}
                onChange={(e) => {
                  setPrWorkflowEnabled(e.target.checked);
                  markDirty();
                }}
              />
              <Label htmlFor="prWorkflowEnabled">
                Offer &quot;create a pull request&quot; at task close
              </Label>
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
