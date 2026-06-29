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
  type ExecutionPath,
  type RagQueryEntry,
  type StepAction,
  type StepActionResponse,
  type Task,
  type TaskAction,
  type TaskEvent,
  type TaskStatus,
  type TaskStep,
  type StepStatus,
  type UsageWindow,
  type UsageWindowSnapshot,
} from '@/lib/api-client';
import { Badge, Button, Card, Input } from '@/components/ui';
import { CircleDot, Route, FolderGit2 } from 'lucide-react';
import { useCliLogin } from '@/lib/use-cli-login';
import { shouldClearSubmitting } from '@/lib/submit-state';
import { formatDuration, formatHoursMinutes } from '@/lib/format-duration';
import { formatTokens } from '@/lib/format-tokens';
import {
  FormRenderer,
  InfoSections,
  StatusSummary,
  type FormValues,
} from '@/components/form-renderer';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { PersistedDetails } from '@/components/persisted-details';
import { PostgresTestButton, OllamaTestButton } from '@/components/connection-tester';
import { EditorTab } from '@/components/editor/editor-tab';
import { AttachmentsPanel } from '@/components/attachments/attachments-panel';
import { CommitDiffViewer } from '@/components/commit-diff-viewer';
import { StepTerminal } from '@/components/terminal/StepTerminal';
import { BrowserVncPanel } from '@/components/terminal/BrowserVncPanel';
import { BrowserDirectPanel } from '@/components/terminal/BrowserDirectPanel';
import { DatabaseAccessPanel } from '@/components/terminal/DatabaseAccessPanel';
import { InteractiveShell } from '@/components/terminal/InteractiveShell';
import { autoScrollTerminalsEnabled } from '@/lib/terminal-autoscroll';
import { usePageTitle } from '@/lib/use-page-title';
import { usePersistedToggle } from '@/lib/use-persisted-toggle';

/** Pick the live-browser surface for a step: the URL info box when the user chose
 *  `direct` (test in your own browser) mode, else the in-app VNC panel when the
 *  in-container headed browser is up, else nothing. */
function liveBrowserPanel(
  step: { id: string; detectOutput: unknown },
  taskId: string,
  opts: { autoCollapse: boolean; title?: string },
) {
  const det = step.detectOutput as {
    liveBrowser?: { available?: boolean };
    directAccess?: boolean;
    dbAccess?: boolean;
  } | null;
  // The browser surface (own-browser URL box OR in-app VNC) and the DB connection box are
  // independent: a task may want neither, either, or both. Render them as siblings.
  const browser = det?.directAccess ? (
    <BrowserDirectPanel
      taskId={taskId}
      title={opts.title}
      autoCollapse={opts.autoCollapse}
      persistId={step.id}
    />
  ) : det?.liveBrowser?.available ? (
    <BrowserVncPanel
      taskId={taskId}
      title={opts.title}
      autoCollapse={opts.autoCollapse}
      persistId={step.id}
    />
  ) : null;
  const dbPanel = det?.dbAccess ? (
    <DatabaseAccessPanel taskId={taskId} autoCollapse={opts.autoCollapse} persistId={step.id} />
  ) : null;
  if (!browser && !dbPanel) return null;
  return (
    <>
      {browser}
      {dbPanel}
    </>
  );
}

/** run_app hold step (99-run-app-ready): the live-app viewer. The viewing mode was
 *  picked upstream at 98-choose-view, so detect surfaces exactly ONE surface — the
 *  in-app VNC (detect.liveBrowser) OR the user's own browser (detect.directAccess) —
 *  and only that one renders here (no toggle; the other never started). The session
 *  commit-diff renders below either way. */
function RunAppReadyPanels({
  step,
  taskId,
  autoCollapse,
}: {
  step: { id: string; detectOutput: unknown };
  taskId: string;
  autoCollapse: boolean;
}) {
  const det = step.detectOutput as {
    mode?: string;
    liveBrowser?: { available?: boolean };
    directAccess?: boolean;
    dbAccess?: boolean;
    diffArtifactPath?: string | null;
  } | null;
  const showVnc = !!det?.liveBrowser?.available;
  const showDirect = !showVnc && !!det?.directAccess;
  // mode 'none' = nothing was runnable (no DDEV config, no dev script/Dockerfile).
  // Surface it clearly so the user isn't left staring at an empty "starting" panel.
  const nothingRunnable = det?.mode === 'none';

  return (
    <div className="flex flex-col gap-3">
      {nothingRunnable && (
        <div className="rounded-md border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          <p className="font-medium">No runnable runtime detected</p>
          <p className="mt-1 text-xs text-amber-200/80">
            This project has nothing to run — no DDEV config and no dev script or Dockerfile. Pick
            DDEV in the dependency step (Haive builds a .ddev config from the detected versions) or
            add a dev script / Dockerfile, then retry the runtime step. You can also just finish to
            tear everything down.
          </p>
        </div>
      )}
      {showVnc && (
        <BrowserVncPanel
          taskId={taskId}
          title="In-app browser (VNC)"
          autoCollapse={autoCollapse}
          persistId={`${step.id}-vnc`}
        />
      )}
      {showDirect && (
        <BrowserDirectPanel
          taskId={taskId}
          title="Open in your own browser"
          autoCollapse={autoCollapse}
          persistId={`${step.id}-direct`}
        />
      )}
      {det?.dbAccess && (
        <DatabaseAccessPanel
          taskId={taskId}
          title="Connect to the database"
          autoCollapse={autoCollapse}
          persistId={`${step.id}-db`}
        />
      )}
      {det?.diffArtifactPath && (
        <CommitDiffViewer taskId={taskId} artifactPath={det.diffArtifactPath} />
      )}
    </div>
  );
}

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

const EXECUTION_PATH_LABELS: Record<ExecutionPath, string> = {
  quick_bugfix: 'Quick bugfix',
  plan_tasklist: 'Plan + tasklist',
  full_workflow: 'Full workflow',
};

/** Chip colour per path: lighter path = greener (fast), full = neutral. Returns
 *  the Badge component's variant union (which includes 'info', unlike the local
 *  BadgeVariant alias used by the status helpers). */
function executionPathVariant(path: ExecutionPath): 'success' | 'info' | 'default' {
  switch (path) {
    case 'quick_bugfix':
      return 'success';
    case 'plan_tasklist':
      return 'info';
    default:
      return 'default';
  }
}

/** Pace colour for effort-vs-estimate: <=100% on/under budget (emerald), <=105%
 *  slightly over (amber), else over (rose). Shared by the header indicator and
 *  the footer verdict card. */
function paceColorClass(pct: number): string {
  if (pct <= 100) return 'text-emerald-300';
  if (pct <= 105) return 'text-amber-300';
  return 'text-rose-300';
}

/** Effort (agent work + your active time) in ms, applying the live user-active
 *  override to the current gate step so it ticks each second — mirrors the
 *  footer's effort so the header indicator and the verdict card agree. */
