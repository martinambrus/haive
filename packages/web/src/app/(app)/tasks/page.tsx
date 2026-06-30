'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { memo, useEffect, useRef, useState } from 'react';
import { api, type Task, type TaskListResponse, type TaskStatus } from '@/lib/api-client';
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { formatDuration } from '@/lib/format-duration';
import { formatTokens } from '@/lib/format-tokens';
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

// Memoized list row. The 3s poll replaces the tasks array each tick (new refs →
// rows re-render, acceptable), but typing in the search box re-renders TasksPage
// WITHOUT changing the tasks array — so memo bails and a keystroke no longer
// reconciles all loaded rows. Props are just `task`; everything else it uses is a
// module-level helper.
const TaskRow = memo(function TaskRow({ task }: { task: Task }) {
  return (
    <Link href={`/tasks/${task.id}`} className="block">
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
            {task.tokenUsage && task.tokenUsage.totalTokens > 0 && (
              <span
                className="text-sky-300"
                title={`CLI tokens (provider-native): in ${task.tokenUsage.inputTokens.toLocaleString()} / out ${task.tokenUsage.outputTokens.toLocaleString()} / total ${task.tokenUsage.totalTokens.toLocaleString()}`}
              >
                {formatTokens(task.tokenUsage.totalTokens)} tok
              </span>
            )}
          </div>
        )}
      </Card>
    </Link>
  );
});

const FILTER_SELECT_CLASS =
  'h-9 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500';

// One page of tasks per fetch; the listing scrolls further pages in on demand.
const PAGE_SIZE = 20;
// The 3s live poll re-fetches the loaded span (newest-first) and refreshes it in
// place. Capped so a deep scroll doesn't refetch an unbounded set every tick;
// rows scrolled past this stay loaded but only refresh on the next scroll/filter.
const POLL_MAX = 100;

// Persist the user's last manually-chosen filter so returning to a bare
// /tasks restores it instead of resetting to "All". Deep-links from the
// repositories page carry ?repositoryId/?status and bypass this. The search
// term (?q) is intentionally URL-only — not persisted — so a stale search is
// not restored on a later visit.
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

// Merge a freshly-polled newest-first span into the current list. `fresh` is the
// authoritative window for the current filter — new tasks, status/timing changes,
// and drop-outs are all reflected. The older tail beyond the polled window is
// kept from `prev` so a deep scroll is not truncated. createdAt is immutable, so
// the oldest fresh row's timestamp cleanly splits refreshed-window from the
// static tail (and id membership prevents duplicating a boundary row).
function mergeSpan(prev: Task[] | null, fresh: Task[]): Task[] {
  const oldest = fresh[fresh.length - 1];
  if (!prev || !oldest || prev.length <= fresh.length) return fresh;
  const cutoff = new Date(oldest.createdAt).getTime();
  const freshIds = new Set(fresh.map((t) => t.id));
  const tail = prev.filter((t) => !freshIds.has(t.id) && new Date(t.createdAt).getTime() < cutoff);
  return [...fresh, ...tail];
}

export default function TasksPage() {
  usePageTitle('Tasks');
  const router = useRouter();
  const searchParams = useSearchParams();
  const repoFilter = searchParams.get('repositoryId') ?? '';
  const statusFilter = searchParams.get('status') ?? '';
  const q = searchParams.get('q') ?? '';
  const filterKey = `${repoFilter}|${statusFilter}|${q}`;
  const filtersActive = Boolean(repoFilter || statusFilter || q);

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [total, setTotal] = useState(0);
  const [repoOptions, setRepoOptions] = useState<{ id: string; name: string }[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(q);

  // Latest loaded list / loadMore, so the poll and the IntersectionObserver can
  // read the freshest values without being torn down and rebuilt every render.
  const tasksRef = useRef<Task[] | null>(null);
  tasksRef.current = tasks;
  const loadMoreRef = useRef<() => void>(() => {});
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loaded = tasks?.length ?? 0;
  const hasMore = tasks !== null && loaded < total;

  function qsFor(page: number, pageSize: number): string {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    if (repoFilter) params.set('repositoryId', repoFilter);
    if (statusFilter) params.set('status', statusFilter);
    if (q) params.set('q', q);
    return params.toString();
  }

  // Initial load + reset whenever a filter changes, plus the 3s live poll that
  // refreshes the currently-loaded span in place (newest-first).
  useEffect(() => {
    let cancelled = false;
    const fetchSpan = async (count: number) => {
      try {
        const data = await api.get<TaskListResponse>(`/tasks?${qsFor(1, count)}`);
        if (cancelled) return;
        setTasks((prev) => mergeSpan(prev, data.tasks));
        setTotal(data.total);
        setRepoOptions(data.repositories);
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to load tasks');
      }
    };
    setTasks(null);
    setTotal(0);
    void fetchSpan(PAGE_SIZE);
    const timer = setInterval(() => {
      const n = tasksRef.current?.length ?? 0;
      void fetchSpan(Math.min(Math.max(n, PAGE_SIZE), POLL_MAX));
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey]);

  // Append the next page (older rows) on scroll. Dedups by id so an offset shift
  // from a task created at the top mid-scroll cannot duplicate a boundary row.
  async function loadMore() {
    const have = tasksRef.current?.length ?? 0;
    if (loadingMore || have === 0 || have >= total) return;
    setLoadingMore(true);
    try {
      const nextPage = Math.floor(have / PAGE_SIZE) + 1;
      const data = await api.get<TaskListResponse>(`/tasks?${qsFor(nextPage, PAGE_SIZE)}`);
      setTasks((prev) => {
        const byId = new Map((prev ?? []).map((t) => [t.id, t] as const));
        for (const t of data.tasks) byId.set(t.id, t);
        return Array.from(byId.values());
      });
      setTotal(data.total);
      setRepoOptions(data.repositories);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load more tasks');
    } finally {
      setLoadingMore(false);
    }
  }
  loadMoreRef.current = loadMore;

  // Observe the bottom sentinel; load the next page as it scrolls into view.
  // Re-attached when `hasMore` flips so it binds the sentinel once it renders.
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMoreRef.current();
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore]);

  // Debounce the search box into the ?q param (which drives the server fetch).
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== q) setFilter('q', search);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

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

  function setFilter(key: 'repositoryId' | 'status' | 'q', value: string) {
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
    setSearch('');
    router.replace('/tasks', { scroll: false });
  }

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
          <input
            type="search"
            aria-label="Search tasks by title"
            placeholder="Search title..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`${FILTER_SELECT_CLASS} w-44`}
          />
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
            <option value="unfinished">Unfinished</option>
            <option value="active">In progress</option>
            <option value="waiting_user">Waiting on you</option>
            <option value="open">Open</option>
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

      {tasks && tasks.length === 0 && !filtersActive && (
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

      {tasks && tasks.length === 0 && filtersActive && (
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <span>No tasks match the current filters.</span>
          <button type="button" onClick={clearFilters} className="text-indigo-400 underline">
            Clear filters
          </button>
        </div>
      )}

      {tasks && tasks.length > 0 && (
        <div className="grid gap-3">
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      )}

      {hasMore && (
        <div ref={sentinelRef} className="py-4 text-center text-sm text-neutral-500">
          {loadingMore ? 'Loading more...' : ''}
        </div>
      )}
    </div>
  );
}
