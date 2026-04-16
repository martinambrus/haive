'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, type Task, type TaskStatus } from '@/lib/api-client';
import { Badge, Button, Card, CardDescription, CardHeader, CardTitle } from '@/components/ui';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error';

function statusVariant(status: TaskStatus): BadgeVariant {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
    case 'cancelled':
      return 'error';
    case 'waiting_user':
    case 'paused':
      return 'warning';
    default:
      return 'default';
  }
}

const TYPE_LABELS: Record<string, string> = {
  onboarding: 'Onboarding',
  workflow: 'Workflow',
  env_replicate: 'Env replicate', // legacy tasks only
};

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-50">Tasks</h1>
          <p className="text-sm text-neutral-400">
            Deterministic step engine runs. Status refreshes every few seconds.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showCancelled ? 'primary' : 'secondary'}
            size="sm"
            onClick={() => setShowCancelled((v) => !v)}
          >
            {showCancelled ? 'Hide cancelled' : 'Show cancelled'}
          </Button>
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

      {tasks && tasks.length > 0 && (
        <div className="grid gap-3">
          {tasks
            .filter((task) => showCancelled || task.status !== 'cancelled')
            .map((task) => (
              <Link key={task.id} href={`/tasks/${task.id}`} className="block">
                <Card className="flex flex-col gap-2 transition-colors hover:border-indigo-700">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold text-neutral-50">{task.title}</h2>
                      <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
                      <Badge>{TYPE_LABELS[task.type]}</Badge>
                    </div>
                    <span className="text-xs text-neutral-500">
                      {new Date(task.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {task.description && (
                    <p className="text-xs text-neutral-400">{task.description}</p>
                  )}
                  <div className="flex items-center gap-3 text-xs text-neutral-500">
                    <span>Step index: {task.currentStepIndex}</span>
                    {task.currentStepId && <span>Current: {task.currentStepId}</span>}
                    {task.errorMessage && <span className="text-red-400">{task.errorMessage}</span>}
                  </div>
                </Card>
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}
