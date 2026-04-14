'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AdminHealthResponse,
  type AdminUser,
  type AdminUserAction,
  type AdminUserActionResponse,
} from '@/lib/api-client';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  FormError,
} from '@/components/ui';

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [health, setHealth] = useState<AdminHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<{ userId: string; value: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [usersData, healthData] = await Promise.all([
        api.get<{ users: AdminUser[] }>('/admin/users'),
        api.get<AdminHealthResponse>('/admin/health'),
      ]);
      setUsers(usersData.users);
      setHealth(healthData);
      setError(null);
    } catch (err) {
      const e = err as { status?: number; message?: string };
      if (e.status === 403) {
        setError('Admin access required');
      } else {
        setError(e.message ?? 'Failed to load admin data');
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runAction(user: AdminUser, action: AdminUserAction, role?: 'admin' | 'user') {
    const payload: { action: AdminUserAction; role?: 'admin' | 'user' } = { action };
    if (role) payload.role = role;

    const confirmMessages: Record<AdminUserAction, string> = {
      deactivate: `Deactivate ${user.email}? This revokes their active sessions.`,
      activate: `Reactivate ${user.email}?`,
      reset_password: `Reset password for ${user.email}? A new temporary password will be shown once.`,
      set_role: `Change role for ${user.email} to ${role}?`,
    };
    if (!confirm(confirmMessages[action])) return;

    setBusyUserId(user.id);
    try {
      const result = await api.post<AdminUserActionResponse>(
        `/admin/users/${user.id}/action`,
        payload,
      );
      if (result.temporaryPassword) {
        setTempPassword({ userId: user.id, value: result.temporaryPassword });
      }
      await load();
    } catch (err) {
      setError((err as Error).message ?? 'Action failed');
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-neutral-50">Admin console</h1>
        <p className="text-sm text-neutral-400">
          User management and system health. Requires an admin role.
        </p>
      </div>

      <FormError message={error} />

      {health && (
        <section className="grid gap-3 md:grid-cols-4">
          <Card>
            <CardHeader>
              <CardTitle>Users</CardTitle>
              <CardDescription>
                {health.users.active} active / {health.users.deactivated} deactivated
              </CardDescription>
            </CardHeader>
            <p className="text-xs text-neutral-500">
              {health.users.admins} admin{health.users.admins === 1 ? '' : 's'}
            </p>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Tasks</CardTitle>
              <CardDescription>By status</CardDescription>
            </CardHeader>
            <div className="flex flex-wrap gap-1 text-xs">
              {Object.entries(health.tasks).map(([status, count]) => (
                <Badge key={status}>
                  {status}: {count}
                </Badge>
              ))}
              {Object.keys(health.tasks).length === 0 && (
                <span className="text-neutral-500">None</span>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Containers</CardTitle>
              <CardDescription>By status</CardDescription>
            </CardHeader>
            <div className="flex flex-wrap gap-1 text-xs">
              {Object.entries(health.containers).map(([status, count]) => (
                <Badge key={status}>
                  {status}: {count}
                </Badge>
              ))}
              {Object.keys(health.containers).length === 0 && (
                <span className="text-neutral-500">None</span>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Recent failures</CardTitle>
              <CardDescription>Last 24h</CardDescription>
            </CardHeader>
            <p className="text-lg font-semibold text-neutral-50">{health.recentFailures.length}</p>
          </Card>
        </section>
      )}

      {health && health.recentFailures.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Recent failed tasks</CardTitle>
          </CardHeader>
          <ul className="flex flex-col gap-2 text-sm">
            {health.recentFailures.map((task) => (
              <li key={task.id} className="flex items-center justify-between gap-2">
                <span className="truncate text-neutral-100">{task.title}</span>
                <span className="text-xs text-neutral-500">
                  {new Date(task.updatedAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-neutral-100">Users</h2>
        {users === null ? (
          <p className="text-sm text-neutral-500">Loading...</p>
        ) : users.length === 0 ? (
          <p className="text-sm text-neutral-500">No users.</p>
        ) : (
          <div className="grid gap-3">
            {users.map((user) => (
              <Card key={user.id}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-base font-semibold text-neutral-50">
                        {user.email}
                      </h3>
                      <Badge variant={user.role === 'admin' ? 'success' : 'default'}>
                        {user.role}
                      </Badge>
                      <Badge variant={user.status === 'active' ? 'success' : 'warning'}>
                        {user.status}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-neutral-500">
                      Created {new Date(user.createdAt).toLocaleString()} - token version{' '}
                      {user.tokenVersion}
                    </p>
                    {tempPassword?.userId === user.id && (
                      <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">
                        <div className="font-semibold">Temporary password (copy now):</div>
                        <code className="break-all">{tempPassword.value}</code>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 flex-wrap gap-2">
                    {user.status === 'active' ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busyUserId === user.id}
                        onClick={() => runAction(user, 'deactivate')}
                      >
                        Deactivate
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyUserId === user.id}
                        onClick={() => runAction(user, 'activate')}
                      >
                        Activate
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyUserId === user.id}
                      onClick={() => runAction(user, 'reset_password')}
                    >
                      Reset password
                    </Button>
                    {user.role === 'admin' ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyUserId === user.id}
                        onClick={() => runAction(user, 'set_role', 'user')}
                      >
                        Demote
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busyUserId === user.id}
                        onClick={() => runAction(user, 'set_role', 'admin')}
                      >
                        Promote
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
