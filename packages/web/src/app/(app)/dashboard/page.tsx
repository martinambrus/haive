'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type Task } from '@/lib/api-client';
import { Button, Card, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { moduleDashboardWidgets } from '@/generated/module-dashboard';
import { ModuleDashboardWidgets } from '@/lib/module-dashboard';
import { useModules } from '@/lib/use-modules';
import { usePageTitle } from '@/lib/use-page-title';
import { rememberTaskOrigin } from '@/lib/task-origin';
import { isTaskDead } from '@/lib/step-banners';
import { taskStatusWord } from '@/lib/task-state';

/** Statuses the listing's `active` token covers — what is running right now. */
const ACTIVE_TOKEN = 'active';

export default function DashboardPage() {
  usePageTitle('Dashboard');

  const [active, setActive] = useState<Task[] | null>(null);
  const { modules } = useModules();

  // The now-strip reuses the task listing rather than duplicating its status vocabulary.
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ tasks: Task[] }>(`/tasks?status=${ACTIVE_TOKEN}&pageSize=5`)
      .then((res) => {
        if (!cancelled) setActive(res.tasks);
      })
      .catch(() => {
        if (!cancelled) setActive([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const inFlight = active?.filter((t) => !isTaskDead(t)).length ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-50">Dashboard</h1>
      </div>

      {/* What is running right now. A dashboard with no now-state is a report. */}
      <Card>
        <CardHeader>
          <CardTitle>Running now</CardTitle>
          <CardDescription>
            {active === null
              ? 'Checking...'
              : inFlight === 0
                ? 'Nothing is running.'
                : `${inFlight} task${inFlight === 1 ? '' : 's'} in flight.`}
          </CardDescription>
        </CardHeader>
        {active && active.length > 0 && (
          <ul className="flex flex-col gap-1">
            {active.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-sm">
                <span
                  className={`inline-block h-2 w-2 shrink-0 rounded-full ${isTaskDead(t) ? 'bg-red-400' : 'animate-pulse bg-indigo-400'}`}
                />
                <Link
                  href={`/tasks/${t.id}`}
                  onClick={() =>
                    rememberTaskOrigin(t.id, { href: '/dashboard', label: 'Dashboard' })
                  }
                  className="truncate text-neutral-200 hover:text-indigo-300"
                >
                  {t.title}
                </Link>
                <span
                  className={`shrink-0 text-xs ${isTaskDead(t) ? 'text-red-400' : 'text-neutral-500'}`}
                >
                  {taskStatusWord(t)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ModuleDashboardWidgets widgets={moduleDashboardWidgets} modules={modules} />

      <div className="flex gap-3">
        <Link href="/tasks">
          <Button variant="secondary" size="sm">
            All tasks
          </Button>
        </Link>
      </div>
    </div>
  );
}
