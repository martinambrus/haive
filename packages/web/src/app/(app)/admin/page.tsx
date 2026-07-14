'use client';

import Link from 'next/link';
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
  const [prWorkflowEnabled, setPrWorkflowEnabled] = useState<boolean | null>(null);
  const [savingPrWorkflow, setSavingPrWorkflow] = useState(false);
  const [softTimeoutEnabled, setSoftTimeoutEnabled] = useState<boolean | null>(null);
  const [softTimeoutPercentInput, setSoftTimeoutPercentInput] = useState('');
  const [savingSoftTimeout, setSavingSoftTimeout] = useState(false);
  const [usageWindowEnabled, setUsageWindowEnabled] = useState<boolean | null>(null);
  const [savingUsageWindow, setSavingUsageWindow] = useState(false);
  const [ideEnabled, setIdeEnabled] = useState<boolean | null>(null);
  const [savingIde, setSavingIde] = useState(false);
  const [debugModeEnabled, setDebugModeEnabled] = useState<boolean | null>(null);
  const [savingDebugMode, setSavingDebugMode] = useState(false);
  const [browserAccessEnabled, setBrowserAccessEnabled] = useState<boolean | null>(null);
  const [savingBrowserAccess, setSavingBrowserAccess] = useState(false);
  const [dbAccessEnabled, setDbAccessEnabled] = useState<boolean | null>(null);
  const [savingDbAccess, setSavingDbAccess] = useState(false);
  const [ddevRegistryCacheEnabled, setDdevRegistryCacheEnabled] = useState<boolean | null>(null);
  const [savingDdevRegistryCache, setSavingDdevRegistryCache] = useState(false);
  const [autoResumeOnAllowanceEnabled, setAutoResumeOnAllowanceEnabled] = useState<boolean | null>(
    null,
  );
  const [savingAutoResumeOnAllowance, setSavingAutoResumeOnAllowance] = useState(false);
  const [ddevControlEnabled, setDdevControlEnabled] = useState<boolean | null>(null);
  const [savingDdevControl, setSavingDdevControl] = useState(false);
  const [fairEnabled, setFairEnabled] = useState<boolean | null>(null);
  const [savingFair, setSavingFair] = useState(false);
  const [promptCaching1hEnabled, setPromptCaching1hEnabled] = useState<boolean | null>(null);
  const [savingPromptCaching1h, setSavingPromptCaching1h] = useState(false);
  const [tersenessLevel, setTersenessLevel] = useState<string | null>(null);
  const [savingTerseness, setSavingTerseness] = useState(false);
  const [reviewDistillEnabled, setReviewDistillEnabled] = useState<boolean | null>(null);
  const [savingReviewDistill, setSavingReviewDistill] = useState(false);
  const [reviewRefuteEnabled, setReviewRefuteEnabled] = useState<boolean | null>(null);
  const [savingReviewRefute, setSavingReviewRefute] = useState(false);
  const [maxPerTask, setMaxPerTask] = useState<number | null>(null);
  const [maxPerTaskInput, setMaxPerTaskInput] = useState('');
  const [savingPerTask, setSavingPerTask] = useState(false);

  const [attachmentMaxBytes, setAttachmentMaxBytes] = useState<number | null>(null);
  const [attachmentMaxMbInput, setAttachmentMaxMbInput] = useState('');
  const [savingAttachmentMax, setSavingAttachmentMax] = useState(false);

  const load = useCallback(async () => {
    try {
      const [
        usersData,
        healthData,
        concurrencyData,
        steeringData,
        softTimeoutData,
        ideData,
        debugModeData,
        browserAccessData,
        dbAccessData,
        ddevRegistryCacheData,
        autoResumeOnAllowanceData,
        ddevControlData,
        fairData,
        perTaskData,
        attachmentData,
        promptCaching1hData,
        tersenessData,
        reviewDistillData,
        reviewRefuteData,
        usageWindowData,
        prWorkflowData,
      ] = await Promise.all([
        api.get<{ users: AdminUser[] }>('/admin/users'),
        api.get<AdminHealthResponse>('/admin/health'),
        api.get<{ maxParallelAgents: number }>('/admin/config/concurrency'),
        api.get<{ enabled: boolean }>('/admin/config/steering'),
        api.get<{ enabled: boolean; percent: number }>('/admin/config/cli-soft-timeout'),
        api.get<{ enabled: boolean }>('/admin/config/ide'),
        api.get<{ enabled: boolean }>('/admin/config/debug-mode'),
        api.get<{ enabled: boolean }>('/admin/config/browser-access'),
        api.get<{ enabled: boolean }>('/admin/config/db-access'),
        api.get<{ enabled: boolean }>('/admin/config/ddev-registry-cache'),
        api.get<{ enabled: boolean }>('/admin/config/auto-resume-on-allowance'),
        api.get<{ enabled: boolean }>('/admin/config/ddev-control'),
        api.get<{ enabled: boolean }>('/admin/config/fair-scheduling'),
        api.get<{ maxAgentsPerTask: number }>('/admin/config/max-agents-per-task'),
        api.get<{ maxBytes: number }>('/admin/config/attachment-max-bytes'),
        api.get<{ enabled: boolean }>('/admin/config/prompt-caching-1h'),
        api.get<{ level: string }>('/admin/config/terseness'),
        api.get<{ enabled: boolean }>('/admin/config/review-fanout-distill'),
        api.get<{ enabled: boolean }>('/admin/config/review-refute'),
        api.get<{ enabled: boolean }>('/admin/config/usage-window'),
        api.get<{ enabled: boolean }>('/admin/config/pr-workflow'),
      ]);
      setUsers(usersData.users);
      setHealth(healthData);
      setMaxParallel(concurrencyData.maxParallelAgents);
      setMaxParallelInput(String(concurrencyData.maxParallelAgents));
      setSteeringEnabled(steeringData.enabled);
      setPrWorkflowEnabled(prWorkflowData.enabled);
      setSoftTimeoutEnabled(softTimeoutData.enabled);
      setSoftTimeoutPercentInput(String(softTimeoutData.percent));
      setIdeEnabled(ideData.enabled);
      setDebugModeEnabled(debugModeData.enabled);
      setBrowserAccessEnabled(browserAccessData.enabled);
      setDbAccessEnabled(dbAccessData.enabled);
      setDdevRegistryCacheEnabled(ddevRegistryCacheData.enabled);
      setAutoResumeOnAllowanceEnabled(autoResumeOnAllowanceData.enabled);
      setDdevControlEnabled(ddevControlData.enabled);
      setFairEnabled(fairData.enabled);
      setPromptCaching1hEnabled(promptCaching1hData.enabled);
      setTersenessLevel(tersenessData.level);
      setReviewDistillEnabled(reviewDistillData.enabled);
      setReviewRefuteEnabled(reviewRefuteData.enabled);
      setUsageWindowEnabled(usageWindowData.enabled);
      setMaxPerTask(perTaskData.maxAgentsPerTask);
      setMaxPerTaskInput(String(perTaskData.maxAgentsPerTask));
      setAttachmentMaxBytes(attachmentData.maxBytes);
      setAttachmentMaxMbInput(
        String(Math.round((attachmentData.maxBytes / 1024 / 1024) * 100) / 100),
      );
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

  async function saveAttachmentMax() {
    const mb = Number.parseFloat(attachmentMaxMbInput);
    if (!Number.isFinite(mb) || mb < 1) {
      setError('Max attachment size must be at least 1 MB.');
      return;
    }
    const bytes = Math.round(mb * 1024 * 1024);
    setSavingAttachmentMax(true);
    try {
      const result = await api.put<{ maxBytes: number }>('/admin/config/attachment-max-bytes', {
        maxBytes: bytes,
      });
      setAttachmentMaxBytes(result.maxBytes);
      setAttachmentMaxMbInput(String(Math.round((result.maxBytes / 1024 / 1024) * 100) / 100));
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update attachment size limit');
    } finally {
      setSavingAttachmentMax(false);
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

  async function setPrWorkflow(next: boolean) {
    setSavingPrWorkflow(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/pr-workflow', {
        enabled: next,
      });
      setPrWorkflowEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update PR workflow');
    } finally {
      setSavingPrWorkflow(false);
    }
  }

  // Enabled and percent share one endpoint, so the toggle re-sends the current percent
  // and the Save button re-sends the current enabled flag.
  async function saveSoftTimeout(enabled: boolean, percentRaw: string) {
    const percent = Number.parseInt(percentRaw, 10);
    if (!Number.isFinite(percent) || percent < 1 || percent > 99) {
      setError('Soft timeout percent must be between 1 and 99.');
      return;
    }
    setSavingSoftTimeout(true);
    try {
      const result = await api.put<{ enabled: boolean; percent: number }>(
        '/admin/config/cli-soft-timeout',
        { enabled, percent },
      );
      setSoftTimeoutEnabled(result.enabled);
      setSoftTimeoutPercentInput(String(result.percent));
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update soft timeout');
    } finally {
      setSavingSoftTimeout(false);
    }
  }

  async function setUsageWindow(next: boolean) {
    setSavingUsageWindow(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/usage-window', {
        enabled: next,
      });
      setUsageWindowEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update usage-window display');
    } finally {
      setSavingUsageWindow(false);
    }
  }

  async function setPromptCaching1h(next: boolean) {
    setSavingPromptCaching1h(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/prompt-caching-1h', {
        enabled: next,
      });
      setPromptCaching1hEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update prompt caching');
    } finally {
      setSavingPromptCaching1h(false);
    }
  }

  async function setTerseness(next: string) {
    setSavingTerseness(true);
    try {
      const result = await api.put<{ level: string }>('/admin/config/terseness', {
        level: next,
      });
      setTersenessLevel(result.level);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update terseness');
    } finally {
      setSavingTerseness(false);
    }
  }

  async function setReviewDistill(next: boolean) {
    setSavingReviewDistill(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/review-fanout-distill', {
        enabled: next,
      });
      setReviewDistillEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update review distill');
    } finally {
      setSavingReviewDistill(false);
    }
  }

  async function setReviewRefute(next: boolean) {
    setSavingReviewRefute(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/review-refute', {
        enabled: next,
      });
      setReviewRefuteEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update review refutation');
    } finally {
      setSavingReviewRefute(false);
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

  async function setDebugMode(next: boolean) {
    setSavingDebugMode(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/debug-mode', {
        enabled: next,
      });
      setDebugModeEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update debug mode switch');
    } finally {
      setSavingDebugMode(false);
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

  async function setDbAccess(next: boolean) {
    setSavingDbAccess(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/db-access', {
        enabled: next,
      });
      setDbAccessEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update database access');
    } finally {
      setSavingDbAccess(false);
    }
  }

  async function setDdevRegistryCache(next: boolean) {
    setSavingDdevRegistryCache(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/ddev-registry-cache', {
        enabled: next,
      });
      setDdevRegistryCacheEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update DDEV image cache');
    } finally {
      setSavingDdevRegistryCache(false);
    }
  }

  async function setAutoResumeOnAllowance(next: boolean) {
    setSavingAutoResumeOnAllowance(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/auto-resume-on-allowance', {
        enabled: next,
      });
      setAutoResumeOnAllowanceEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update auto-resume');
    } finally {
      setSavingAutoResumeOnAllowance(false);
    }
  }

  async function setDdevControl(next: boolean) {
    setSavingDdevControl(true);
    try {
      const result = await api.put<{ enabled: boolean }>('/admin/config/ddev-control', {
        enabled: next,
      });
      setDdevControlEnabled(result.enabled);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to update DDEV-control MCP');
    } finally {
      setSavingDdevControl(false);
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
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-neutral-50">Admin console</h1>
          <p className="text-sm text-neutral-400">
            User management and system health. Requires an admin role.
          </p>
        </div>
        <Link href="/admin/audit">
          <Button variant="secondary" size="sm">
            Audit log
          </Button>
        </Link>
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

      {attachmentMaxBytes !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Task attachment size</CardTitle>
            <CardDescription>
              Maximum size per uploaded task attachment. Users attach reference files (docs,
              screenshots, sample data) the AI agent reads while it works. Applies within ~30s;
              persists across restarts.
            </CardDescription>
          </CardHeader>
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-400">
              Max size (MB)
              <input
                type="number"
                min={1}
                value={attachmentMaxMbInput}
                onChange={(e) => setAttachmentMaxMbInput(e.target.value)}
                className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
              />
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={savingAttachmentMax}
              onClick={() => void saveAttachmentMax()}
            >
              {savingAttachmentMax ? 'Saving...' : 'Save'}
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

      {prWorkflowEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Pull-request close-out</CardTitle>
            <CardDescription>
              Master switch for the &quot;create a pull request&quot; close-out at task end. When
              on, a workflow task on a connected forge (GitHub, Gitea/Forgejo, GitLab, Bitbucket)
              can open a PR instead of merging locally, then wait for it to merge. The per-repo
              toggle sits under this switch; each repo also needs a credential with its forge
              provider set. Default off. Takes effect within ~30s; persists across restarts.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={prWorkflowEnabled}
              disabled={savingPrWorkflow}
              onChange={(e) => void setPrWorkflow(e.target.checked)}
              className="h-4 w-4"
            />
            {prWorkflowEnabled ? 'Enabled' : 'Disabled'}
            {savingPrWorkflow && <span className="text-xs text-neutral-500">saving…</span>}
          </label>
        </Card>
      )}

      {softTimeoutEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>CLI soft timeout</CardTitle>
            <CardDescription>
              A CLI that hits its timeout is SIGKILLed with no grace, so a reviewer that runs its
              full budget loses everything it found. At the percentage below, the worker steers the
              CLI to stop investigating and emit only the findings it has already verified.
              Delivered as a steering message, so it reaches Claude-family CLIs only, and only while
              mid-run steering is enabled above. Read at invocation start; a change applies to the
              next invocation, not a running one.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={softTimeoutEnabled}
              disabled={savingSoftTimeout}
              onChange={(e) => void saveSoftTimeout(e.target.checked, softTimeoutPercentInput)}
              className="h-4 w-4"
            />
            {softTimeoutEnabled ? 'Enabled' : 'Disabled'}
            {savingSoftTimeout && <span className="text-xs text-neutral-500">saving…</span>}
          </label>
          <div className="mt-3 flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-400">
              Wind-down at (% of budget)
              <input
                type="number"
                min={1}
                max={99}
                value={softTimeoutPercentInput}
                onChange={(e) => setSoftTimeoutPercentInput(e.target.value)}
                className="w-24 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100"
              />
            </label>
            <Button
              size="sm"
              variant="secondary"
              disabled={savingSoftTimeout}
              onClick={() => void saveSoftTimeout(softTimeoutEnabled, softTimeoutPercentInput)}
            >
              {savingSoftTimeout ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </Card>
      )}

      {usageWindowEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Subscription usage display</CardTitle>
            <CardDescription>
              Shows each logged-in CLI provider&apos;s 5-hour and weekly subscription windows in the
              task header, following the active step&apos;s CLI. A gentle background poller reads
              each vendor&apos;s usage endpoint. Global kill-switch; takes effect within ~30s and
              persists across restarts.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={usageWindowEnabled}
              disabled={savingUsageWindow}
              onChange={(e) => void setUsageWindow(e.target.checked)}
              className="h-4 w-4"
            />
            {usageWindowEnabled ? 'Enabled' : 'Disabled'}
            {savingUsageWindow && <span className="text-xs text-neutral-500">saving…</span>}
          </label>
        </Card>
      )}

      {promptCaching1hEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>1-hour prompt cache (claude-family)</CardTitle>
            <CardDescription>
              Opts API-key / Bedrock / Vertex claude-family CLI steps into the 1-hour prompt-cache
              TTL (subscription auth already uses 1h). The 1h cache write costs 2x base input vs the
              5-min default&apos;s 1.25x, so enable this only when steps reuse the cached prefix
              within the hour &mdash; check the per-step token panel (cache read vs write). Default
              OFF; takes effect within ~30s, persists across restarts.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={promptCaching1hEnabled}
              disabled={savingPromptCaching1h}
              onChange={(e) => void setPromptCaching1h(e.target.checked)}
              className="h-4 w-4"
            />
            {promptCaching1hEnabled ? 'Enabled' : 'Disabled'}
            {savingPromptCaching1h && <span className="text-xs text-neutral-500">saving…</span>}
          </label>
        </Card>
      )}

      {tersenessLevel !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Output terseness</CardTitle>
            <CardDescription>
              Global style directive appended to every CLI step&apos;s main prompt, controlling how
              terse the model&apos;s PROSE output is. Structured output (JSON, code, diffs, specs)
              and the reasoning channel are always left exact and untouched. lite = lightest, full =
              default, ultra = most aggressive. Takes effect within ~30s; persists across restarts.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <select
              value={tersenessLevel}
              disabled={savingTerseness}
              onChange={(e) => void setTerseness(e.target.value)}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm"
            >
              <option value="lite">lite</option>
              <option value="full">full</option>
              <option value="ultra">ultra</option>
            </select>
            {savingTerseness && <span className="text-xs text-neutral-500">saving…</span>}
          </label>
        </Card>
      )}

      {reviewDistillEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Condense code-review fan-out spec</CardTitle>
            <CardDescription>
              Opt-in (default OFF). The parallel code-review agents (peer, security, lenses) each
              embed the full spec in their own prompt, and prompt caching can&apos;t dedup it
              (separate sessions). When on, the spec is condensed for the reviewers and the full
              spec is written to a worktree file they can Read on demand &mdash; lossy but
              retrievable. Leave off until the per-step token panel shows the review fan-out is a
              heavy share. Takes effect within ~30s, persists across restarts.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={reviewDistillEnabled}
              disabled={savingReviewDistill}
              onChange={(e) => void setReviewDistill(e.target.checked)}
              className="h-4 w-4"
            />
            {reviewDistillEnabled ? 'Enabled' : 'Disabled'}
            {savingReviewDistill && <span className="text-xs text-neutral-500">saving…</span>}
          </label>
        </Card>
      )}

      {reviewRefuteEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Refute blocking review findings</CardTitle>
            <CardDescription>
              Default ON. A blocking code-review finding sends the change back through
              implementation and spends one of the capped fix rounds, so each one is first handed to
              a refuter agent that tries to disprove it against the code. A finding is dismissed
              only on positive evidence, cited at a file and line, that it is wrong; an uncertain,
              unreadable or failed refuter leaves it blocking. Dismissed findings stay visible at
              gate 2 as advisory. Costs one extra CLI invocation per blocking finding, and only in a
              round that has one. Takes effect on the next review; persists across restarts.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={reviewRefuteEnabled}
              disabled={savingReviewRefute}
              onChange={(e) => void setReviewRefute(e.target.checked)}
              className="h-4 w-4"
            />
            {reviewRefuteEnabled ? 'Enabled' : 'Disabled'}
            {savingReviewRefute && <span className="text-xs text-neutral-500">saving…</span>}
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

      {debugModeEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Step debugging</CardTitle>
            <CardDescription>
              Lets each task offer an on-demand debug toggle (the 01-debug-mode step) that wires
              step-debugging into the live runtime — PHP via Xdebug for DDEV apps, client-side
              JavaScript via the in-app (VNC) browser, and Node via --inspect — so breakpoints work
              from the Editor tab. Global kill-switch: OFF skips that step everywhere (tasks run
              with no debug overhead). Takes effect within ~30s; persists across restarts.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={debugModeEnabled}
              disabled={savingDebugMode}
              onChange={(e) => void setDebugMode(e.target.checked)}
              className="h-4 w-4"
            />
            {debugModeEnabled ? 'Enabled' : 'Disabled'}
            {savingDebugMode && <span className="text-xs text-neutral-500">saving…</span>}
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

      {dbAccessEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Direct database access</CardTitle>
            <CardDescription>
              Lets a task expose its DDEV project database on a loopback host port so users can
              connect a local DB client (mysql/psql/DataGrip) to localhost on the published port
              while developing. Opt-in per task (default off); the port binds 127.0.0.1 only. Global
              kill-switch across every repo; OFF refuses the opt-in everywhere. Read at runner start
              — a mid-task flip needs Stop/Retry to take effect.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={dbAccessEnabled}
              disabled={savingDbAccess}
              onChange={(e) => void setDbAccess(e.target.checked)}
              className="h-4 w-4"
            />
            {dbAccessEnabled ? 'Enabled' : 'Disabled'}
            {savingDbAccess && <span className="text-xs text-neutral-500">saving…</span>}
          </label>
        </Card>
      )}

      {ddevRegistryCacheEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>DDEV image cache</CardTitle>
            <CardDescription>
              Routes each task&apos;s DDEV runner Docker Hub pulls through a shared pull-through
              cache (a registry mirror on a persistent volume), so a repo&apos;s DDEV base images
              are pulled once and served locally to every later task instead of re-pulled per task.
              Global kill-switch across every repo; OFF makes runners pull direct from Docker Hub.
              Read at runner start — a mid-task flip needs Stop/Retry. To reclaim disk, remove the
              haive-ddev-registry container and haive_ddev_registry_cache volume (re-created on next
              worker boot).
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={ddevRegistryCacheEnabled}
              disabled={savingDdevRegistryCache}
              onChange={(e) => void setDdevRegistryCache(e.target.checked)}
              className="h-4 w-4"
            />
            {ddevRegistryCacheEnabled ? 'Enabled' : 'Disabled'}
            {savingDdevRegistryCache && <span className="text-xs text-neutral-500">saving…</span>}
          </label>
        </Card>
      )}

      {autoResumeOnAllowanceEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Auto-resume on allowance reset</CardTitle>
            <CardDescription>
              When a task fails because a provider hit its session / rate limit, automatically
              resume it once that provider&apos;s allowance resets, preserving completed work (e.g.
              skills already generated). OFF (default) only notifies you so you can resume manually.
              Capped at a few consecutive auto-resumes per task to avoid thrashing; any manual
              action or successful step resets the count.
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={autoResumeOnAllowanceEnabled}
              disabled={savingAutoResumeOnAllowance}
              onChange={(e) => void setAutoResumeOnAllowance(e.target.checked)}
              className="h-4 w-4"
            />
            {autoResumeOnAllowanceEnabled ? 'Enabled' : 'Disabled'}
            {savingAutoResumeOnAllowance && (
              <span className="text-xs text-neutral-500">saving…</span>
            )}
          </label>
        </Card>
      )}

      {ddevControlEnabled !== null && (
        <Card>
          <CardHeader>
            <CardTitle>DDEV control (agent MCP)</CardTitle>
            <CardDescription>
              Gives a DDEV task&apos;s AI CLI a ddev-control MCP with ddev_status, ddev_logs, and
              ddev_restart tools, so the agent can inspect and recover its OWN per-task DDEV runner
              when the app 404s instead of guessing at a code bug. Global kill-switch across every
              repo; OFF stops injecting the server everywhere. Read at cli-exec build time (a
              mid-task flip applies to the next CLI invocation).
            </CardDescription>
          </CardHeader>
          <label className="flex items-center gap-2 text-sm text-neutral-200">
            <input
              type="checkbox"
              checked={ddevControlEnabled}
              disabled={savingDdevControl}
              onChange={(e) => void setDdevControl(e.target.checked)}
              className="h-4 w-4"
            />
            {ddevControlEnabled ? 'Enabled' : 'Disabled'}
            {savingDdevControl && <span className="text-xs text-neutral-500">saving…</span>}
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
