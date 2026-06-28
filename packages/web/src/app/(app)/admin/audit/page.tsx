'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, listAuditEvents, type AdminUser, type AuditListResponse } from '@/lib/api-client';
import { Button, Badge, Input, FormError } from '@/components/ui';
import { usePageTitle } from '@/lib/use-page-title';

const PAGE_SIZE = 50;

const selectClass =
  'rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 outline-none focus:border-indigo-500';

function actionVariant(action: string): 'default' | 'error' | 'warning' {
  if (action.includes('delete') || action.includes('deactivate')) return 'error';
  if (action.includes('reset') || action.includes('update')) return 'warning';
  return 'default';
}

function formatMeta(metadata: Record<string, unknown> | null): string {
  if (!metadata) return '';
  return Object.entries(metadata)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('  ');
}

export default function AuditLogPage() {
  usePageTitle('Audit log');

  const [data, setData] = useState<AuditListResponse | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [actorUserId, setActorUserId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);

  // Load the user list once for the actor filter dropdown (id -> email).
  useEffect(() => {
    api
      .get<{ users: AdminUser[] }>('/admin/users')
      .then((res) => setUsers(res.users))
      .catch(() => {
        /* actor dropdown is optional; ignore failure */
      });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAuditEvents({
        action: action || undefined,
        targetType: targetType || undefined,
        actorUserId: actorUserId || undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(to).toISOString() : undefined,
        limit: PAGE_SIZE,
        offset,
      });
      setData(res);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, [action, targetType, actorUserId, from, to, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any filter change resets to the first page.
  function onFilter(setter: (v: string) => void, value: string) {
    setter(value);
    setOffset(0);
  }

  function clearFilters() {
    setAction('');
    setTargetType('');
    setActorUserId('');
    setFrom('');
    setTo('');
    setOffset(0);
  }

  const total = data?.total ?? 0;
  const events = data?.events ?? [];
  const facets = data?.facets ?? { actions: [], targetTypes: [] };
  const rangeStart = total === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_SIZE, total);
  const hasFilters = Boolean(action || targetType || actorUserId || from || to);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-50">Audit log</h1>
          <p className="text-sm text-neutral-400">
            Security-sensitive actions (git credentials, admin user actions). Append-only.
          </p>
        </div>
        <Link href="/admin">
          <Button variant="secondary" size="sm">
            Back to admin
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-neutral-800 bg-neutral-900/50 p-3">
        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Action
          <select
            className={selectClass}
            value={action}
            onChange={(e) => onFilter(setAction, e.target.value)}
          >
            <option value="">All</option>
            {facets.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Target type
          <select
            className={selectClass}
            value={targetType}
            onChange={(e) => onFilter(setTargetType, e.target.value)}
          >
            <option value="">All</option>
            {facets.targetTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          Actor
          <select
            className={selectClass}
            value={actorUserId}
            onChange={(e) => onFilter(setActorUserId, e.target.value)}
          >
            <option value="">All</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.email}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          From
          <Input
            type="datetime-local"
            value={from}
            onChange={(e) => onFilter(setFrom, e.target.value)}
            className="h-9 w-auto"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-neutral-400">
          To
          <Input
            type="datetime-local"
            value={to}
            onChange={(e) => onFilter(setTo, e.target.value)}
            className="h-9 w-auto"
          />
        </label>

        {hasFilters && (
          <Button variant="secondary" size="sm" onClick={clearFilters}>
            Clear
          </Button>
        )}
      </div>

      <FormError message={error} />

      <div className="overflow-x-auto rounded-md border border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-neutral-900/70 text-xs uppercase text-neutral-500">
            <tr>
              <th className="px-3 py-2 font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Actor</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Target</th>
              <th className="px-3 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {events.map((ev) => (
              <tr key={ev.id} className="align-top">
                <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-400">
                  {new Date(ev.createdAt).toLocaleString()}
                </td>
                <td className="px-3 py-2 text-neutral-200" title={ev.actorUserId}>
                  {ev.actorEmail ?? `${ev.actorUserId.slice(0, 8)}…`}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={actionVariant(ev.action)}>{ev.action}</Badge>
                </td>
                <td className="px-3 py-2 text-xs text-neutral-300" title={ev.targetId ?? ''}>
                  {ev.targetType}
                  {ev.targetId ? ` · ${ev.targetId.slice(0, 8)}…` : ''}
                </td>
                <td className="break-all px-3 py-2 text-xs text-neutral-400">
                  {formatMeta(ev.metadata)}
                </td>
              </tr>
            ))}
            {events.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-neutral-500">
                  No audit events{hasFilters ? ' match these filters' : ' yet'}.
                </td>
              </tr>
            )}
            {loading && events.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-neutral-500">
                  Loading{'…'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-neutral-400">
        <span>
          {total === 0 ? 'No results' : `Showing ${rangeStart}–${rangeEnd} of ${total}`}
          {loading && total > 0 ? ' (updating…)' : ''}
        </span>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={offset === 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={offset + PAGE_SIZE >= total || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
