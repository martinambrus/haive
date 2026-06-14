'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { api, type Task, type TaskStatus } from '@/lib/api-client';
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { formatDuration } from '@/lib/format-duration';
import { usePageTitle } from '@/lib/use-page-title';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error';

function statusVariant(status: TaskStatus): BadgeVariant {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
    case 'cancelled':
      return 'error';
    case 'waiting_user':
      return 'warning';
    default:
      return 'default';
  }
}

const TYPE_LABELS: Record<string, string> = {
  onboarding: 'Onboarding',
  workflow: 'Workflow',
  onboarding_upgrade: 'Onboarding upgrade',
  env_replicate: 'Env replicate', // legacy tasks only
};

// Status filter tokens shared by the dropdown and the repositories-page badge
// links. 'open' = non-terminal; 'active' = open minus waiting_user — the same
// sets the repo list counts with.
const OPEN_STATUSES = new Set(['created', 'queued', 'running', 'paused', 'waiting_user']);
const ACTIVE_STATUSES = new Set(['created', 'queued', 'running', 'paused']);

function matchesStatus(status: TaskStatus, filter: string): boolean {
  if (!filter) return true;
  if (filter === 'open') return OPEN_STATUSES.has(status);
  if (filter === 'active') return ACTIVE_STATUSES.has(status);
  return status === filter;
}

const FILTER_SELECT_CLASS =
  'h-9 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500';

// Persist the user's last manually-chosen filter so returning to a bare
// /tasks restores it instead of resetting to "All". Deep-links from the
// repositories page carry ?repositoryId/?status and bypass this.
const FILTER_STORAGE_KEY = 'haive:tasks-filter';

type SavedFilter = { repositoryId: string; status: string };

function readSavedFilter(): SavedFilter | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedFilter>;
    return { repositoryId: parsed.repositoryId ?? '', status: parsed.status ?? '' };
  } catch {
    return null;
  }
}

function writeSavedFilter(filter: SavedFilter): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(filter));
  } catch {
    // storage disabled or over quota — remembering the filter is best-effort
  }
}

export default function TasksPage() {
  usePageTitle('Tasks');
  const router = useRouter();
  const searchParams = useSearchParams();
  const repoFilter = searchParams.get('repositoryId') ?? '';
  const statusFilter = searchParams.get('status') ?? '';

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const data = await api.get<{ tasks: Task[] }>('/tasks');
      setTasks(data.tasks);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load tasks');
    }
  }

  useEffect(() => {
    void reload();
    const timer = setInterval(reload, 3000);
    return () => clearInterval(timer);
  }, []);

  // Restore the last manually-chosen filter on a fresh, unfiltered visit
  // (e.g. arriving from the nav). Repo-badge deep-links include params and
  // win, so they skip this. Mount-only by design.
  useEffect(() => {
    if (searchParams.has('repositoryId') || searchParams.has('status')) return;
    const saved = readSavedFilter();
    if (!saved || (!saved.repositoryId && !saved.status)) return;
    const params = new URLSearchParams();
    if (saved.repositoryId) params.set('repositoryId', saved.repositoryId);
    if (saved.status) params.set('status', saved.status);
    router.replace(`/tasks?${params.toString()}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setFilter(key: 'repositoryId' | 'status', value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    writeSavedFilter({
      repositoryId: params.get('repositoryId') ?? '',
      status: params.get('status') ?? '',
    });
    const qs = params.toString();
    router.replace(qs ? `/tasks?${qs}` : '/tasks', { scroll: false });
  }

  function clearFilters() {
    writeSavedFilter({ repositoryId: '', status: '' });
    router.replace('/tasks', { scroll: false });
  }

  // Repos that own at least one task, for the repository dropdown. Derived from
  // the full (unfiltered) task list so the options stay stable as filters change.
  const repoOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const t of tasks ?? []) {
      if (t.repository) byId.set(t.repository.id, t.repository.name);
    }
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [tasks]);

  const visible = (tasks ?? []).filter(
    (t) => (!repoFilter || t.repositoryId === repoFilter) && matchesStatus(t.status, statusFilter),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-50">Tasks</h1>
          <p className="text-sm text-neutral-400">
            Deterministic step engine runs. Status refreshes every few seconds.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Filter by repository"
            value={repoFilter}
            onChange={(e) => setFilter('repositoryId', e.target.value)}
            className={FILTER_SELECT_CLASS}
          >
            <option value="">All repositories</option>
            {repoOptions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(e) => setFilter('status', e.target.value)}
            className={FILTER_SELECT_CLASS}
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="active">Active</option>
            <option value="waiting_user">Waiting on you</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <Link href="/tasks/new">
            <Button>New task</Button>
          </Link>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {tasks === null && <div className="text-sm text-neutral-500">Loading...</div>}

      {tasks && tasks.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No tasks yet</CardTitle>
            <CardDescription>
              Create one to run the onboarding step engine against a repository.
            </CardDescription>
          </CardHeader>
          <Link href="/tasks/new">
            <Button size="sm">New task</Button>
          </Link>
        </Card>
      )}

      {tasks && tasks.length > 0 && visible.length === 0 && (
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <span>No tasks match the current filters.</span>
          <button type="button" onClick={clearFilters} className="text-indigo-400 underline">
            Clear filters
          </button>
        </div>
      )}

      {tasks && visible.length > 0 && (
        <div className="grid gap-3">
          {visible.map((task) => (
            <Link key={task.id} href={`/tasks/${task.id}`} className="block">
              <Card className="flex flex-col gap-2 transition-colors hover:border-indigo-700">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-semibold text-neutral-50">{task.title}</h2>
                    <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
                    <Badge>{TYPE_LABELS[task.type]}</Badge>
                    {task.repository && <Badge variant="info">repo: {task.repository.name}</Badge>}
                  </div>
                  <span className="text-xs text-neutral-500">
                    {new Date(task.createdAt).toLocaleString()}
                  </span>
                </div>
                {task.description && <p className="text-xs text-neutral-400">{task.description}</p>}
                <div className="flex items-center gap-3 text-xs text-neutral-500">
                  <span>Step index: {task.currentStepIndex}</span>
                  {task.currentStepId && <span>Current: {task.currentStepId}</span>}
                  {task.errorMessage && <span className="text-red-400">{task.errorMessage}</span>}
                </div>
                {task.timing && task.startedAt && (
                  <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
                    <span className="text-neutral-300" title="Wall clock since the task started">
                      wall {formatDuration(task.timing.wallMs)}
                    </span>
                    <span
                      className="text-indigo-400"
                      title="Agent active work time (idle waits and gaps excluded)"
                    >
                      work {formatDuration(task.timing.workMs)}
                    </span>
                    <span className="text-amber-400" title="Time the task sat waiting on you">
                      idle {formatDuration(task.timing.idleMs)}
                    </span>
                    <span
                      className="text-emerald-400"
                      title="Your active time at gates (focused while it waited)"
                    >
                      user {formatDuration(task.timing.userActiveMs)}
                    </span>
                  </div>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
