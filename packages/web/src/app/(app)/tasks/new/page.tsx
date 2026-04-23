'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type CliProvider,
  type CliProviderCatalogEntry,
  type OnboardingStatus,
  type Repository,
  type Task,
  type WorkflowType,
} from '@/lib/api-client';
import {
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  FormError,
  Input,
  Label,
} from '@/components/ui';

export default function NewTaskPage() {
  const router = useRouter();
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [providers, setProviders] = useState<CliProvider[] | null>(null);
  const [catalog, setCatalog] = useState<CliProviderCatalogEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repositoryId, setRepositoryId] = useState<string>('');
  const [cliProviderId, setCliProviderId] = useState<string>('');

  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [resetting, setResetting] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [repoRes, providerRes, catalogRes] = await Promise.all([
          api.get<{ repositories: Repository[] }>('/repos'),
          api.get<{ providers: CliProvider[] }>('/cli-providers').catch(() => ({
            providers: [],
          })),
          api
            .get<{ providers: CliProviderCatalogEntry[] }>('/cli-providers/catalog')
            .catch(() => ({ providers: [] })),
        ]);
        if (cancelled) return;
        setRepos(repoRes.repositories);
        setProviders(providerRes.providers);
        setCatalog(catalogRes.providers);
      } catch (err) {
        if (cancelled) return;
        setLoadError((err as Error).message ?? 'Failed to load repositories');
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshStatus = useCallback(async (repoId: string) => {
    if (!repoId) {
      setOnboardingStatus(null);
      setStatusError(null);
      return;
    }
    setStatusLoading(true);
    setStatusError(null);
    try {
      const res = await api.get<OnboardingStatus>(`/repos/${repoId}/onboarding-status`);
      setOnboardingStatus(res);
    } catch (err) {
      setOnboardingStatus(null);
      setStatusError((err as Error).message ?? 'Failed to check onboarding status');
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus(repositoryId);
  }, [repositoryId, refreshStatus]);

  async function handleResetOnboarding() {
    if (!repositoryId) return;
    const confirmed = window.confirm(
      'This will permanently remove onboarding artifacts from the repository so onboarding can run again:\n' +
        '  • delete .claude/ and .ripgreprc\n' +
        '  • strip haive-managed blocks from AGENTS.md, CLAUDE.md, and GEMINI.md (file removed if empty after)\n\n' +
        'User-authored content outside those marker blocks is preserved. This cannot be undone. Continue?',
    );
    if (!confirmed) return;
    setResetting(true);
    try {
      await api.delete<{ ok: boolean; removed: string[]; cleaned: string[] }>(
        `/repos/${repositoryId}/onboarding-artifacts`,
      );
      await refreshStatus(repositoryId);
    } catch (err) {
      setStatusError((err as Error).message ?? 'Failed to reset onboarding');
    } finally {
      setResetting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (!repositoryId) {
      setError('Repository is required');
      return;
    }
    if (!onboardingStatus) {
      setError('Waiting for onboarding status check');
      return;
    }
    const type: WorkflowType = onboardingStatus.onboarded ? 'workflow' : 'onboarding';

    setError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        type,
        title: title.trim(),
        repositoryId,
      };
      if (description.trim()) body.description = description.trim();
      if (cliProviderId) body.cliProviderId = cliProviderId;

      const data = await api.post<{ task: Task }>('/tasks', body);
      router.push(`/tasks/${data.task.id}`);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to create task');
      setSubmitting(false);
    }
  }

  const readyRepos = repos?.filter((r) => r.status === 'ready') ?? [];
  const inferredType: WorkflowType | null = onboardingStatus
    ? onboardingStatus.onboarded
      ? 'workflow'
      : 'onboarding'
    : null;

  const selectedProvider = (providers ?? []).find((p) => p.id === cliProviderId) ?? null;
  const selectedProviderMeta = selectedProvider
    ? ((catalog ?? []).find((c) => c.name === selectedProvider.name) ?? null)
    : null;
  // Onboarding produces long-lived agent/skill/KB files. A below-max effort
  // here propagates into every later task that runs against the same repo,
  // so we surface a yellow warning before the user commits to it.
  const effortWarning =
    inferredType === 'onboarding' &&
    selectedProvider &&
    selectedProviderMeta?.effortScale &&
    (selectedProvider.effortLevel ?? selectedProviderMeta.effortScale.max) !==
      selectedProviderMeta.effortScale.max
      ? {
          chosen: selectedProvider.effortLevel ?? selectedProviderMeta.effortScale.max,
          max: selectedProviderMeta.effortScale.max,
          providerLabel: selectedProvider.label,
        }
      : null;

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-50">New task</h1>
          <p className="text-sm text-neutral-400">
            Workflow type is auto-detected from the selected repository. Onboarded repos run the
            autonomous workflow; fresh repos run onboarding.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onboardingStatus?.onboarded && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={resetting}
              onClick={handleResetOnboarding}
            >
              {resetting ? 'Resetting...' : 'Re-run onboarding'}
            </Button>
          )}
          <Link href="/tasks">
            <Button variant="secondary" size="sm">
              Cancel
            </Button>
          </Link>
        </div>
      </div>

      {loadError && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {loadError}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repositoryId">Repository</Label>
          <select
            id="repositoryId"
            value={repositoryId}
            onChange={(e) => setRepositoryId(e.target.value)}
            className="h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            required
          >
            <option value="">(select a repository)</option>
            {readyRepos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name} {repo.detectedFramework ? `(${repo.detectedFramework})` : ''}
              </option>
            ))}
          </select>
          {repos && readyRepos.length === 0 && (
            <p className="text-xs text-neutral-500">
              No ready repositories.{' '}
              <Link href="/repos/new" className="underline">
                Add one
              </Link>{' '}
              first.
            </p>
          )}
          {repositoryId && (
            <div className="mt-1 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs">
              {statusLoading && <span className="text-neutral-400">Checking onboarding...</span>}
              {statusError && <span className="text-red-400">{statusError}</span>}
              {!statusLoading && !statusError && onboardingStatus && (
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        onboardingStatus.onboarded
                          ? 'rounded bg-green-950/50 px-2 py-0.5 text-green-300'
                          : 'rounded bg-amber-950/50 px-2 py-0.5 text-amber-300'
                      }
                    >
                      {onboardingStatus.onboarded ? 'Onboarded' : 'Not onboarded'}
                    </span>
                    <span className="text-neutral-400">
                      Will run: <strong>{inferredType}</strong>
                    </span>
                  </div>
                  {!onboardingStatus.onboarded && onboardingStatus.missing.length > 0 && (
                    <p className="text-neutral-500">
                      Missing: {onboardingStatus.missing.join(', ')}
                    </p>
                  )}
                  {onboardingStatus.onboarded && (
                    <p className="text-neutral-500">
                      Use &quot;Re-run onboarding&quot; above to wipe the generated workflow files
                      and start fresh.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={inferredType === 'workflow' ? 'Implement feature X' : 'Onboard repo'}
            required
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="description">Description (optional)</Label>
          <textarea
            id="description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short note about this run"
            className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cliProviderId">CLI provider (optional)</Label>
          <select
            id="cliProviderId"
            value={cliProviderId}
            onChange={(e) => setCliProviderId(e.target.value)}
            className="h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          >
            <option value="">(none — deterministic steps only)</option>
            {(providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.name})
              </option>
            ))}
          </select>
          {effortWarning && (
            <div className="mt-2 rounded-md border border-amber-700 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
              <strong>Reasoning effort below maximum.</strong> Provider{' '}
              <code className="font-mono">{effortWarning.providerLabel}</code> is set to{' '}
              <code className="font-mono">{effortWarning.chosen}</code> (max:{' '}
              <code className="font-mono">{effortWarning.max}</code>). Onboarding produces
              long-lived agent, skill, and knowledge-base files that every later task against this
              repository inherits — running it below the maximum effort can degrade the quality of
              every future workflow. Adjust the level on the provider in Settings &rarr; CLI
              providers, or pick a different provider, before continuing.
            </div>
          )}
        </div>

        <FormError message={error} />

        <div>
          <Button type="submit" disabled={submitting || !onboardingStatus}>
            {submitting ? 'Creating...' : 'Create task'}
          </Button>
        </div>
      </form>

      {repos === null && (
        <Card>
          <CardHeader>
            <CardTitle>Loading...</CardTitle>
            <CardDescription>Fetching repositories.</CardDescription>
          </CardHeader>
        </Card>
      )}
    </div>
  );
}
