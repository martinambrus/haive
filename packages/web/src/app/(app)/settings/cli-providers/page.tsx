'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type CliAuthStatus,
  type CliProbePathResult,
  type CliProbeResult,
  type CliProvider,
  type CliProviderCatalogEntry,
  type CliProviderName,
} from '@/lib/api-client';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  FormError,
  Input,
} from '@/components/ui';
import { CliUpgradeAll } from '@/components/cli-upgrade-all';
import { cliUpgradeLatest, groupUpgradable } from '@/components/cli-upgrade-selection';
import { useCliLogin } from '@/lib/use-cli-login';
import { usePageTitle } from '@/lib/use-page-title';

const LOGIN_SUPPORTED: CliProviderName[] = ['claude-code', 'codex', 'amp', 'antigravity'];
const LOGIN_RECOVERABLE: CliAuthStatus[] = [
  'auth_expired',
  'auth_denied',
  'unknown_error',
  'timeout',
];

interface TestState {
  testing: boolean;
  result: CliProbeResult | null;
  error: string | null;
}

interface SignOutResult {
  ok: boolean;
  removed: string[];
  failed: { name: string; stderr: string }[];
}

interface SignOutState {
  busy: boolean;
  message: string | null;
  error: string | null;
}

interface UsageConnectState {
  busy: boolean;
  /** Set once the authorize round-trip starts: reveals the code#state paste input. */
  authorizeUrl: string | null;
  message: string | null;
  error: string | null;
}

