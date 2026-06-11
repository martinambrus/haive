'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormSchema } from '@haive/shared';
// Import the pure timing helper from its dedicated subpath, NOT the package
// barrel — the barrel pulls server-only utils (ioredis -> dns) that break the
// browser bundle. timing.ts has no imports, so this subpath is browser-safe.
import { computeTaskTiming } from '@haive/shared/timing';
import {
  api,
  postUserActive,
  type CliProvider,
  type CliProviderName,
  type EnvDepPreset,
  type RagQueryEntry,
  type StepAction,
  type StepActionResponse,
  type Task,
  type TaskAction,
  type TaskEvent,
  type TaskStatus,
  type TaskStep,
  type StepStatus,
} from '@/lib/api-client';
import { Badge, Button, Card, Input } from '@/components/ui';
import { useCliLogin } from '@/lib/use-cli-login';
import { shouldClearSubmitting } from '@/lib/submit-state';
import { formatDuration } from '@/lib/format-duration';
import { FormRenderer, type FormValues } from '@/components/form-renderer';
import { PostgresTestButton, OllamaTestButton } from '@/components/connection-tester';
import { TaskSource } from '@/components/task-source';
import { StepTerminal } from '@/components/terminal/StepTerminal';
import { BrowserVncPanel } from '@/components/terminal/BrowserVncPanel';
import { InteractiveShell } from '@/components/terminal/InteractiveShell';
import { autoScrollTerminalsEnabled } from '@/lib/terminal-autoscroll';
import { usePageTitle } from '@/lib/use-page-title';

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

type Tab = 'steps' | 'source' | 'terminal' | 'activity';

