'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, listAdminTaskTypes, type AdminTaskTypeListed, type ApiError } from '@/lib/api-client';
import { describeAvailability } from '@/lib/composition-messages';
import { usePageTitle } from '@/lib/use-page-title';
import { TaskTypeDeleteDialog } from '@/components/task-type-delete-dialog';
import { Badge, Card, FormError } from '@/components/ui';

function sourceLabel(source: string): string {
  if (source === 'admin') return 'Custom';
  if (source === 'builtin') return 'Built-in';
  return `Module ${source.replace(/^module:/, '')}`;
}

export default function TaskTypesPage() {
  usePageTitle('Task types');

  const [rows, setRows] = useState<AdminTaskTypeListed[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [customEnabled, setCustomEnabled] = useState<boolean | null>(null);
  const [deleting, setDeleting] = useState<AdminTaskTypeListed | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await listAdminTaskTypes()).taskTypes);
      setError(null);
    } catch (err) {
      setError((err as ApiError).message ?? 'Failed to load task types');
    }
  }, []);

  useEffect(() => {
    void load();
    api
      .get<{ customEnabled: boolean }>('/admin/config/task-types')
      .then((c) => setCustomEnabled(c.customEnabled))
      .catch(() => {
        /* the banner is optional; the list stands without it */
      });
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 max-w-2xl text-sm text-neutral-400">
          The kinds of task people can start. Built-in types keep their steps; custom types are
          composed here from the step catalog.
        </p>
        <Link
          href="/admin/task-types/new"
          className="inline-flex h-11 items-center rounded-md bg-indigo-500 px-4 text-sm font-medium text-white hover:bg-indigo-400"
        >
          New task type
        </Link>
      </div>
      {customEnabled === false && (
        <p className="rounded-md border border-amber-700/50 bg-amber-900/20 px-3 py-2 text-sm text-amber-200">
          Custom task types are switched off, so no task of a custom type can be created. Switch
          them on under{' '}
          <Link href="/admin?tab=workflow" className="underline">
            Settings, Workflow
          </Link>
          .
        </p>
      )}
      <FormError message={error} />
      {rows === null && !error && <p className="text-sm text-neutral-400">Loading…</p>}
      <div className="flex flex-col gap-2">
        {rows?.map((row) => (
          <Card
            key={row.slug}
            className="flex flex-wrap items-center justify-between gap-3 p-3"
            data-task-type={row.slug}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/admin/task-types/${encodeURIComponent(row.slug)}`}
                  className="text-sm font-medium text-neutral-50 hover:underline [overflow-wrap:anywhere]"
                >
                  {row.displayName}
                </Link>
                <Badge>{sourceLabel(row.source)}</Badge>
                <Badge variant={row.enabled ? 'success' : 'warning'}>
                  {row.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                {!row.requiresRepository && <Badge variant="info">No repository</Badge>}
              </div>
              <p className="font-mono text-[11px] text-neutral-500 [overflow-wrap:anywhere]">
                {row.slug}
              </p>
              <p
                className={
                  row.availability.available
                    ? 'mt-1 text-xs text-neutral-400'
                    : 'mt-1 text-xs text-amber-300'
                }
              >
                {describeAvailability(row.availability)}
              </p>
              <p className="text-xs text-neutral-500">
                {`${row.taskCount} task${row.taskCount === 1 ? '' : 's'}`}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Link
                href={`/admin/task-types/${encodeURIComponent(row.slug)}`}
                className="inline-flex h-11 items-center rounded-md border border-neutral-700 bg-neutral-800 px-4 text-sm text-neutral-100 hover:bg-neutral-700"
              >
                {row.source === 'admin' ? 'Edit' : 'View'}
              </Link>
              {row.source === 'admin' && (
                <button
                  type="button"
                  onClick={() => setDeleting(row)}
                  className="h-11 rounded-md border border-red-900/60 px-4 text-sm text-red-300 hover:bg-red-950/40"
                >
                  Delete
                </button>
              )}
            </div>
          </Card>
        ))}
      </div>
      <TaskTypeDeleteDialog
        slug={deleting?.slug ?? null}
        displayName={deleting?.displayName ?? ''}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          void load();
        }}
      />
    </div>
  );
}
