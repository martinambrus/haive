'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  api,
  type CliProvider,
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

const WORKFLOW_OPTIONS: { value: WorkflowType; label: string; description: string }[] = [
  {
    value: 'onboarding',
    label: 'Onboarding',
    description: 'Run deterministic environment detection and setup steps.',
  },
  {
    value: 'workflow',
    label: 'Workflow (autonomous)',
    description: 'Autonomous implementation loop with spec/verify/commit gates.',
  },
  {
    value: 'env_replicate',
    label: 'Environment replication',
    description: 'Build a sandboxed Docker image matching this project.',
  },
];

export default function NewTaskPage() {
  const router = useRouter();
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [providers, setProviders] = useState<CliProvider[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [type, setType] = useState<WorkflowType>('onboarding');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [repositoryId, setRepositoryId] = useState<string>('');
  const [cliProviderId, setCliProviderId] = useState<string>('');
  const [envReplicatePrelude, setEnvReplicatePrelude] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [repoRes, providerRes] = await Promise.all([
          api.get<{ repositories: Repository[] }>('/repos'),
          api.get<{ providers: CliProvider[] }>('/cli-providers').catch(() => ({
            providers: [],
          })),
        ]);
        if (cancelled) return;
        setRepos(repoRes.repositories);
        setProviders(providerRes.providers);
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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        type,
        title: title.trim(),
      };
      if (description.trim()) body.description = description.trim();
      if (repositoryId) body.repositoryId = repositoryId;
      if (cliProviderId) body.cliProviderId = cliProviderId;
      if (envReplicatePrelude && type !== 'env_replicate') {
        body.envReplicatePrelude = true;
      }

      const data = await api.post<{ task: Task }>('/tasks', body);
      router.push(`/tasks/${data.task.id}`);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to create task');
      setSubmitting(false);
    }
  }

  const readyRepos = repos?.filter((r) => r.status === 'ready') ?? [];

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-50">New task</h1>
          <p className="text-sm text-neutral-400">
            Pick a workflow type and target repository. CLI provider is optional for now.
          </p>
        </div>
        <Link href="/tasks">
          <Button variant="secondary" size="sm">
            Cancel
          </Button>
        </Link>
      </div>

      {loadError && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {loadError}
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label>Workflow type</Label>
          <div className="grid gap-2">
            {WORKFLOW_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${
                  type === opt.value
                    ? 'border-indigo-500 bg-indigo-950/30'
                    : 'border-neutral-800 bg-neutral-900/40 hover:border-neutral-700'
                }`}
              >
                <input
                  type="radio"
                  name="type"
                  value={opt.value}
                  checked={type === opt.value}
                  onChange={() => setType(opt.value)}
                  className="mt-1"
                />
                <div>
                  <div className="font-medium text-neutral-100">{opt.label}</div>
                  <div className="text-xs text-neutral-400">{opt.description}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Onboard my-drupal-site"
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
          <Label htmlFor="repositoryId">Repository</Label>
          <select
            id="repositoryId"
            value={repositoryId}
            onChange={(e) => setRepositoryId(e.target.value)}
            className="h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          >
            <option value="">(none)</option>
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
        </div>

        {type !== 'env_replicate' && (
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-3 text-sm hover:border-neutral-700">
            <input
              type="checkbox"
              checked={envReplicatePrelude}
              onChange={(e) => setEnvReplicatePrelude(e.target.checked)}
              className="mt-1"
            />
            <div>
              <div className="font-medium text-neutral-100">
                Set up sandboxed local environment first
              </div>
              <div className="text-xs text-neutral-400">
                Prepends the environment-replication step sequence (declare deps, generate
                Dockerfile, build image, verify) before the chosen workflow.
              </div>
            </div>
          </label>
        )}

        <FormError message={error} />

        <div>
          <Button type="submit" disabled={submitting}>
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
