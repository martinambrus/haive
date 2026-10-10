'use client';

import { Suspense, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, type RagUsageAssessment } from '@/lib/api-client';
import { usePageTitle } from '@/lib/use-page-title';
import { ragUsageStyle } from '@/lib/rag-usage';
import { Button, Card, Input, Label } from '@/components/ui';
import { MarkdownView } from '@/components/markdown/markdown-view';

type TaskChoice = { id: string; title: string };
type QueryChoice = {
  id: string;
  query: string;
  topK: number | null;
  hitCount: number;
  createdAt: string;
  usageAssessment?: RagUsageAssessment | null;
};
type RecordedQuery = QueryChoice & {
  taskId: string;
  taskTitle: string;
  hits: unknown[] | null;
  text: string | null;
  usageAssessment: RagUsageAssessment | null;
};
type SearchResult = { hits: unknown[]; text: string; query: string; topK: number };
const BASE = '/rag/playground';

export default function RagPlaygroundPage() {
  return (
    <Suspense fallback={<p className="text-sm text-neutral-400">Loading playground…</p>}>
      <RagPlayground />
    </Suspense>
  );
}

function RagPlayground() {
  usePageTitle('RAG Playground');
  const router = useRouter();
  const params = useSearchParams();
  const queryId = params.get('queryId');
  const [tasks, setTasks] = useState<TaskChoice[]>([]);
  const [taskSearch, setTaskSearch] = useState('');
  const [taskPage, setTaskPage] = useState(1);
  const [moreTasks, setMoreTasks] = useState(false);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [task, setTask] = useState<TaskChoice | null>(null);
  const [queries, setQueries] = useState<QueryChoice[]>([]);
  const [queryPage, setQueryPage] = useState(1);
  const [moreQueries, setMoreQueries] = useState(false);
  const [queriesLoading, setQueriesLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(8);
  const [recorded, setRecorded] = useState<RecordedQuery | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loadingRecorded, setLoadingRecorded] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runVersion = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setTasksLoading(true);
    const timer = setTimeout(() => {
      api
        .get<{ tasks: TaskChoice[]; hasMore: boolean }>(
          `${BASE}/tasks?q=${encodeURIComponent(taskSearch)}&page=${taskPage}`,
        )
        .then((data) => {
          if (cancelled) return;
          setTasks(data.tasks);
          setMoreTasks(data.hasMore);
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message);
        })
        .finally(() => {
          if (!cancelled) setTasksLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [taskSearch, taskPage]);

  useEffect(() => {
    if (!task) return;
    let cancelled = false;
    setQueriesLoading(true);
    setQueries([]);
    api
      .get<{ queries: QueryChoice[]; hasMore: boolean }>(
        `${BASE}/tasks/${task.id}/queries?page=${queryPage}`,
      )
      .then((data) => {
        if (cancelled) return;
        setQueries(data.queries);
        setMoreQueries(data.hasMore);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setQueriesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [task?.id, queryPage]);

  useEffect(() => {
    if (!queryId) return;
    let cancelled = false;
    runVersion.current += 1;
    setRunning(false);
    setLoadingRecorded(true);
    setRecorded(null);
    setResult(null);
    setError(null);
    api
      .get<RecordedQuery>(`${BASE}/queries/${encodeURIComponent(queryId)}`)
      .then((data) => {
        if (cancelled) return;
        setTask({ id: data.taskId, title: data.taskTitle });
        setQueryPage(1);
        setQuery(data.query);
        setTopK(data.topK ?? 8);
        setRecorded(data);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoadingRecorded(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryId]);

  function chooseTask(next: TaskChoice) {
    runVersion.current += 1;
    router.replace('/settings/rag-playground', { scroll: false });
    setTask(next);
    setQueryPage(1);
    setRecorded(null);
    setResult(null);
    setQuery('');
    setTopK(8);
    setRunning(false);
    setLoadingRecorded(false);
    setError(null);
  }

  async function run(event: FormEvent) {
    event.preventDefault();
    if (!task || !query.trim()) return;
    const version = ++runVersion.current;
    const submittedQuery = query.trim();
    const submittedTopK = topK;
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      const data = await api.post<{ hits: unknown[]; text: string }>(`${BASE}/search`, {
        taskId: task.id,
        query: submittedQuery,
        top_k: submittedTopK,
      });
      if (runVersion.current === version)
        setResult({ ...data, query: submittedQuery, topK: submittedTopK });
    } catch (e) {
      if (runVersion.current === version) setError((e as Error).message);
    } finally {
      if (runVersion.current === version) setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-neutral-100">RAG Playground</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Inspect the results returned to an agent, or try a query using a task’s repository and
          global knowledge context. Reruns search the current index and may differ from the
          original.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="grid gap-5 lg:grid-cols-[minmax(240px,1fr)_minmax(0,3fr)]">
        <Card className="flex flex-col gap-3 self-start p-4">
          <Label htmlFor="task-search">Your tasks</Label>
          <Input
            id="task-search"
            placeholder="Search tasks by title"
            value={taskSearch}
            onChange={(e) => {
              setTaskSearch(e.target.value);
              setTaskPage(1);
            }}
          />
          {tasksLoading ? (
            <p className="text-sm text-neutral-500">Loading tasks…</p>
          ) : (
            <div className="flex max-h-80 flex-col gap-1 overflow-auto">
              {tasks.length === 0 && <p className="text-sm text-neutral-500">No matching tasks.</p>}
              {tasks.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  aria-pressed={task?.id === choice.id}
                  onClick={() => chooseTask(choice)}
                  className={`rounded px-2 py-2 text-left text-sm hover:bg-neutral-800 ${
                    task?.id === choice.id ? 'bg-neutral-800 text-indigo-300' : 'text-neutral-300'
                  }`}
                >
                  {choice.title}
                </button>
              ))}
            </div>
          )}
          <Pagination
            page={taskPage}
            hasMore={moreTasks}
            disabled={tasksLoading}
            onChange={setTaskPage}
          />
        </Card>
        <div className="flex min-w-0 flex-col gap-5">
          <Card className="p-4">
            {task ? (
              <form onSubmit={run} className="flex flex-col gap-3">
                <div className="text-sm text-neutral-300">
                  Task context:{' '}
                  <Link href={`/tasks/${task.id}`} className="text-indigo-300 hover:underline">
                    {task.title}
                  </Link>
                </div>
                <Label htmlFor="rag-query">Query</Label>
                <textarea
                  id="rag-query"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  required
                  maxLength={10000}
                  rows={3}
                  disabled={running || loadingRecorded}
                  className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100"
                  placeholder="Natural language or code keywords"
                />
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="rag-top-k">Max results</Label>
                    <Input
                      id="rag-top-k"
                      type="number"
                      min={1}
                      max={50}
                      required
                      value={Number.isNaN(topK) ? '' : topK}
                      disabled={running || loadingRecorded}
                      className="w-24"
                      onChange={(e) => setTopK(e.target.valueAsNumber)}
                    />
                  </div>
                  <Button type="submit" disabled={running || loadingRecorded || !query.trim()}>
                    {running ? 'Searching…' : 'Run query'}
                  </Button>
                </div>
                <p className="text-xs text-neutral-500">
                  Playground runs do not count toward task RAG statistics.
                </p>
              </form>
            ) : (
              <p className="text-sm text-neutral-400">
                Choose a task to set the retrieval context.
              </p>
            )}
          </Card>
          {loadingRecorded && (
            <p role="status" className="text-sm text-neutral-400">
              Loading original results…
            </p>
          )}
          {recorded?.usageAssessment && (
            <Card className="p-4">
              <h3 className="font-medium text-neutral-100">
                Usage review: {recorded.usageAssessment.status}
              </h3>
              <MarkdownView body={recorded.usageAssessment.reason} />
              {recorded.usageAssessment.evidence.map((item, index) => (
                <blockquote key={index} className="mt-3 border-l-2 border-neutral-700 pl-3">
                  <p className="text-xs text-neutral-500">Agent run {item.invocationId}</p>
                  <MarkdownView body={item.quote} />
                </blockquote>
              ))}
            </Card>
          )}
          {recorded &&
            (recorded.hits === null ? (
              <Card className="p-4 text-sm text-neutral-400">
                Original results were not saved for this query. Run it to see results from the
                current index.
              </Card>
            ) : (
              <Results
                title="Original agent results"
                text={recorded.text ?? ''}
                count={recorded.hits.length}
                query={recorded.query}
                timestamp={recorded.createdAt}
              />
            ))}
          {running && (
            <p role="status" className="text-sm text-neutral-400">
              Searching the current index…
            </p>
          )}
          {result && (
            <Results
              title="Current results"
              text={result.text}
              count={result.hits.length}
              query={result.query}
            />
          )}
          {task && (
            <Card className="flex flex-col gap-3 p-4">
              <h3 className="font-medium text-neutral-100">Recorded queries</h3>
              {queriesLoading ? (
                <p className="text-sm text-neutral-500">Loading queries…</p>
              ) : (
                <div className="flex max-h-80 flex-col gap-2 overflow-auto">
                  {queries.length === 0 && (
                    <p className="text-sm text-neutral-500">
                      No RAG queries recorded for this task.
                    </p>
                  )}
                  {queries.map((entry) => (
                    <Link
                      key={entry.id}
                      href={`/settings/rag-playground?queryId=${entry.id}`}
                      scroll={false}
                      aria-current={queryId === entry.id ? 'true' : undefined}
                      className={`rounded border border-neutral-800 p-3 hover:bg-neutral-800 ${ragUsageStyle(entry.usageAssessment).className}`}
                    >
                      <span className="block break-words text-sm text-indigo-300">
                        {entry.query}
                      </span>
                      <span className="text-xs text-neutral-500">
                        {new Date(entry.createdAt).toLocaleString()} · {entry.hitCount} hits · max{' '}
                        {entry.topK ?? 8}
                        {' · '}
                        {ragUsageStyle(entry.usageAssessment).label}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
              <Pagination
                page={queryPage}
                hasMore={moreQueries}
                disabled={queriesLoading}
                onChange={setQueryPage}
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Pagination({
  page,
  hasMore,
  disabled,
  onChange,
}: {
  page: number;
  hasMore: boolean;
  disabled: boolean;
  onChange: (page: number) => void;
}) {
  if (page === 1 && !hasMore) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-400">
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled || page === 1}
        onClick={() => onChange(page - 1)}
      >
        Previous
      </Button>
      <span>Page {page}</span>
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled || !hasMore}
        onClick={() => onChange(page + 1)}
      >
        Next
      </Button>
    </div>
  );
}

function Results({
  title,
  text,
  count,
  query,
  timestamp,
}: {
  title: string;
  text: string;
  count: number;
  query: string;
  timestamp?: string;
}) {
  return (
    <Card className="min-w-0 p-4">
      <h3 className="font-medium text-neutral-100">
        {title} · {count} hits
      </h3>
      <p className="mt-1 break-words text-xs text-neutral-400">Query: {query}</p>
      {timestamp && (
        <p className="mt-1 text-xs text-neutral-500">
          Returned {new Date(timestamp).toLocaleString()}
        </p>
      )}
      <div className="mt-4">
        {count === 0 ? (
          <p className="text-sm text-neutral-400">No RAG hits.</p>
        ) : (
          <MarkdownView body={text} enhanced={false} toolbar />
        )}
      </div>
    </Card>
  );
}
