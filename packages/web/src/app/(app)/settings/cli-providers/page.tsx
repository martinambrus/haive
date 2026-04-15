'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  api,
  type CliProbePathResult,
  type CliProbeResult,
  type CliProvider,
  type CliProviderMetadata,
} from '@/lib/api-client';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  FormError,
} from '@/components/ui';

interface TestState {
  testing: boolean;
  result: CliProbeResult | null;
  error: string | null;
}

export default function CliProvidersPage() {
  const [providers, setProviders] = useState<CliProvider[] | null>(null);
  const [catalog, setCatalog] = useState<CliProviderMetadata[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});

  async function load() {
    try {
      const [providersData, catalogData] = await Promise.all([
        api.get<{ providers: CliProvider[] }>('/cli-providers'),
        api.get<{ providers: CliProviderMetadata[] }>('/cli-providers/catalog'),
      ]);
      setProviders(providersData.providers);
      setCatalog(catalogData.providers);
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

  async function handleTest(id: string) {
    setTestStates((s) => ({ ...s, [id]: { testing: true, result: null, error: null } }));
    try {
      const data = await api.post<{ result: CliProbeResult }>(`/cli-providers/${id}/test`);
      setTestStates((s) => ({
        ...s,
        [id]: { testing: false, result: data.result, error: null },
      }));
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
            {providers.length === 0 ? (
              <p className="text-sm text-neutral-500">None yet. Pick a CLI below to get started.</p>
            ) : (
              <div className="grid gap-3">
                {providers.map((p) => {
                  const meta = catalog.find((m) => m.name === p.name);
                  const testState = testStates[p.id];
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
                          <Link href={`/settings/cli-providers/${p.id}`}>
                            <Button variant="secondary" size="sm">
                              Edit
                            </Button>
                          </Link>
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
                            <TestPathLine label="CLI" res={testState.result.cli} />
                          )}
                          {testState.result?.api && (
                            <TestPathLine label="API" res={testState.result.api} />
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
                      {m.supportsApi && <Badge>API</Badge>}
                      {m.supportsCliAuth && <Badge>subscription</Badge>}
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

function TestPathLine({ label, res }: { label: string; res: CliProbePathResult }) {
  return (
    <div className="mt-1 flex items-start gap-2 text-xs">
      <span className="font-semibold text-neutral-400">{label}</span>
      <Badge variant={res.ok ? 'success' : 'error'}>{res.ok ? 'OK' : 'FAIL'}</Badge>
      {typeof res.durationMs === 'number' && (
        <span className="text-neutral-500">{res.durationMs}ms</span>
      )}
      <pre className="flex-1 whitespace-pre-wrap break-words font-mono text-neutral-400">
        {res.ok ? (res.detail ?? '') : (res.error ?? '')}
      </pre>
    </div>
  );
}
