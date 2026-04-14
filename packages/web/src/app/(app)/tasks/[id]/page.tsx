'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { FormSchema } from '@haive/shared';
import {
  api,
  type CliProvider,
  type StepAction,
  type StepActionResponse,
  type Task,
  type TaskAction,
  type TaskEvent,
  type TaskStatus,
  type TaskStep,
  type StepStatus,
} from '@/lib/api-client';
import { Badge, Button, Card, Label } from '@/components/ui';
import { FormRenderer, type FormValues } from '@/components/form-renderer';
import { TaskOutputs } from '@/components/task-outputs';
import { Terminal } from '@/components/terminal/Terminal';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error';

function taskStatusVariant(status: TaskStatus): BadgeVariant {
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

function stepStatusVariant(status: StepStatus): BadgeVariant {
  switch (status) {
    case 'done':
      return 'success';
    case 'failed':
      return 'error';
    case 'waiting_form':
    case 'waiting_cli':
      return 'warning';
    default:
      return 'default';
  }
}

type Tab = 'steps' | 'outputs' | 'terminal' | 'settings' | 'activity';

interface TaskDetailResponse {
  task: Task;
  steps: TaskStep[];
}

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [task, setTask] = useState<Task | null>(null);
  const [steps, setSteps] = useState<TaskStep[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('steps');
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stepActionBusy, setStepActionBusy] = useState<string | null>(null);
  const [stepActionError, setStepActionError] = useState<{
    stepId: string;
    message: string;
  } | null>(null);
  const [providers, setProviders] = useState<CliProvider[]>([]);
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [overrideTarget, setOverrideTarget] = useState<string>('');
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await api.get<TaskDetailResponse>(`/tasks/${id}`);
      setTask(data.task);
      setSteps(data.steps);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load task');
    }
  }, [id]);

  const reloadEvents = useCallback(async () => {
    try {
      const data = await api.get<{ events: TaskEvent[] }>(`/tasks/${id}/events`);
      setEvents(data.events);
    } catch {
      // swallow
    }
  }, [id]);

  useEffect(() => {
    void reload();
    const timer = setInterval(() => {
      void reload();
      if (tab === 'activity') void reloadEvents();
    }, 2000);
    return () => clearInterval(timer);
  }, [reload, reloadEvents, tab]);

  useEffect(() => {
    if (tab === 'activity') void reloadEvents();
  }, [tab, reloadEvents]);

  useEffect(() => {
    if (tab !== 'settings') return;
    api
      .get<{ providers: CliProvider[] }>('/cli-providers')
      .then((data) => setProviders(data.providers))
      .catch(() => setProviders([]));
  }, [tab]);

  async function submitStep(step: TaskStep, values: FormValues) {
    setSubmitting(step.stepId);
    setSubmitError(null);
    try {
      await api.post(`/tasks/${id}/steps/${step.stepId}/submit`, { values });
      await reload();
    } catch (err) {
      setSubmitError((err as Error).message ?? 'Failed to submit step');
    } finally {
      setSubmitting(null);
    }
  }

  async function runAction(action: TaskAction) {
    setActionError(null);
    try {
      await api.post(`/tasks/${id}/action`, { action });
      await reload();
    } catch (err) {
      setActionError((err as Error).message ?? 'Action failed');
    }
  }

  async function runStepAction(step: TaskStep, action: StepAction) {
    const label = action === 'retry' ? 'Retry this step?' : 'Skip this step?';
    if (!confirm(label)) return;
    setStepActionBusy(step.stepId);
    setStepActionError(null);
    try {
      await api.post<StepActionResponse>(`/tasks/${id}/steps/${step.stepId}/action`, { action });
      await reload();
    } catch (err) {
      setStepActionError({
        stepId: step.stepId,
        message: (err as Error).message ?? `${action} failed`,
      });
    } finally {
      setStepActionBusy(null);
    }
  }

  async function changeProvider(cliProviderId: string | null) {
    setProviderBusy(true);
    setProviderError(null);
    try {
      await api.patch(`/tasks/${id}/cli-provider`, { cliProviderId });
      await reload();
    } catch (err) {
      setProviderError((err as Error).message ?? 'Failed to change provider');
    } finally {
      setProviderBusy(false);
    }
  }

  async function submitOverride() {
    if (!overrideTarget) return;
    if (
      !confirm(`Jump to step ${overrideTarget}? All intermediate steps will be marked skipped.`)
    ) {
      return;
    }
    setOverrideBusy(true);
    setOverrideError(null);
    try {
      await api.post(`/tasks/${id}/override-next-step`, {
        stepId: overrideTarget,
      });
      setOverrideTarget('');
      await reload();
    } catch (err) {
      setOverrideError((err as Error).message ?? 'Failed to override step');
    } finally {
      setOverrideBusy(false);
    }
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <Link href="/tasks" className="text-sm text-indigo-400 underline">
          Back to tasks
        </Link>
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex flex-col gap-4">
        <Link href="/tasks" className="text-sm text-indigo-400 underline">
          Back to tasks
        </Link>
        <div className="text-sm text-neutral-500">Loading...</div>
      </div>
    );
  }

  const canPause = task.status === 'running';
  const canResume = task.status === 'paused';
  const canCancel = !['completed', 'cancelled', 'failed'].includes(task.status);
  const canRetry = task.status === 'failed';

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/tasks" className="text-xs text-indigo-400 underline">
            Back to tasks
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-neutral-50">{task.title}</h1>
            <Badge variant={taskStatusVariant(task.status)}>{task.status}</Badge>
            <Badge>{task.type}</Badge>
          </div>
          {task.description && <p className="text-sm text-neutral-400">{task.description}</p>}
          {task.errorMessage && <p className="text-sm text-red-400">Error: {task.errorMessage}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {canPause && (
            <Button variant="secondary" size="sm" onClick={() => runAction('pause')}>
              Pause
            </Button>
          )}
          {canResume && (
            <Button size="sm" onClick={() => runAction('resume')}>
              Resume
            </Button>
          )}
          {canRetry && (
            <Button size="sm" onClick={() => runAction('retry')}>
              Retry
            </Button>
          )}
          {canCancel && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (confirm('Cancel this task?')) void runAction('cancel');
              }}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>

      {actionError && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {actionError}
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-b border-neutral-800">
        <TabButton active={tab === 'steps'} onClick={() => setTab('steps')}>
          Steps
        </TabButton>
        <TabButton active={tab === 'outputs'} onClick={() => setTab('outputs')}>
          Outputs
        </TabButton>
        <TabButton
          active={tab === 'terminal'}
          onClick={() => setTab('terminal')}
          disabled={!task.containerId || task.status !== 'running'}
        >
          Terminal
        </TabButton>
        <TabButton active={tab === 'settings'} onClick={() => setTab('settings')}>
          Settings
        </TabButton>
        <TabButton active={tab === 'activity'} onClick={() => setTab('activity')}>
          Activity
        </TabButton>
      </div>

      {tab === 'steps' && (
        <div className="flex flex-col gap-3">
          {steps.length === 0 && (
            <div className="text-sm text-neutral-500">
              No steps recorded yet. The task worker will populate them once it starts.
            </div>
          )}
          {steps.map((step) => (
            <StepCard
              key={step.id}
              step={step}
              submitting={submitting === step.stepId}
              submitError={submitting === step.stepId ? submitError : null}
              onSubmit={(values) => submitStep(step, values)}
              actionBusy={stepActionBusy === step.stepId}
              actionError={stepActionError?.stepId === step.stepId ? stepActionError.message : null}
              onAction={(action) => runStepAction(step, action)}
            />
          ))}
        </div>
      )}

      {tab === 'outputs' && <TaskOutputs taskId={id} />}

      {tab === 'terminal' && (
        <div className="flex flex-col gap-2">
          {!task.containerId && (
            <div className="rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-400">
              No container attached to this task yet.
            </div>
          )}
          {task.containerId && task.status !== 'running' && (
            <div className="rounded-md border border-neutral-800 bg-neutral-950 p-4 text-sm text-neutral-400">
              Task is {task.status}. Terminal is only available while the task is running.
            </div>
          )}
          {task.containerId && task.status === 'running' && (
            <Terminal containerId={task.containerId} />
          )}
        </div>
      )}

      {tab === 'settings' && (
        <div className="flex flex-col gap-6">
          <Card className="flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-neutral-100">CLI provider</h3>
              <p className="text-xs text-neutral-500">
                Switch which CLI provider handles LLM-backed steps. Takes effect on the next step
                invocation.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="cliProvider">Provider</Label>
              <select
                id="cliProvider"
                disabled={providerBusy}
                value={task.cliProviderId ?? ''}
                onChange={(e) => void changeProvider(e.target.value || null)}
                className="h-10 w-full max-w-md rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              >
                <option value="">(none — deterministic steps only)</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.enabled}>
                    {p.label} ({p.name}){!p.enabled ? ' — disabled' : ''}
                  </option>
                ))}
              </select>
              {providerError && <p className="text-xs text-red-400">{providerError}</p>}
            </div>
          </Card>

          <Card className="flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold text-neutral-100">Override next step</h3>
              <p className="text-xs text-neutral-500">
                Jump forward to a specific step. Any intermediate pending steps will be marked
                skipped. Forward-only — use step retry to rerun an earlier step.
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex min-w-[240px] flex-1 flex-col gap-2">
                <Label htmlFor="overrideStep">Target step</Label>
                <select
                  id="overrideStep"
                  value={overrideTarget}
                  onChange={(e) => setOverrideTarget(e.target.value)}
                  disabled={overrideBusy}
                  className="h-10 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                >
                  <option value="">(pick a step)</option>
                  {steps
                    .filter((s) => s.status !== 'done' && s.status !== 'skipped')
                    .map((s) => (
                      <option key={s.id} value={s.stepId}>
                        #{s.stepIndex} {s.title} ({s.stepId})
                      </option>
                    ))}
                </select>
              </div>
              <Button
                onClick={() => void submitOverride()}
                disabled={overrideBusy || !overrideTarget}
              >
                {overrideBusy ? 'Working...' : 'Jump to step'}
              </Button>
            </div>
            {overrideError && <p className="text-xs text-red-400">{overrideError}</p>}
          </Card>
        </div>
      )}

      {tab === 'activity' && (
        <div className="flex flex-col gap-2">
          {events.length === 0 && <div className="text-sm text-neutral-500">No events yet.</div>}
          {events.map((ev) => (
            <Card key={ev.id} className="flex flex-col gap-1 p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-100">{ev.eventType}</span>
                <span className="text-xs text-neutral-500">
                  {new Date(ev.createdAt).toLocaleString()}
                </span>
              </div>
              {ev.payload && (
                <pre className="overflow-auto rounded bg-neutral-950 p-2 text-[11px] text-neutral-400">
                  {JSON.stringify(ev.payload, null, 2)}
                </pre>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`border-b-2 px-3 pb-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'border-indigo-500 text-neutral-100'
          : 'border-transparent text-neutral-500 hover:text-neutral-300'
      }`}
    >
      {children}
    </button>
  );
}

interface StepCardProps {
  step: TaskStep;
  submitting: boolean;
  submitError: string | null;
  onSubmit: (values: FormValues) => Promise<void>;
  actionBusy: boolean;
  actionError: string | null;
  onAction: (action: StepAction) => Promise<void>;
}

function StepCard({
  step,
  submitting,
  submitError,
  onSubmit,
  actionBusy,
  actionError,
  onAction,
}: StepCardProps) {
  const [showOutput, setShowOutput] = useState(false);
  const schema = step.formSchema as FormSchema | null;
  const initialValues = (step.formValues as FormValues | null) ?? undefined;
  const showForm = step.status === 'waiting_form' && schema;
  const canRetry = step.status === 'failed';
  const canSkip = step.status === 'failed' || step.status === 'waiting_form';

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-neutral-500">#{step.stepIndex}</span>
          <h3 className="text-base font-semibold text-neutral-100">{step.title}</h3>
          <Badge variant={stepStatusVariant(step.status)}>{step.status}</Badge>
        </div>
        <span className="font-mono text-xs text-neutral-500">{step.stepId}</span>
      </div>

      {step.errorMessage && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {step.errorMessage}
        </div>
      )}

      {(canRetry || canSkip) && (
        <div className="flex flex-wrap gap-2">
          {canRetry && (
            <Button size="sm" disabled={actionBusy} onClick={() => onAction('retry')}>
              {actionBusy ? 'Working...' : 'Retry step'}
            </Button>
          )}
          {canSkip && (
            <Button
              variant="secondary"
              size="sm"
              disabled={actionBusy}
              onClick={() => onAction('skip')}
            >
              {actionBusy ? 'Working...' : 'Skip step'}
            </Button>
          )}
        </div>
      )}

      {actionError && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {actionError}
        </div>
      )}

      {showForm && (
        <div className="border-t border-neutral-800 pt-4">
          <FormRenderer
            schema={schema}
            initialValues={initialValues}
            submitting={submitting}
            errorMessage={submitError}
            onSubmit={onSubmit}
          />
        </div>
      )}

      {step.status !== 'waiting_form' && (step.detectOutput !== null || step.output !== null) && (
        <button
          type="button"
          onClick={() => setShowOutput((v) => !v)}
          className="self-start text-xs text-indigo-400 underline"
        >
          {showOutput ? 'Hide' : 'Show'} output
        </button>
      )}

      {showOutput && (
        <div className="flex flex-col gap-2">
          {step.detectOutput !== null && (
            <div>
              <div className="text-xs font-medium text-neutral-400">Detect</div>
              <pre className="overflow-auto rounded bg-neutral-950 p-2 text-[11px] text-neutral-400">
                {JSON.stringify(step.detectOutput, null, 2)}
              </pre>
            </div>
          )}
          {step.output !== null && (
            <div>
              <div className="text-xs font-medium text-neutral-400">Apply</div>
              <pre className="overflow-auto rounded bg-neutral-950 p-2 text-[11px] text-neutral-400">
                {JSON.stringify(step.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