interface TaskDetailResponse {
  task: Task;
  steps: TaskStep[];
}

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [task, setTask] = useState<Task | null>(null);
  usePageTitle(task ? task.title : 'Task');
  const [steps, setSteps] = useState<TaskStep[]>([]);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [autoContinueBusy, setAutoContinueBusy] = useState(false);
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
  const [terminalCliProviderId, setTerminalCliProviderId] = useState<string | null>(null);
  const [stepProviderBusy, setStepProviderBusy] = useState<string | null>(null);
  const [stepProviderError, setStepProviderError] = useState<{
    stepId: string;
    message: string;
  } | null>(null);
  const stepsContainerRef = useRef<HTMLDivElement>(null);
  // Composite "what we last scrolled for" = `${activeStepId}|head|term`. Tracks
  // both the active step AND whether its terminal had appeared, so the scroll
  // re-runs when the terminal mounts (not only when the active step changes).
  const prevScrollKeyRef = useRef<string | null>(null);
  const scrollTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const titleRowRef = useRef<HTMLDivElement>(null);
  const [titleStripVisible, setTitleStripVisible] = useState(false);

  // Show the fixed title strip while the real header is scrolled out of view.
  // Keyed on task presence, not the task object — the 2s poll replaces the
  // object every tick and would re-create the observer.
  const hasTask = task !== null;
  useEffect(() => {
    const el = titleRowRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      setTitleStripVisible(entry ? !entry.isIntersecting : false);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasTask]);

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

  // Auto-scroll to the active step when it changes. For a step that shows a
  // terminal (running / waiting_cli with at least one CLI run) scroll to the
  // END of the last terminal so its output is fully in view, rather than the
  // step header which would hide it. Other steps scroll to the header so the
  // form / status stays visible.
  useEffect(() => {
    const container = stepsContainerRef.current;
    const activeStep = steps.find(
      (s) => s.status === 'waiting_form' || s.status === 'running' || s.status === 'waiting_cli',
    );
    const activeId = activeStep?.stepId ?? null;
    const showsTerminal =
      (activeStep?.cliInvocationCount ?? 0) > 0 &&
      (activeStep?.status === 'running' || activeStep?.status === 'waiting_cli');
    const auto = autoScrollTerminalsEnabled();
    // Re-run when the active step changes OR (with auto-scroll on) when that
    // step's terminal first appears: cliInvocationCount flips 0 -> >0 a moment
    // after the step starts running. Without the terminal trigger we'd only ever
    // scroll to the header — at the instant a step becomes active its terminal /
    // checkbox aren't in the DOM yet, and the old effect never re-ran once they
    // were. Keyed on `head` unless auto is on AND the terminal is up, so a user
    // who turned auto-scroll off keeps the scroll-to-header-once behavior.
    const scrollKey = activeId ? `${activeId}|${showsTerminal && auto ? 'term' : 'head'}` : null;
    if (scrollKey && scrollKey !== prevScrollKeyRef.current && container) {
      scrollTimersRef.current.forEach(clearTimeout);
      scrollTimersRef.current = [];

      const scrollToHeader = () => {
        container
          .querySelector(`[data-step-id="${activeId}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      const scrollToLastTerminal = (): boolean => {
        const stepEl = container.querySelector(`[data-step-id="${activeId}"]`);
        // Prefer the auto-scroll toggle (just below the newest run) so the
        // checkbox stays visible; fall back to the last run panel.
        const toggle = stepEl?.querySelector('[data-cli-autoscroll]');
        if (toggle) {
          toggle.scrollIntoView({ behavior: 'smooth', block: 'end' });
          return true;
        }
        const terminals = stepEl?.querySelectorAll('[data-cli-terminal]');
        if (!terminals || terminals.length === 0) return false;
        const last = terminals[terminals.length - 1];
        if (!last) return false;
        last.scrollIntoView({ behavior: 'smooth', block: 'end' });
        return true;
      };

      if (!showsTerminal || !auto) {
        scrollToHeader();
      } else if (!scrollToLastTerminal()) {
        // Terminal panels mount after an async invocations fetch, so the first
        // attempt can run before they exist — retry until they're in the DOM.
        const attempt = () => {
          if (scrollToLastTerminal()) {
            scrollTimersRef.current.forEach(clearTimeout);
            scrollTimersRef.current = [];
          }
        };
        [200, 500, 900].forEach((delay) => {
          scrollTimersRef.current.push(setTimeout(attempt, delay));
        });
      }
    }
    prevScrollKeyRef.current = scrollKey;
  }, [steps]);

  // Clear any pending scroll retries on unmount.
  useEffect(() => () => scrollTimersRef.current.forEach(clearTimeout), []);

  useEffect(() => {
    api
      .get<{ providers: CliProvider[] }>('/cli-providers')
      .then((data) => setProviders(data.providers))
      .catch(() => setProviders([]));
  }, []);

  // Default terminal CLI to the task's bound provider when known, else the
  // first enabled provider. User can switch via the dropdown above the shell.
  useEffect(() => {
    if (terminalCliProviderId) return;
    const taskProvider = task?.cliProviderId ?? null;
    if (taskProvider && providers.some((p) => p.id === taskProvider)) {
      setTerminalCliProviderId(taskProvider);
      return;
    }
    const fallback = providers.find((p) => p.enabled)?.id ?? providers[0]?.id ?? null;
    if (fallback) setTerminalCliProviderId(fallback);
  }, [providers, task?.cliProviderId, terminalCliProviderId]);

  // The single step (if any) currently blocked on user input. Its focused-and-
  // visible time is tracked as "user active time"; everything else pauses.
  // A terminal task can leave a step parked in waiting_form (e.g. cancelled
  // mid-gate) — nothing waits on the user anymore, so don't count or post.
  const taskEnded =
    task?.status === 'completed' || task?.status === 'failed' || task?.status === 'cancelled';
  const activeWaitingStep = taskEnded
    ? null
    : (steps.find((s) => s.status === 'waiting_form') ?? null);
  const userActive = useUserActiveTimer(
    id,
    activeWaitingStep?.stepId ?? null,
    activeWaitingStep?.userActiveMs ?? 0,
  );

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
    const label =
      action === 'retry_ai'
        ? 'Spawn an AI agent to diagnose and fix this failure, then re-run the step?'
        : action === 'abort'
          ? 'Abort this step and cancel the task? The environment will be torn down.'
          : action === 'skip'
            ? 'Skip this step and continue to the next step?'
            : action === 'resume'
              ? step.iterationCount > 0
                ? `Resume this step from the last completed pass (${step.iterationCount} kept) with the currently-selected CLI?`
                : `Resume this step's first pass with the currently-selected CLI?`
              : downstreamCount
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

  async function changeStepProvider(stepId: string, cliProviderId: string | null, role?: string) {
    setStepProviderBusy(stepId);
    setStepProviderError(null);
    try {
      await api.patch(`/tasks/${id}/steps/${stepId}/cli-provider`, {
        cliProviderId,
        ...(role ? { role } : {}),
      });
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

  function startRename() {
    if (!task) return;
    setTitleDraft(task.title);
    setRenameError(null);
    setRenaming(true);
  }

  async function saveRename() {
    const next = titleDraft.trim();
    if (!next) {
      setRenameError('Title cannot be empty');
      return;
    }
    if (task && next === task.title) {
      setRenaming(false);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await api.patch(`/tasks/${id}`, { title: next });
      await reload();
      setRenaming(false);
    } catch (err) {
      setRenameError((err as Error).message ?? 'Failed to rename task');
    } finally {
      setRenameBusy(false);
    }
  }

  async function toggleAutoContinue() {
    if (!task || autoContinueBusy) return;
    const next = !task.autoContinue;
    setAutoContinueBusy(true);
    // Optimistic flip; the 2s poll reconciles with the server either way.
    setTask((t) => (t ? { ...t, autoContinue: next } : t));
    try {
      await api.patch(`/tasks/${id}`, { autoContinue: next });
    } catch (err) {
      setTask((t) => (t ? { ...t, autoContinue: !next } : t));
      setActionError((err as Error).message ?? 'Failed to update auto-continue');
    } finally {
      setAutoContinueBusy(false);
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
  // A failed task failed AT a step. The top-level Retry must re-run that step
  // (reset it + downstream, re-execute), which is exactly the per-step Retry —
  // NOT the task-level `start` action, which re-walks from the first step and
  // stalls on the still-failed step without re-executing it. Fall back to the
  // task-level retry only when nothing is marked failed (e.g. an orchestrator-
  // level failure before any step ran).
  const failedStep = steps.find((s) => s.status === 'failed');
  // The step the run is currently parked on — the only card that offers the
  // auto-continue checkbox (passed steps can't be auto-continued anymore).
  const currentStep = steps.find(
    (s) =>
      s.status === 'waiting_form' ||
      s.status === 'running' ||
      s.status === 'waiting_cli' ||
      s.status === 'failed',
  );

  return (
    <div className="flex flex-col gap-6">
      {titleStripVisible && (
        <div className="fixed left-64 right-0 top-0 z-30 border-b border-neutral-800 bg-neutral-950/90 px-8 py-2 backdrop-blur">
          <p className="truncate text-sm font-semibold text-indigo-300">{task.title}</p>
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href="/tasks" className="text-xs text-indigo-400 underline">
            Back to tasks
          </Link>
          <div ref={titleRowRef} className="flex items-center gap-2">
            {renaming ? (
              <>
                <Input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveRename();
                    else if (e.key === 'Escape') setRenaming(false);
                  }}
                  maxLength={512}
                  autoFocus
                  className="w-80 text-lg"
                />
                <Button size="sm" disabled={renameBusy} onClick={() => void saveRename()}>
                  {renameBusy ? 'Saving…' : 'Save'}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={renameBusy}
                  onClick={() => setRenaming(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <h1 className="text-2xl font-bold text-neutral-50">{task.title}</h1>
                <Badge variant={taskStatusVariant(task.status)}>{task.status}</Badge>
                <Badge>{task.type}</Badge>
                {task.repository && <Badge variant="info">repo: {task.repository.name}</Badge>}
                <Button size="sm" variant="secondary" onClick={startRename}>
                  Rename
                </Button>
              </>
            )}
          </div>
          {renameError && <p className="mt-1 text-xs text-red-400">{renameError}</p>}
          {task.description && <p className="text-sm text-neutral-400">{task.description}</p>}
          {task.errorMessage && <p className="text-sm text-red-400">Error: {task.errorMessage}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {canRetry && (
            <Button
              size="sm"
              onClick={() => (failedStep ? runStepAction(failedStep, 'retry') : runAction('retry'))}
            >
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
        <TabButton active={tab === 'terminal'} onClick={() => setTab('terminal')}>
          Terminal
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
              {/* currentStep: the step the run is parked on — auto-continue is
                  only offered there; passed steps can't be auto-continued. */}
              <StepCard
                step={step}
                taskId={task.id}
                taskStatus={task.status}
                taskCompletedAt={task.completedAt}
                taskRepositoryId={task.repositoryId}
                userActiveDisplayMs={
                  userActive.activeStepId === step.stepId ? userActive.displayMs : step.userActiveMs
                }
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
                onChangeCli={(cliProviderId, role) =>
                  changeStepProvider(step.stepId, cliProviderId, role)
                }
                autoContinue={task.autoContinue}
                autoContinueBusy={autoContinueBusy}
                showAutoContinue={step.id === currentStep?.id}
                onToggleAutoContinue={() => void toggleAutoContinue()}
              />
            </div>
          ))}
          <TaskTotalTime task={task} steps={steps} userActive={userActive} />
        </div>
      )}

      {tab === 'source' && <TaskSource taskId={id} />}

      {tab === 'terminal' && (
        <TerminalTab
          taskId={id}
          taskStatus={task.status}
          providers={providers}
          selectedCliProviderId={terminalCliProviderId}
          onSelectCliProvider={setTerminalCliProviderId}
        />
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

interface TerminalTabProps {
  taskId: string;
  taskStatus: TaskStatus;
  providers: CliProvider[];
  selectedCliProviderId: string | null;
  onSelectCliProvider: (id: string) => void;
}

function TerminalTab({
  taskId,
  taskStatus,
  providers,
  selectedCliProviderId,
  onSelectCliProvider,
}: TerminalTabProps) {
  const terminalDisabled =
    taskStatus === 'completed' || taskStatus === 'failed' || taskStatus === 'cancelled';
  const enabledProviders = providers.filter((p) => p.enabled);
  const usableProviders = enabledProviders.length > 0 ? enabledProviders : providers;

  if (usableProviders.length === 0) {
    return (
      <Card className="p-4 text-sm text-neutral-400">
        No CLI providers configured. Add one in{' '}
        <Link href="/settings/cli-providers" className="text-indigo-400 underline">
          Settings → CLI providers
        </Link>{' '}
        to launch a shell.
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs text-neutral-400">
          CLI environment
          <select
            value={selectedCliProviderId ?? ''}
            onChange={(e) => onSelectCliProvider(e.target.value)}
            disabled={terminalDisabled}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {usableProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.name})
              </option>
            ))}
          </select>
        </label>
        <span className="text-[10px] text-neutral-500">
          Shell runs inside the same sandbox image used for CLI execs.
        </span>
      </div>
      {selectedCliProviderId && (
        <InteractiveShell
          taskId={taskId}
          cliProviderId={selectedCliProviderId}
          disabled={terminalDisabled}
        />
      )}
    </div>
  );
}

interface StepCardProps {
  step: TaskStep;
  taskId: string;
  taskStatus: TaskStatus;
  /** Caps step timers when the task ended without the step itself ending. */
  taskCompletedAt: string | null;
  taskRepositoryId: string | null;
  /** Live display total of this step's user-active time (committed + pending
   *  for the active step; the plain server value for the rest). */
  userActiveDisplayMs: number;
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
  onChangeCli: (cliProviderId: string | null, role?: string) => Promise<void>;
  /** Task-level auto-continue flag, shown as a checkbox on the CURRENT step
   *  card only (passed steps can't be auto-continued anymore). */
  autoContinue: boolean;
  autoContinueBusy: boolean;
  showAutoContinue: boolean;
  onToggleAutoContinue: () => void;
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

// "User active time": the time the user actively spends on a step while it
// waits for input (waiting_form) AND the tab is visible AND the window is
// focused. It is the focused subset of idle time and pauses whenever the agent
// works (we only count while a step is waiting_form). The browser is the only
// place that knows focus/visibility, so we measure locally and post increments
// to the server (postUserActive). Returns the active step id and a live display
// total for it. `baseMs` is that step's server-side total, read once at
// activation; `committed + pending` is then driven locally so flushes don't make
// the live timer jump backwards.
function useUserActiveTimer(
  taskId: string,
  activeWaitingStepId: string | null,
  baseMs: number,
): { activeStepId: string | null; displayMs: number } {
  const [pendingMs, setPendingMs] = useState(0);
  const committedRef = useRef(baseMs); // server total we've locally accounted for
  const pendingRef = useRef(0); // measured, not yet flushed
  const lastTickRef = useRef(Date.now());
  const lastFlushRef = useRef(Date.now());
  const activeStepRef = useRef<string | null>(activeWaitingStepId);
  const baseRef = useRef(baseMs);
  baseRef.current = baseMs; // latest; consumed only at the next activation

  const flush = useCallback(() => {
    const stepId = activeStepRef.current;
    const ms = Math.round(pendingRef.current);
    if (stepId && ms > 0) {
      pendingRef.current = 0;
      committedRef.current += ms; // account locally so the display doesn't dip
      setPendingMs(0); // keep state in lock-step with pendingRef (no double count)
      lastFlushRef.current = Date.now();
      postUserActive(taskId, stepId, ms);
    }
  }, [taskId]);

  // Activation: when the waiting step changes, flush the prior step's pending,
  // then seed the committed total from the new step's server value.
  useEffect(() => {
    if (activeStepRef.current !== activeWaitingStepId) {
      flush();
      activeStepRef.current = activeWaitingStepId;
      committedRef.current = baseRef.current;
      pendingRef.current = 0;
      setPendingMs(0);
      lastTickRef.current = Date.now();
    }
  }, [activeWaitingStepId, flush]);

  useEffect(() => {
    const counting = () =>
      !!activeStepRef.current && document.visibilityState === 'visible' && document.hasFocus();

    const sample = () => {
      const now = Date.now();
      const elapsed = now - lastTickRef.current;
      lastTickRef.current = now;
      // Drop large gaps (throttled background tab, machine asleep) — not active.
      if (counting() && elapsed > 0 && elapsed < 5000) {
        pendingRef.current += elapsed;
        setPendingMs(pendingRef.current);
      }
    };

    const tick = () => {
      sample();
      // Safety flush so a crash loses at most ~60s; ordinary stops flush sooner.
      if (Date.now() - lastFlushRef.current >= 60_000) flush();
    };
    const onVisibility = () => {
      sample();
      if (document.visibilityState === 'hidden') flush();
    };
    const onBlur = () => {
      sample();
      flush();
    };
    // Returning focus must not retro-count the away gap.
    const onFocus = () => {
      lastTickRef.current = Date.now();
    };

    const interval = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      flush();
    };
  }, [flush]);

  return {
    activeStepId: activeWaitingStepId,
    displayMs: committedRef.current + pendingMs,
  };
}

// Per-step ACTIVE-work timer: wall-clock since start minus idle (time spent
// waiting for user input). While the step is in waiting_form the open wait is
// subtracted live, which freezes the displayed value; it resumes ticking once
// the form is submitted. Fixed once the step ends, nothing before it starts.
// Only the in-progress card re-renders each second via its own interval.
// A cancelled/failed task can leave its open step without endedAt — the task's
// completedAt then caps the timer so it stops ticking.
function StepDuration({
  startedAt,
  endedAt,
  idleMs,
  waitingStartedAt,
  status,
  taskCompletedAt,
}: {
  startedAt: string | null;
  endedAt: string | null;
  idleMs: number;
  waitingStartedAt: string | null;
  status: StepStatus;
  taskCompletedAt: string | null;
}) {
  const stepEndedAt = endedAt ?? taskCompletedAt;
  const ticking = !!startedAt && !stepEndedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = stepEndedAt ? new Date(stepEndedAt).getTime() : now;
  const openWaitMs =
    !stepEndedAt && status === 'waiting_form' && waitingStartedAt
      ? Math.max(0, now - new Date(waitingStartedAt).getTime())
      : 0;
  const workMs = Math.max(0, end - start - idleMs - openWaitMs);
  const waiting = !stepEndedAt && status === 'waiting_form';
  const color = stepEndedAt ? 'text-neutral-500' : waiting ? 'text-amber-300' : 'text-indigo-300';
  return (
    <span
      className={`font-mono text-xs ${color}`}
      title={
        stepEndedAt
          ? 'Active work time'
          : waiting
            ? 'Work time (paused — waiting for input)'
            : 'Active work so far'
      }
    >
      {formatDuration(workMs)}
      {waiting ? ' (waiting)' : ''}
    </span>
  );
}

// Per-step "user active time": the time you actively spent on this step (tab
// visible + window focused) while it waited for input. Hidden when zero so it
// only appears on steps that actually gated on you.
function UserActiveDuration({ ms }: { ms: number }) {
  if (ms < 1000) return null;
  return (
    <span
      className="font-mono text-xs text-emerald-300"
      title="Your active time on this step (page focused while it waited for input)"
    >
      user {formatDuration(ms)}
    </span>
  );
}

// Task time summary: agent work, idle (time waiting on you), your active time at
// gates, total effort, and wall clock. Shown live while the task runs (ticks each
// second) and frozen once it ends. Renders nothing until the task has started.
function TaskTotalTime({
  task,
  steps,
  userActive,
}: {
  task: Task;
  steps: TaskStep[];
  userActive: { activeStepId: string | null; displayMs: number };
}) {
  const ticking = !!task.startedAt && !task.completedAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  if (!task.startedAt) return null;
  const startMs = new Date(task.startedAt).getTime();
  const endMs = task.completedAt ? new Date(task.completedAt).getTime() : now;
  const wallMs = Math.max(0, endMs - startMs);
  // Work / idle / user from the shared helper (the same numbers the server sends
  // to the tasks listing). Work excludes idle waits and the gaps between steps;
  // idle is time spent waiting on you; user is the focused subset of idle.
  // Effort = agent work + your active time — the real task effort, which
  // agent-only "work" undercounts. Open steps use endMs (now while running).
  // Override the active waiting step's stored user-active time with the live
  // local timer so "user" (and effort) tick each second at a gate instead of
  // lagging until the next server flush. idle + wall tick via the now state and
  // computeTaskTiming's open-wait handling; work correctly pauses at the gate.
  const liveSteps = userActive.activeStepId
    ? steps.map((s) =>
        s.stepId === userActive.activeStepId ? { ...s, userActiveMs: userActive.displayMs } : s,
      )
    : steps;
  const { workMs, idleMs, userActiveMs } = computeTaskTiming(liveSteps, endMs);
  const effortMs = workMs + userActiveMs;
  // While running, show seconds even past 1h so the live values visibly tick:
  // the 1s interval advances them, but the compact h/m format hides sub-minute
  // changes (a multi-hour task looks frozen). Completed tasks stay compact.
  const fmt = (ms: number) => formatDuration(ms, { alwaysSeconds: !task.completedAt });
  return (
    <Card className="flex items-center justify-between gap-3 py-3">
      <div className="flex flex-col">
        <span className="text-sm font-medium text-neutral-200">Total time</span>
        <span className="text-xs text-neutral-500">
          {new Date(task.startedAt).toLocaleString()} →{' '}
          {task.completedAt ? new Date(task.completedAt).toLocaleString() : '(running)'}
        </span>
      </div>
      <div className="flex items-center gap-6">
        <div className="flex flex-col items-end">
          <span className="font-mono text-lg text-indigo-300">{fmt(workMs)}</span>
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">work</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="font-mono text-lg text-amber-300">{fmt(idleMs)}</span>
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">idle</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="font-mono text-lg text-emerald-300">{fmt(userActiveMs)}</span>
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">user</span>
        </div>
        <div className="flex flex-col items-end">
          <span className="font-mono text-lg font-semibold text-neutral-50">{fmt(effortMs)}</span>
          <span
            className="text-[10px] uppercase tracking-wider text-neutral-400"
            title="Agent work + your active time = real task effort"
          >
            effort
          </span>
        </div>
        <div className="flex flex-col items-end">
          <span className="font-mono text-lg text-neutral-100">{fmt(wallMs)}</span>
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">wall clock</span>
        </div>
      </div>
    </Card>
  );
}

function StepCard({
  step,
  taskId,
  taskStatus,
  taskCompletedAt,
  taskRepositoryId,
  userActiveDisplayMs,
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
  autoContinue,
  autoContinueBusy,
  showAutoContinue,
  onToggleAutoContinue,
}: StepCardProps) {
  const [showOutput, setShowOutput] = useState(false);
  const [showRagStats, setShowRagStats] = useState(false);
  const isDiscovery = step.stepId === '03-phase-0a-discovery';
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
  // Multi-CLI alternating steps (cliRoles) count one user-facing round per N
  // passes (N = role count: review + correct = 2). Show rounds, not raw passes.
  const loopPassesPerRound = step.cliRoles?.length ?? 1;
  const iterBadgeLabel =
    loopPassesPerRound > 1
      ? `round ×${Math.ceil(step.iterationCount / loopPassesPerRound)}`
      : `iter ×${step.iterationCount}`;
  const cliSelectClass =
    'h-8 max-w-xs rounded-md border border-neutral-800 bg-neutral-950 px-2 text-xs text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50';
  const cliOptions = (
    <>
      <option value="">(none — deterministic only)</option>
      {providers.map((p) => (
        <option key={p.id} value={p.id} disabled={!p.enabled}>
          {p.label} ({p.name}){!p.enabled ? ' — disabled' : ''}
        </option>
      ))}
    </>
  );

  // Detect tooling step fields for inline connection test buttons
  const hasConnectionFields =
    showForm &&
    schema?.fields.some((f) => f.id === 'ragMode') &&
    schema?.fields.some((f) => f.id === 'ollamaUrl');

  // --- Per-repository dependency templates (env-replicate step 1 only) ----
  // Save the filled-in 01-declare-deps form as a named, repo-scoped template
  // and re-apply it on later runs to prefill all fields. The save controls
  // (checkbox + name) are deliberately page-local state — they must never
  // enter FormValues, which the submit route persists verbatim.
  const isDeclareDeps = step.stepId === '01-declare-deps';
  const [presets, setPresets] = useState<EnvDepPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [appliedValues, setAppliedValues] = useState<FormValues | undefined>(undefined);
  const [formKey, setFormKey] = useState(0);
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [presetError, setPresetError] = useState<string | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState(false);

  const refreshPresets = useCallback(async () => {
    if (!isDeclareDeps || !taskRepositoryId) return;
    try {
      const data = await api.get<{ presets: EnvDepPreset[] }>(
        `/env-dep-presets?repositoryId=${taskRepositoryId}`,
      );
      setPresets(data.presets);
    } catch {
      setPresets([]);
    }
  }, [isDeclareDeps, taskRepositoryId]);

  useEffect(() => {
    if (isDeclareDeps && showForm && taskRepositoryId) void refreshPresets();
  }, [isDeclareDeps, showForm, taskRepositoryId, refreshPresets]);

  // Picking a template remounts FormRenderer (via formKey) so its initial
  // values re-seed from the template; "— none —" reverts to the step's own
  // detected/saved values.
  function applyPreset(id: string) {
    setSelectedPresetId(id);
    const preset = id ? presets.find((p) => p.id === id) : null;
    setAppliedValues(preset ? (preset.values as FormValues) : undefined);
    setFormKey((k) => k + 1);
  }

  async function deleteSelectedPreset() {
    if (!selectedPresetId) return;
    const preset = presets.find((p) => p.id === selectedPresetId);
    if (!confirm(`Delete template "${preset?.name ?? ''}"?`)) return;
    setDeletingTemplate(true);
    try {
      await api.delete(`/env-dep-presets/${selectedPresetId}`);
      setSelectedPresetId('');
      await refreshPresets();
    } finally {
      setDeletingTemplate(false);
    }
  }

  // Wraps the normal step submit: when "Save as template" is ticked, persist
  // the template first (aborting on a blank name), then submit the step.
  async function handleDeclareDepsSubmit(values: FormValues) {
    if (saveAsTemplate) {
      const name = templateName.trim();
      if (!name) {
        setPresetError('Template name is required');
        return;
      }
      if (!taskRepositoryId) {
        setPresetError('No repository associated with this task');
        return;
      }
      try {
        await api.post('/env-dep-presets', { repositoryId: taskRepositoryId, name, values });
        await refreshPresets();
      } catch (err) {
        setPresetError((err as Error).message ?? 'Failed to save template');
        return;
      }
    }
    setPresetError(null);
    await onSubmit(values);
  }

  const renderAfterFieldFn = (fieldId: string, values: FormValues): React.ReactNode => {
    if (hasConnectionFields) {
      if (fieldId === 'ragConnectionString') return <PostgresTestButton formValues={values} />;
      if (fieldId === 'embeddingModel') return <OllamaTestButton formValues={values} />;
    }
    if (isDeclareDeps && fieldId === 'extraPackages') {
      return (
        <SaveAsTemplateControls
          checked={saveAsTemplate}
          onToggle={(v) => {
            setSaveAsTemplate(v);
            setPresetError(null);
          }}
          name={templateName}
          onNameChange={(v) => {
            setTemplateName(v);
            setPresetError(null);
          }}
          error={presetError}
        />
      );
    }
    return null;
  };

  return (
    <Card className="flex flex-col gap-3">
      {(showCliPicker || showAutoContinue) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-800 pb-3">
          {showCliPicker &&
            (step.cliRoles && step.cliRoles.length > 0 ? (
              // Multi-CLI step (e.g. spec-quality): one dropdown per role.
              step.cliRoles.map((roleDesc) => (
                <div key={roleDesc.id} className="flex items-center gap-2">
                  <label
                    htmlFor={`${cliPickerId}-${roleDesc.id}`}
                    className="text-xs font-medium text-neutral-400"
                  >
                    {roleDesc.label}
                  </label>
                  <select
                    id={`${cliPickerId}-${roleDesc.id}`}
                    disabled={cliLocked || cliBusy}
                    value={step.cliRoleProviders?.[roleDesc.id] ?? taskCliProviderId ?? ''}
                    onChange={(e) => void onChangeCli(e.target.value || null, roleDesc.id)}
                    className={cliSelectClass}
                  >
                    {cliOptions}
                  </select>
                </div>
              ))
            ) : (
              <>
                <label htmlFor={cliPickerId} className="text-xs font-medium text-neutral-400">
                  CLI
                </label>
                <select
                  id={cliPickerId}
                  disabled={cliLocked || cliBusy}
                  value={effectiveCliProviderId}
                  onChange={(e) => void onChangeCli(e.target.value || null)}
                  className={`${cliSelectClass} flex-1`}
                >
                  {cliOptions}
                </select>
              </>
            ))}
          {showCliPicker && cliLocked && (
            <span className="text-[11px] text-neutral-500">locked while step running</span>
          )}
          {showCliPicker && cliBusy && (
            <span className="text-[11px] text-neutral-500">saving...</span>
          )}
          {showCliPicker && cliError && (
            <span className="text-[11px] text-red-400">{cliError}</span>
          )}
          {showAutoContinue && (
            <label
              className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-neutral-300"
              title="Auto-submit info-only steps and the Gate 1 run configuration so the workflow runs hands-free between gates. Untick to confirm every step with a Continue button. Task-wide; applies from the next step decision."
            >
              <input
                type="checkbox"
                checked={autoContinue}
                disabled={autoContinueBusy}
                onChange={onToggleAutoContinue}
                className="h-3.5 w-3.5 rounded border-neutral-700 bg-neutral-950"
              />
              Auto-continue
            </label>
          )}
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-neutral-500">#{step.stepIndex}</span>
          <h3 className="text-base font-semibold text-neutral-100">{step.title}</h3>
          <Badge variant={stepStatusVariant(step.status)}>{step.status}</Badge>
          <StepDuration
            startedAt={step.startedAt}
            endedAt={step.endedAt}
            idleMs={step.idleMs}
            waitingStartedAt={step.waitingStartedAt}
            status={step.status}
            taskCompletedAt={taskCompletedAt}
          />
          <UserActiveDuration ms={userActiveDisplayMs} />
          {step.iterationCount > 0 && (
            <span
              className="rounded border border-indigo-700 bg-indigo-950/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-indigo-300"
              title={
                loopPassesPerRound > 1
                  ? 'Review/correct rounds completed for this step'
                  : 'Loop passes completed for this step'
              }
            >
              {iterBadgeLabel}
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
          {step.status === 'failed' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={actionBusy}
              onClick={() => onAction('retry_ai')}
              title="Spawn an AI agent to diagnose and fix the failure, then re-run this step automatically. Uses the step's CLI provider."
            >
              Retry with AI
            </Button>
          )}
          {step.status === 'failed' &&
            (step.iterationCount > 0 || (step.cliRoles?.length ?? 0) > 0) && (
              <Button
                size="sm"
                disabled={actionBusy}
                onClick={() => onAction('resume')}
                title="Continue this multi-pass step from where it failed. If a CLI ran out of credits, pick a different one above first. Completed passes are kept; a first-pass failure re-runs from the start with the new CLI."
              >
                {actionBusy
                  ? 'Resuming…'
                  : step.iterationCount > 0
                    ? `Resume (keep ${step.iterationCount} pass${step.iterationCount === 1 ? '' : 'es'})`
                    : 'Resume (new CLI)'}
              </Button>
            )}
          {step.status === 'failed' && step.stepId === '06a-db-migrate' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={actionBusy}
              onClick={() => onAction('skip')}
              title="Skip database migrations and continue. Only available on this step."
            >
              Skip
            </Button>
          )}
          {step.status === 'failed' && (
            <Button
              size="sm"
              variant="secondary"
              disabled={actionBusy}
              onClick={() => onAction('abort')}
              title="Give up on this step and cancel the task (tears down the environment)."
            >
              Abort
            </Button>
          )}
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

      {showForm && schema?.submitAction === 'retry' ? (
        <div className="flex flex-col gap-3 border-t border-neutral-800 pt-4">
          <div>
            <h3 className="text-lg font-semibold text-neutral-50">{schema.title}</h3>
            {schema.description && (
              <p className="mt-1 whitespace-pre-line text-sm text-neutral-400">
                {schema.description}
              </p>
            )}
          </div>
          {actionError && (
            <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {actionError}
            </div>
          )}
          <div>
            <Button disabled={actionBusy} onClick={() => onAction('retry')}>
              {actionBusy ? 'Retrying…' : (schema.submitLabel ?? 'Retry')}
            </Button>
          </div>
        </div>
      ) : (
        showForm && (
          <div className="flex flex-col gap-4 border-t border-neutral-800 pt-4">
            {isDeclareDeps && taskRepositoryId && (
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={`tpl-${step.stepId}`}
                  className="text-sm font-medium text-neutral-200"
                >
                  Apply saved template
                </label>
                <div className="flex items-center gap-2">
                  <select
                    id={`tpl-${step.stepId}`}
                    value={selectedPresetId}
                    onChange={(e) => applyPreset(e.target.value)}
                    className="h-10 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 text-sm text-neutral-100 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  >
                    <option value="">— none —</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {selectedPresetId && (
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={deletingTemplate}
                      onClick={() => void deleteSelectedPreset()}
                    >
                      {deletingTemplate ? 'Deleting…' : 'Delete'}
                    </Button>
                  )}
                </div>
                {presets.length === 0 && (
                  <p className="text-xs text-neutral-500">
                    No saved templates for this repository yet.
                  </p>
                )}
              </div>
            )}
            <FormRenderer
              key={isDeclareDeps ? `${step.stepId}-${formKey}` : undefined}
              schema={schema}
              initialValues={isDeclareDeps ? (appliedValues ?? initialValues) : initialValues}
              submitting={submitting}
              errorMessage={submitError}
              onSubmit={isDeclareDeps ? handleDeclareDepsSubmit : onSubmit}
              repositoryId={taskRepositoryId}
              renderAfterField={
                hasConnectionFields || isDeclareDeps ? renderAfterFieldFn : undefined
              }
            />
          </div>
        )
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

      {isDiscovery && step.startedAt && (
        <button
          type="button"
          onClick={() => setShowRagStats((v) => !v)}
          className="self-start text-xs text-indigo-400 underline"
        >
          {showRagStats ? 'Hide' : 'Show'} RAG stats
        </button>
      )}
      {isDiscovery && showRagStats && <RagStatsPanel taskId={taskId} stepId={step.stepId} />}

      {step.cliInvocationCount > 0 && (
        <StepTerminal
          taskId={taskId}
          stepRowId={step.id}
          autoExpand={step.status === 'running' || step.status === 'waiting_cli'}
          statusMessage={step.statusMessage}
        />
      )}

      {step.stepId === '08a-browser-verify' &&
        ['interactive', 'mcp'].includes(
          (step.formValues as { mode?: string } | null)?.mode ?? '',
        ) && <BrowserVncPanel taskId={taskId} autoCollapse={step.status === 'done'} />}

      {step.stepId === '09-gate-2-verify-approval' &&
        (step.detectOutput as { liveBrowser?: { available?: boolean } } | null)?.liveBrowser
          ?.available && <BrowserVncPanel taskId={taskId} title="Browser — test the app here" />}
    </Card>
  );
}

// Lazy-loaded RAG retrieval stats for the discovery step: the rag_search calls
// made during the step, with the KB-vs-code hit split + top scores. `code`
// being non-zero is the signal that code (not just KB) is actually retrieved.
function RagStatsPanel({ taskId, stepId }: { taskId: string; stepId: string }) {
  const [queries, setQueries] = useState<RagQueryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ queries: RagQueryEntry[] }>(`/tasks/${taskId}/steps/${stepId}/rag-queries`)
      .then((d) => {
        if (!cancelled) setQueries(d.queries);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message ?? 'Failed to load RAG stats');
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, stepId]);

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!queries) return <p className="text-xs text-neutral-500">Loading RAG stats…</p>;
  if (queries.length === 0)
    return <p className="text-xs text-neutral-500">No RAG queries recorded for this step.</p>;

  const totalHits = queries.reduce((s, q) => s + q.hitCount, 0);
  const totalKb = queries.reduce((s, q) => s + q.kbHits, 0);
  const totalCode = queries.reduce((s, q) => s + q.codeHits, 0);
  const withHits = queries.filter((q) => q.hitCount > 0).length;
  // Effectiveness: how often RAG returned anything, and the KB-vs-code split of
  // the chunks it returned. codePct is the remainder so the two always sum to 100%.
  const ragUsedPct = queries.length ? Math.round((withHits / queries.length) * 100) : 0;
  const totalChunks = totalKb + totalCode;
  const kbPct = totalChunks ? Math.round((totalKb / totalChunks) * 100) : 0;
  const codePct = totalChunks ? 100 - kbPct : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-neutral-300">
        <span>{queries.length} queries</span>
        <span>{withHits} returned hits</span>
        <span>{totalHits} hits total</span>
        <span className="text-indigo-300">KB: {totalKb}</span>
        <span className="text-emerald-300">code: {totalCode}</span>
      </div>
      <div className="max-h-80 overflow-auto rounded border border-neutral-800">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-neutral-900 text-neutral-400">
            <tr>
              <th className="px-2 py-1 font-medium">Query</th>
              <th className="px-2 py-1 text-right font-medium">hits</th>
              <th className="px-2 py-1 text-right font-medium">kb</th>
              <th className="px-2 py-1 text-right font-medium">code</th>
              <th className="px-2 py-1 text-right font-medium">top rrf</th>
              <th className="px-2 py-1 text-right font-medium">top dense</th>
            </tr>
          </thead>
          <tbody className="text-neutral-300">
            {queries.map((q) => (
              <tr key={q.id} className="border-t border-neutral-800 align-top">
                <td className="px-2 py-1 font-mono">{q.query}</td>
                <td className="px-2 py-1 text-right">{q.hitCount}</td>
                <td className="px-2 py-1 text-right text-indigo-300">{q.kbHits}</td>
                <td className="px-2 py-1 text-right text-emerald-300">{q.codeHits}</td>
                <td className="px-2 py-1 text-right font-mono">{q.maxRrf.toFixed(4)}</td>
                <td className="px-2 py-1 text-right font-mono">{q.maxDense.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-neutral-400">
        RAG effective <span className="text-neutral-200">{ragUsedPct}%</span> of the time · of
        retrieved chunks <span className="text-indigo-300">{kbPct}% KB</span> /{' '}
        <span className="text-emerald-300">{codePct}% code</span>
      </p>
    </div>
  );
}

// "Save as template" controls injected next to the Save dependencies submit
// button (env-replicate step 1). Ticking the checkbox reveals a required name
// input; the existing submit then also saves the template. State lives in the
// parent StepCard so it never becomes part of the submitted FormValues.
function SaveAsTemplateControls({
  checked,
  onToggle,
  name,
  onNameChange,
  error,
}: {
  checked: boolean;
  onToggle: (value: boolean) => void;
  name: string;
  onNameChange: (value: string) => void;
  error: string | null;
}) {
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-neutral-800 pt-3">
      <label className="flex items-center gap-2 text-sm text-neutral-200">
        <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
        <span>Save as template</span>
      </label>
      {checked && (
        <div className="flex flex-col gap-1 pl-6">
          <Input
            value={name}
            placeholder="Template name"
            maxLength={255}
            onChange={(e) => onNameChange(e.target.value)}
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
