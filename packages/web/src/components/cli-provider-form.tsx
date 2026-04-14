'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  api,
  type CliAuthMode,
  type CliProvider,
  type CliProviderMetadata,
  type CliProviderName,
} from '@/lib/api-client';
import { Button, FormError, Input, Label } from '@/components/ui';

interface CliProviderFormProps {
  mode: 'create' | 'edit';
  provider?: CliProvider;
  metadata: CliProviderMetadata;
}

interface FormState {
  name: CliProviderName;
  label: string;
  executablePath: string;
  wrapperPath: string;
  envVarsText: string;
  cliArgsText: string;
  authMode: CliAuthMode;
  enabled: boolean;
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

  const [state, setState] = useState<FormState>({
    name: provider?.name ?? metadata.name,
    label: provider?.label ?? metadata.displayName,
    executablePath: provider?.executablePath ?? '',
    wrapperPath: provider?.wrapperPath ?? '',
    envVarsText: envVarsToText(provider?.envVars),
    cliArgsText: (provider?.cliArgs ?? []).join('\n'),
    authMode: provider?.authMode ?? metadata.defaultAuthMode,
    enabled: provider?.enabled ?? true,
  });

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const payload = {
        name: state.name,
        label: state.label,
        executablePath: state.executablePath || undefined,
        wrapperPath: state.wrapperPath || undefined,
        envVars: parseEnvVars(state.envVarsText),
        cliArgs: parseCliArgs(state.cliArgsText),
        authMode: state.authMode,
        enabled: state.enabled,
      };
      if (mode === 'create') {
        await api.post('/cli-providers', payload);
        router.push('/settings/cli-providers');
      } else if (provider) {
        await api.patch(`/cli-providers/${provider.id}`, payload);
        router.push(`/settings/cli-providers/${provider.id}`);
      }
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
          One KEY=VALUE per line. Stored as plaintext metadata; use Secrets for sensitive values.
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
          One argument per line. Prepended to every invocation.
        </p>
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