function liveEffortMs(
  steps: TaskStep[],
  userActive: { activeStepId: string | null; displayMs: number },
  endMs: number,
): number {
  const liveSteps = userActive.activeStepId
    ? steps.map((s) =>
        s.id === userActive.activeStepId ? { ...s, userActiveMs: userActive.displayMs } : s,
      )
    : steps;
  const { workMs, userActiveMs } = computeTaskTiming(liveSteps, endMs);
  return workMs + userActiveMs;
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

type Tab = 'steps' | 'editor' | 'terminal' | 'activity' | 'attachments';

interface TaskDetailResponse {
  task: Task;
  steps: TaskStep[];
}

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [task, setTask] = useState<Task | null>(null);
  const [promotedDraftCount, setPromotedDraftCount] = useState(0);
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
  // One-shot guard so the scroll-to-bottom-on-completion fires once per
  // completion (reset if the task leaves 'completed', e.g. a retry).
  const completedScrolledRef = useRef(false);
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

  // Data-driven "review promoted drafts" CTA for a completed task: count this task's
  // pending global-KB drafts from a live query, refetched on window focus, so the CTA
  // disappears on its own once they're all activated/deleted — no stale "review" link
  // weeks later when nothing is pending. 0 (and no CTA) when the global KB is off.
  useEffect(() => {
    if (task?.status !== 'completed') {
      setPromotedDraftCount(0);
      return;
    }
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const res = await api.get<{ total: number }>(
          `/global-kb/entries?status=draft&sourceTaskId=${id}&pageSize=1`,
        );
        if (!cancelled) setPromotedDraftCount(res.total ?? 0);
      } catch {
        if (!cancelled) setPromotedDraftCount(0);
      }
    };
    void fetchCount();
    const onFocus = () => void fetchCount();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [task?.status, id]);

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
    const activeId = activeStep?.id ?? null;
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
        if (!stepEl) return false;
        // Prefer the newest RUNNING run. The last panel (and the toggle below it)
        // is often a queued, empty terminal — a step that fans out more
        // invocations than the concurrency cap (03-phase-0a-discovery: 8
        // dispatched, ~5 run at once) leaves the tail panels waiting their turn.
        // Fall back to the toggle (keeps the checkbox visible), then the last
        // panel, when nothing is running yet.
        const running = stepEl.querySelectorAll('[data-cli-terminal][data-cli-running]');
        const panels = stepEl.querySelectorAll('[data-cli-terminal]');
        const target =
          running[running.length - 1] ??
          stepEl.querySelector('[data-cli-autoscroll]') ??
          panels[panels.length - 1] ??
          null;
        if (!target) return false;
        target.scrollIntoView({ behavior: 'smooth', block: 'end' });
        return true;
      };

      if (!showsTerminal || !auto) {
        scrollToHeader();
        // The just-finished step's terminal collapses a tick later (its
        // autoExpand flips false and the run panels unmount), removing a large
        // chunk of vertical space ABOVE this header and shoving it back out of
        // view — so the scroll above, computed against the still-expanded
        // layout, lands too high (often near page top). Re-apply once the
        // collapse settles. Timers are cleared on the next key change / unmount.
        [150, 400].forEach((delay) =>
          scrollTimersRef.current.push(setTimeout(scrollToHeader, delay)),
        );
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

  // When the task completes, trailing CTAs render BELOW the last step: the
  // KB-draft "Review N drafts" button, the upgrade "Back to repositories"
  // button, and the total-time row. The active-step auto-scroll above stops
  // firing on completion (no step is active anymore), so the view is left at
  // the final step's header and those buttons sit off-screen. Scroll the
  // container's bottom into view once, when the task finishes. Keyed on `tab`
  // too: if completion lands while another tab is showing, the steps container
  // is unmounted (ref null) — re-run so the scroll fires when steps is shown.
  useEffect(() => {
    const container = stepsContainerRef.current;
    if (!container) return;
    if (task?.status !== 'completed') {
      completedScrolledRef.current = false;
      return;
    }
    if (completedScrolledRef.current) return;
    completedScrolledRef.current = true;
    // Cancel pending active-step re-scroll timers so they can't yank the view
    // back up to the final step header after we reach the bottom.
    scrollTimersRef.current.forEach(clearTimeout);
    scrollTimersRef.current = [];
    const scrollToBottom = () => {
      container.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    };
    scrollToBottom();
    // The just-finished step's terminal collapses a tick later, shifting the
    // layout; re-apply so the final position accounts for the shorter page.
    [150, 400, 800].forEach((delay) =>
      scrollTimersRef.current.push(setTimeout(scrollToBottom, delay)),
    );
  }, [task?.status, tab]);

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
    // The step ROW id (unique per fix-loop round), so the live timer + the task total
    // attach to the CURRENT round only — not every row that shares this stepId.
    activeWaitingStep?.id ?? null,
    activeWaitingStep?.userActiveMs ?? 0,
  );

  // The Editor opens the task's GIT WORKTREE as its sole workspace folder, so the tab is
  // gated two ways:
  //  - Disabled outright for completed/cancelled tasks: the worktree and branch are reaped
  //    at task end, so even a read-only source would be empty and a fresh editor would be
  //    rooted at a path that no longer exists. 'failed' stays editable (runtime kept for
  //    recovery).
  //  - Disabled until the worktree exists. Worktree-using types (workflow, run_app — see
  //    buildRunList / SPINE) create it in the mandatory 01-worktree-setup step; opening the
  //    editor earlier would root at the repo checkout (wrong folder) or a path not there
  //    yet. Step rows are created lazily, so the readiness signal must be POSITIVE — that
  //    step present AND done, OR skipped: run_app may skip 01-worktree-setup to run from
  //    the repo root, and the IDE then roots there (resolveDdevWorkspace's repo-root
  //    fallback), so a skipped step is just as "ready" as a done one. Other types
  //    (onboarding) edit the repo root and have no worktree step, so they are not
  //    worktree-gated.
  // Switch away if the user is sitting on the Editor tab while it is (or becomes) disabled.
  const usesWorktree = task?.type === 'workflow' || task?.type === 'run_app';
  const worktreeReady =
    !usesWorktree ||
    steps.some(
      (s) => s.stepId === '01-worktree-setup' && (s.status === 'done' || s.status === 'skipped'),
    );
  const editorDisabled =
    task?.status === 'completed' || task?.status === 'cancelled' || !worktreeReady;
  useEffect(() => {
    if (editorDisabled && tab === 'editor') setTab('steps');
  }, [editorDisabled, tab]);

  async function submitStep(step: TaskStep, values: FormValues) {
    setSubmitting(step.stepId);
    setSubmitError(null);
    try {
      const schema = step.formSchema as FormSchema | null;
      if (schema?.submitAction === 'clarify') {
        // Mid-step clarification (e.g. the merge-resolver). The answer must NOT
        // overwrite the step's form values, so it goes to /clarify (task_events).
        await api.post(`/tasks/${id}/steps/${step.stepId}/clarify`, {
          answer: String(values.mergeGuidance ?? ''),
        });
      } else {
        await api.post(`/tasks/${id}/steps/${step.stepId}/submit`, { values });
      }
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

  // Stop the running CLI step without ending the task (vs runAction('cancel'),
  // which tears everything down). Leaves the task open/restartable.
  async function stopActiveCli() {
    setActionError(null);
    try {
      await api.post(`/tasks/${id}/cancel-active-cli`, {});
      await reload();
    } catch (err) {
      setActionError((err as Error).message ?? 'Stop failed');
    }
  }

  async function runStepAction(
    step: TaskStep,
    action: StepAction,
    opts?: { overrideLocalModel?: boolean },
  ) {
    const downstreamCount = steps.filter(
      (s) => s.stepIndex > step.stepIndex && s.status !== 'pending',
    ).length;
    const label = opts?.overrideLocalModel
      ? 'Run this step on the current local model anyway?\n\nLocal models are unreliable at rewriting long-lived project files (skills, agents, config) and may produce low-quality or damaging output. Proceed only if you understand the risk.'
      : action === 'retry_ai'
        ? 'Spawn an AI agent to diagnose and fix this failure, then re-run the step?'
        : action === 'abort'
          ? 'Abort this step and cancel the task? The environment will be torn down.'
          : action === 'skip'
            ? step.stepId === '01-worktree-setup'
              ? 'Work from the project root (the repo’s current branch) instead of an isolated branch/worktree? You can still commit your edits at the end.'
              : 'Skip this step and continue to the next step?'
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
      await api.post<StepActionResponse>(`/tasks/${id}/steps/${step.stepId}/action`, {
        action,
        round: step.round,
        overrideLocalModel: opts?.overrideLocalModel,
      });
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
        round: step.round,
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

  async function changeStepProvider(
    stepId: string,
    cliProviderId: string | null,
    role: string | undefined,
    round: number,
    effortLevel?: string,
  ) {
    setStepProviderBusy(stepId);
    setStepProviderError(null);
    try {
      // effortLevel omitted (a CLI-only change) clears the stored effort server-side,
      // so the dropdown resets to the new CLI's default on reload; sent (an effort
      // change) pins the effective CLI + the chosen effort for this (step, role).
      await api.patch(`/tasks/${id}/steps/${stepId}/cli-provider`, {
        cliProviderId,
        round,
        ...(role ? { role } : {}),
        ...(effortLevel !== undefined ? { effortLevel } : {}),
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

  // Upgrade/rollback tasks (both type 'onboarding_upgrade'; rollback is
  // metadata.mode === 'rollback') return to the repositories list rather than
  // the tasks list.
  const isUpgradeTask = task.type === 'onboarding_upgrade';
  const backHref = isUpgradeTask ? '/repos' : '/tasks';
  const backLabel = isUpgradeTask ? 'Back to repositories' : 'Back to tasks';
  const canCancel = !['completed', 'cancelled'].includes(task.status);
  // A CLI step is actively executing. The Stop buttons (top-right + the running
  // step row) target it: stop the CLI, keep the environment, task stays open.
  // Cancel, by contrast, ends the whole task and tears the environment down.
  const stepRunning = steps.some((s) => s.status === 'running' || s.status === 'waiting_cli');
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

  // The subscription-usage chip follows the CLI of the step the run is parked on (or the
  // task default): a Codex step shows Codex's windows, a Claude step shows Claude's.
  const usageProviderId = currentStep?.preferredCliProviderId ?? task.cliProviderId ?? null;
  const usageProvider = usageProviderId
    ? (providers.find((p) => p.id === usageProviderId) ?? null)
    : null;

  return (
    <div className="flex flex-col gap-6">
      {titleStripVisible && (
        <div className="fixed left-64 right-0 top-0 z-30 flex items-center gap-3 border-b border-neutral-800 bg-neutral-950/90 px-8 py-2 backdrop-blur">
          <p className="min-w-0 truncate text-sm font-semibold text-indigo-300">{task.title}</p>
          {task.repository && (
            <Badge
              variant="default"
              className="shrink-0 gap-1 border-violet-800/60 bg-violet-900/60 text-violet-300"
            >
              <FolderGit2 className="h-3 w-3" />
              {task.repository.name}
            </Badge>
          )}
          {task.executionPath && (
            <Badge variant={executionPathVariant(task.executionPath)} className="shrink-0 gap-1">
              <Route className="h-3 w-3" />
              {EXECUTION_PATH_LABELS[task.executionPath]}
            </Badge>
          )}
          {currentStep && (
            <Badge variant="warning" className="min-w-0 shrink gap-1" title={currentStep.title}>
              <CircleDot className="h-3 w-3 shrink-0" />
              <span className="truncate">{currentStep.title}</span>
            </Badge>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <HeaderUsageChip
              providerId={usageProviderId}
              providerName={usageProvider?.name ?? null}
              providerLabel={usageProvider?.label ?? null}
            />
            <HeaderPaceChip task={task} steps={steps} userActive={userActive} />
          </div>
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link href={backHref} className="text-xs text-indigo-400 underline">
            {backLabel}
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
                {task.executionPath && (
                  <Badge variant={executionPathVariant(task.executionPath)}>
                    {EXECUTION_PATH_LABELS[task.executionPath]}
                  </Badge>
                )}
                {task.repository && <Badge variant="info">repo: {task.repository.name}</Badge>}
                <Button size="sm" variant="secondary" onClick={startRename}>
                  Rename
                </Button>
              </>
            )}
          </div>
          {renameError && <p className="mt-1 text-xs text-red-400">{renameError}</p>}
          {task.description && <p className="text-sm text-neutral-400">{task.description}</p>}
          {task.status === 'failed' && task.errorMessage && (
            <p className="text-sm text-red-400">Error: {task.errorMessage}</p>
          )}
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
          {stepRunning && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (confirm('Stop the running step? The task stays open so you can restart it.'))
                  void stopActiveCli();
              }}
              title="Stop the running CLI for the current step. Keeps the environment; the task stays open and restartable."
            >
              Stop
            </Button>
          )}
          {canCancel && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (
                  confirm(
                    'Cancel this task? This stops the running step, tears down the environment, and ends the task.',
                  )
                )
                  void runAction('cancel');
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
        <TabButton
          active={tab === 'editor'}
          onClick={() => setTab('editor')}
          disabled={editorDisabled}
        >
          Editor
        </TabButton>
        <TabButton active={tab === 'terminal'} onClick={() => setTab('terminal')}>
          Terminal
        </TabButton>
        <TabButton active={tab === 'activity'} onClick={() => setTab('activity')}>
          Activity
        </TabButton>
        <TabButton active={tab === 'attachments'} onClick={() => setTab('attachments')}>
          Attachments
        </TabButton>
      </div>

      {tab === 'steps' && (
        <div ref={stepsContainerRef} className="flex flex-col gap-3">
          {steps.length === 0 && (
            <div className="text-sm text-neutral-500">
              No steps recorded yet. The task worker will populate them once it starts.
            </div>
          )}
          {steps.map((step, i) => {
            // Fix-loop rounds: the same stepId recurs once per round (round 0 = the
            // original pass). Mark the start of each round > 0 group with a header.
            const showLoopHeader =
              step.round > 0 && (i === 0 || steps[i - 1]!.round !== step.round);
            return (
              <div key={step.id} data-step-id={step.id}>
                {showLoopHeader && (
                  <div className="mb-2 mt-5 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-amber-400/80">
                    <span className="h-px flex-1 bg-amber-400/20" />
                    Fix loop #{step.round}
                    <span className="h-px flex-1 bg-amber-400/20" />
                  </div>
                )}
                {/* currentStep: the step the run is parked on — auto-continue is
                  only offered there; passed steps can't be auto-continued. */}
                <StepCard
                  step={step}
                  taskId={task.id}
                  taskStatus={task.status}
                  taskCompletedAt={task.completedAt}
                  taskRepositoryId={task.repositoryId}
                  userActiveDisplayMs={
                    userActive.activeStepId === step.id ? userActive.displayMs : step.userActiveMs
                  }
                  submitting={submitting === step.stepId}
                  submitError={submitting === step.stepId ? submitError : null}
                  onSubmit={(values) => submitStep(step, values)}
                  actionBusy={stepActionBusy === step.stepId}
                  actionError={
                    stepActionError?.stepId === step.stepId ? stepActionError.message : null
                  }
                  onAction={(action, opts) => runStepAction(step, action, opts)}
                  onRetryStep={async (sid) => {
                    const target = steps.find((s) => s.stepId === sid);
                    if (target) await runStepAction(target, 'retry');
                  }}
                  onStop={() => void stopActiveCli()}
                  onCliLogin={() => openCliLoginForStep(step)}
                  providers={providers}
                  taskCliProviderId={task.cliProviderId ?? null}
                  cliBusy={stepProviderBusy === step.stepId}
                  cliError={
                    stepProviderError?.stepId === step.stepId ? stepProviderError.message : null
                  }
                  onChangeCli={(cliProviderId, role, effortLevel) =>
                    changeStepProvider(step.stepId, cliProviderId, role, step.round, effortLevel)
                  }
                  autoContinue={task.autoContinue}
                  autoContinueBusy={autoContinueBusy}
                  showAutoContinue={step.id === currentStep?.id}
                  onToggleAutoContinue={() => void toggleAutoContinue()}
                />
              </div>
            );
          })}
          <TaskTotalTime task={task} steps={steps} userActive={userActive} />
          {task.status === 'completed' && promotedDraftCount > 0 && (
            <div className="flex justify-center pt-2">
              <Link href={`/settings/global-kb?status=draft&sourceTaskId=${task.id}`}>
                <Button>
                  Review {promotedDraftCount} global KB draft{promotedDraftCount === 1 ? '' : 's'}{' '}
                  you promoted →
                </Button>
              </Link>
            </div>
          )}
          {isUpgradeTask && task.status === 'completed' && (
            <div className="flex justify-center pt-2">
              <Link href="/repos">
                <Button>Back to repositories</Button>
              </Link>
            </div>
          )}
        </div>
      )}

      {tab === 'editor' && !editorDisabled && <EditorTab taskId={id} />}

      {tab === 'attachments' && <AttachmentsPanel taskId={id} />}

      {tab === 'terminal' && (
        <TerminalTab
          taskId={id}
          taskStatus={task.status}
          repositoryId={task.repositoryId}
          repositoryName={task.repository?.name ?? null}
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
  repositoryId: string | null;
  repositoryName: string | null;
  providers: CliProvider[];
  selectedCliProviderId: string | null;
  onSelectCliProvider: (id: string) => void;
}

function TerminalTab({
  taskId,
  taskStatus,
  repositoryId,
  repositoryName,
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
          repositoryId={repositoryId ?? undefined}
          repositoryName={repositoryName}
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
  onAction: (action: StepAction, opts?: { overrideLocalModel?: boolean }) => Promise<void>;
  onCliLogin: () => void;
  providers: CliProvider[];
  /** Task-level fallback when this step has no per-step preference set. */
  taskCliProviderId: string | null;
  cliBusy: boolean;
  cliError: string | null;
  onChangeCli: (cliProviderId: string | null, role?: string, effortLevel?: string) => Promise<void>;
  /** Task-level auto-continue flag, shown as a checkbox on the CURRENT step
   *  card only (passed steps can't be auto-continued anymore). */
  autoContinue: boolean;
  autoContinueBusy: boolean;
  showAutoContinue: boolean;
  onToggleAutoContinue: () => void;
  /** Retry an arbitrary step by id (not just this card's own step). Used by the
   *  03c review card to re-run the previous business-requirements step. */
  onRetryStep: (stepId: string) => Promise<void>;
  /** Stop the running CLI for this step without re-running it (vs onAction('retry'),
   *  which stops AND re-runs). Same effect as the top-right Stop. */
  onStop: () => void;
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

// Per-step CLI token usage: summed across the step's non-superseded invocations
// (reconciles with the per-invocation terminal panel). Hidden when the step ran
// no token-bearing CLI so deterministic steps stay clean.
function StepTokens({ tokenUsage }: { tokenUsage: TaskStep['tokenUsage'] }) {
  if (!tokenUsage || tokenUsage.totalTokens <= 0) return null;
  const { inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheCreationTokens, costUsd } =
    tokenUsage;
  const title =
    `CLI tokens (provider-native): in ${inputTokens.toLocaleString()} / out ${outputTokens.toLocaleString()} / total ${totalTokens.toLocaleString()}` +
    (cacheReadTokens ? `, cache read ${cacheReadTokens.toLocaleString()}` : '') +
    (cacheCreationTokens ? `, cache write ${cacheCreationTokens.toLocaleString()}` : '') +
    (costUsd ? `, ~$${costUsd.toFixed(2)}` : '');
  return (
    <span className="font-mono text-xs text-sky-300" title={title}>
      {formatTokens(totalTokens)} tok
    </span>
  );
}

// Surface B: context-window headroom frozen when this step finished (audit trail).
// Renders nothing on deterministic steps (no CLI invocations -> null columns).
function StepContextLeft({ step }: { step: TaskStep }) {
  if (step.contextLeftPercent == null) return null;
  const left = step.contextLeftPercent;
  const color = left <= 10 ? 'text-red-400' : left <= 25 ? 'text-amber-400' : 'text-emerald-300';
  const title =
    step.contextTokens != null && step.contextWindowSize != null
      ? `Context at finish: ${step.contextTokens.toLocaleString()} / ${step.contextWindowSize.toLocaleString()} prompt tokens — ${left}% of the window left`
      : `Context ${left}% left at finish`;
  return (
    <span className={`font-mono text-xs ${color}`} title={title}>
      ctx {left}%
    </span>
  );
}

// Task time summary: agent work, idle (time waiting on you), your active time at
// gates, total effort, and wall clock. Shown live while the task runs (ticks each
// second) and frozen once it ends. Renders nothing until the task has started.
/** Live effort-vs-estimate chip for the fixed header (top-right). Owns its own
 *  1s tick — like TaskTotalTime — so only this chip re-renders each second, not
 *  the whole task page. Renders nothing unless an estimate is set and the task
 *  has started; effort freezes at completedAt once done. */
function HeaderPaceChip({
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
  const estHours = task.estimatedTimeHours ?? 0;
  if (estHours <= 0 || !task.startedAt) return null;
  const endMs = task.completedAt ? new Date(task.completedAt).getTime() : now;
  const effortMs = liveEffortMs(steps, userActive, endMs);
  const estimateMs = estHours * 3_600_000;
  const pct = estimateMs > 0 ? (effortMs / estimateMs) * 100 : 0;
  return (
    <span
      className={`ml-auto shrink-0 font-mono text-sm font-semibold ${paceColorClass(pct)}`}
      title={`Effort vs estimate — ${Math.round(pct)}% of the ${estHours}h estimate`}
    >
      {formatHoursMinutes(effortMs)} / {formatHoursMinutes(estimateMs)}
    </span>
  );
}

// Short display names for the usage chip (the CLI "type", not the user's clone label).
const CLI_USAGE_LABEL: Partial<Record<CliProviderName, string>> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  zai: 'Z.ai',
};

function resetSuffix(resetsAt: string | null, now: number): string {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - now;
  if (ms <= 0) return ' (resetting)';
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  return d > 0 ? ` (resets in ${d}d ${h}h)` : ` (resets in ${h}h ${m}m)`;
}

/**
 * Subscription usage chip: each window's REMAINING percentage for the provider the
 * current step runs on (used = vendor-reported; remaining = 100 - used, matching the
 * vendor's own "% left" view). Polls /usage-window gently (~60s). Renders nothing when
 * the provider has no readable window, isn't connected, or the snapshot errored; dims
 * when stale. Colour reflects the tightest remaining window.
 */
function HeaderUsageChip({
  providerId,
  providerName,
  providerLabel,
}: {
  providerId: string | null;
  providerName: CliProviderName | null;
  providerLabel: string | null;
}) {
  const [snapshots, setSnapshots] = useState<UsageWindowSnapshot[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<{ snapshots: UsageWindowSnapshot[] }>('/usage-window')
        .then((d) => {
          if (!cancelled) setSnapshots(d.snapshots);
        })
        .catch(() => {
          if (!cancelled) setSnapshots([]);
        });
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!providerId || !snapshots) return null;
  const snap = snapshots.find((s) => s.providerId === providerId);
  if (!snap || snap.status !== 'ok') return null;

  const windows: { label: string; w: UsageWindow }[] = [];
  if (snap.fiveHour) windows.push({ label: '5h', w: snap.fiveHour });
  if (snap.sevenDay) windows.push({ label: 'week', w: snap.sevenDay });
  if (snap.daily) windows.push({ label: 'day', w: snap.daily });
  if (windows.length === 0) return null;

  const minRemaining = Math.min(...windows.map((x) => 100 - x.w.usedPct));
  const color =
    minRemaining <= 10
      ? 'text-red-400'
      : minRemaining <= 25
        ? 'text-amber-400'
        : 'text-emerald-400';
  const name =
    (providerName && CLI_USAGE_LABEL[providerName]) || providerLabel || providerName || 'CLI';
  const tooltip = windows
    .map((x) => `${x.label}: ${100 - x.w.usedPct}% left${resetSuffix(x.w.resetsAt, now)}`)
    .join('   ·   ');

  return (
    <span
      className={`mx-2 flex shrink-0 items-center gap-1.5 font-mono text-xs font-semibold ${color} ${
        snap.stale ? 'opacity-50' : ''
      }`}
      title={`${name} subscription usage — ${tooltip}${snap.stale ? '   (stale)' : ''}`}
    >
      <span className="text-neutral-400">{name}</span>
      {windows.map((x, i) => (
        <span key={x.label} className="flex items-center gap-1.5">
          {i > 0 && <span className="h-3 w-px bg-neutral-600" aria-hidden />}
          <span>
            {x.label} {100 - x.w.usedPct}%
          </span>
        </span>
      ))}
    </span>
  );
}

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
        s.id === userActive.activeStepId ? { ...s, userActiveMs: userActive.displayMs } : s,
      )
    : steps;
  const { workMs, idleMs, userActiveMs } = computeTaskTiming(liveSteps, endMs);
  const effortMs = workMs + userActiveMs;
  // CLI tokens summed across steps (the server already summed each step over its
  // non-superseded invocations), so this total equals the sum of the per-step
  // figures shown on the cards.
  const totalTokens = steps.reduce((sum, s) => sum + (s.tokenUsage?.totalTokens ?? 0), 0);
  const inputTokens = steps.reduce((sum, s) => sum + (s.tokenUsage?.inputTokens ?? 0), 0);
  const outputTokens = steps.reduce((sum, s) => sum + (s.tokenUsage?.outputTokens ?? 0), 0);
  // Split the total: cached (cache read + write, re-used context) vs fresh in+out
  // (the genuinely new tokens). cached + fresh === total.
  const cachedTokens = steps.reduce(
    (sum, s) =>
      sum + (s.tokenUsage?.cacheReadTokens ?? 0) + (s.tokenUsage?.cacheCreationTokens ?? 0),
    0,
  );
  const freshTokens = inputTokens + outputTokens;
  // While running, show seconds even past 1h so the live values visibly tick:
  // the 1s interval advances them, but the compact h/m format hides sub-minute
  // changes (a multi-hour task looks frozen). Completed tasks stay compact.
  const fmt = (ms: number) => formatDuration(ms, { alwaysSeconds: !task.completedAt });
  // Estimate-vs-effort verdict (only when the developer set an estimate and the
  // task has finished). Same effort basis + colour thresholds as the header chip.
  const showVerdict =
    !!task.completedAt && !!task.estimatedTimeHours && task.estimatedTimeHours > 0;
  const verdictEstimateMs = (task.estimatedTimeHours ?? 0) * 3_600_000;
  const verdictPct =
    showVerdict && verdictEstimateMs > 0 ? (effortMs / verdictEstimateMs) * 100 : 0;
  const verdictLabel =
    verdictPct <= 100
      ? 'On time / faster'
      : verdictPct <= 105
        ? 'Slightly over estimate'
        : 'Over estimate';
  return (
    <>
      <Card className="flex items-center justify-between gap-3 py-3">
        <div className="flex flex-col">
          <span className="text-sm font-medium text-neutral-200">Total time</span>
          <span className="text-xs text-neutral-500">
            {new Date(task.startedAt).toLocaleString()} →{' '}
            {task.completedAt ? new Date(task.completedAt).toLocaleString() : '(running)'}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-2">
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
            <span className="font-mono text-lg font-semibold text-rose-300">{fmt(effortMs)}</span>
            <span
              className="text-[10px] uppercase tracking-wider text-rose-400/80"
              title="Agent work + your active time = real task effort"
            >
              effort
            </span>
          </div>
          <div className="flex flex-col items-end">
            <span className="font-mono text-lg text-neutral-100">{fmt(wallMs)}</span>
            <span className="text-[10px] uppercase tracking-wider text-neutral-500">
              wall clock
            </span>
          </div>
          {totalTokens > 0 && (
            <>
              <div className="flex flex-col items-end">
                <span
                  className="font-mono text-lg text-sky-300"
                  title={`CLI tokens (provider-native): in ${inputTokens.toLocaleString()} / out ${outputTokens.toLocaleString()} / cache ${cachedTokens.toLocaleString()} / total ${totalTokens.toLocaleString()}`}
                >
                  {formatTokens(totalTokens)}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                  tokens
                </span>
              </div>
              <div className="flex flex-col items-end">
                <span
                  className="font-mono text-lg text-cyan-300"
                  title={`Cached tokens (cache read + cache write — re-used context): ${cachedTokens.toLocaleString()}`}
                >
                  {formatTokens(cachedTokens)}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                  cached
                </span>
              </div>
              <div className="flex flex-col items-end">
                <span
                  className="font-mono text-lg text-teal-300"
                  title={`Fresh tokens (input + output — genuinely new): ${freshTokens.toLocaleString()}`}
                >
                  {formatTokens(freshTokens)}
                </span>
                <span className="text-[10px] uppercase tracking-wider text-neutral-500">
                  in+out
                </span>
              </div>
            </>
          )}
        </div>
      </Card>
      {showVerdict && (
        <Card className="flex items-center justify-between gap-3 py-3">
          <div className="flex flex-col">
            <span className="text-sm font-medium text-neutral-200">Estimate vs effort</span>
            <span className="text-xs text-neutral-500">
              Estimated {formatHoursMinutes(verdictEstimateMs)} · actual effort{' '}
              {formatHoursMinutes(effortMs)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className={`font-mono text-lg font-semibold ${paceColorClass(verdictPct)}`}>
              {Math.round(verdictPct)}%
            </span>
            <span className={`text-sm font-medium ${paceColorClass(verdictPct)}`}>
              {verdictLabel}
            </span>
          </div>
        </Card>
      )}
    </>
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
  onRetryStep,
  onStop,
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
  // Per-task / per-step namespace for remembering this card's collapse/expand state
  // across reloads (the disclosures, the raw-output + RAG-stats toggles).
  const uiPrefix = `task-ui:${taskId}:${step.id}`;
  const [showOutput, setShowOutput] = usePersistedToggle(`${uiPrefix}:output`, false);
  const [showRagStats, setShowRagStats] = usePersistedToggle(`${uiPrefix}:ragstats`, false);
  const isDiscovery = step.stepId === '03-phase-0a-discovery';
  const schema = step.formSchema as FormSchema | null;
  const initialValues = (step.formValues as FormValues | null) ?? undefined;
  const taskCancelled = taskStatus === 'cancelled';
  // Whole task finished — used to drop live-runtime panels (e.g. the gate-2 VNC)
  // so they stop reconnecting against a torn-down runtime and spamming the console
  // with WebSocket 1006 errors.
  const taskEnded = taskCancelled || taskStatus === 'completed' || taskStatus === 'failed';
  // The live browser/VNC needs a running task runtime; once the task is completed or
  // cancelled that runtime is torn down (cleanup/teardown), so hide the browser
  // panels entirely instead of letting them reconnect to nothing (WebSocket 1006
  // spam). Failed tasks keep theirs — the runtime may still be up for debugging.
  const runtimeTornDown = taskCancelled || taskStatus === 'completed';
  const showForm = !taskCancelled && step.status === 'waiting_form' && schema;
  // Auto-skipped steps (shouldRun → false, or detect skipReason) have nothing
  // to retry — they were intentionally bypassed by the runner. Manually-skipped
  // steps remain retryable in case the user changed their mind.
  const isAutoSkipped = step.status === 'skipped' && !step.manuallySkipped;
  // A completed task has already run its tail steps — worktree-cleanup may have
  // merged + removed the worktree and deleted the branch, so re-running a step
  // against a missing workspace/branch would fail or churn the tail. Hide per-step
  // retry once the task is done (cancelled is excluded above; failed stays
  // retryable — that is the whole point of retry on a failed step).
  const canRetry =
    !taskCancelled &&
    taskStatus !== 'completed' &&
    !isAutoSkipped &&
    RETRYABLE_STEP_STATUSES.has(step.status);
  // No per-step action is possible once the task is terminally cancelled or
  // completed — there is nothing left to do on it, so every action button is
  // hidden. A FAILED task is deliberately excluded (canActOnStep stays true) so
  // its failed step keeps Retry / Retry with AI / Abort for recovery. Gates the
  // whole action-button group below (the stepId label stays visible).
  const canActOnStep = !taskCancelled && taskStatus !== 'completed';
  // Only steps that actually dispatch a CLI (llm | agentMining | dagExecute) get a
  // provider picker; deterministic steps never consume a per-step provider, so the
  // picker would be a dead control. usesCli comes from CLI_DISPATCH_STEP_IDS.
  const showCliPicker = !taskCancelled && ACTIONABLE_STATUSES.has(step.status) && step.usesCli;
  // Deterministic actionable steps show a subtle note in place of the picker so
  // its absence reads as intentional rather than a bug.
  const showDeterministicNote =
    !taskCancelled && ACTIONABLE_STATUSES.has(step.status) && !step.usesCli;
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

  // Per-step effort dropdown: given the effective provider for a (step, role) and the
  // remembered effort, render a select of that CLI's effort scale, or null when the CLI
  // has no effort knob (effortScale === null) so the control hides entirely. A CLI change
  // clears the stored effort server-side, so on the next reload this re-derives its
  // options + selected value from the NEW provider (claude 'max' drops on a switch to
  // codex, which exposes 'xhigh'; switching to gemini/ollama hides the dropdown).
  const effortSelectFor = (
    providerId: string,
    rememberedEffort: string | null | undefined,
    roleId?: string,
  ): React.ReactNode => {
    const prov = providers.find((p) => p.id === providerId);
    const scale = prov?.effortScale ?? null;
    if (!scale) return null;
    const value = rememberedEffort ?? prov?.effortLevel ?? scale.max;
    return (
      <select
        aria-label="reasoning effort"
        title="Reasoning/effort level for this step's CLI (overrides the CLI's default)"
        disabled={cliLocked || cliBusy}
        value={value}
        onChange={(e) => void onChangeCli(providerId || null, roleId, e.target.value)}
        className={cliSelectClass}
      >
        {scale.values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  };

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
  // Steps whose form can be saved/applied as a named, repo-scoped template, each
  // mapped to the field after which the "Save as template" controls render.
  const presetAnchorField = (
    {
      '01-declare-deps': 'extraPackages',
      '02-generate-dockerfile': 'dockerfile',
    } as Record<string, string>
  )[step.stepId];
  const supportsPresets = presetAnchorField !== undefined;
  const [presets, setPresets] = useState<EnvDepPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [appliedValues, setAppliedValues] = useState<FormValues | undefined>(undefined);
  const [formKey, setFormKey] = useState(0);
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [makeGlobal, setMakeGlobal] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [presetError, setPresetError] = useState<string | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState(false);

  const refreshPresets = useCallback(async () => {
    if (!supportsPresets || !taskRepositoryId) return;
    try {
      const data = await api.get<{ presets: EnvDepPreset[] }>(
        `/env-dep-presets?repositoryId=${taskRepositoryId}&stepId=${step.stepId}`,
      );
      setPresets(data.presets);
    } catch {
      setPresets([]);
    }
  }, [supportsPresets, taskRepositoryId, step.stepId]);

  useEffect(() => {
    if (supportsPresets && showForm && taskRepositoryId) void refreshPresets();
  }, [supportsPresets, showForm, taskRepositoryId, refreshPresets]);

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
  async function handlePresetSubmit(values: FormValues) {
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
        await api.post('/env-dep-presets', {
          repositoryId: taskRepositoryId,
          stepId: step.stepId,
          name,
          values,
          global: makeGlobal,
        });
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
    if (supportsPresets && fieldId === presetAnchorField) {
      return (
        <SaveAsTemplateControls
          checked={saveAsTemplate}
          onToggle={(v) => {
            setSaveAsTemplate(v);
            if (!v) setMakeGlobal(false);
            setPresetError(null);
          }}
          name={templateName}
          onNameChange={(v) => {
            setTemplateName(v);
            setPresetError(null);
          }}
          global={makeGlobal}
          onGlobalToggle={(v) => {
            setMakeGlobal(v);
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
      {(showCliPicker || showAutoContinue || showDeterministicNote) && (
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
                  {effortSelectFor(
                    step.cliRoleProviders?.[roleDesc.id] ?? taskCliProviderId ?? '',
                    step.cliRoleEfforts?.[roleDesc.id],
                    roleDesc.id,
                  )}
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
                {effortSelectFor(effectiveCliProviderId, step.preferredEffortLevel)}
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
          {showDeterministicNote && (
            <span className="text-[11px] text-neutral-500">
              Deterministic step — runs without an AI CLI
            </span>
          )}
          {showAutoContinue && (
            <label
              className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-neutral-300"
              title="Auto-submit info-only and pre-configured steps so the workflow runs hands-free between the decision gates. Untick to confirm every step with a Continue button. Task-wide; applies from the next step decision."
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
          <StepTokens tokenUsage={step.tokenUsage} />
          <StepContextLeft step={step} />
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
          {canActOnStep && (
            <>
              {step.stepId === '03c-business-requirements-review' && step.status === 'failed' && (
                <Button
                  size="sm"
                  disabled={actionBusy}
                  onClick={() => void onRetryStep('03b-business-requirements')}
                  title="Reset and re-run the business-requirements step with your rejection feedback pre-filled, so the agent re-drafts addressing it. Retrying THIS step would only re-review the same draft."
                >
                  Re-run business requirements
                </Button>
              )}
              {(step.status === 'running' || step.status === 'waiting_cli') && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    if (
                      confirm('Stop this step? It stops without re-running; the task stays open.')
                    )
                      onStop();
                  }}
                  title="Stop the running CLI for this step. Keeps the environment; the task stays open and restartable. Use Stop & retry to stop and immediately re-run."
                >
                  Stop
                </Button>
              )}
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
              {step.errorHint?.type === 'local_model_destructive' && step.status === 'failed' && (
                <Button
                  size="sm"
                  disabled={actionBusy}
                  onClick={() => onAction('retry', { overrideLocalModel: true })}
                  title="Run this step on the current local model despite the reliability warning. Bypasses the block for this step only — other steps keep the guard."
                >
                  {actionBusy ? 'Overriding…' : 'Override and run'}
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
              {(step.status === 'failed' || step.status === 'waiting_form') && step.canSkip && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={actionBusy}
                  onClick={() => onAction('skip')}
                  title={
                    step.stepId === '01-worktree-setup'
                      ? 'Run from the project root (the repo’s current branch) instead of creating an isolated branch/worktree.'
                      : 'Skip this optional step and continue to the next one.'
                  }
                >
                  {step.stepId === '01-worktree-setup' ? 'Skip — work from project root' : 'Skip'}
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
            </>
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

      {step.warningMessage && (
        <div className="whitespace-pre-wrap rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          {step.warningMessage}
        </div>
      )}

      {step.errorMessage && (
        <div className="whitespace-pre-wrap rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {step.errorMessage}
        </div>
      )}

      {step.attemptCount > 1 && step.iterationCount === 0 && (
        <div className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          {step.attemptCount - 1 === 1
            ? 'The first attempt produced output that could not be used (e.g. unparseable model JSON), so this step re-ran automatically. The latest run is shown below.'
            : `${step.attemptCount - 1} earlier attempts produced output that could not be used (e.g. unparseable model JSON), so this step re-ran automatically. The latest run is shown below.`}
        </div>
      )}

      {step.degradedNote && (
        <div className="whitespace-pre-wrap rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          {step.degradedNote}
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

      {step.errorHint?.type === 'provider_unavailable' && step.status === 'failed' && (
        <div className="rounded-md border border-amber-700/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          <span className="font-medium">
            {step.errorHint.providerName
              ? `Provider ${step.errorHint.providerName} `
              : 'The CLI provider '}
            {step.errorHint.reason === 'rate_limit'
              ? 'is rate-limited or out of quota'
              : 'returned a server error (temporarily unavailable)'}
            .
          </span>{' '}
          This is a provider outage, not a problem with your code or this task. Retry once the
          provider recovers.
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
            {supportsPresets && taskRepositoryId && (
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
                        {p.repositoryId === null ? `[global] ${p.name}` : p.name}
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
              key={supportsPresets ? `${step.stepId}-${formKey}` : undefined}
              schema={schema}
              initialValues={supportsPresets ? (appliedValues ?? initialValues) : initialValues}
              submitting={submitting}
              errorMessage={submitError}
              onSubmit={supportsPresets ? handlePresetSubmit : onSubmit}
              repositoryId={taskRepositoryId}
              persistPrefix={uiPrefix}
              renderAfterField={
                hasConnectionFields || supportsPresets ? renderAfterFieldFn : undefined
              }
              headerSlot={
                !runtimeTornDown &&
                step.stepId === '08a-browser-verify' &&
                step.activeRole !== 'fixer'
                  ? liveBrowserPanel(step, taskId, { autoCollapse: taskEnded })
                  : undefined
              }
              beforeFieldsSlot={
                !runtimeTornDown && step.stepId === '99-run-app-ready' ? (
                  <RunAppReadyPanels step={step} taskId={taskId} autoCollapse={taskEnded} />
                ) : !runtimeTornDown && step.stepId === '09-gate-2-verify-approval' ? (
                  // Gate-2: the live browser (or, in direct mode, the URL info box) sits
                  // BELOW the verification status table but ABOVE the approve/reject
                  // decision — review the results, test, then decide.
                  liveBrowserPanel(step, taskId, {
                    autoCollapse: taskEnded,
                    title: 'Browser — test the app here',
                  })
                ) : step.stepId === '11-phase-8-learning' &&
                  step.status === 'waiting_form' &&
                  (step.detectOutput as { knowledgeDiffArtifactPath?: string | null } | null)
                    ?.knowledgeDiffArtifactPath ? (
                  // Learning: the knowledge diff sits BELOW the drafted-artifact disclosures
                  // but ABOVE the apply checkboxes / instruction / submit — review what will be
                  // written, then decide.
                  <CommitDiffViewer
                    taskId={taskId}
                    artifactPath={
                      (step.detectOutput as { knowledgeDiffArtifactPath: string })
                        .knowledgeDiffArtifactPath
                    }
                  />
                ) : undefined
              }
              onSkip={step.canSkip ? () => onAction('skip') : undefined}
              skipLabel={
                step.stepId === '01-worktree-setup' ? 'Skip — work from project root' : undefined
              }
              skipDisabled={actionBusy}
            />
          </div>
        )
      )}

      {/* Done/skipped steps: re-show the spec/summary disclosures (business
          requirements, technical spec, gate reviews, …) read-only so they stay
          reviewable after the interactive form is gone. */}
      {step.status !== 'waiting_form' && (
        <>
          <StatusSummary items={schema?.statusSummary} persistPrefix={uiPrefix} />
          <InfoSections sections={schema?.infoSections} persistPrefix={uiPrefix} />
        </>
      )}
      {(step.summary ?? '').trim().length > 0 && (
        <PersistedDetails
          persistKey={`${uiPrefix}:summary`}
          className="rounded-md border border-neutral-800 bg-neutral-950/60"
          summaryClassName="cursor-pointer select-none px-3 py-2 text-sm text-neutral-200 marker:text-neutral-500 hover:bg-neutral-900"
          summary={<span className="font-medium">What the agent did</span>}
        >
          <div className="border-t border-neutral-800">
            <MarkdownView body={step.summary ?? ''} enhanced />
          </div>
        </PersistedDetails>
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

      {!runtimeTornDown &&
        step.stepId === '08a-browser-verify' &&
        step.status !== 'failed' &&
        step.status !== 'waiting_form' &&
        step.activeRole !== 'fixer' &&
        liveBrowserPanel(step, taskId, { autoCollapse: step.status === 'done' || taskEnded })}

      {step.stepId === '08a-browser-verify' && step.activeRole === 'fixer' && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          The browser test found issues — fixing them in the code now. The live browser is paused;
          follow the fix in the terminal above.
        </div>
      )}

      {!runtimeTornDown &&
        step.stepId === '09-gate-2-verify-approval' &&
        step.status !== 'waiting_form' &&
        liveBrowserPanel(step, taskId, {
          autoCollapse: step.status === 'done' || taskEnded,
          title: 'Browser — test the app here',
        })}

      {step.stepId === '10-gate-3-commit' &&
        (step.detectOutput as { diffArtifactPath?: string | null } | null)?.diffArtifactPath && (
          <CommitDiffViewer
            taskId={taskId}
            artifactPath={(step.detectOutput as { diffArtifactPath: string }).diffArtifactPath}
          />
        )}
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
  const totalRunbook = queries.reduce((s, q) => s + q.runbookHits, 0);
  const totalLearning = queries.reduce((s, q) => s + q.learningHits, 0);
  const withHits = queries.filter((q) => q.hitCount > 0).length;
  // Effectiveness: how often RAG returned anything, and the source-type split of
  // the chunks it returned. learningPct is the remainder so the four always sum
  // to 100%.
  const ragUsedPct = queries.length ? Math.round((withHits / queries.length) * 100) : 0;
  const totalChunks = totalKb + totalCode + totalRunbook + totalLearning;
  const kbPct = totalChunks ? Math.round((totalKb / totalChunks) * 100) : 0;
  const codePct = totalChunks ? Math.round((totalCode / totalChunks) * 100) : 0;
  const runbookPct = totalChunks ? Math.round((totalRunbook / totalChunks) * 100) : 0;
  const learningPct = totalChunks ? Math.max(0, 100 - kbPct - codePct - runbookPct) : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-neutral-300">
        <span>{queries.length} queries</span>
        <span>{withHits} returned hits</span>
        <span>{totalHits} hits total</span>
        <span className="text-indigo-300">KB: {totalKb}</span>
        <span className="text-emerald-300">code: {totalCode}</span>
        <span className="text-amber-300">runbook: {totalRunbook}</span>
        <span className="text-sky-300">learning: {totalLearning}</span>
      </div>
      <div className="max-h-80 overflow-auto rounded border border-neutral-800">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-neutral-900 text-neutral-400">
            <tr>
              <th className="px-2 py-1 font-medium">Query</th>
              <th className="px-2 py-1 text-right font-medium">hits</th>
              <th className="px-2 py-1 text-right font-medium">kb</th>
              <th className="px-2 py-1 text-right font-medium">code</th>
              <th className="px-2 py-1 text-right font-medium">runbook</th>
              <th className="px-2 py-1 text-right font-medium">learning</th>
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
                <td className="px-2 py-1 text-right text-amber-300">{q.runbookHits}</td>
                <td className="px-2 py-1 text-right text-sky-300">{q.learningHits}</td>
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
        <span className="text-emerald-300">{codePct}% code</span> /{' '}
        <span className="text-amber-300">{runbookPct}% runbook</span> /{' '}
        <span className="text-sky-300">{learningPct}% learning</span>
      </p>
    </div>
  );
}

// "Save as template" controls injected after a preset-enabled env-replicate
// step's anchor field (step 1 deps, step 2 Dockerfile). Ticking the checkbox
// reveals a required name input; the existing submit then also saves the
// template. State lives in the parent StepCard so it never becomes part of the
// submitted FormValues.
function SaveAsTemplateControls({
  checked,
  onToggle,
  name,
  onNameChange,
  global,
  onGlobalToggle,
  error,
}: {
  checked: boolean;
  onToggle: (value: boolean) => void;
  name: string;
  onNameChange: (value: string) => void;
  global: boolean;
  onGlobalToggle: (value: boolean) => void;
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
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <Input
                value={name}
                placeholder="Template name"
                maxLength={255}
                onChange={(e) => onNameChange(e.target.value)}
              />
            </div>
            <label className="flex shrink-0 items-center gap-2 text-sm text-neutral-200">
              <input
                type="checkbox"
                checked={global}
                onChange={(e) => onGlobalToggle(e.target.checked)}
              />
              <span>Make global</span>
            </label>
          </div>
          <p className="text-xs text-neutral-500">
            Global templates are reusable across all your repositories.
          </p>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
