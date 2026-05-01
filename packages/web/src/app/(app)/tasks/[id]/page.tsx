'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormSchema } from '@haive/shared';
import {
  api,
  type CliProvider,
  type CliProviderName,
  type StepAction,
  type StepActionResponse,
  type Task,
  type TaskAction,
  type TaskEvent,
  type TaskStatus,
  type TaskStep,
  type StepStatus,
} from '@/lib/api-client';
import { Badge, Button, Card } from '@/components/ui';
import { useCliLogin } from '@/lib/use-cli-login';
import { shouldClearSubmitting } from '@/lib/submit-state';
import { FormRenderer, type FormValues } from '@/components/form-renderer';
import { PostgresTestButton, OllamaTestButton } from '@/components/connection-tester';
import { TaskSource } from '@/components/task-source';
import { StepTerminal } from '@/components/terminal/StepTerminal';

type BadgeVariant = 'default' | 'success' | 'warning' | 'error';

function taskStatusVariant(status: TaskStatus): BadgeVariant {
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

type Tab = 'steps' | 'source' | 'activity';

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
  const [stepProviderBusy, setStepProviderBusy] = useState<string | null>(null);
  const [stepProviderError, setStepProviderError] = useState<{
    stepId: string;
    message: string;
  } | null>(null);
  const stepsContainerRef = useRef<HTMLDivElement>(null);
  const prevActiveStepRef = useRef<string | null>(null);

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

  // Auto-scroll to active step when it changes
  useEffect(() => {
    const activeStep = steps.find(
      (s) => s.status === 'waiting_form' || s.status === 'running' || s.status === 'waiting_cli',
    );
    const activeId = activeStep?.stepId ?? null;
    if (activeId && activeId !== prevActiveStepRef.current && stepsContainerRef.current) {
      const el = stepsContainerRef.current.querySelector(`[data-step-id="${activeId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
    prevActiveStepRef.current = activeId;
  }, [steps]);

  useEffect(() => {
    api
      .get<{ providers: CliProvider[] }>('/cli-providers')
      .then((data) => setProviders(data.providers))
      .catch(() => setProviders([]));
  }, []);

  async function submitStep(step: TaskStep, values: FormValues) {
    setSubmitting(step.stepId);
    setSubmitError(null);
    try {
      await api.post(`/tasks/${id}/steps/${step.stepId}/submit`, { values });
      await reload();
      // Keep button disabled here. The effect below clears `submitting` once the
      // step's status leaves `waiting_form`, which is when the form unmounts
      // (success) or is replaced by a retry button (failure). Clearing in a
      // `finally` re-enabled the button between reload and backend transition.
    } catch (err) {
      setSubmitError((err as Error).message ?? 'Failed to submit step');
      setSubmitting(null);
    }
  }

  useEffect(() => {
    if (shouldClearSubmitting(submitting, steps)) {
      setSubmitting(null);
    }
  }, [steps, submitting]);

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
    const downstreamCount = steps.filter(
      (s) => s.stepIndex > step.stepIndex && s.status !== 'pending',
    ).length;
    const label = downstreamCount
      ? `Retry this step? ${downstreamCount} downstream step(s) will also be reset and re-run.`
      : 'Retry this step?';
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

  // Post-login auto-retry flow: after the user completes a CLI login triggered
  // from a `cli_login_required` error hint, we prompt them to confirm retrying
  // the step so they don't have to hunt for the Retry button themselves.
  const { requireCliLogin } = useCliLogin();
  const [pendingLoginRetry, setPendingLoginRetry] = useState<TaskStep | null>(null);

  function openCliLoginForStep(step: TaskStep) {
    if (step.errorHint?.type !== 'cli_login_required') return;
    const { providerId, providerName } = step.errorHint;
    requireCliLogin({
      providerId,
      providerLabel: providerName,
      providerName: providerName as CliProviderName,
      onComplete: () => setPendingLoginRetry(step),
    });
  }

  async function confirmPostLoginRetry() {
    const step = pendingLoginRetry;
    if (!step) return;
    setPendingLoginRetry(null);
    setStepActionBusy(step.stepId);
    setStepActionError(null);
    try {
      await api.post<StepActionResponse>(`/tasks/${id}/steps/${step.stepId}/action`, {
        action: 'retry',
      });
      await reload();
    } catch (err) {
      setStepActionError({
        stepId: step.stepId,
        message: (err as Error).message ?? 'retry failed',
      });
    } finally {
      setStepActionBusy(null);
    }
  }

  async function changeStepProvider(stepId: string, cliProviderId: string | null) {
    setStepProviderBusy(stepId);
    setStepProviderError(null);
    try {
      await api.patch(`/tasks/${id}/steps/${stepId}/cli-provider`, { cliProviderId });
      await reload();
    } catch (err) {
      setStepProviderError({
        stepId,
        message: (err as Error).message ?? 'Failed to change provider',
      });
    } finally {
      setStepProviderBusy(null);
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

  const canCancel = !['completed', 'cancelled'].includes(task.status);
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
        <TabButton active={tab === 'source'} onClick={() => setTab('source')}>
          Source
        </TabButton>
        <TabButton active={tab === 'activity'} onClick={() => setTab('activity')}>
          Activity
        </TabButton>
      </div>

      {tab === 'steps' && (
        <div ref={stepsContainerRef} className="flex flex-col gap-3">
          {steps.length === 0 && (
            <div className="text-sm text-neutral-500">
              No steps recorded yet. The task worker will populate them once it starts.
            </div>
          )}
          {steps.map((step) => (
            <div key={step.id} data-step-id={step.stepId}>
              <StepCard
                step={step}
                taskId={task.id}
                taskStatus={task.status}
                taskRepositoryId={task.repositoryId}
                submitting={submitting === step.stepId}
                submitError={submitting === step.stepId ? submitError : null}
                onSubmit={(values) => submitStep(step, values)}
                actionBusy={stepActionBusy === step.stepId}
                actionError={
                  stepActionError?.stepId === step.stepId ? stepActionError.message : null
                }
                onAction={(action) => runStepAction(step, action)}
                onCliLogin={() => openCliLoginForStep(step)}
                providers={providers}
                taskCliProviderId={task.cliProviderId ?? null}
                cliBusy={stepProviderBusy === step.stepId}
                cliError={
                  stepProviderError?.stepId === step.stepId ? stepProviderError.message : null
                }
                onChangeCli={(cliProviderId) => changeStepProvider(step.stepId, cliProviderId)}
              />
            </div>
          ))}
        </div>
      )}

      {tab === 'source' && <TaskSource taskId={id} />}

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

      {pendingLoginRetry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <Card className="flex max-w-md flex-col gap-4 p-5">
            <h2 className="text-base font-semibold text-neutral-100">Login successful</h2>
            <p className="text-sm text-neutral-300">
              You&apos;re now signed in. Retry step{' '}
              <span className="font-mono text-xs text-neutral-400">{pendingLoginRetry.stepId}</span>{' '}
              now?
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setPendingLoginRetry(null)}>
                Not now
              </Button>
              <Button size="sm" onClick={confirmPostLoginRetry}>
                Retry step
              </Button>
            </div>
          </Card>
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
  taskId: string;
  taskStatus: TaskStatus;
  taskRepositoryId: string | null;
  submitting: boolean;
  submitError: string | null;
  onSubmit: (values: FormValues) => Promise<void>;
  actionBusy: boolean;
  actionError: string | null;
  onAction: (action: StepAction) => Promise<void>;
  onCliLogin: () => void;
  providers: CliProvider[];
  /** Task-level fallback when this step has no per-step preference set. */
  taskCliProviderId: string | null;
  cliBusy: boolean;
  cliError: string | null;
  onChangeCli: (cliProviderId: string | null) => Promise<void>;
}

const ACTIONABLE_STATUSES: ReadonlySet<StepStatus> = new Set([
  'pending',
  'waiting_form',
  'waiting_cli',
  'running',
  'failed',
]);

const RETRYABLE_STEP_STATUSES: ReadonlySet<StepStatus> = new Set([
  'pending',
  'running',
  'waiting_form',
  'waiting_cli',
  'done',
  'failed',
  'skipped',
]);

function StepCard({
  step,
  taskId,
  taskStatus,
  taskRepositoryId,
  submitting,
  submitError,
  onSubmit,
  actionBusy,
  actionError,
  onAction,
  onCliLogin,
  providers,
  taskCliProviderId,
  cliBusy,
  cliError,
  onChangeCli,
}: StepCardProps) {
  const [showOutput, setShowOutput] = useState(false);
  const schema = step.formSchema as FormSchema | null;
  const initialValues = (step.formValues as FormValues | null) ?? undefined;
  const taskCancelled = taskStatus === 'cancelled';
  const showForm = !taskCancelled && step.status === 'waiting_form' && schema;
  // Auto-skipped steps (shouldRun → false, or detect skipReason) have nothing
  // to retry — they were intentionally bypassed by the runner. Manually-skipped
  // steps remain retryable in case the user changed their mind.
  const isAutoSkipped = step.status === 'skipped' && !step.manuallySkipped;
  const canRetry = !taskCancelled && !isAutoSkipped && RETRYABLE_STEP_STATUSES.has(step.status);
  const showCliPicker = !taskCancelled && ACTIONABLE_STATUSES.has(step.status);
  const cliPickerId = `cli-${step.stepId}`;
  // Per-step preference wins; otherwise fall back to the task default. Empty
  // string for "no preference" so the dropdown shows the (none) option.
  const effectiveCliProviderId = step.preferredCliProviderId ?? taskCliProviderId ?? '';
  // Per-step lock: only locked while THIS step is running/waiting on CLI.
  const cliLocked = step.status === 'running' || step.status === 'waiting_cli';

  // Detect tooling step fields for inline connection test buttons
  const hasConnectionFields =
    showForm &&
    schema?.fields.some((f) => f.id === 'ragMode') &&
    schema?.fields.some((f) => f.id === 'ollamaUrl');

  return (
    <Card className="flex flex-col gap-3">
      {showCliPicker && (
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-800 pb-3">
          <label htmlFor={cliPickerId} className="text-xs font-medium text-neutral-400">
            CLI
          </label>
          <select
            id={cliPickerId}
            disabled={cliLocked || cliBusy}
            value={effectiveCliProviderId}
            onChange={(e) => void onChangeCli(e.target.value || null)}
            className="h-8 max-w-xs flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">(none — deterministic only)</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.enabled}>
                {p.label} ({p.name}){!p.enabled ? ' — disabled' : ''}
              </option>
            ))}
          </select>
          {cliLocked && (
            <span className="text-[11px] text-neutral-500">locked while step running</span>
          )}
          {cliBusy && <span className="text-[11px] text-neutral-500">saving...</span>}
          {cliError && <span className="text-[11px] text-red-400">{cliError}</span>}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-neutral-500">#{step.stepIndex}</span>
          <h3 className="text-base font-semibold text-neutral-100">{step.title}</h3>
          <Badge variant={stepStatusVariant(step.status)}>{step.status}</Badge>
          {step.iterationCount > 0 && (
            <span
              className="rounded border border-indigo-700 bg-indigo-950/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-indigo-300"
              title="Loop passes completed for this step"
            >
              iter ×{step.iterationCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canRetry &&
            (() => {
              const isActive = step.status === 'running' || step.status === 'waiting_cli';
              const label = isActive ? 'Stop & retry' : 'Retry';
              const title = isActive
                ? 'Stop the running CLI for this step (and any downstream activity), then re-run from this step'
                : 'Reset this step and re-run it (downstream steps will also reset)';
              return (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={actionBusy}
                  onClick={() => onAction('retry')}
                  title={title}
                >
                  {actionBusy ? (isActive ? 'Stopping…' : 'Retrying…') : label}
                </Button>
              );
            })()}
          <span className="font-mono text-xs text-neutral-500">{step.stepId}</span>
        </div>
      </div>

      {step.statusMessage && (step.status === 'running' || step.status === 'waiting_cli') && (
        <div className="flex items-center gap-2 rounded-md border border-indigo-900/50 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-400" />
          {step.statusMessage}
        </div>
      )}

      {step.errorMessage && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {step.errorMessage}
        </div>
      )}

      {step.errorHint?.type === 'cli_login_required' && step.status === 'failed' && (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={actionBusy} onClick={onCliLogin}>
            Log in to {step.errorHint.providerName}
          </Button>
          <span className="text-xs text-neutral-400">
            We&apos;ll prompt you to retry the step right after you log in.
          </span>
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
            repositoryId={taskRepositoryId}
            renderAfterField={
              hasConnectionFields
                ? (fieldId, values) => {
                    if (fieldId === 'ragConnectionString') {
                      return <PostgresTestButton formValues={values} />;
                    }
                    if (fieldId === 'embeddingModel') {
                      return <OllamaTestButton formValues={values} />;
                    }
                    return null;
                  }
                : undefined
            }
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

      {step.cliInvocationCount > 0 && (
        <StepTerminal
          taskId={taskId}
          stepRowId={step.id}
          autoExpand={step.status === 'running' || step.status === 'waiting_cli'}
        />
      )}
    </Card>
  );
}