export default function CliProvidersPage() {
  usePageTitle('CLI Providers');
  const [providers, setProviders] = useState<CliProvider[] | null>(null);
  const [catalog, setCatalog] = useState<CliProviderCatalogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const [signOutStates, setSignOutStates] = useState<Record<string, SignOutState>>({});
  const [usageStates, setUsageStates] = useState<Record<string, UsageConnectState>>({});
  const [usageCodes, setUsageCodes] = useState<Record<string, string>>({});
  /** Per-claude-provider usage-tracking connection status (drives Connect vs Disconnect). */
  const [usageConnected, setUsageConnected] = useState<Record<string, boolean>>({});
  /** Providers whose stored usage token the poller marked dead — a re-auth is needed. */
  const [needsReconnect, setNeedsReconnect] = useState<Record<string, boolean>>({});
  const [cloningIds, setCloningIds] = useState<Record<string, boolean>>({});
  const [upgradingIds, setUpgradingIds] = useState<Record<string, boolean>>({});
  /** Bulk ("Upgrade All") run state — separate from upgradingIds, which drives
   *  the per-row buttons for both the single and the bulk path. */
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const { requireCliLogin } = useCliLogin();

  const upgradeGroups = useMemo(
    () => (providers && catalog ? groupUpgradable(providers, catalog) : []),
    [providers, catalog],
  );

  function handleLogin(p: CliProvider) {
    requireCliLogin({
      providerId: p.id,
      providerLabel: p.label,
      providerName: p.name,
      onComplete: (res) => {
        setTestStates((s) => ({
          ...s,
          [p.id]: { testing: false, result: res, error: null },
        }));
        // Server-side probe (run inside saveOauthTokenAndProbe / runProbeAndSave)
        // already wrote the new authStatus to the row. Refetch so the row's
        // authStatus updates and the Sign out button can re-appear when ok.
        void load();
      },
    });
  }

  async function load() {
    try {
      const [providersData, catalogData] = await Promise.all([
        api.get<{ providers: CliProvider[] }>('/cli-providers'),
        api.get<{ providers: CliProviderCatalogEntry[] }>('/cli-providers/catalog'),
      ]);
      setProviders(providersData.providers);
      setCatalog(catalogData.providers);
      // Usage-tracking connection status for each claude provider (Connect vs Disconnect).
      const claudeProviders = providersData.providers.filter((p) => p.name === 'claude-code');
      const statuses = await Promise.all(
        claudeProviders.map((p) =>
          api
            .get<{ connected: boolean }>(`/cli-providers/${p.id}/usage-auth`)
            .then((r) => [p.id, r.connected] as const)
            .catch(() => [p.id, false] as const),
        ),
      );
      setUsageConnected(Object.fromEntries(statuses));
      // Which providers the poller flagged as needing re-auth (a usage token it found
      // dead — invalid_grant on refresh, or 401/403 on the fetch).
      const usage = await api
        .get<{ snapshots: { providerId: string; status: string }[] }>('/usage-window')
        .catch(() => ({ snapshots: [] as { providerId: string; status: string }[] }));
      setNeedsReconnect(
        Object.fromEntries(
          usage.snapshots
            .filter((s) => s.status === 'needs_reconnect')
            .map((s) => [s.providerId, true]),
        ),
      );
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load CLI providers');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleDelete(id: string) {
    if (!confirm('Delete this CLI provider configuration?')) return;
    try {
      await api.delete(`/cli-providers/${id}`);
      await load();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to delete provider');
    }
  }

  async function handleClone(id: string) {
    setCloningIds((s) => ({ ...s, [id]: true }));
    setError(null);
    try {
      await api.post<{ provider: CliProvider }>(`/cli-providers/${id}/clone`);
      await load();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to clone provider');
    } finally {
      setCloningIds((s) => {
        const next = { ...s };
        delete next[id];
        return next;
      });
    }
  }

  async function handleUpgrade(p: CliProvider, latest: string) {
    setUpgradingIds((s) => ({ ...s, [p.id]: true }));
    setError(null);
    try {
      // PATCH cliVersion → the API flags imageInputsChanged and rebuilds the
      // provider's sandbox image automatically.
      await api.patch(`/cli-providers/${p.id}`, { cliVersion: latest });
      await load();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to upgrade CLI version');
    } finally {
      setUpgradingIds((s) => {
        const next = { ...s };
        delete next[p.id];
        return next;
      });
    }
  }

  /** Bulk path for the Upgrade All control. Sequential rather than Promise.all so
   *  the progress count is real; each provider is upgraded through the same PATCH
   *  the per-row button uses. One provider failing must not strand the rest, so
   *  every iteration catches on its own and failures are reported in aggregate. */
  async function handleUpgradeMany(ids: string[]) {
    if (ids.length === 0 || bulkBusy) return;
    const byId = new Map((providers ?? []).map((p) => [p.id, p]));
    const targets: { p: CliProvider; latest: string }[] = [];
    for (const id of ids) {
      const p = byId.get(id);
      if (!p) continue;
      const latest = cliUpgradeLatest(
        p,
        catalog?.find((m) => m.name === p.name),
      );
      if (latest) targets.push({ p, latest });
    }
    if (targets.length === 0) return;

    setBulkBusy(true);
    setError(null);
    setUpgradingIds((s) => {
      const next = { ...s };
      for (const t of targets) next[t.p.id] = true;
      return next;
    });

    const failed: { label: string; message: string }[] = [];
    let upgraded = 0;
    for (const [i, { p, latest }] of targets.entries()) {
      setBulkProgress(`Upgrading ${i + 1} of ${targets.length}...`);
      try {
        await api.patch(`/cli-providers/${p.id}`, { cliVersion: latest });
        upgraded++;
      } catch (err) {
        failed.push({ label: p.label, message: (err as Error).message ?? 'Upgrade failed' });
      }
    }

    // Refetch before reporting: load() writes its own error on failure and would
    // otherwise clobber the summary below.
    await load();
    setUpgradingIds((s) => {
      const next = { ...s };
      for (const t of targets) delete next[t.p.id];
      return next;
    });
    setBulkProgress(null);
    setBulkBusy(false);
    if (failed.length > 0) {
      setError(
        `Upgraded ${upgraded} of ${targets.length}. Failed: ${failed
          .map((f) => `${f.label} (${f.message})`)
          .join('; ')}`,
      );
    }
  }

  async function handleSignOut(p: CliProvider) {
    if (
      !confirm(
        `Sign out of ${p.label}? Removes the auth volume(s) for ${p.name}. You'll need to log in again before next use.`,
      )
    ) {
      return;
    }
    setSignOutStates((s) => ({
      ...s,
      [p.id]: { busy: true, message: null, error: null },
    }));
    setTestStates((s) => {
      const next = { ...s };
      delete next[p.id];
      return next;
    });
    try {
      const data = await api.post<{ result: SignOutResult }>(`/cli-providers/${p.id}/sign-out`);
      const { ok, removed, failed } = data.result;
      const summary = ok
        ? removed.length === 0
          ? 'Already signed out.'
          : `Removed: ${removed.join(', ')}`
        : `Failed: ${failed.map((f) => `${f.name} (${f.stderr})`).join('; ')}`;
      setSignOutStates((s) => ({
        ...s,
        [p.id]: { busy: false, message: ok ? summary : null, error: ok ? null : summary },
      }));
      if (ok) await load();
    } catch (err) {
      setSignOutStates((s) => ({
        ...s,
        [p.id]: {
          busy: false,
          message: null,
          error: (err as Error).message ?? 'Sign-out failed',
        },
      }));
    }
  }

  // Claude usage-tracking OAuth (PKCE), same flow as the provider edit page: open the
  // authorize URL in a new tab, then paste back the code#state to mint a user:profile token.
  async function handleStartUsage(p: CliProvider) {
    setUsageStates((s) => ({
      ...s,
      [p.id]: { busy: true, authorizeUrl: null, message: null, error: null },
    }));
    try {
      const { authorizeUrl } = await api.post<{ authorizeUrl: string }>(
        `/cli-providers/${p.id}/usage-auth/start`,
      );
      window.open(authorizeUrl, '_blank', 'noopener,noreferrer');
      setUsageStates((s) => ({
        ...s,
        [p.id]: { busy: false, authorizeUrl, message: null, error: null },
      }));
    } catch (err) {
      setUsageStates((s) => ({
        ...s,
        [p.id]: {
          busy: false,
          authorizeUrl: null,
          message: null,
          error: (err as Error).message ?? 'Failed to start authorization',
        },
      }));
    }
  }

  async function handleCompleteUsage(p: CliProvider) {
    const code = (usageCodes[p.id] ?? '').trim();
    if (!code) return;
    const authorizeUrl = usageStates[p.id]?.authorizeUrl ?? null;
    setUsageStates((s) => ({
      ...s,
      [p.id]: { busy: true, authorizeUrl, message: null, error: null },
    }));
    try {
      await api.post(`/cli-providers/${p.id}/usage-auth/complete`, { code });
      setUsageStates((s) => ({
        ...s,
        [p.id]: {
          busy: false,
          authorizeUrl: null,
          message: 'Usage tracking connected.',
          error: null,
        },
      }));
      setUsageConnected((s) => ({ ...s, [p.id]: true }));
      setNeedsReconnect((s) => ({ ...s, [p.id]: false }));
      setUsageCodes((s) => ({ ...s, [p.id]: '' }));
    } catch (err) {
      setUsageStates((s) => ({
        ...s,
        [p.id]: {
          busy: false,
          authorizeUrl,
          message: null,
          error: (err as Error).message ?? 'Failed to complete authorization',
        },
      }));
    }
  }

  async function handleDisconnectUsage(p: CliProvider) {
    if (
      !confirm(
        `Disconnect usage tracking for ${p.label}? The task header will stop showing its 5h/weekly windows until you reconnect.`,
      )
    ) {
      return;
    }
    setUsageStates((s) => ({
      ...s,
      [p.id]: { busy: true, authorizeUrl: null, message: null, error: null },
    }));
    try {
      await api.delete(`/cli-providers/${p.id}/usage-auth`);
      setUsageConnected((s) => ({ ...s, [p.id]: false }));
      setNeedsReconnect((s) => ({ ...s, [p.id]: false }));
      setUsageStates((s) => ({
        ...s,
        [p.id]: {
          busy: false,
          authorizeUrl: null,
          message: 'Usage tracking disconnected.',
          error: null,
        },
      }));
    } catch (err) {
      setUsageStates((s) => ({
        ...s,
        [p.id]: {
          busy: false,
          authorizeUrl: null,
          message: null,
          error: (err as Error).message ?? 'Failed to disconnect',
        },
      }));
    }
  }

  async function handleTest(id: string) {
    setTestStates((s) => ({ ...s, [id]: { testing: true, result: null, error: null } }));
    try {
      const data = await api.post<{ result: CliProbeResult }>(`/cli-providers/${id}/test`);
      setTestStates((s) => ({
        ...s,
        [id]: { testing: false, result: data.result, error: null },
      }));
      // Probe wrote authStatus to the row — refetch so the Sign out button
      // appears/disappears in response to the new state.
      await load();
    } catch (err) {
      setTestStates((s) => ({
        ...s,
        [id]: {
          testing: false,
          result: null,
          error: (err as Error).message ?? 'Test failed',
        },
      }));
    }
  }

  const availableCatalog = catalog ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-50">CLI Providers</h1>
        <p className="text-sm text-neutral-400">
          Register the CLI tools (Claude Code, Codex, Gemini, etc.) Haive can drive on your behalf.
        </p>
      </div>

      <FormError message={error} />

      {providers === null || catalog === null ? (
        <p className="text-sm text-neutral-500">Loading...</p>
      ) : (
        <>
          <section className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold text-neutral-100">Configured</h2>
            <CliUpgradeAll
              groups={upgradeGroups}
              onUpgrade={(ids) => void handleUpgradeMany(ids)}
              busy={bulkBusy}
              progress={bulkProgress}
            />
            {providers.length === 0 ? (
              <p className="text-sm text-neutral-500">None yet. Pick a CLI below to get started.</p>
            ) : (
              <div className="grid gap-3">
                {providers.map((p) => {
                  const meta = catalog.find((m) => m.name === p.name);
                  const upgradeLatest = cliUpgradeLatest(p, meta);
                  const upgrading = upgradingIds[p.id] === true;
                  const testState = testStates[p.id];
                  const cliAuthStatus = testState?.result?.cli?.authStatus;
                  const showLogin =
                    LOGIN_SUPPORTED.includes(p.name) &&
                    cliAuthStatus !== undefined &&
                    LOGIN_RECOVERABLE.includes(cliAuthStatus);
                  const showSignOut = LOGIN_SUPPORTED.includes(p.name) && p.authStatus === 'ok';
                  const signOutState = signOutStates[p.id];
                  const usageState = usageStates[p.id];
                  return (
                    <Card key={p.id}>
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="text-lg font-semibold text-neutral-50">{p.label}</h3>
                            <Badge>{p.name}</Badge>
                            {p.enabled ? (
                              <Badge variant="success">enabled</Badge>
                            ) : (
                              <Badge variant="warning">disabled</Badge>
                            )}
                            <Badge>{p.authMode}</Badge>
                            {testState?.result && (
                              <Badge variant={testState.result.ok ? 'success' : 'error'}>
                                {testState.result.ok ? 'test ok' : 'test failed'}
                              </Badge>
                            )}
                            {upgradeLatest && (
                              <Badge variant="warning">
                                upgrade: {p.cliVersion} → {upgradeLatest}
                              </Badge>
                            )}
                            {needsReconnect[p.id] && (
                              <Badge
                                variant="warning"
                                title="This provider's usage token expired — Reconnect to restore its subscription meters"
                              >
                                ⚠ usage token expired
                              </Badge>
                            )}
                          </div>
                          {meta && (
                            <p className="mt-1 text-xs text-neutral-500">{meta.description}</p>
                          )}
                        </div>
                        <div className="flex flex-shrink-0 gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleTest(p.id)}
                            disabled={testState?.testing === true}
                          >
                            {testState?.testing ? 'Testing...' : 'Test'}
                          </Button>
                          {showLogin && (
                            <Button variant="secondary" size="sm" onClick={() => handleLogin(p)}>
                              Log in
                            </Button>
                          )}
                          {showSignOut && (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => handleSignOut(p)}
                              disabled={signOutState?.busy === true}
                            >
                              {signOutState?.busy ? 'Signing out...' : 'Sign out'}
                            </Button>
                          )}
                          {p.name === 'claude-code' &&
                            (needsReconnect[p.id] ? (
                              <>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => handleStartUsage(p)}
                                  disabled={usageState?.busy === true}
                                  title="Re-authorize the expired usage token to restore this provider's meters"
                                >
                                  {usageState?.busy ? 'Connecting...' : 'Reconnect'}
                                </Button>
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => handleDisconnectUsage(p)}
                                  disabled={usageState?.busy === true}
                                  title="Stop tracking usage and delete the stored token (use this to drop a duplicate of the same account)"
                                >
                                  {usageState?.busy ? 'Working...' : 'Disconnect usage'}
                                </Button>
                              </>
                            ) : usageConnected[p.id] ? (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => handleDisconnectUsage(p)}
                                disabled={usageState?.busy === true}
                                title="Stop tracking Claude's subscription usage and delete the stored usage token"
                              >
                                {usageState?.busy ? 'Working...' : 'Disconnect usage'}
                              </Button>
                            ) : (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => handleStartUsage(p)}
                                disabled={usageState?.busy === true}
                                title="Authorize a usage-scoped token so the task header can show Claude's 5h/weekly windows"
                              >
                                {usageState?.busy ? 'Connecting...' : 'Connect usage'}
                              </Button>
                            ))}
                          {upgradeLatest && (
                            <Button
                              size="sm"
                              onClick={() => handleUpgrade(p, upgradeLatest)}
                              disabled={upgrading}
                              title={`Pin ${upgradeLatest} and rebuild this provider's sandbox image`}
                            >
                              {upgrading ? 'Upgrading...' : 'Upgrade'}
                            </Button>
                          )}
                          <Link href={`/settings/cli-providers/${p.id}`}>
                            <Button variant="secondary" size="sm">
                              Edit
                            </Button>
                          </Link>
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => handleClone(p.id)}
                            disabled={cloningIds[p.id] === true}
                          >
                            {cloningIds[p.id] ? 'Cloning...' : 'Clone'}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleDelete(p.id)}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                      {(testState?.error || testState?.result) && (
                        <div className="mt-3 border-t border-neutral-800 pt-3">
                          {testState.error && (
                            <p className="font-mono text-xs text-red-400">{testState.error}</p>
                          )}
                          {testState.result?.cli && (
                            <TestPathLine
                              label="CLI"
                              res={testState.result.cli}
                              providerName={p.name}
                              onLogin={() => handleLogin(p)}
                            />
                          )}
                          {testState.result?.api && (
                            <TestPathLine
                              label="API"
                              res={testState.result.api}
                              providerName={p.name}
                              onLogin={() => handleLogin(p)}
                            />
                          )}
                        </div>
                      )}
                      {(signOutState?.error || signOutState?.message) && (
                        <div className="mt-3 border-t border-neutral-800 pt-3 text-xs">
                          {signOutState.error ? (
                            <p className="font-mono text-red-400">{signOutState.error}</p>
                          ) : (
                            <p className="font-mono text-neutral-300">{signOutState.message}</p>
                          )}
                        </div>
                      )}
                      {usageState?.authorizeUrl && (
                        <div className="mt-3 flex flex-col gap-2 border-t border-neutral-800 pt-3">
                          <p className="text-xs text-neutral-400">
                            Approve access in the new tab (or{' '}
                            <a
                              href={usageState.authorizeUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-indigo-400 underline"
                            >
                              open it
                            </a>
                            ), then paste the code it shows (code#state):
                          </p>
                          <div className="flex gap-2">
                            <Input
                              value={usageCodes[p.id] ?? ''}
                              onChange={(e) =>
                                setUsageCodes((s) => ({ ...s, [p.id]: e.target.value }))
                              }
                              placeholder="code#state"
                              className="h-8 text-xs"
                            />
                            <Button
                              size="sm"
                              onClick={() => handleCompleteUsage(p)}
                              disabled={!usageCodes[p.id]?.trim() || usageState.busy}
                            >
                              Complete
                            </Button>
                          </div>
                        </div>
                      )}
                      {(usageState?.error || usageState?.message) && !usageState?.authorizeUrl && (
                        <div className="mt-3 border-t border-neutral-800 pt-3 text-xs">
                          {usageState.error ? (
                            <p className="font-mono text-red-400">{usageState.error}</p>
                          ) : (
                            <p className="font-mono text-emerald-400">{usageState.message}</p>
                          )}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </section>

          {availableCatalog.length > 0 && (
            <section className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-neutral-100">Add another CLI</h2>
              <p className="text-xs text-neutral-500">
                You can register the same CLI multiple times with different labels, models, or
                permissions.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                {availableCatalog.map((m) => (
                  <Card key={m.name}>
                    <CardHeader>
                      <CardTitle>{m.displayName}</CardTitle>
                      <CardDescription>{m.description}</CardDescription>
                    </CardHeader>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                      <Badge>{m.defaultAuthMode}</Badge>
                      {m.supportsSubagents && <Badge variant="success">subagents</Badge>}
                      {m.supportsCliAuth && <Badge>CLI</Badge>}
                    </div>
                    <div className="mt-4">
                      <Link href={`/settings/cli-providers/new?name=${m.name}`}>
                        <Button size="sm">Add</Button>
                      </Link>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

const AUTH_STATUS_LABEL: Record<CliAuthStatus, string> = {
  unknown: 'unknown',
  ok: 'authenticated',
  auth_expired: 'login expired',
  auth_denied: 'login denied',
  rate_limited: 'rate limited',
  network_error: 'network error',
  timeout: 'timeout',
  unknown_error: 'error',
};

function authBadgeVariant(status: CliAuthStatus): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'ok') return 'success';
  if (status === 'rate_limited' || status === 'network_error') return 'warning';
  if (status === 'unknown') return 'default';
  return 'error';
}

function TestPathLine({
  label,
  res,
  providerName,
  onLogin,
}: {
  label: string;
  res: CliProbePathResult;
  providerName: CliProviderName;
  onLogin: () => void;
}) {
  const loginPrompt =
    !res.ok &&
    res.authStatus &&
    LOGIN_SUPPORTED.includes(providerName) &&
    LOGIN_RECOVERABLE.includes(res.authStatus);
  return (
    <div className="mt-1 flex items-start gap-2 text-xs">
      <span className="font-semibold text-neutral-400">{label}</span>
      <Badge variant={res.ok ? 'success' : 'error'}>{res.ok ? 'OK' : 'FAIL'}</Badge>
      {res.authStatus && (
        <Badge variant={authBadgeVariant(res.authStatus)}>
          {AUTH_STATUS_LABEL[res.authStatus]}
        </Badge>
      )}
      {typeof res.durationMs === 'number' && (
        <span className="text-neutral-500">{res.durationMs}ms</span>
      )}
      {loginPrompt ? (
        <span className="flex-1 text-amber-300">
          Not logged in. Click the{' '}
          <button
            type="button"
            onClick={onLogin}
            className="font-semibold text-amber-200 underline underline-offset-2 hover:text-amber-100"
          >
            Log in
          </button>{' '}
          button to start an interactive login.
        </span>
      ) : (
        <div className="flex flex-1 flex-col gap-1">
          <pre className="whitespace-pre-wrap break-words font-mono text-neutral-400">
            {res.ok ? (res.detail ?? '') : (res.error ?? '')}
          </pre>
          {res.warning && (
            <p className="rounded-md border border-amber-500/40 bg-amber-950/30 p-2 text-amber-300">
              {res.warning}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
