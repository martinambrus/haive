'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  DEFAULT_CLI_NETWORK_POLICY,
  type CliAuthMode,
  type CliNetworkMode,
  type CliNetworkPolicy,
  type CliPackageVersionsEntry,
  type CliProvider,
  type CliProviderCatalogEntry,
  type CliProviderName,
  type CliProviderSecret,
  type CliSandboxBuildStatus,
} from '@/lib/api-client';
import { Button, FormError, Input, Label } from '@/components/ui';

interface CliProviderFormProps {
  mode: 'create' | 'edit';
  provider?: CliProvider;
  metadata: CliProviderCatalogEntry;
}

interface FormState {
  name: CliProviderName;
  label: string;
  executablePath: string;
  wrapperPath: string;
  wrapperContent: string;
  envVarsText: string;
  secretsText: string;
  cliArgsText: string;
  authMode: CliAuthMode;
  cliVersion: string;
  sandboxDockerfileExtra: string;
  enabled: boolean;
  networkMode: CliNetworkMode;
  networkDomainsText: string;
  networkIpsText: string;
}

function parseLinesList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

interface BuildState {
  status: CliSandboxBuildStatus;
  error: string | null;
  imageTag: string | null;
  builtAt: string | null;
}

function envVarsToText(envVars: Record<string, string> | null | undefined): string {
  if (!envVars) return '';
  return Object.entries(envVars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function parseEnvVars(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

function parseCliArgs(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function CliProviderForm({ mode, provider, metadata }: CliProviderFormProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [existingSecrets, setExistingSecrets] = useState<CliProviderSecret[]>([]);
  const [buildState, setBuildState] = useState<BuildState>({
    status: provider?.sandboxImageBuildStatus ?? 'idle',
    error: provider?.sandboxImageBuildError ?? null,
    imageTag: provider?.sandboxImageTag ?? null,
    builtAt: provider?.sandboxImageBuiltAt ?? null,
  });
  const [buildRequesting, setBuildRequesting] = useState(false);
  const [versionCache, setVersionCache] = useState<CliPackageVersionsEntry | null>(
    metadata.versionCache,
  );
  const [refreshingVersions, setRefreshingVersions] = useState(false);

  const [state, setState] = useState<FormState>({
    name: provider?.name ?? metadata.name,
    label: provider?.label ?? metadata.displayName,
    executablePath: provider?.executablePath ?? '',
    wrapperPath: provider?.wrapperPath ?? '',
    wrapperContent: provider?.wrapperContent ?? '',
    envVarsText: envVarsToText(provider?.envVars),
    secretsText: '',
    cliArgsText: (provider?.cliArgs ?? []).join('\n'),
    authMode: provider?.authMode ?? metadata.defaultAuthMode,
    cliVersion:
      provider?.cliVersion ??
      (metadata.versionPinnable ? metadata.versionCache?.latestVersion ?? '' : ''),
    sandboxDockerfileExtra: provider?.sandboxDockerfileExtra ?? '',
    enabled: provider?.enabled ?? true,
    networkMode: (provider?.networkPolicy ?? DEFAULT_CLI_NETWORK_POLICY).mode,
    networkDomainsText: (provider?.networkPolicy?.domains ?? []).join('\n'),
    networkIpsText: (provider?.networkPolicy?.ips ?? []).join('\n'),
  });

  useEffect(() => {
    if (mode !== 'edit' || !provider?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { secrets } = await api.get<{ secrets: CliProviderSecret[] }>(
          `/cli-providers/${provider.id}/secrets`,
        );
        if (cancelled) return;
        setExistingSecrets(secrets);
        setState((prev) => ({
          ...prev,
          secretsText: secrets.map((s) => `${s.secretName}=`).join('\n'),
        }));
      } catch {
        // Leave empty; user will see no existing secrets.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, provider?.id]);

  useEffect(() => {
    if (mode !== 'edit' || !provider?.id) return;
    if (buildState.status !== 'building') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const { provider: fresh } = await api.get<{ provider: CliProvider }>(
          `/cli-providers/${provider.id}`,
        );
        if (cancelled) return;
        setBuildState({
          status: fresh.sandboxImageBuildStatus,
          error: fresh.sandboxImageBuildError,
          imageTag: fresh.sandboxImageTag,
          builtAt: fresh.sandboxImageBuiltAt,
        });
      } catch {
        // Keep polling even if a single request fails.
      }
    };
    const interval = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [mode, provider?.id, buildState.status]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleRefreshVersions() {
    if (!metadata.versionPinnable) return;
    setRefreshingVersions(true);
    setError(null);
    try {
      const { entry } = await api.post<{ entry: CliPackageVersionsEntry }>(
        `/cli-providers/catalog/${metadata.name}/refresh-versions`,
      );
      setVersionCache(entry);
      setState((prev) =>
        prev.cliVersion || !entry.latestVersion
          ? prev
          : { ...prev, cliVersion: entry.latestVersion },
      );
    } catch (err) {
      setError((err as Error).message ?? 'Failed to refresh versions');
    } finally {
      setRefreshingVersions(false);
    }
  }

  async function handleRebuildImage() {
    if (mode !== 'edit' || !provider?.id) return;
    setBuildRequesting(true);
    setError(null);
    try {
      if ((provider.sandboxDockerfileExtra ?? '') !== state.sandboxDockerfileExtra) {
        await api.patch(`/cli-providers/${provider.id}`, {
          sandboxDockerfileExtra: state.sandboxDockerfileExtra,
        });
      }
      await api.post(`/cli-providers/${provider.id}/sandbox-image/build`);
      setBuildState((prev) => ({ ...prev, status: 'building', error: null }));
    } catch (err) {
      setError((err as Error).message ?? 'Failed to start build');
    } finally {
      setBuildRequesting(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const networkPolicy: CliNetworkPolicy = {
        mode: state.networkMode,
        domains: state.networkMode === 'allowlist' ? parseLinesList(state.networkDomainsText) : [],
        ips: state.networkMode === 'allowlist' ? parseLinesList(state.networkIpsText) : [],
      };

      const payload = {
        name: state.name,
        label: state.label,
        executablePath: state.executablePath || undefined,
        wrapperPath: state.wrapperPath || undefined,
        wrapperContent: state.wrapperContent || undefined,
        envVars: parseEnvVars(state.envVarsText),
        cliArgs: parseCliArgs(state.cliArgsText),
        authMode: state.authMode,
        cliVersion: state.cliVersion || null,
        sandboxDockerfileExtra: state.sandboxDockerfileExtra,
        enabled: state.enabled,
        networkPolicy,
      };

      let providerId: string;
      if (mode === 'create') {
        const { provider: created } = await api.post<{ provider: CliProvider }>(
          '/cli-providers',
          payload,
        );
        providerId = created.id;
      } else if (provider) {
        await api.patch(`/cli-providers/${provider.id}`, payload);
        providerId = provider.id;
      } else {
        throw new Error('No provider context for edit mode');
      }

      const parsedSecrets = parseEnvVars(state.secretsText);
      const submittedNames = new Set(Object.keys(parsedSecrets));

      for (const s of existingSecrets) {
        if (!submittedNames.has(s.secretName)) {
          await api.delete(`/cli-providers/${providerId}/secrets/${encodeURIComponent(s.secretName)}`);
        }
      }

      for (const [secretName, value] of Object.entries(parsedSecrets)) {
        if (value.length > 0) {
          await api.post(`/cli-providers/${providerId}/secrets`, { secretName, value });
        }
      }

      router.push('/settings/cli-providers');
      router.refresh();
    } catch (err) {
      setError((err as Error).message ?? 'Failed to save provider');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <FormError message={error} />

      <div>
        <Label>Name</Label>
        <div className="mt-1 text-sm text-neutral-300">
          {metadata.displayName} <span className="text-xs text-neutral-500">({state.name})</span>
        </div>
      </div>

      <div>
        <Label htmlFor="label">Label</Label>
        <Input
          id="label"
          value={state.label}
          onChange={(e) => update('label', e.target.value)}
          required
        />
      </div>

      <div>
        <Label htmlFor="executablePath">Executable path</Label>
        <Input
          id="executablePath"
          value={state.executablePath}
          onChange={(e) => update('executablePath', e.target.value)}
          placeholder={metadata.defaultExecutable}
        />
        <p className="mt-1 text-xs text-neutral-500">
          Leave blank to use the default ({metadata.defaultExecutable}).
        </p>
      </div>

      <div>
        <Label htmlFor="wrapperPath">Wrapper script path</Label>
        <Input
          id="wrapperPath"
          value={state.wrapperPath}
          onChange={(e) => update('wrapperPath', e.target.value)}
          placeholder="(optional)"
        />
        <p className="mt-1 text-xs text-neutral-500">
          If set, used as the actual invoked executable (inside the sandbox). Must exist in the
          sandbox image, or use Wrapper script content below to inject one at runtime.
        </p>
      </div>

      <div>
        <Label htmlFor="wrapperContent">Wrapper script content</Label>
        <textarea
          id="wrapperContent"
          rows={6}
          className="block w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100"
          value={state.wrapperContent}
          onChange={(e) => update('wrapperContent', e.target.value)}
          placeholder="#!/bin/bash&#10;exec /usr/local/bin/claude &quot;$@&quot;"
        />
        <p className="mt-1 text-xs text-neutral-500">
          Optional. Materialized to <code className="font-mono">/haive/wrapper.sh</code> inside
          the sandbox at each run, chmod +x, then used as the executable (overrides executable
          and wrapper path). Useful for inline logging wrappers or flag injection.
        </p>
      </div>

      <div>
        <Label htmlFor="authMode">Authentication mode</Label>
        <select
          id="authMode"
          className="h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
          value={state.authMode}
          onChange={(e) => update('authMode', e.target.value as CliAuthMode)}
        >
          {metadata.supportsCliAuth && <option value="subscription">Subscription (CLI)</option>}
          {metadata.supportsApi && <option value="api_key">API key (BYOK)</option>}
          {metadata.supportsApi && metadata.supportsCliAuth && <option value="mixed">Mixed</option>}
        </select>
      </div>

      <div>
        <Label htmlFor="cliVersion">CLI version</Label>
        {!metadata.installSupported ? (
          <p className="mt-1 text-xs text-neutral-500">
            No first-party CLI is available for this provider. The sandbox will not install a
            binary; configure your own via Custom Dockerfile lines below.
          </p>
        ) : !metadata.versionPinnable ? (
          <p className="mt-1 text-xs text-neutral-500">
            This provider uses an installer script and cannot be pinned to a specific version.
            The sandbox image installs whichever version the installer ships the first time the
            provider runs.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <select
                id="cliVersion"
                className="h-10 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100"
                value={state.cliVersion}
                onChange={(e) => update('cliVersion', e.target.value)}
                disabled={!versionCache?.versions.length}
              >
                {!versionCache?.versions.length && (
                  <option value="">Click Refresh to load versions</option>
                )}
                {versionCache?.versions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="ghost"
                onClick={handleRefreshVersions}
                disabled={refreshingVersions}
                title="Refresh version list from registry"
              >
                {refreshingVersions ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>
            <p className="mt-1 text-xs text-neutral-500">
              The sandbox image for this CLI and version is built on first use and cached, then
              reused across all providers that pin the same version. Auto-update is always
              disabled inside the image so your pin cannot drift.
            </p>
            {versionCache?.fetchedAt && (
              <p className="mt-1 text-xs text-neutral-600">
                Version list refreshed {new Date(versionCache.fetchedAt).toLocaleString()} (max
                every 12h automatically).
              </p>
            )}
            {versionCache?.fetchError && (
              <p className="mt-1 text-xs text-red-400">
                Last refresh failed: {versionCache.fetchError}
              </p>
            )}
          </>
        )}
      </div>

      <div>
        <Label htmlFor="sandboxDockerfileExtra">Custom Dockerfile lines (sandbox image)</Label>
          <textarea
            id="sandboxDockerfileExtra"
            rows={6}
            className="block w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100"
            value={state.sandboxDockerfileExtra}
            onChange={(e) => update('sandboxDockerfileExtra', e.target.value)}
            placeholder="# Appended after the CLI install lines on top of haive-cli-sandbox:latest&#10;RUN apk add --no-cache jq&#10;RUN npm install -g some-tool"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Leave empty to reuse the shared cached image for this CLI and version. If you add
            lines here, the image is tagged{' '}
            <code className="font-mono">haive-cli-sandbox:provider-&lt;id&gt;</code> and rebuilt
            on demand for this provider only (no cross-user sharing).
          </p>

          {mode === 'edit' && provider?.id && (
            <div className="mt-3 rounded-md border border-neutral-800 bg-neutral-950/60 p-3 text-xs">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-neutral-400">Image build status:</span>
                  <span
                    className={
                      buildState.status === 'ready'
                        ? 'font-semibold text-emerald-400'
                        : buildState.status === 'building'
                          ? 'font-semibold text-amber-400'
                          : buildState.status === 'failed'
                            ? 'font-semibold text-red-400'
                            : 'font-semibold text-neutral-400'
                    }
                  >
                    {buildState.status}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={handleRebuildImage}
                  disabled={buildRequesting || buildState.status === 'building'}
                >
                  {buildState.status === 'building'
                    ? 'Building...'
                    : buildRequesting
                      ? 'Starting...'
                      : 'Rebuild image'}
                </Button>
              </div>
              {buildState.imageTag && (
                <p className="mt-1 text-neutral-500">
                  Tag: <code className="font-mono text-neutral-300">{buildState.imageTag}</code>
                </p>
              )}
              {buildState.builtAt && (
                <p className="mt-1 text-neutral-500">
                  Built at: {new Date(buildState.builtAt).toLocaleString()}
                </p>
              )}
              {buildState.status === 'failed' && buildState.error && (
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-red-950/40 p-2 font-mono text-[11px] text-red-300">
                  {buildState.error}
                </pre>
              )}
            </div>
          )}
      </div>

      <div>
        <Label htmlFor="secrets">Secrets</Label>
        {mode === 'edit' && existingSecrets.length > 0 && (
          <p className="mb-1 text-xs text-neutral-400">
            {existingSecrets.length} secret{existingSecrets.length === 1 ? '' : 's'} configured.
            Values are hidden — leave the value empty to keep unchanged, type a value to replace,
            delete the line to remove.
          </p>
        )}
        <textarea
          id="secrets"
          rows={5}
          className="block w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100"
          value={state.secretsText}
          onChange={(e) => update('secretsText', e.target.value)}
          placeholder={metadata.apiKeyEnvName ? `${metadata.apiKeyEnvName}=sk-...` : 'KEY=VALUE'}
        />
        <p className="mt-1 text-xs text-neutral-500">
          One KEY=VALUE per line. Envelope-encrypted (AES-256-GCM) at rest and injected as
          environment variables into the sandbox at run time.
        </p>
      </div>

      <div>
        <Label htmlFor="envVars">Environment variables</Label>
        <textarea
          id="envVars"
          rows={5}
          className="block w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100"
          value={state.envVarsText}
          onChange={(e) => update('envVarsText', e.target.value)}
          placeholder="KEY=VALUE"
        />
        <p className="mt-1 text-xs text-neutral-500">
          One KEY=VALUE per line. Stored as plaintext metadata.
        </p>
        <p className="mt-1 text-xs font-bold text-red-500">
          Never put secrets (API keys, tokens, passwords) here.
          <br />
          Use the Secrets field above — values are encrypted at rest.
        </p>
      </div>

      <div>
        <Label htmlFor="cliArgs">Extra CLI arguments</Label>
        <textarea
          id="cliArgs"
          rows={3}
          className="block w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100"
          value={state.cliArgsText}
          onChange={(e) => update('cliArgsText', e.target.value)}
          placeholder="--verbose"
        />
        <p className="mt-1 text-xs text-neutral-500">
          One argument per line. A line that looks like{' '}
          <code className="font-mono text-neutral-300">--flag value</code> is split at the
          first whitespace into two argv elements; the value is taken verbatim from there
          to the end of the line, so embedded quotes, punctuation, and any other characters
          survive unchanged. Everything else is treated as a single argument. A single
          pair of outer matching quotes around the value (or around a whole standalone
          line) is stripped, so{' '}
          <code className="font-mono text-neutral-300">--mcp-config &quot;.claude/mcp.json&quot;</code>{' '}
          becomes{' '}
          <code className="font-mono text-neutral-300">--mcp-config</code> +{' '}
          <code className="font-mono text-neutral-300">.claude/mcp.json</code>. For long
          prose values, wrap the whole value in a single pair of quotes; no shell escape
          rules apply inside.
        </p>
      </div>

      <div>
        <Label>Network access</Label>
        <div className="mt-2 flex flex-col gap-2">
          <label className="flex items-start gap-2 text-sm text-neutral-200">
            <input
              type="radio"
              name="networkMode"
              className="mt-1"
              checked={state.networkMode === 'full'}
              onChange={() => update('networkMode', 'full')}
            />
            <div>
              <div className="font-medium">Full internet</div>
              <div className="text-xs text-neutral-500">
                Sandbox can reach any domain or IP. Default.
              </div>
            </div>
          </label>
          <label className="flex items-start gap-2 text-sm text-neutral-200">
            <input
              type="radio"
              name="networkMode"
              className="mt-1"
              checked={state.networkMode === 'none'}
              onChange={() => update('networkMode', 'none')}
            />
            <div>
              <div className="font-medium">No network</div>
              <div className="text-xs text-neutral-500">
                Container is started with <code className="font-mono">--network=none</code>.
                CLI cannot reach the internet or any external service.
              </div>
            </div>
          </label>
          <label className="flex items-start gap-2 text-sm text-neutral-200">
            <input
              type="radio"
              name="networkMode"
              className="mt-1"
              checked={state.networkMode === 'allowlist'}
              onChange={() => update('networkMode', 'allowlist')}
            />
            <div>
              <div className="font-medium">Allowlist (domains / IPs)</div>
              <div className="text-xs text-neutral-500">
                Only the listed destinations are reachable. Enforced by a per-task squid
                forward proxy on an isolated docker network; the sandbox only sees squid.
                Traffic that does not respect <code className="font-mono">HTTP_PROXY</code>{' '}
                will fail (no route).
              </div>
            </div>
          </label>
        </div>

        {state.networkMode === 'allowlist' && (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <Label htmlFor="networkDomains">Allowed domains</Label>
              <textarea
                id="networkDomains"
                rows={4}
                className="block w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100"
                value={state.networkDomainsText}
                onChange={(e) => update('networkDomainsText', e.target.value)}
                placeholder="api.anthropic.com&#10;*.npmjs.org&#10;example.*"
              />
              <p className="mt-1 text-xs text-neutral-500">
                One hostname per line. Wildcards:{' '}
                <code className="font-mono">*.example.com</code> matches all subdomains,{' '}
                <code className="font-mono">example.*</code> matches any single-label TLD.
              </p>
            </div>
            <div>
              <Label htmlFor="networkIps">Allowed IPs / CIDRs</Label>
              <textarea
                id="networkIps"
                rows={4}
                className="block w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100"
                value={state.networkIpsText}
                onChange={(e) => update('networkIpsText', e.target.value)}
                placeholder="10.0.0.0/8&#10;192.168.1.42"
              />
              <p className="mt-1 text-xs text-neutral-500">One IP or CIDR per line.</p>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          id="enabled"
          type="checkbox"
          className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 text-indigo-500 focus:ring-indigo-500"
          checked={state.enabled}
          onChange={(e) => update('enabled', e.target.checked)}
        />
        <Label htmlFor="enabled">Enabled</Label>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Saving...' : mode === 'create' ? 'Create' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
