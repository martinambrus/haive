'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, type CliProvider, type CliProviderMetadata } from '@/lib/api-client';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  FormError,
} from '@/components/ui';

export default function CliProvidersPage() {
  const [providers, setProviders] = useState<CliProvider[] | null>(null);
  const [catalog, setCatalog] = useState<CliProviderMetadata[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const configuredNames = new Set(providers?.map((p) => p.name) ?? []);
  const unconfigured = catalog?.filter((m) => !configuredNames.has(m.name)) ?? [];

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
                          </div>
                          {meta && (
                            <p className="mt-1 text-xs text-neutral-500">{meta.description}</p>
                          )}
                        </div>
                        <div className="flex flex-shrink-0 gap-2">
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
                    </Card>
                  );
                })}
              </div>
            )}
          </section>

          {unconfigured.length > 0 && (
            <section className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-neutral-100">Available</h2>
              <div className="grid gap-3 md:grid-cols-2">
                {unconfigured.map((m) => (
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
