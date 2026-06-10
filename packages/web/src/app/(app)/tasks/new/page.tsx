'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePageTitle } from '@/lib/use-page-title';
import {
  api,
  API_BASE_URL,
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

const DUMP_CHUNK_SIZE = 5 * 1024 * 1024; // 5 MiB

// Chunked upload of a DB dump (mirrors the repo archive upload). Returns the
// dbUploadId to attach to the task; the dump is imported + deleted later by the
// task's env-boot/import step.
async function chunkedUploadDbDump(opts: {
  file: File;
  onProgress: (pct: number) => void;
}): Promise<string> {
  const { file, onProgress } = opts;
  const initRes = await fetch(`${API_BASE_URL}/db-dumps/upload/init`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, totalSize: file.size, chunkSize: DUMP_CHUNK_SIZE }),
  });
  if (!initRes.ok) {
    const b = (await initRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `Failed to start dump upload (HTTP ${initRes.status})`);
  }
  const { session: initial } = (await initRes.json()) as {
    session: { id: string; bytesReceived: number };
  };
  let offset = initial.bytesReceived;
  onProgress(file.size === 0 ? 100 : Math.floor((offset / file.size) * 100));
  while (offset < file.size) {
    const end = Math.min(offset + DUMP_CHUNK_SIZE, file.size);
    const slice = file.slice(offset, end);
    const res = await fetch(`${API_BASE_URL}/db-dumps/upload/${initial.id}/chunk`, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${offset}-${end - 1}/${file.size}`,
      },
      body: slice,
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(b.error ?? `Dump chunk failed (HTTP ${res.status})`);
    }
    const { session } = (await res.json()) as { session: { bytesReceived: number } };
    offset = session.bytesReceived;
    onProgress(Math.floor((offset / file.size) * 100));
  }
  const completeRes = await fetch(`${API_BASE_URL}/db-dumps/upload/${initial.id}/complete`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!completeRes.ok) {
    const b = (await completeRes.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `Failed to finalize dump upload (HTTP ${completeRes.status})`);
  }
  return initial.id;
}

export default function NewTaskPage() {
  usePageTitle('New task');
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryRepoId = searchParams.get('repositoryId');
  const presetAppliedRef = useRef(false);
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [providers, setProviders] = useState<CliProvider[] | null>(null);
  const [catalog, setCatalog] = useState<CliProviderCatalogEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repositoryId, setRepositoryId] = useState<string>('');
  const [cliProviderId, setCliProviderId] = useState<string>('');
  /** Max iterations the spec-quality reviewer will loop through before
   *  surfacing gate 1, even if findings remain. Default 10 matches the
   *  loop hook's built-in default. */
  const [specQualityMaxIterations, setSpecQualityMaxIterations] = useState<number>(10);
  const [simplifyCode, setSimplifyCode] = useState(true);
  const [isBugFix, setIsBugFix] = useState(false);
  const [adversarialQaLevel, setAdversarialQaLevel] = useState<
    'none' | 'poc' | 'standard' | 'enterprise'
  >('none');

  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [resetting, setResetting] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dumpFile, setDumpFile] = useState<File | null>(null);
  const [dumpProgress, setDumpProgress] = useState(0);
  const [dumpUploading, setDumpUploading] = useState(false);

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
    if (presetAppliedRef.current || !queryRepoId || !repos) return;
    presetAppliedRef.current = true;
    if (repos.some((r) => r.id === queryRepoId && r.status === 'ready')) {
      setRepositoryId(queryRepoId);
    }
  }, [queryRepoId, repos]);

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
    if (type === 'workflow' && !description.trim()) {
      setError('Description is required for workflow tasks');
      return;
    }

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
      if (type === 'workflow') {
        body.stepLoopLimits = { '05-phase-0b5-spec-quality': specQualityMaxIterations };
        body.simplifyCode = simplifyCode;
        body.isBugFix = isBugFix;
        body.adversarialQaLevel = adversarialQaLevel;
      }

      if (type === 'workflow' && dumpFile) {
        setDumpUploading(true);
        try {
          body.dbUploadId = await chunkedUploadDbDump({
            file: dumpFile,
            onProgress: setDumpProgress,
          });
        } catch (err) {
          setError((err as Error).message ?? 'DB dump upload failed');
          setDumpUploading(false);
          setSubmitting(false);
          return;
        }
        setDumpUploading(false);
      }

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
          <Label htmlFor="description">
            Description{inferredType === 'workflow' ? '' : ' (optional)'}
          </Label>
          <textarea
            id="description"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What should the workflow accomplish? Be specific — this drives knowledge mining and planning."
            required={inferredType === 'workflow'}
            className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="cliProviderId">CLI provider (optional)</Label>
            <Link href="/settings/cli-providers">
              <Button type="button" variant="primary" size="sm">
                Add a CLI
              </Button>
            </Link>
          </div>
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

        {inferredType === 'workflow' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="specQualityMaxIterations">Spec-quality review passes</Label>
            <select
              id="specQualityMaxIterations"
              value={specQualityMaxIterations}
              onChange={(e) => setSpecQualityMaxIterations(Number(e.target.value))}
              className="h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            >
              <option value={3}>3 (default)</option>
              <option value={5}>5</option>
              <option value={10}>10</option>
              <option value={15}>15</option>
              <option value={20}>20</option>
            </select>
            <p className="text-xs text-neutral-500">
              The spec quality reviewer loops, amending the draft on each pass until no warn/error
              findings remain or this budget is hit. Higher values give the LLM more chances to
              converge but cost more tokens. Gate 1 will flag if the budget was exhausted with
              issues still open so you can decide whether to approve as-is or re-run.
            </p>
          </div>
        )}

        {inferredType === 'workflow' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="adversarialQaLevel">Adversarial QA (Phase 7)</Label>
            <select
              id="adversarialQaLevel"
              value={adversarialQaLevel}
              onChange={(e) =>
                setAdversarialQaLevel(e.target.value as 'none' | 'poc' | 'standard' | 'enterprise')
              }
              className="h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
            >
              <option value="none">None (default)</option>
              <option value="poc">POC — 2 agents (edge cases)</option>
              <option value="standard">Standard — 4 agents (OWASP)</option>
              <option value="enterprise">Enterprise — 6 agents (exhaustive)</option>
            </select>
            <p className="text-xs text-neutral-500">
              After code review, adversarial agents actively try to break the change (edge cases,
              auth, injection, logic flaws — proof-of-concept only, no destructive actions).
              Findings surface at Gate 2. Costs more tokens at higher levels.
            </p>
          </div>
        )}

        {inferredType === 'workflow' && (
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm text-neutral-100">
              <input
                type="checkbox"
                checked={simplifyCode}
                onChange={(e) => setSimplifyCode(e.target.checked)}
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-950"
              />
              AI code simplification pass after implementation (Phase 3.5)
            </label>
            <p className="text-xs text-neutral-500">
              A simplifier agent reviews the implemented code and reduces unnecessary complexity
              without changing functionality; if it edits anything, one fixup agent verifies the
              spec still holds. Single pass, before verification.
            </p>
          </div>
        )}

        {inferredType === 'workflow' && (
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm text-neutral-100">
              <input
                type="checkbox"
                checked={isBugFix}
                onChange={(e) => setIsBugFix(e.target.checked)}
                className="h-4 w-4 rounded border-neutral-700 bg-neutral-950"
              />
              This is a bug fix
            </label>
            <p className="text-xs text-neutral-500">
              At the learning step, an agent also writes a durable investigation (root cause + the
              lesson) into the knowledge base, so future runs find it via search. You review the
              draft before it is written.
            </p>
          </div>
        )}

        {inferredType === 'workflow' && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dbDump">Database dump (optional)</Label>
            <input
              id="dbDump"
              type="file"
              accept=".sql,.sql.gz,.dump"
              onChange={(e) => {
                setDumpFile(e.target.files?.[0] ?? null);
                setDumpProgress(0);
              }}
              className="block w-full text-sm text-neutral-300 file:mr-3 file:rounded-md file:border-0 file:bg-neutral-800 file:px-3 file:py-1.5 file:text-sm file:text-neutral-100 hover:file:bg-neutral-700"
            />
            <p className="text-xs text-neutral-500">
              Uploaded before the task runs and imported into the temporary environment, so
              migrations run against your real data. Accepts .sql, .sql.gz, .dump. Deleted
              immediately after import.
            </p>
            {dumpUploading && (
              <p className="text-xs text-indigo-300">Uploading dump… {dumpProgress}%</p>
            )}
          </div>
        )}

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
