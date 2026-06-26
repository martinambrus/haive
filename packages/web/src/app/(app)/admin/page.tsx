'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePageTitle } from '@/lib/use-page-title';
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
  usePageTitle('Admin console');
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [health, setHealth] = useState<AdminHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<{ userId: string; value: string } | null>(null);
  const [maxParallel, setMaxParallel] = useState<number | null>(null);
  const [maxParallelInput, setMaxParallelInput] = useState('');
  const [savingConcurrency, setSavingConcurrency] = useState(false);
  const [steeringEnabled, setSteeringEnabled] = useState<boolean | null>(null);
  const [savingSteering, setSavingSteering] = useState(false);
  const [ideEnabled, setIdeEnabled] = useState<boolean | null>(null);
  const [savingIde, setSavingIde] = useState(false);
  const [browserAccessEnabled, setBrowserAccessEnabled] = useState<boolean | null>(null);
  const [savingBrowserAccess, setSavingBrowserAccess] = useState(false);
  const [fairEnabled, setFairEnabled] = useState<boolean | null>(null);
  const [savingFair, setSavingFair] = useState(false);
  const [maxPerTask, setMaxPerTask] = useState<number | null>(null);
  const [maxPerTaskInput, setMaxPerTaskInput] = useState('');
  const [savingPerTask, setSavingPerTask] = useState(false);

  const load = useCallback(async () => {
    try {
      const [
        usersData,
        healthData,
        concurrencyData,
        steeringData,
        ideData,
        browserAccessData,
        fairData,
        perTaskData,
      ] = await Promise.all([
        api.get<{ users: AdminUser[] }>('/admin/users'),
        api.get<AdminHealthResponse>('/admin/health'),
        api.get<{ maxParallelAgents: number }>('/admin/config/concurrency'),
        api.get<{ enabled: boolean }>('/admin/config/steering'),
        api.get<{ enabled: boolean }>('/admin/config/ide'),
        api.get<{ enabled: boolean }>('/admin/config/browser-access'),
        api.get<{ enabled: boolean }>('/admin/config/fair-scheduling'),
        api.get<{ maxAgentsPerTask: number }>('/admin/config/max-agents-per-task'),
      ]);
      setUsers(usersData.users);
      setHealth(healthData);
      setMaxParallel(concurrencyData.maxParallelAgents);
      setMaxParallelInput(String(concurrencyData.maxParallelAgents));
      setSteeringEnabled(steeringData.enabled);
      setIdeEnabled(ideData.enabled);
      setBrowserAccessEnabled(browserAccessData.enabled);
      setFairEnabled(fairData.enabled);
      setMaxPerTask(perTaskData.maxAgentsPerTask);
      setMaxPerTaskInput(String(perTaskData.maxAgentsPerTask));
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

  async function saveConcurrency() {
    const value = Number.parseInt(maxParallelInput, 10);
    if (!Number.isInteger(value) || value < 1) {
      setError('Max parallel agents must be an integer of at least 1.');
      return;
    }
    setSavingConcurrency(true);
    try {
      const result = await api.put<{ maxParallelAgents: number }>('/admin/config/concurrency', {
        maxParallelAgents: value,
      });
      setMaxParallel(result.maxParallelAgents);
      setMaxParallelInput(String(result.maxParallelAgents));
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update concurrency');
    } finally {
      setSavingConcurrency(false);
    }
  }

  async function savePerTask() {
    const value = Number.parseInt(maxPerTaskInput, 10);
    if (!Number.isInteger(value) || value < 1) {
      setError('Max agents per task must be an integer of at least 1.');
      return;
    }
    setSavingPerTask(true);
    try {
      const result = await api.put<{ maxAgentsPerTask: number }>(
        '/admin/config/max-agents-per-task',
        { maxAgentsPerTask: value },
      );
      setMaxPerTask(result.maxAgentsPerTask);
      setMaxPerTaskInput(String(result.maxAgentsPerTask));
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update per-task cap');
    } finally {
      setSavingPerTask(false);
    }
  }

  async function setSteering(next: boolean) {
    setSavingSteering(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/steering', {
        enabled: next,
      });
      setSteeringEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update steering');
    } finally {
      setSavingSteering(false);
    }
  }

  async function setIde(next: boolean) {
    setSavingIde(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/ide', {
        enabled: next,
      });
      setIdeEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update editor switch');
    } finally {
      setSavingIde(false);
    }
  }

  async function setBrowserAccess(next: boolean) {
    setSavingBrowserAccess(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/browser-access', {
        enabled: next,
      });
      setBrowserAccessEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update browser access');
    } finally {
      setSavingBrowserAccess(false);
    }
  }

  async function setFair(next: boolean) {
    setSavingFair(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/fair-scheduling', {
        enabled: next,
      });
      setFairEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update fair scheduling');
    } finally {
      setSavingFair(false);
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

      {maxParallel !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Performance</CardTitle>
            <CardDescription>
              Max parallel agents — caps concurrent CLI/agent invocations (cli-exec queue + DAG
              coders). Set to what your machine can handle; higher means more parallelism and load.
              Applies immediately; persists across restarts.
            </CardDescription>
          </CardHeader>
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-400">
              Max parallel agents
              <input
                type="number"
                min={1}
                value={maxParallelInput}
                onChange={(e) => setMaxParallelInput(e.target.value)}
                className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
              />
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={savingConcurrency || maxParallelInput === String(maxParallel)}
              onClick={() => void saveConcurrency()}
            >
              {savingConcurrency ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </Card>
      )}

      {maxPerTask !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Per-task agent cap</CardTitle>
            <CardDescription>
              Max CLI/agent invocations a single task may run at once. Bounds one task&apos;s share
              of the global pool above, so one task&apos;s fan-out can&apos;t seize every slot. Must
              be ≥ 1; only binds when set below the global max. Applies within ~30s; persists across
              restarts.
            </CardDescription>
          </CardHeader>
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-400">
              Max agents per task
              <input
                type="number"
                min={1}
                value={maxPerTaskInput}
                onChange={(e) => setMaxPerTaskInput(e.target.value)}
                className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
              />
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={savingPerTask || maxPerTaskInput === String(maxPerTask)}
              onClick={() => void savePerTask()}
            >
              {savingPerTask ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </Card>
      )}

      {steeringEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Mid-run steering</CardTitle>
            <CardDescription>
              Lets users inject a message into a running Claude-family CLI step (applied at the next
              tool-call boundary) and mines those nudges into the knowledge base. Global kill-switch
              across every repo. Takes effect within ~30s; persists across restarts.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={steeringEnabled}
              disabled={savingSteering}
              onChange={(e) => void setSteering(e.target.checked)}
              className="h-4 w-4"
            />
            {steeringEnabled ? 'Enabled' : 'Disabled'}
            {savingSteering && <span className="text-xs text-neutral-500">saving…</span>}
          </label>
        </Card>
      )}

      {ideEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>In-task editor (IDE)</CardTitle>
            <CardDescription>
              The Editor tab runs a browser VS Code (code-server) on each task&apos;s worktree.
              Global kill-switch: OFF hides the Editor tab and refuses new editor launches (the
              read-only Source viewer remains). Takes effect within ~30s; persists across restarts.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={ideEnabled}
              disabled={savingIde}
              onChange={(e) => void setIde(e.target.checked)}
              className="h-4 w-4"
            />
            {ideEnabled ? 'Enabled' : 'Disabled'}
            {savingIde && <span className="text-xs text-neutral-500">saving…</span>}
          </label>
        </Card>
      )}

      {browserAccessEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Direct browser access</CardTitle>
            <CardDescription>
              Lets a task publish its running app to a loopback host port so users can test it in
              their OWN browser (localhost + *.ddev.site URLs) instead of the in-app VNC stream.
              Ports bind 127.0.0.1 only. Global kill-switch across every repo; OFF reverts to
              VNC-only. Read at runner start — a mid-task flip needs Stop/Retry to take effect.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={browserAccessEnabled}
              disabled={savingBrowserAccess}
              onChange={(e) => void setBrowserAccess(e.target.checked)}
              className="h-4 w-4"
            />
            {browserAccessEnabled ? 'Enabled' : 'Disabled'}
            {savingBrowserAccess && <span className="text-xs text-neutral-500">saving…</span>}
          </label>
        </Card>
      )}

      {fairEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Fair scheduling</CardTitle>
            <CardDescription>
              Shares the global CLI/agent concurrency fairly across users: each invocation is
              enqueued with a priority equal to the submitting user&apos;s in-flight backlog, so a
              freed slot goes to the most-starved user instead of one task&apos;s fan-out tail. Off
              = plain FIFO. Takes effect within ~30s; persists across restarts.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={fairEnabled}
              disabled={savingFair}
              onChange={(e) => void setFair(e.target.checked)}
              className="h-4 w-4"
            />
            {fairEnabled ? 'Enabled' : 'Disabled'}
            {savingFair && <span className="text-xs text-neutral-500">saving…</span>}
          </label>
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
