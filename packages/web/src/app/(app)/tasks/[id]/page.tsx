'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormSchema } from '@haive/shared';
// Import the pure timing helper from its dedicated subpath, NOT the package
// barrel — the barrel pulls server-only utils (ioredis -> dns) that break the
// browser bundle. timing.ts has no imports, so this subpath is browser-safe.
import { computeStepContribution, computeTaskTiming } from '@haive/shared/timing';
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
  type UpcomingCliStep,
  type UsageWindowSnapshot,
} from '@/lib/api-client';
import { Badge, Button, Card, Input } from '@/components/ui';
import { CliPickerGrid } from '@/components/cli-picker-grid';
import { ArrowLeft, CircleDot, Route, FolderGit2 } from 'lucide-react';
import { useCliLogin } from '@/lib/use-cli-login';
import { shouldClearSubmitting } from '@/lib/submit-state';
import { formatDuration, formatHoursMinutes } from '@/lib/format-duration';
import { isAfterFrontier, isBeforeFrontier, type StepOrderKey } from '@/lib/step-order';
import { failureBanner, modelIdentityBanner, parkBanner } from '@/lib/step-banners';
import { useGlobalPause } from '@/lib/use-global-pause';
import {
  defaultRetryTimeoutMinutes,
  parseRetryTimeoutMinutes,
  RETRY_TIMEOUT_MAX_MINUTES,
  RETRY_TIMEOUT_MIN_MINUTES,
} from '@/lib/retry-timeout';
import { formatTokens } from '@/lib/format-tokens';
import { CLI_USAGE_LABEL } from '@/lib/usage-format';
import {
  UsageFaultChip,
  UsagePendingChip,
  UsageReconnectAction,
} from '@/components/usage-reconnect-action';
import { resolveUsageChipState } from '@/lib/usage-chip-state';
import { stepCliProviderIds } from '@/lib/step-cli-providers';
import { selectMetersForProviderIds, type StripMeter } from '@/components/usage-strip-select';
import {
  UsageBars,
  usageRemainingColor,
  usageTooltip,
  usageWindowsOf,
} from '@/components/usage-meter';
import {
  FormRenderer,
  InfoSections,
  StatusSummary,
  type FormValues,
} from '@/components/form-renderer';
import { MarkdownView } from '@/components/markdown/markdown-view';
import { InlineMarkdown } from '@/components/markdown/inline-markdown';
import { PersistedDetails } from '@/components/persisted-details';
import { SlotWaitBadge } from '@/components/slot-wait-badge';
import {
  describeCostSource,
  formatCost,
  USD_DISPLAY,
  type CostDisplay,
  type CostSource,
} from '@/lib/format-cost';
import { formatVoteScore, TaskVote, voteToneClass } from '@/components/task-vote';
import { PostgresTestButton, OllamaTestButton } from '@/components/connection-tester';
import { EditorTab } from '@/components/editor/editor-tab';
import { AttachmentsPanel } from '@/components/attachments/attachments-panel';
import { CommitDiffViewer } from '@/components/commit-diff-viewer';
import { PrStatusPanel } from '@/components/PrStatusPanel';
import { StepTerminal } from '@/components/terminal/StepTerminal';
import { BrowserVncPanel } from '@/components/terminal/BrowserVncPanel';
import { ScreenshotGallery } from '@/components/browser/screenshot-gallery';
import { BrowserDirectPanel } from '@/components/terminal/BrowserDirectPanel';
import { DatabaseAccessPanel } from '@/components/terminal/DatabaseAccessPanel';
import { InteractiveShell } from '@/components/terminal/InteractiveShell';
import {
  autoScrollTerminalsEnabled,
  scrollToNewestRunningTerminal,
} from '@/lib/terminal-autoscroll';
import { usePageTitle } from '@/lib/use-page-title';
import { usePersistedToggle } from '@/lib/use-persisted-toggle';

/** Pick the live-browser surface for a step: the URL info box when the user chose
 *  `direct` (test in your own browser) mode, else the in-app VNC panel when the
 *  in-container headed browser is up, else nothing. */
/** The browser tester's screenshot evidence, when the step recorded a manifest.
 *  08a writes the pointer to its apply output (`step.output`); gate 2 re-derives it in
 *  detect (`step.detectOutput`), because 08a's output column is not durable. Renders
 *  nothing without a pointer — a task whose tester took no shots shows no gallery. */
function screenshotGallery(
  step: { id: string; detectOutput: unknown; output: unknown },
  taskId: string,
  source: 'output' | 'detect',
) {
  const bag = (source === 'output' ? step.output : step.detectOutput) as {
    screenshotsArtifactPath?: string | null;
  } | null;
  if (!bag?.screenshotsArtifactPath) return null;
  return (
    <ScreenshotGallery
      taskId={taskId}
      artifactPath={bag.screenshotsArtifactPath}
      persistId={step.id}
    />
  );
}

function liveBrowserPanel(
  step: { id: string; detectOutput: unknown },
  taskId: string,
  opts: { autoCollapse: boolean; title?: string; splitTerminal?: boolean },
) {
  const det = step.detectOutput as {
    liveBrowser?: { available?: boolean; appUrl?: string | null };
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
      appUrl={det.liveBrowser.appUrl}
      // Split view (browser beside the agent's prose) is offered only where an agent is
      // driving this browser — the browser-testing step. At gate 2 or in run_app the
      // browser is the user's to click, so there is no run to watch.
      terminalStepRowId={opts.splitTerminal ? step.id : undefined}
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
    liveBrowser?: { available?: boolean; appUrl?: string | null };
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
          appUrl={det?.liveBrowser?.appUrl}
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
    case 'waiting_pr':
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

/** Compact "in-place loop pass" badge text for a step that loops without a rejection
 *  round (spec-quality review/correct, learning). Multi-CLI alternating steps count one
 *  user-facing round per N passes (N = role count); single-pass loops show raw iterations.
 *  Callers guard on iterationCount > 0. */
function iterationBadgeLabel(step: Pick<TaskStep, 'iterationCount' | 'cliRoles'>): string {
  const loopPassesPerRound = step.cliRoles?.length ?? 1;
  return loopPassesPerRound > 1
    ? `round ×${Math.ceil(step.iterationCount / loopPassesPerRound)}`
    : `iter ×${step.iterationCount}`;
}

/* --- Failed-step recovery. The header Retry and the failed step's own card must offer the
   SAME primary action: the header used to hardcode `retry`, which resets a multi-pass step's
   iterations to 0 and nulls its output (api routes/tasks/steps.ts, the `retry` branch), so it
   threw away passes the card's Resume button would have kept. Derive both from here. --- */

const BIZ_REQ_DRAFT_STEP_ID = '03b-business-requirements';
const BIZ_REQ_REVIEW_STEP_ID = '03c-business-requirements-review';

const BIZ_REQ_RERUN_TITLE =
  'Reset and re-run the business-requirements step with your rejection feedback pre-filled, so the agent re-drafts addressing it. Retrying THIS step would only re-review the same draft.';
const RESUME_TITLE =
  'Continue this multi-pass step from where it failed. If a CLI ran out of credits, pick a different one above first. Completed passes are kept; a first-pass failure re-runs from the start with the new CLI.';
const RETRY_TITLE = 'Reset this step and re-run it (downstream steps will also reset)';

/** A failed step that can resume from the pass that failed instead of resetting to pass 0.
 *  iterationCount > 0 means there are completed passes to keep; a loop step (cliRoles) that
 *  failed on its FIRST pass keeps nothing but is still resumable — resume re-dispatches that
 *  pass with the newly-picked CLI, which is the whole point when one ran out of credits. */
function isResumableStep(
  step: Pick<TaskStep, 'status' | 'iterationCount' | 'cliRoles' | 'agentCounts'>,
): boolean {
  // Fan-out steps first, and deliberately NOT gated on status === 'failed': a step whose
  // concurrent terminals include a dead one DEGRADES to `done` (the agent failed, not the
  // code), which is exactly the state that needs "re-run just that terminal". Gating on
  // 'failed' is why the button never appeared on 08c.
  //
  // Gated on inFlight instead, the structural proof the fan-out has SETTLED. A dead terminal
  // beside live siblings is a run still in progress, not a finished one with something to
  // redo: resuming there kills every sibling's sandbox (the endpoint's liveInCascade reads
  // this step's own waiting_cli) and loses their verdicts, while the label counts the settled
  // subset as the whole fan-out — observed as "keep 8 of 9 terminals" on a 13-wide 08c with 4
  // still running. Once inFlight is 0, done + failed IS the fan-out, so the label is correct
  // as written. Stop / Stop & retry stay available meanwhile.
  if ((step.agentCounts?.failed ?? 0) > 0) return (step.agentCounts?.inFlight ?? 0) === 0;
  return step.status === 'failed' && (step.iterationCount > 0 || (step.cliRoles?.length ?? 0) > 0);
}

function resumeButtonLabel(step: Pick<TaskStep, 'iterationCount' | 'agentCounts'>): string {
  const failed = step.agentCounts?.failed ?? 0;
  if (failed > 0) {
    const kept = step.agentCounts?.done ?? 0;
    return kept > 0
      ? `Resume (keep ${kept} of ${kept + failed} terminals)`
      : `Re-run ${failed} failed terminal${failed === 1 ? '' : 's'}`;
  }
  return step.iterationCount > 0
    ? `Resume (keep ${step.iterationCount} pass${step.iterationCount === 1 ? '' : 'es'})`
    : 'Resume (new CLI)';
}

/** The recovery the failed step's own card offers as its PRIMARY (non-secondary) button, so
 *  the header Retry never does something more destructive than the button sitting next to the
 *  step. Same precedence as the card's button order: the business-requirements review re-runs
 *  the DRAFT step (re-reviewing the same rejected draft only fails again), then resume, then a
 *  plain retry. */
function primaryRecovery(
  failedStep: TaskStep,
  steps: TaskStep[],
  frontier: StepOrderKey | null,
): { step: TaskStep; action: StepAction; label: string; title: string } {
  if (failedStep.stepId === BIZ_REQ_REVIEW_STEP_ID) {
    const draft = steps.find((s) => s.stepId === BIZ_REQ_DRAFT_STEP_ID);
    if (draft)
      return {
        step: draft,
        action: 'retry',
        label: 'Re-run business requirements',
        title: BIZ_REQ_RERUN_TITLE,
      };
  }
  // Same rule as the card: never resume a step the run has moved past. This path can target a
  // non-frontier row — the caller picks the FIRST failed step while the frontier is the LAST —
  // so it needs its own guard rather than inheriting the card's.
  const isPast = frontier != null && isBeforeFrontier(failedStep, frontier);
  if (!isPast && isResumableStep(failedStep))
    return {
      step: failedStep,
      action: 'resume',
      label: resumeButtonLabel(failedStep),
      title: RESUME_TITLE,
    };
  return { step: failedStep, action: 'retry', label: 'Retry', title: RETRY_TITLE };
}

type Tab = 'steps' | 'clis' | 'editor' | 'terminal' | 'activity' | 'attachments';

// Mirrors @haive/api TaskProviderUsage (kept local per the barrel-avoidance rule).
interface TaskProviderUsage {
  provider: string;
  /** 'metered' | 'subscription' | 'local' | 'estimate' — costUsd is real only for metered. */
  costBasis: string;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  /** What these invocations WOULD have cost at list API rates, for the ones not billed
   *  per token (a subscription or flat plan). Informational — never real money, never
   *  added to costUsd. */
  notionalCostUsd: number;
  /** Where the dollars came from, so the number can be labelled rather than guessed at. */
  costSource: CostSource;
  /** Invocations with tokens but no usable rate — excluded from costUsd, shown so a low
   *  total is explained rather than silently understated. */
  unpricedInvocations: number;
}

interface LinkedTask {
  id: string;
  title: string;
  status: TaskStatus;
  createdAt?: string;
}

interface TaskDetailResponse {
  task: Task;
  steps: TaskStep[];
  /** CLI steps with no row yet — the CLIs tab's content. Absent on an older server. */
  upcomingCliSteps?: UpcomingCliStep[];
  providerBreakdown: TaskProviderUsage[];
  /** Currency + dated FX rate the server resolved for THIS task, so costs render the
   *  same on every later view. Absent on an older server: fall back to USD. */
  costDisplay?: CostDisplay | null;
  /** The completed task this one belongs to (bug fixes only; null otherwise). */
  parentTask?: LinkedTask | null;
  /** Tasks that link to this one as their parent (its linked bug fixes). */
  childTasks?: LinkedTask[];
}

/**
 * Optimistic mirror of PATCH /tasks/:id/steps/:stepId/cli-provider applied to one step
 * row. The CLI/effort dropdowns are controlled on server state, so without this the
 * select visibly reverts to the previous CLI for the whole PATCH+reload round-trip and
 * then flips — which reads as the dropdown changing itself.
 *
 * Mirrors the server rule that a CLI-only change (effortLevel omitted) CLEARS the stored
 * effort, so the effort select falls back to the new CLI's default rather than briefly
 * showing a level the new CLI may not even expose.
 *
 * `role` is a cliRole id or a miningSeat id — both live in the same (user, step, role)
 * table server-side, so the cliRoles list decides which map it belongs to here.
 */
/** The preference fields applyCliPreference rewrites. Both a real step row and an
 *  upcoming (row-less) CLI step carry them, and both lists paint the same optimistic
 *  update, so the helper is generic over the shape rather than tied to TaskStep. */
type CliPreferenceFields = Pick<
  TaskStep,
  | 'preferredCliProviderId'
  | 'preferredEffortLevel'
  | 'cliRoles'
  | 'cliRoleProviders'
  | 'cliRoleEfforts'
  | 'miningSeatProviders'
  | 'miningSeatEfforts'
>;

function applyCliPreference<T extends CliPreferenceFields>(
  step: T,
  cliProviderId: string | null,
  role: string | undefined,
  effortLevel: string | undefined,
): T {
  const effort = effortLevel ?? null;
  if (!role) {
    return { ...step, preferredCliProviderId: cliProviderId, preferredEffortLevel: effort };
  }
  if (step.cliRoles?.some((r) => r.id === role)) {
    return {
      ...step,
      cliRoleProviders: { ...step.cliRoleProviders, [role]: cliProviderId },
      cliRoleEfforts: { ...step.cliRoleEfforts, [role]: effort },
    };
  }
  return {
    ...step,
    miningSeatProviders: { ...step.miningSeatProviders, [role]: cliProviderId },
    miningSeatEfforts: { ...step.miningSeatEfforts, [role]: effort },
  };
}

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [task, setTask] = useState<Task | null>(null);
  const [costDisplay, setCostDisplay] = useState<CostDisplay>(USD_DISPLAY);
  const [providerBreakdown, setProviderBreakdown] = useState<TaskProviderUsage[]>([]);
  const [parentTask, setParentTask] = useState<LinkedTask | null>(null);
  const [childTasks, setChildTasks] = useState<LinkedTask[]>([]);
  const [promotedDraftCount, setPromotedDraftCount] = useState(0);
  usePageTitle(task ? task.title : 'Task');
  const [steps, setSteps] = useState<TaskStep[]>([]);
  const [upcomingCliSteps, setUpcomingCliSteps] = useState<UpcomingCliStep[]>([]);
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
  // One-shot guard: the very first auto-scroll after the page loads is allowed
  // even when the active step is off-screen (brings it into view). Every scroll
  // after that is gated on the active step being in view, so the page never
  // yanks a user who scrolled away to re-read an earlier step. Reset on task id
  // change (the route component can persist across :id changes).
  const didInitialScrollRef = useRef(false);
  // The active step's run_seq on the previous render. A loop re-entry (gate revise or
  // fix loop_back) makes the active step jump BACKWARD to a lower run_seq; forward flow
  // only ever increases it. Used to force the follow-scroll on a backward jump. Keyed on
  // run_seq (the true run order) NOT step_index — a static per-workflow-type offset that
  // is not run-monotonic when step families interleave (env-replicate prelude in a
  // workflow), so a forward advance across families would look like a backward jump.
  const prevActiveRunSeqRef = useRef<number | null>(null);
  // The previously-active step's id, captured null-tick resistant (updated only
  // when an active step exists, so a transient "no active step" tick between
  // steps — e.g. a 0s auto-advancing 06a-db-migrate — doesn't wipe it). Used to
  // tell whether the user is still looking at the just-finished step when the
  // active step advances forward to one that's below the fold.
  const prevActiveIdRef = useRef<string | null>(null);
  // One-shot guard so the scroll-to-bottom-on-completion fires once per
  // completion (reset if the task leaves 'completed', e.g. a retry).
  const completedScrolledRef = useRef(false);
  const titleRowRef = useRef<HTMLDivElement>(null);
  const [titleStripVisible, setTitleStripVisible] = useState(false);

  // Show the fixed title strip while the real header is scrolled out of view.
  // Re-derived from the row's live geometry on every scroll, NOT kept in sync by
  // an IntersectionObserver: the observer subscribed to whichever node was mounted
  // when the task first loaded, so anything that swapped that node or dropped a
  // delivery left the strip frozen on the last value it happened to see — and
  // since only the observer could change it back, scrolling did nothing and the
  // header stayed gone until a reload. A geometric read carries no subscription,
  // so a wrong value cannot survive the next scroll. Keyed on task presence, not
  // the task object — the 2s poll replaces the object every tick and would
  // re-attach the listeners each time.
  const hasTask = task !== null;
  useEffect(() => {
    let frame = 0;
    const sync = () => {
      frame = 0;
      const el = titleRowRef.current;
      // No row in the DOM (loading / error branch): nothing has scrolled away.
      setTitleStripVisible(el ? el.getBoundingClientRect().bottom <= 0 : false);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    sync();
    // Capture phase: a scroll inside a nested container never bubbles to window.
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
    };
  }, [hasTask]);

  const reload = useCallback(async () => {
    try {
      const data = await api.get<TaskDetailResponse>(`/tasks/${id}`);
      setTask(data.task);
      setSteps(data.steps);
      setUpcomingCliSteps(data.upcomingCliSteps ?? []);
      setProviderBreakdown(data.providerBreakdown ?? []);
      setCostDisplay(data.costDisplay ?? USD_DISPLAY);
      setParentTask(data.parentTask ?? null);
      setChildTasks(data.childTasks ?? []);
      // Clear on success: this runs every 2s, so a single blipped poll (api
      // restarting, a token refresh in flight) must not outlive the tick that
      // recovers from it. Without this the first failure stuck forever.
      setError(null);
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

  // Labels for each round > 0 group, derived in one pass so the divider and the fixed-
  // header badge stay consistent. A round group is named by the step it RE-ENTERS at: the
  // spec gates fork a new round at 04 / 03b ("Spec revision"), the auto-fix loop re-enters
  // at 07 ("Fix loop"). Numbered per-kind, not by the raw round int (the two kinds
  // interleave rounds). byStepId → divider text at the group's first row ("Spec revision
  // #1"); byRound → compact suffix for ANY row in that round ("spec rev 1") so the header
  // badge can label a mid-group step too.
  const roundLabels = useMemo(() => {
    const byStepId = new Map<string, string>();
    const byRound = new Map<number, string>();
    let specN = 0;
    let fixN = 0;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (step.round > 0 && (i === 0 || steps[i - 1]!.round !== step.round)) {
        const isSpecRevision =
          step.stepId === '04-phase-0b-pre-planning' || step.stepId === '03b-business-requirements';
        if (isSpecRevision) {
          const n = ++specN;
          byStepId.set(step.id, `Spec revision #${n}`);
          byRound.set(step.round, `spec rev ${n}`);
        } else {
          const n = ++fixN;
          byStepId.set(step.id, `Fix loop #${n}`);
          byRound.set(step.round, `fix loop ${n}`);
        }
      }
    }
    return { byStepId, byRound };
  }, [steps]);

  // The "frontier" step — the one the run is parked on / working (running / waiting_form /
  // waiting_cli), the one queued for a runtime slot, or a failed task's failure. Every step BELOW
  // it is pending and gets reset + re-run whenever an at-or-before step is retried, so those must
  // not offer their own Retry/Stop/Skip actions (the orchestrator's concurrency guard would just
  // skip acting on them, which reads as "nothing happened"). Steps ABOVE it keep their Retry —
  // that is how you re-run finished work.
  //
  // Ordered by (round, run_seq), never run_seq alone — see isAfterFrontier. Uses run_seq rather
  // than step_index (a static per-workflow-type offset, not run-monotonic when step families
  // interleave, e.g. an env-replicate prelude spliced into a workflow).
  //
  // LAST match per category, not first: a task can carry a failure in round 0 and another in
  // round 3, and picking the earlier one would push the real, furthest-along failure below the
  // frontier and strip the very Retry needed to recover it.
  const frontierKey = useMemo<StepOrderKey | null>(() => {
    const lastMatching = (pred: (s: TaskStep) => boolean): TaskStep | undefined => {
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (s && pred(s)) return s;
      }
      return undefined;
    };
    const active =
      lastMatching(
        (s) => s.status === 'running' || s.status === 'waiting_form' || s.status === 'waiting_cli',
      ) ??
      // A step queued for a runtime slot is the frontier too: the park re-queues its row to
      // `pending` (+ a wait marker), so it matches none of the live statuses above even though the
      // task IS on it. Without this a parked task had no frontier at all, and the steps after it
      // kept offering their own Retry/Stop/Skip — the same buttons a running task already
      // suppresses on the steps it has not reached yet.
      lastMatching((s) => s.status === 'pending' && !!s.waitingStartedAt) ??
      lastMatching((s) => s.status === 'failed');
    return active ? { round: active.round, runSeq: active.runSeq } : null;
  }, [steps]);

  // Auto-scroll to the active step when it changes. For a step that shows a
  // terminal (running / waiting_cli with at least one CLI run) scroll to the
  // END of the last terminal so its output is fully in view, rather than the
  // step header which would hide it. Other steps scroll to the header so the
  // form / status stays visible.
  useEffect(() => {
    const container = stepsContainerRef.current;
    const activeStep =
      steps.find(
        (s) => s.status === 'waiting_form' || s.status === 'running' || s.status === 'waiting_cli',
      ) ??
      // Queued for a runtime slot: the park re-queues the row to `pending`, so without this the
      // page scrolled nowhere and left the user looking at leftover rows further down.
      steps.find((s) => s.status === 'pending' && s.waitingStartedAt);
    const activeId = activeStep?.id ?? null;
    // Loop re-entry: a gate revise / fix loop_back re-enters an EARLIER step, so the active
    // step's run_seq drops below the previously-active one (forward flow only increases it).
    // Capture the prior value first, then update the ref to the latest non-null run_seq so a
    // transient "no active step" tick between steps doesn't reset the baseline.
    const activeRunSeq = activeStep?.runSeq ?? null;
    const prevActiveRunSeq = prevActiveRunSeqRef.current;
    const prevActiveId = prevActiveIdRef.current;
    const loopReentry =
      activeRunSeq !== null && prevActiveRunSeq !== null && activeRunSeq < prevActiveRunSeq;
    if (activeRunSeq !== null) prevActiveRunSeqRef.current = activeRunSeq;
    if (activeId !== null) prevActiveIdRef.current = activeId;
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
      // Target pick and framing live in lib/terminal-autoscroll so this and the
      // per-step follow effect (StepTerminal) can never frame a terminal differently.
      const scrollToLastTerminal = (): boolean => {
        const stepEl = container.querySelector(`[data-step-id="${activeId}"]`);
        if (!stepEl) return false;
        return scrollToNewestRunningTerminal(stepEl);
      };

      // Follow the active step into view only when the user is already looking
      // at it. If they've scrolled away (e.g. up to re-read an earlier step's
      // review output), don't yank the page to the newly-active step or its
      // terminal. The first scroll after load is exempt so the initially
      // off-screen active step is still brought into view. The transition key
      // is consumed either way, so a skipped scroll won't re-fire when the user
      // scrolls back on their own.
      const activeStepEl = container.querySelector(`[data-step-id="${activeId}"]`);
      const rect = activeStepEl?.getBoundingClientRect();
      const activeStepInView = !rect || (rect.top < window.innerHeight && rect.bottom > 0);
      // A forward advance lands the new active step below the fold whenever the
      // just-finished step's card filled the viewport (e.g. confirming the tall
      // 06-run-config form, which then auto-advances 0s through 06a-db-migrate into
      // 06b): the new step is off-screen, so the in-view guard below would wrongly
      // skip the follow. Treat "the previously-active step is still in view" as "the
      // user is still watching the flow" and follow forward anyway. This stays
      // distinct from a user who scrolled far away during a long run — there the prev
      // step is off-screen too, so the guard still holds and we don't yank them.
      const prevActiveEl = prevActiveId
        ? container.querySelector(`[data-step-id="${prevActiveId}"]`)
        : null;
      const prevRect = prevActiveEl?.getBoundingClientRect();
      const prevActiveInView =
        !!prevRect && prevRect.top < window.innerHeight && prevRect.bottom > 0;
      // A loop re-entry (backward jump) overrides the don't-yank-if-off-screen guard: the
      // user just rejected / triggered a re-run and should be followed to the re-entered step.
      if (didInitialScrollRef.current && !activeStepInView && !prevActiveInView && !loopReentry) {
        prevScrollKeyRef.current = scrollKey;
        return;
      }
      didInitialScrollRef.current = true;

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

  // The route component can survive an :id change without remounting; reset the
  // initial-scroll guard so a freshly opened task still scrolls to its active
  // step once.
  useEffect(() => {
    didInitialScrollRef.current = false;
  }, [id]);

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
  // The Terminal shell is gated exactly like the Editor: enabled on 'failed' (the
  // worktree + sandbox survive for recovery), disabled on completed/cancelled (the
  // worktree is reaped) and until 01-worktree-setup has prepared the worktree —
  // otherwise the shell's persistent tmux session would be rooted at the repo
  // checkout (wrong branch). Mirrors terminal-session-manager's openSession gate.
  const terminalDisabled =
    task?.status === 'completed' || task?.status === 'cancelled' || !worktreeReady;
  const terminalDisabledReason: 'ended' | 'preparing' =
    task?.status === 'completed' || task?.status === 'cancelled' ? 'ended' : 'preparing';
  useEffect(() => {
    if (terminalDisabled && tab === 'terminal') setTab('steps');
  }, [terminalDisabled, tab]);

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
    opts?: { overrideLocalModel?: boolean; timeoutMinutes?: number },
  ) {
    // Downstream by TRUE run order (run_seq): retrying re-runs the WHOLE tail after
    // this step — pending steps run too, non-pending ones are also reset first — so
    // count EVERY later step, which is what the user sees in the list. (Counting only
    // non-pending undercounts to ~1 whenever the tail hasn't run yet.) Fall back to
    // step_index for legacy rows with no run_seq. Same ROUND only, matching what the
    // retry endpoint actually resets — counting every round's cards overstated the
    // cascade on any task that has been through a fix loop.
    const downstreamCount = steps.filter(
      (s) =>
        s.round === step.round &&
        (step.runSeq != null && s.runSeq != null
          ? s.runSeq > step.runSeq
          : s.stepIndex > step.stepIndex),
    ).length;
    const label = opts?.overrideLocalModel
      ? 'Run this step on the current local model anyway?\n\nLocal models are unreliable at rewriting long-lived project files (skills, agents, config) and may produce low-quality or damaging output. Proceed only if you understand the risk.'
      : opts?.timeoutMinutes
        ? `Retry this step with a ${opts.timeoutMinutes}-minute CLI timeout?${downstreamCount ? ` ${downstreamCount} downstream step(s) will also be reset and re-run.` : ''}`
        : action === 'retry_ai'
          ? 'Spawn an AI agent to diagnose and fix this failure, then re-run the step?'
          : action === 'abort'
            ? 'Abort this step and cancel the task? The environment will be torn down.'
            : action === 'skip'
              ? step.stepId === '01-worktree-setup'
                ? 'Work from the project root (the repo’s current branch) instead of an isolated branch/worktree? You can still commit your edits at the end.'
                : 'Skip this step and continue to the next step?'
              : action === 'resume'
                ? (step.agentCounts?.failed ?? 0) > 0
                  ? // Fan-out resume. It must state the cascade: a step that DEGRADED ended
                    // `done`, so the endpoint resets what already consumed its result. A step
                    // still sitting `failed` has nothing downstream that ran, and resets none.
                    `Re-run ${step.agentCounts.failed} failed terminal(s) and keep the ${step.agentCounts.done} that finished?${
                      step.status === 'done' && downstreamCount
                        ? ` ${downstreamCount} downstream step(s) will also be reset and re-run.`
                        : ''
                    }`
                  : step.iterationCount > 0
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
        timeoutMinutes: opts?.timeoutMinutes,
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
    // Paint the pick before the round-trip; the 2s poll reconciles either way, same as
    // the auto-continue flip above. Preferences are keyed by (user, step, role) with no
    // round, so every round's row of this step moves together — matching what the
    // reload would return.
    //
    // Paint the id off the loaded provider row rather than the raw dropdown value. This
    // write is the only place a DOM value reaches component state without passing through
    // the server first, and the id ends up in the usage chip's reconnect href — an id
    // that is not in `providers` is not one this page can render anything for anyway.
    // The PATCH still sends what was picked; the server is the authority on it.
    const picked = providers.find((p) => p.id === cliProviderId)?.id ?? null;
    setSteps((rows) =>
      rows.map((s) => (s.stepId === stepId ? applyCliPreference(s, picked, role, effortLevel) : s)),
    );
    // Same paint for a step chosen from the CLIs tab: it has no row, so it is absent from
    // `steps` and the map above is a no-op for it — without this its dropdown snaps back
    // to the old value until the next poll.
    setUpcomingCliSteps((rows) =>
      rows.map((s) => (s.stepId === stepId ? applyCliPreference(s, picked, role, effortLevel) : s)),
    );
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
      // Resync rather than restoring a captured snapshot: a poll may have landed while
      // the PATCH was in flight, and rolling back to pre-click state would undo it.
      await reload();
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

  // Takeover only when there is nothing to show. A refresh that fails while the
  // task is on screen is not a load failure: swapping the page for a red box
  // would tear down the step cards and their live terminals over a hiccup that
  // the next 2s tick usually undoes. That case renders a banner below instead.
  if (error && !task) {
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

  // Fixed-header badge text. Served by the API (derived from the task's own current-step
  // pointer, with the rejection-round / in-place-pass suffix already applied) and rendered
  // verbatim, because the LISTING shows the same string — computing it a second time here
  // is how the two surfaces came to name the same step differently. Falls back to the local
  // rows when an older api omits it.
  const currentStepBadgeText = task.currentStepLabel ?? (currentStep ? currentStep.title : '');

  // The subscription-usage chip follows the CLIs of the step the run is parked on (or the
  // task default): a Codex step shows Codex's windows, a Claude step shows Claude's.
  //
  // PLURAL, because a fan-out step resolves a provider per SEAT — 08c-code-review can be
  // spending three subscriptions at once. Reading only `preferredCliProviderId` (the
  // 'default' row) named a CLI that none of its agents were running on, and its reconnect
  // prompt covered only that one, so a dead token on a seat CLI failed the step in silence.
  const usageProviderIds = stepCliProviderIds({
    step: currentStep ?? null,
    taskCliProviderId: task.cliProviderId ?? null,
    enabledProviderIds: new Set(providers.filter((p) => p.enabled).map((p) => p.id)),
  });

  return (
    <div className="flex flex-col gap-6">
      {titleStripVisible && (
        <div className="fixed left-64 right-0 top-0 z-30 flex items-center gap-3 border-b border-neutral-800 bg-neutral-950/90 px-8 py-2 backdrop-blur">
          {/* Same destination as the header link the strip replaces, so scrolling never
              costs the user the way out. */}
          <Link
            href={backHref}
            aria-label={backLabel}
            title={backLabel}
            className="shrink-0 text-indigo-400 hover:text-indigo-300"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          {/* The SCORE only — no arrows. The strip is a scrolled-past summary, so it states the
              priority in the same place the listing and the page header do; the control itself
              stays in the header, one screen away, where a misclick is not a stray vote.
              Hidden at the default 0, like every other conditional in this strip: an unvoted
              task has nothing to say here, and a column of "0" is noise on most pages. */}
          {(task.voteScore ?? 0) !== 0 && (
            <span
              className={`shrink-0 font-mono text-xs tabular-nums ${voteToneClass(task.voteScore ?? 0)}`}
              title={`Priority ${formatVoteScore(task.voteScore ?? 0)} — vote in the task header above.`}
            >
              {formatVoteScore(task.voteScore ?? 0)}
            </span>
          )}
          <p className="min-w-0 truncate text-sm font-semibold text-indigo-300">{task.title}</p>
          {/* The strip carries no status badge, so a held task would otherwise look like it
              is working once the page is scrolled past the header. */}
          {task.pausedAt && (
            <Badge variant="warning" className="shrink-0">
              paused
            </Badge>
          )}
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
            <Badge variant="warning" className="min-w-0 shrink gap-1" title={currentStepBadgeText}>
              <CircleDot className="h-3 w-3 shrink-0" />
              <span className="truncate">{currentStepBadgeText}</span>
            </Badge>
          )}
          {/* Usage chip centers in the gap between the left badges and the right
              pace chip: its ml-auto + the pace chip's own ml-auto split the free
              space evenly on each side. Collapses to the strip's gap-3 at low res. */}
          <HeaderUsageChip providerIds={usageProviderIds} providers={providers} />
          <HeaderPaceChip task={task} steps={steps} userActive={userActive} />
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
                <TaskVote taskId={task.id} score={task.voteScore ?? 0} />
                <h1 className="text-2xl font-bold text-neutral-50">{task.title}</h1>
                {/* Paused, or queued behind a capacity cap: the task row still says `running`
                    in both cases, so show the real state instead (same precedence as the
                    tasks listing — paused wins, and the server suppresses slotWait while it
                    is set, so the two can never both be true). */}
                {task.pausedAt ? (
                  <Badge variant="warning">paused</Badge>
                ) : task.slotWait ? (
                  <SlotWaitBadge slotWait={task.slotWait} />
                ) : (
                  <Badge variant={taskStatusVariant(task.status)}>{task.status}</Badge>
                )}
                <Badge>{task.type}</Badge>
                {task.executionPath && (
                  <Badge variant={executionPathVariant(task.executionPath)}>
                    {EXECUTION_PATH_LABELS[task.executionPath]}
                  </Badge>
                )}
                {task.repository && <Badge variant="info">repo: {task.repository.name}</Badge>}
                {/* Which model ANSWERED, not which one is configured — captured by the
                    00-model-health canary from the CLI's own stream. Shown only when a CLI
                    actually reported one; codex and amp report none, and an empty badge
                    would read as "no model" rather than "this CLI does not say". */}
                {task.modelIdentity?.served && (
                  <Badge
                    variant={task.modelIdentity.match === 'differs' ? 'warning' : 'info'}
                    title={
                      task.modelIdentity.match === 'differs'
                        ? `Configured ${task.modelIdentity.requested ?? 'unknown'}, but ${task.modelIdentity.served} answered.`
                        : `Requested ${task.modelIdentity.requested ?? 'unknown'} · reported by ${task.modelIdentity.source ?? 'unknown'}`
                    }
                  >
                    model: {task.modelIdentity.served}
                  </Badge>
                )}
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
          {/* Amber, not red: a mismatch is a fact worth seeing, not a failure. Some are
              benign (an alias resolving to a dated snapshot); the one that matters is an
              endpoint quietly serving a different model than the one configured. The
              visibility rule lives in modelIdentityBanner (lib/step-banners), gated on the
              structural `match` field rather than re-compared here. */}
          {modelIdentityBanner(task.modelIdentity) && (
            <p className="mt-1 text-sm text-amber-400">
              {modelIdentityBanner(task.modelIdentity)!.text}
            </p>
          )}
          {parentTask && (
            <p className="mt-1 text-sm text-neutral-400">
              Parent task:{' '}
              <Link href={`/tasks/${parentTask.id}`} className="text-indigo-400 underline">
                {parentTask.title}
              </Link>
            </p>
          )}
          {childTasks.length > 0 && (
            <div className="mt-1 text-sm text-neutral-400">
              Linked bug fixes ({childTasks.length}):
              <ul className="mt-0.5 flex flex-col gap-1">
                {childTasks.map((ct) => (
                  <li key={ct.id} className="flex items-center gap-2">
                    <Link href={`/tasks/${ct.id}`} className="text-indigo-400 underline">
                      {ct.title}
                    </Link>
                    <Badge variant={taskStatusVariant(ct.status)}>{ct.status}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Sits with the recovery buttons, not in the title strip: on a task that failed on
              a dead CLI token this is the action, and the strip's copy only appears once the
              user has scrolled the header away. */}
          <HeaderUsageChip providerIds={usageProviderIds} providers={providers} reconnectOnly />
          {canRetry &&
            (() => {
              // Mirror the failed step's own primary button (primaryRecovery) instead of
              // hardcoding `retry`: on a multi-pass step that is Resume, so the header no
              // longer discards passes the CLIs already delivered.
              const recovery = failedStep ? primaryRecovery(failedStep, steps, frontierKey) : null;
              return (
                <Button
                  size="sm"
                  title={recovery?.title}
                  onClick={() => {
                    if (recovery) void runStepAction(recovery.step, recovery.action);
                    else void runAction('retry');
                  }}
                >
                  {recovery?.label ?? 'Retry'}
                </Button>
              );
            })()}
          {/* Pause/Resume: hold this task so the CLI concurrency goes to the others. No
              confirm() — nothing is killed and nothing is lost, so it is cheap to undo. */}
          {canCancel &&
            (task.pausedAt ? (
              <Button
                size="sm"
                onClick={() => void runAction('resume')}
                title="Continue this task from where it stopped. It picks up within ~30 seconds."
              >
                Resume
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void runAction('pause')}
                title="Let the CLI run in flight finish, then hold the task so its subscription budget goes to your other tasks. Nothing is killed and the task stays open. The environment stays up, but another task may reclaim its runtime slot while this one is held."
              >
                Pause
              </Button>
            ))}
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

      {/* The 2s refresh is failing but the task below is still on screen: say so
          rather than hide it, since every timer keeps ticking on data that has
          stopped arriving. Clears itself on the first tick that succeeds. */}
      {error && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          Live updates stopped: {error}
        </div>
      )}

      {actionError && (
        <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {actionError}
        </div>
      )}

      {/* Task-scoped hold. The GLOBAL pause has its own app-wide banner, so it is not
          repeated here — this one only ever means "you paused this task". */}
      {task.pausedAt && (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <span className="font-semibold">Paused</span> since{' '}
          {new Date(task.pausedAt).toLocaleString()}. Any CLI run that was already in flight
          finishes, and nothing new starts — the concurrency goes to your other tasks. The
          environment stays up, though another task may reclaim its runtime slot while this one is
          held. Press Resume to continue where it stopped.
        </div>
      )}

      {task.prUrl && (
        <PrStatusPanel
          taskId={task.id}
          provider={task.prProvider}
          url={task.prUrl}
          number={task.prNumber}
          state={task.prState}
          mergedAt={task.prMergedAt}
          finalizeMode={task.prFinalizeMode}
          pollError={task.prPollError}
          reopenable={task.status === 'waiting_pr'}
        />
      )}

      <div className="flex flex-wrap gap-2 border-b border-neutral-800">
        <TabButton active={tab === 'steps'} onClick={() => setTab('steps')}>
          Steps
        </TabButton>
        <TabButton active={tab === 'clis'} onClick={() => setTab('clis')}>
          CLIs
        </TabButton>
        <TabButton
          active={tab === 'editor'}
          onClick={() => setTab('editor')}
          disabled={editorDisabled}
        >
          Editor
        </TabButton>
        <TabButton
          active={tab === 'terminal'}
          onClick={() => setTab('terminal')}
          disabled={terminalDisabled}
        >
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
          {steps.map((step) => {
            // Re-entry rounds: the same stepId recurs once per round (round 0 = the
            // original pass). Mark the start of each round > 0 group with a kind-aware
            // header (spec revision vs fix loop) computed in roundLabels.byStepId.
            const loopHeader = roundLabels.byStepId.get(step.id) ?? null;
            // Steps below the frontier get reset + re-run on any at-or-before retry, so
            // they hide their own action buttons (see frontierKey).
            const isDownstreamOfActive = frontierKey != null && isAfterFrontier(step, frontierKey);
            // The mirror: a step the run has already moved PAST. It keeps Retry (which resets
            // it and everything after it, so the task ends up on one coherent frontier) but
            // must not offer Resume — resume flips this row back to `running` without standing
            // down the row the task is actually on, leaving two live steps for the
            // other-step-active guard to refuse. Reachable in the wild because a fan-out step
            // DEGRADES to `done` when a terminal dies, so the task advances past a step that
            // still has something worth re-running.
            const isPastStep = frontierKey != null && isBeforeFrontier(step, frontierKey);
            return (
              <div key={step.id} data-step-id={step.id}>
                {loopHeader && (
                  <div className="mb-2 mt-5 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-amber-400/80">
                    <span className="h-px flex-1 bg-amber-400/20" />
                    {loopHeader}
                    <span className="h-px flex-1 bg-amber-400/20" />
                  </div>
                )}
                {/* currentStep: the step the run is parked on — auto-continue is
                  only offered there; passed steps can't be auto-continued. */}
                <StepCard
                  step={step}
                  isDownstreamOfActive={isDownstreamOfActive}
                  isPastStep={isPastStep}
                  taskId={task.id}
                  taskStatus={task.status}
                  taskCompletedAt={task.completedAt}
                  taskRepositoryId={task.repositoryId}
                  userActiveDisplayMs={
                    (userActive.activeStepId === step.id
                      ? userActive.displayMs
                      : step.userActiveMs) + step.carriedUserActiveMs
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
          <TaskTotalTime
            task={task}
            steps={steps}
            userActive={userActive}
            providerBreakdown={providerBreakdown}
            costDisplay={costDisplay}
          />
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

      {tab === 'clis' && (
        <UpcomingCliPanel
          steps={upcomingCliSteps}
          providers={providers}
          taskCliProviderId={task.cliProviderId ?? null}
          busyStepId={stepProviderBusy}
          error={stepProviderError}
          disabled={task.status === 'cancelled' || task.status === 'completed'}
          onChangeCli={(stepId, cliProviderId, role, effortLevel) =>
            changeStepProvider(stepId, cliProviderId, role, 0, effortLevel)
          }
        />
      )}

      {tab === 'editor' && !editorDisabled && <EditorTab taskId={id} />}

      {tab === 'attachments' && <AttachmentsPanel taskId={id} />}

      {tab === 'terminal' && (
        <TerminalTab
          taskId={id}
          disabled={terminalDisabled}
          disabledReason={terminalDisabledReason}
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

/** The CLIs tab: one picker per CLI step the run has not reached yet.
 *
 *  A step's CLI is normally chosen on its own card, but a card only exists once the step
 *  has a `task_steps` row — created when it runs or parks. A step that never pauses first
 *  (its form auto-submits, as 08a-browser-verify's does in automated mode, or it has no
 *  form and the task is on auto-continue) therefore went straight from "not started" to
 *  "running on the task default", with stopping the step as the only lever. This is that
 *  missing window: the preference is keyed (user, step, role) and the worker resolves it
 *  at dispatch, so a pick here lands on this task.
 *
 *  Over-lists rather than under-lists: a workflow task's execution path can drop some of
 *  these steps, and a preference for a step that never runs is inert. */
function UpcomingCliPanel({
  steps,
  providers,
  taskCliProviderId,
  busyStepId,
  error,
  disabled,
  onChangeCli,
}: {
  steps: UpcomingCliStep[];
  providers: CliProvider[];
  taskCliProviderId: string | null;
  busyStepId: string | null;
  error: { stepId: string; message: string } | null;
  disabled: boolean;
  onChangeCli: (
    stepId: string,
    cliProviderId: string | null,
    role?: string,
    effortLevel?: string,
  ) => void;
}) {
  if (steps.length === 0) {
    return (
      <div className="text-sm text-neutral-500">
        No upcoming CLI steps — every step that runs an AI CLI has already started. Change a started
        step&apos;s CLI on its own card in the Steps tab.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-neutral-500">
        CLI steps this task has not reached yet. Setting one here applies to this task and is
        remembered for later tasks. Steps already started keep their picker on their own card. Some
        of these may not run — the execution path chosen at triage can skip them.
      </div>
      {steps.map((s) => (
        <Card key={s.stepId} className="flex flex-col gap-2 p-3">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-neutral-200">{s.title}</span>
            <span className="font-mono text-[11px] text-neutral-600">{s.stepId}</span>
          </div>
          <CliPickerGrid
            providers={providers}
            idPrefix={`upcoming-cli-${s.stepId}`}
            roles={s.cliRoles}
            seats={s.miningSeats}
            defaultProviderId={s.preferredCliProviderId ?? taskCliProviderId ?? ''}
            defaultEffortLevel={s.preferredEffortLevel}
            roleProviders={s.cliRoleProviders}
            roleEfforts={s.cliRoleEfforts}
            seatProviders={s.miningSeatProviders}
            seatEfforts={s.miningSeatEfforts}
            taskCliProviderId={taskCliProviderId}
            locked={disabled}
            busy={busyStepId === s.stepId}
            onChange={(cliProviderId, role, effortLevel) =>
              onChangeCli(s.stepId, cliProviderId, role, effortLevel)
            }
          />
          {error?.stepId === s.stepId && (
            <span className="text-[11px] text-red-400">{error.message}</span>
          )}
        </Card>
      ))}
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
  disabled: boolean;
  disabledReason: 'ended' | 'preparing';
  repositoryId: string | null;
  repositoryName: string | null;
  providers: CliProvider[];
  selectedCliProviderId: string | null;
  onSelectCliProvider: (id: string) => void;
}

function TerminalTab({
  taskId,
  disabled,
  disabledReason,
  repositoryId,
  repositoryName,
  providers,
  selectedCliProviderId,
  onSelectCliProvider,
}: TerminalTabProps) {
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
            disabled={disabled}
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
          disabled={disabled}
          disabledReason={disabledReason}
        />
      )}
    </div>
  );
}

interface StepCardProps {
  step: TaskStep;
  /** True when this step runs AFTER the frontier (active/failed) step in run order.
   *  Such steps are pending and get reset + re-run on any at-or-before retry, so their
   *  per-step action buttons (Retry / Stop / Skip / ...) are hidden. */
  isDownstreamOfActive: boolean;
  /** The run has already moved past this step. Suppresses Resume; Retry stays. */
  isPastStep: boolean;
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
  onAction: (
    action: StepAction,
    opts?: { overrideLocalModel?: boolean; timeoutMinutes?: number },
  ) => Promise<void>;
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
  carriedWorkMs,
}: {
  startedAt: string | null;
  endedAt: string | null;
  idleMs: number;
  waitingStartedAt: string | null;
  status: StepStatus;
  taskCompletedAt: string | null;
  /** Work (ms) from prior runs of this step, added on top of the current run so a
   *  retried step shows its full work, not just the latest attempt. */
  carriedWorkMs: number;
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
  // Reuse the shared effort math so this per-step timer freezes on the SAME waits
  // the totals do: a waiting_form gate AND a waiting_cli park (queued for a CLI
  // slot / rate-limited — waitingStartedAt set, no agent running). Inlining the
  // formula here is what let it drift and tick through a queue park while the
  // totals correctly paused. carriedWorkMs is added on top (prior runs of a retry).
  const { workMs: liveWorkMs } = computeStepContribution(
    { startedAt, endedAt: stepEndedAt, idleMs, userActiveMs: 0, waitingStartedAt, status },
    now,
  );
  const workMs = liveWorkMs + carriedWorkMs;
  const parkedForm = !stepEndedAt && status === 'waiting_form' && !!waitingStartedAt;
  const parkedCli = !stepEndedAt && status === 'waiting_cli' && !!waitingStartedAt;
  const color = stepEndedAt
    ? 'text-neutral-500'
    : parkedForm
      ? 'text-amber-300'
      : parkedCli
        ? 'text-neutral-400'
        : 'text-indigo-300';
  return (
    <span
      className={`font-mono text-xs ${color}`}
      title={
        stepEndedAt
          ? 'Active work time'
          : parkedForm
            ? 'Work time (paused — waiting for input)'
            : parkedCli
              ? 'Work time (paused — queued for a CLI slot)'
              : 'Active work so far'
      }
    >
      {formatDuration(workMs)}
      {parkedForm ? ' (waiting)' : parkedCli ? ' (queued)' : ''}
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

// Surface B: a historical stamp frozen when this step finished — context-window
// headroom plus the subscription allowance (5h / weekly / daily) remaining at that
// moment, so you can watch the allowance drop step by step. Mirrors the top header
// chip's look (mono text, vertical dividers, per-value colour, side padding); no
// reset time here — that lives only in the header. Each value is a bare percentage
// with its own hover title. Renders nothing on deterministic steps / when no usage
// data was captured.
function StepUsageStamp({ step }: { step: TaskStep }) {
  const parts: { key: string; remaining: number; title: string }[] = [];
  if (step.contextLeftPercent != null) {
    const tokens =
      step.contextTokens != null && step.contextWindowSize != null
        ? ` (${step.contextTokens.toLocaleString()} / ${step.contextWindowSize.toLocaleString()} prompt tokens)`
        : '';
    parts.push({
      key: 'ctx',
      remaining: step.contextLeftPercent,
      title: `Context window remaining when this step finished — ${step.contextLeftPercent}%${tokens}`,
    });
  }
  if (step.usageFiveHourPct != null) {
    const r = 100 - step.usageFiveHourPct;
    parts.push({
      key: '5h',
      remaining: r,
      title: `5-hour subscription allowance remaining when this step finished — ${r}%`,
    });
  }
  if (step.usageSevenDayPct != null) {
    const r = 100 - step.usageSevenDayPct;
    parts.push({
      key: 'wk',
      remaining: r,
      title: `Weekly subscription allowance remaining when this step finished — ${r}%`,
    });
  }
  if (step.usageDailyPct != null) {
    const r = 100 - step.usageDailyPct;
    parts.push({
      key: 'day',
      remaining: r,
      title: `Daily subscription allowance remaining when this step finished — ${r}%`,
    });
  }
  if (parts.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 px-2 font-mono text-xs">
      {parts.map((p, i) => (
        <span key={p.key} className="flex items-center gap-1.5">
          {i > 0 && <span className="h-3 w-px bg-neutral-600" aria-hidden />}
          <span className={usageRemainingColor(p.remaining)} title={p.title}>
            {p.remaining}%
          </span>
        </span>
      ))}
    </span>
  );
}

// Task time summary: agent work, idle (time waiting on you), your active time at
// gates, total effort, and wall clock. Shown live while the task runs (ticks each
// second) and frozen once it ends. Renders nothing until the task has started.
/** Live effort-vs-estimate chip for the fixed header (top-right). Owns its own
 *  1s tick — like TaskTotalTime — so only this chip re-renders each second, not
 *  the whole task page. Renders as soon as the task has started: against a pace
 *  budget when one exists, else as a bare effort timer, so a task nobody
 *  estimated still gets a clock in the header. Effort freezes at completedAt. */
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
  if (!task.startedAt) return null;
  const endMs = task.completedAt ? new Date(task.completedAt).getTime() : now;
  const effortMs = liveEffortMs(steps, userActive, endMs);
  const confirmedHours = task.estimatedTimeHours ?? 0;
  // AI's learned estimate (decimal hours). Zero on legacy tasks and on every task type
  // that never runs 00b-estimate (onboarding, onboarding_upgrade, run_app, kb_author).
  const aiEstHours = task.aiEstimatedTimeHours ?? 0;
  // Budget the pace is measured against: the confirmed estimate when one was set, else
  // the AI's own number — a task the user never estimated still gets a pace. With
  // neither, the chip degrades to a bare effort timer instead of disappearing.
  const budgetHours = confirmedHours > 0 ? confirmedHours : aiEstHours;
  const budgetMs = budgetHours * 3_600_000;
  const pct = budgetMs > 0 ? (effortMs / budgetMs) * 100 : 0;
  // Muted middle segment only when the AI number is not already the budget on the right.
  const aiSegmentMs = aiEstHours > 0 && confirmedHours > 0 ? aiEstHours * 3_600_000 : 0;
  const title =
    budgetMs <= 0
      ? 'Effort — agent work + your active time. No estimate set for this task.'
      : confirmedHours <= 0
        ? `Effort vs AI estimate — ${Math.round(pct)}% of the ${aiEstHours}h AI estimate (you set none)`
        : aiSegmentMs > 0
          ? `Effort / AI estimate / your estimate — ${Math.round(pct)}% of the ${confirmedHours}h estimate (AI predicted ${aiEstHours}h)`
          : `Effort vs estimate — ${Math.round(pct)}% of the ${confirmedHours}h estimate`;
  return (
    <span
      className={`ml-auto shrink-0 font-mono text-sm font-semibold ${
        budgetMs > 0 ? paceColorClass(pct) : 'text-neutral-300'
      }`}
      title={title}
    >
      {formatHoursMinutes(effortMs)}
      {budgetMs > 0 && (
        <>
          {' / '}
          {aiSegmentMs > 0 && (
            <>
              <span className="text-neutral-400">{formatHoursMinutes(aiSegmentMs)}</span>
              {' / '}
            </>
          )}
          <span className={confirmedHours > 0 ? undefined : 'text-neutral-400'}>
            {formatHoursMinutes(budgetMs)}
          </span>
        </>
      )}
    </span>
  );
}

/** How many meters the fixed title strip draws before collapsing the rest into "+N". The
 *  strip is ONE line that also carries the back link, the vote score, the title, up to four
 *  badges and the pace chip, and a full meter is ~250px (name + a 50px bar per window + its
 *  reset time). Two is what fits on a laptop without the title truncating to nothing; the
 *  hidden ones keep their numbers in the "+N" tooltip. */
const HEADER_METER_LIMIT = 2;

/**
 * Subscription usage chips: each window's REMAINING percentage for the CLIs the current
 * step runs on (used = vendor-reported; remaining = 100 - used, matching the vendor's own
 * "% left" view). Polls /usage-window gently (~60s); dims a stale reading. Each window is
 * coloured independently on its own remaining headroom.
 *
 * PLURAL because a fan-out step resolves a provider per SEAT — 08c-code-review can spend
 * three subscriptions at once. One meter per SUBSCRIPTION, never per provider row: the
 * grouping is selectMetersForProviderIds, shared with the task-list strip so the two
 * surfaces cannot disagree about what counts as one allowance or which reading speaks for
 * it. Renders nothing when none of the step's CLIs has a readable window and none of them
 * names a fault worth stating.
 */
function HeaderUsageChip({
  providerIds,
  providers,
  reconnectOnly,
}: {
  /** Every CLI this step will spend, from stepCliProviderIds — the step default plus each
   *  configured seat/role, already deduped. */
  providerIds: readonly string[];
  providers: CliProvider[];
  /** Render the dead-token prompts and nothing else. The meters are a summary and can live
   *  in the title strip the user only sees after scrolling; a repair is an action and has to
   *  be on screen when the page opens, which is why the always-visible header mounts this
   *  variant alongside the strip's full one. */
  reconnectOnly?: boolean;
}) {
  const [snapshots, setSnapshots] = useState<UsageWindowSnapshot[] | null>(null);
  const [allowanceKeys, setAllowanceKeys] = useState<Record<string, string> | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  /** Bumped when a repair completes in this tab — see UsageReconnectAction's onRepaired. */
  const [repairNonce, setRepairNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<{
          snapshots: UsageWindowSnapshot[];
          alert?: { allowanceKeys?: Record<string, string> };
        }>('/usage-window')
        .then((d) => {
          if (cancelled) return;
          setSnapshots(d.snapshots);
          // Rides along on the response the chip already fetches. Without it every provider
          // row is its own allowance, so one Claude login backing a seat and the step default
          // would print two identical meters side by side.
          setAllowanceKeys(d.alert?.allowanceKeys);
        })
        .catch(() => {
          if (!cancelled) setSnapshots([]);
        });
    void load();
    const t = setInterval(() => void load(), 60_000);
    // Refetch when the tab regains focus so returning from a reconnect (done in another
    // tab) updates the chip promptly instead of waiting up to 60s for the next tick.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      cancelled = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [repairNonce]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Narrowing guard, not a duplicate of the resolver's own: the fault fallback below indexes
  // providerIds[0], and only this early return proves it exists to tsc.
  if (providerIds.length === 0) return null;
  const meters = selectMetersForProviderIds(providerIds, snapshots, allowanceKeys);

  const rowOf = (providerId: string) => providers.find((p) => p.id === providerId) ?? null;
  /** Short CLI name for a chip, from the provider row where there is one — the snapshot's own
   *  name is the fallback for a row the list has not delivered yet. */
  const nameOf = (snap: UsageWindowSnapshot): string => {
    const row = rowOf(snap.providerId);
    const name = (row?.name ?? snap.providerName) as CliProviderName;
    return CLI_USAGE_LABEL[name] || row?.label || snap.providerName || 'CLI';
  };

  const chipClass = (tone: string) =>
    `flex shrink-0 items-center gap-1 px-2 font-mono text-xs font-semibold ${tone}`;

  const renderMeter = (m: StripMeter) => {
    const who = nameOf(m.snapshot);
    // Dead token: the numbers are gone and only a user action brings them back, so say so
    // here rather than leaving the slot blank on the page the user is already looking at.
    if (m.status === 'pending') {
      return (
        <UsagePendingChip
          key={m.allowanceKey}
          displayName={who}
          className={chipClass('text-neutral-400')}
        />
      );
    }
    if (m.status === 'needs_reconnect') {
      const row = rowOf(m.snapshot.providerId);
      return (
        <UsageReconnectAction
          key={m.allowanceKey}
          providerId={m.snapshot.providerId}
          providerName={(row?.name ?? m.snapshot.providerName) as CliProviderName}
          providerLabel={row?.label ?? null}
          displayName={who}
          className={chipClass('text-amber-400 hover:text-amber-300')}
          onRepaired={() => setRepairNonce((n) => n + 1)}
        />
      );
    }
    const windows = usageWindowsOf(m.snapshot);
    if (windows.length === 0) return null;
    return (
      <span
        key={m.allowanceKey}
        className={`flex shrink-0 items-center gap-1.5 font-mono text-xs font-semibold ${
          m.snapshot.stale ? 'opacity-50' : ''
        }`}
        title={`${who} subscription usage — ${usageTooltip(windows, now)}${
          m.snapshot.stale ? '   (stale)' : ''
        }`}
      >
        <UsageBars name={who} windows={windows} now={now} />
      </span>
    );
  };

  // Sits with the recovery buttons rather than in the title strip, so a repair is on screen
  // without scrolling. Every dead subscription the step spends, not just its default one: a
  // fan-out step whose SEAT token expired fails exactly as hard as one whose default did.
  if (reconnectOnly) {
    const repairs = meters.filter((m) => m.status !== 'ok');
    if (repairs.length === 0) return null;
    return <>{repairs.map(renderMeter)}</>;
  }

  if (meters.length === 0) {
    // Nothing readable for ANY of the step's CLIs. Name WHY for the primary one instead of
    // going blank: four unrelated situations (unmetered CLI, never polled, failed fetch,
    // vendor reported no window) used to share one identical blank, which read as the meter
    // breaking mid-run whenever the previous step's CLI had shown live bars.
    const primaryId = providerIds[0]!;
    const row = rowOf(primaryId);
    const state = resolveUsageChipState({
      providerId: primaryId,
      providerName: row?.name ?? null,
      snapshots,
    });
    if (state.kind !== 'fault') return null;
    return (
      <UsageFaultChip
        fault={state.fault}
        displayName={(row?.name && CLI_USAGE_LABEL[row.name]) || row?.label || 'CLI'}
        className={`ml-auto ${chipClass(
          state.fault === 'not_connected'
            ? 'text-amber-400 hover:text-amber-300'
            : 'text-neutral-500',
        )}`}
      />
    );
  }

  const shown = meters.slice(0, HEADER_METER_LIMIT);
  const hidden = meters.slice(HEADER_METER_LIMIT);
  // Worst headroom a hidden meter has left, so "+N" carries the colour of the most depleted
  // thing it covers. The sort above is by allowance key — stable across polls, which is the
  // point, but arbitrary as an ordering — so without this a CLI at 3% could be invisible
  // purely because its name sorts late. A meter with no readable window (a dead or repairing
  // token) counts as 0: that is the most urgent thing the chip can be hiding.
  const worstOf = (m: StripMeter): number => {
    const pcts = usageWindowsOf(m.snapshot).map((x) => 100 - x.w.usedPct);
    return pcts.length === 0 ? 0 : Math.min(...pcts);
  };
  const hiddenLine = (m: StripMeter): string =>
    m.status === 'needs_reconnect'
      ? `${nameOf(m.snapshot)} — reconnect needed`
      : m.status === 'pending'
        ? `${nameOf(m.snapshot)} — reconnecting`
        : `${nameOf(m.snapshot)} — ${usageTooltip(usageWindowsOf(m.snapshot), now)}`;

  return (
    <span className="ml-auto flex shrink-0 items-center gap-4">
      {shown.map(renderMeter)}
      {hidden.length > 0 && (
        <span
          className={`shrink-0 font-mono text-xs font-semibold ${usageRemainingColor(
            Math.min(...hidden.map(worstOf)),
          )}`}
          title={hidden.map(hiddenLine).join('   ·   ')}
        >
          +{hidden.length}
        </span>
      )}
    </span>
  );
}

function TaskTotalTime({
  task,
  steps,
  userActive,
  providerBreakdown,
  costDisplay,
}: {
  task: Task;
  steps: TaskStep[];
  userActive: { activeStepId: string | null; displayMs: number };
  providerBreakdown: TaskProviderUsage[];
  costDisplay: CostDisplay;
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
  // The AI's own estimate (00b-estimate), shown alongside the confirmed one so its
  // accuracy vs actual effort is visible even when the user overrode it on the form.
  const aiEstimateHours = task.aiEstimatedTimeHours ?? null;
  const aiEstimateMs = (aiEstimateHours ?? 0) * 3_600_000;
  const aiVerdictPct = showVerdict && aiEstimateMs > 0 ? (effortMs / aiEstimateMs) * 100 : null;
  const aiLow = task.aiEstimateLowHours ?? null;
  const aiHigh = task.aiEstimateHighHours ?? null;
  // The subscription counterfactual: what the runs that were NOT billed per token would
  // have cost at list API rates. Kept apart from costUsd everywhere — it is money saved,
  // not money spent, and adding the two would report a total nobody was ever charged.
  const notionalCostUsd = providerBreakdown.reduce((sum, p) => sum + (p.notionalCostUsd || 0), 0);
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
      {providerBreakdown.length > 0 && (
        <Card className="py-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-neutral-200">
              Tokens and spend by provider
            </span>
            <span className="text-[11px] text-neutral-500">
              {costDisplay.currency === 'USD'
                ? 'real spend only — a subscription plan and an unpriced model both show as no cost'
                : `shown in ${costDisplay.currency} at the ${costDisplay.approximate ? 'nearest known' : (costDisplay.rateDate ?? 'current')} ECB rate`}
            </span>
          </div>
          <div className="space-y-1">
            {providerBreakdown.map((p) => {
              const cache = p.cacheReadTokens + p.cacheCreationTokens;
              // Gate the money on whether a cost was actually established for THESE
              // invocations, not on the provider's static basis: a claude-binary wrapper
              // is 'estimate' yet now carries a real computed cost, and a metered CLI on
              // a subscription plan carries none. costUsd is already the billable total.
              const priced =
                p.costUsd > 0 || p.costSource === 'computed' || p.costSource === 'manual';
              return (
                <div
                  key={`${p.provider}-${p.costBasis}`}
                  className="flex items-center justify-between gap-3 text-xs"
                  title={`${p.invocations} invocation(s) — input ${p.inputTokens.toLocaleString()} / output ${p.outputTokens.toLocaleString()} / cache ${cache.toLocaleString()}`}
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-neutral-200">{p.provider}</span>
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
                      {p.costBasis}
                    </span>
                    {p.unpricedInvocations > 0 && (
                      <span
                        className="rounded bg-amber-950/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300"
                        title={`${p.unpricedInvocations} invocation(s) ran a model with no rate on record, so their cost is not included. Add a rate on the admin pricing page.`}
                      >
                        {p.unpricedInvocations} unpriced
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-3 font-mono text-neutral-400">
                    <span>in {formatTokens(p.inputTokens)}</span>
                    <span>out {formatTokens(p.outputTokens)}</span>
                    <span className="text-cyan-400/80">cache {formatTokens(cache)}</span>
                    <span
                      className={priced ? 'text-emerald-300' : 'text-neutral-600'}
                      title={describeCostSource(p.costSource, costDisplay, p.unpricedInvocations)}
                    >
                      {priced ? formatCost(p.costUsd, costDisplay) : '—'}
                    </span>
                    {p.notionalCostUsd > 0 && (
                      <span
                        className="text-neutral-500"
                        title={`Not spent. These invocations ran on a subscription or flat plan; at list API rates the same tokens would have cost ${formatCost(p.notionalCostUsd, costDisplay)}.`}
                      >
                        ~{formatCost(p.notionalCostUsd, costDisplay)} if API
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          {notionalCostUsd > 0 && (
            <div className="mt-2 flex items-center justify-between gap-3 border-t border-neutral-800 pt-2 text-xs text-neutral-500">
              <span>Estimate if task used API pricing instead of subscription:</span>
              <span className="font-mono text-sm font-bold text-neutral-300">
                {formatCost(notionalCostUsd, costDisplay)}
              </span>
            </div>
          )}
        </Card>
      )}
      {showVerdict && (
        <Card className="flex items-center justify-between gap-3 py-3">
          <div className="flex flex-col">
            <span className="text-sm font-medium text-neutral-200">Estimate vs effort</span>
            <span className="text-xs text-neutral-500">
              Estimated {formatHoursMinutes(verdictEstimateMs)} · actual effort{' '}
              {formatHoursMinutes(effortMs)}
            </span>
            {aiEstimateHours != null && (
              <span className="text-xs text-neutral-500">
                AI predicted {formatHoursMinutes(aiEstimateMs)}
                {aiLow != null && aiHigh != null && (
                  <span className="text-neutral-500">
                    {' '}
                    ({aiLow}–{aiHigh}h)
                  </span>
                )}
                {aiVerdictPct != null && (
                  <span className={paceColorClass(aiVerdictPct)}>
                    {' '}
                    · {Math.round(aiVerdictPct)}% of actual
                  </span>
                )}
              </span>
            )}
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

function StepCardImpl({
  step,
  isDownstreamOfActive,
  isPastStep,
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
  // RAG stats are available for any step that ran an agent (rag_search only
  // fires during a CLI invocation). Attribution is by time window server-side,
  // so no per-step wiring is needed; the panel shows "none recorded" for the
  // rare agent step that made no rag_search. Deterministic/form-only steps
  // (cliInvocationCount 0) never call rag, so they get no toggle.
  const ranAgent = step.cliInvocationCount > 0;
  const schema = step.formSchema as FormSchema | null;
  const initialValues = (step.formValues as FormValues | null) ?? undefined;
  const taskCancelled = taskStatus === 'cancelled';
  // Whole task finished — used to drop live-runtime panels (e.g. the gate-2 VNC)
  // so they stop reconnecting against a torn-down runtime and spamming the console
  // with WebSocket 1006 errors.
  const taskEnded = taskCancelled || taskStatus === 'completed' || taskStatus === 'failed';
  // Banner visibility comes from the structural columns, never from the presence of the copy —
  // lib/step-banners is the single tested source of that rule.
  //
  // Global pause is one of those structural inputs: a parked step under pause is not waiting for
  // a machine slot, it is waiting for the switch, and its stored "Waiting for a free runtime
  // slot" line would otherwise promise a slot nothing is handing out. Cheap to read per card — the
  // hook shares ONE poller across every consumer on the page.
  const globalPaused = useGlobalPause();
  const park = parkBanner(step, { taskEnded, paused: globalPaused });
  const failure = failureBanner(step);
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
  const canActOnStep = !taskCancelled && taskStatus !== 'completed' && !isDownstreamOfActive;
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
  const iterBadgeLabel = iterationBadgeLabel(step);
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
        <div className="flex flex-col gap-2 border-b border-neutral-800 pb-3">
          {/* One grid cell per picker, each cell laid out label | CLI | effort at fixed
              widths, so the three columns line up across every row instead of each
              picker starting wherever the previous label happened to end. auto-fill
              drops cells per row as the window narrows; the cell width never changes,
              so nothing re-flows on a CLI switch. */}
          {showCliPicker && (
            <CliPickerGrid
              providers={providers}
              idPrefix={cliPickerId}
              roles={step.cliRoles}
              seats={step.miningSeats}
              defaultProviderId={effectiveCliProviderId}
              defaultEffortLevel={step.preferredEffortLevel}
              roleProviders={step.cliRoleProviders}
              roleEfforts={step.cliRoleEfforts}
              seatProviders={step.miningSeatProviders}
              seatEfforts={step.miningSeatEfforts}
              taskCliProviderId={taskCliProviderId}
              locked={cliLocked}
              busy={cliBusy}
              onChange={onChangeCli}
            />
          )}
          {/* Status line and auto-continue on their own row, below the grid. Both used to
              sit inside the picker row, where the three status messages inserted and
              removed an element on every CLI switch and re-flowed the pickers twice. The
              slot is always rendered so the text appears in place rather than pushing. */}
          <div className="flex items-center gap-x-4">
            {showCliPicker && (
              <span
                className={`min-w-[8rem] text-[11px] ${cliError ? 'text-red-400' : 'text-neutral-500'}`}
              >
                {cliError ?? (cliLocked ? 'locked while step running' : cliBusy ? 'saving...' : '')}
              </span>
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
            carriedWorkMs={step.carriedWorkMs}
          />
          <StepTokens tokenUsage={step.tokenUsage} />
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
          {/* Surface B stamp pinned to the right, just left of the action buttons
              (centering read as random since each step's left content differs). */}
          <StepUsageStamp step={step} />
          {canActOnStep && (
            <>
              {step.stepId === BIZ_REQ_REVIEW_STEP_ID && step.status === 'failed' && (
                <Button
                  size="sm"
                  disabled={actionBusy}
                  onClick={() => void onRetryStep(BIZ_REQ_DRAFT_STEP_ID)}
                  title={BIZ_REQ_RERUN_TITLE}
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
                    : RETRY_TITLE;
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
              {/* Not gated on status === 'failed': a fan-out step whose agents were killed
                  at their budget DEGRADES to done (the agent failed, not the code), and
                  that is precisely the step that needs a longer budget. errorHint is the
                  structural proof either way, and canRetry already covers done. */}
              {step.errorHint?.type === 'cli_timeout' && canRetry && (
                <Button
                  size="sm"
                  disabled={actionBusy}
                  onClick={() => {
                    // errorHint is the structural proof the CLI hit its budget on every
                    // rung — never the step's message copy, which outlives the state it
                    // describes. Narrowed inside the handler so the union stays exhaustive.
                    const hint = step.errorHint;
                    if (hint?.type !== 'cli_timeout') return;
                    const minutes = parseRetryTimeoutMinutes(
                      prompt(
                        `The CLI was stopped at its ${hint.lastBudgetMinutes}-minute budget on ${hint.attempts} attempt(s).\n\nMinutes to give it this time (${RETRY_TIMEOUT_MIN_MINUTES}–${RETRY_TIMEOUT_MAX_MINUTES}):`,
                        String(defaultRetryTimeoutMinutes(hint.lastBudgetMinutes)),
                      ),
                    );
                    if (minutes === null) return;
                    void onAction('retry', { timeoutMinutes: minutes });
                  }}
                  title="Re-run this step with a CLI timeout you choose, instead of the automatic budget ladder. Use when the pass is genuinely long rather than stuck."
                >
                  {actionBusy ? 'Retrying…' : 'Retry with longer timeout'}
                </Button>
              )}
              {/* Never on a step the run has moved past: there, Retry is the only coherent
                  recovery (it resets this step and everything after it), while a resume would
                  leave this row and the frontier row both live. */}
              {isResumableStep(step) && !isPastStep && (
                <Button
                  size="sm"
                  disabled={actionBusy}
                  onClick={() => onAction('resume')}
                  title={RESUME_TITLE}
                >
                  {actionBusy ? 'Resuming…' : resumeButtonLabel(step)}
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

      {failure && (
        // Only while the row has NOT ended successfully — see failureBanner (lib/step-banners) for
        // why a `done` row's error_message is either stale or a deliberate fix-loop diagnosis.
        // Steps that ended well but with caveats use degradedNote / warningMessage instead.
        <div className="whitespace-pre-wrap rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {failure.text}
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
              <InlineMarkdown body={schema.description} className="mt-1 text-sm text-neutral-400" />
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
                step.activeRole !== 'fixer' ? (
                  <>
                    {liveBrowserPanel(step, taskId, {
                      autoCollapse: taskEnded,
                      splitTerminal: true,
                    })}
                    {screenshotGallery(step, taskId, 'output')}
                  </>
                ) : undefined
              }
              beforeFieldsSlot={
                !runtimeTornDown && step.stepId === '99-run-app-ready' ? (
                  <RunAppReadyPanels step={step} taskId={taskId} autoCollapse={taskEnded} />
                ) : !runtimeTornDown && step.stepId === '09-gate-2-verify-approval' ? (
                  // Gate-2: the live browser (or, in direct mode, the URL info box) sits
                  // BELOW the verification status table but ABOVE the approve/reject
                  // decision — review the results, test, then decide.
                  <>
                    {liveBrowserPanel(step, taskId, {
                      autoCollapse: taskEnded,
                      title: 'Browser — test the app here',
                    })}
                    {screenshotGallery(step, taskId, 'detect')}
                  </>
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

      {ranAgent && step.startedAt && (
        <button
          type="button"
          onClick={() => setShowRagStats((v) => !v)}
          className="self-start text-xs text-indigo-400 underline"
        >
          {showRagStats ? 'Hide' : 'Show'} RAG stats
        </button>
      )}
      {ranAgent && showRagStats && <RagStatsPanel taskId={taskId} stepId={step.stepId} />}

      {step.cliInvocationCount > 0 && (
        <StepTerminal
          taskId={taskId}
          stepRowId={step.id}
          autoExpand={step.status === 'running' || step.status === 'waiting_cli'}
          statusMessage={step.statusMessage}
        />
      )}
      {park && (
        // Runtime-parked: the step is queued for a runtime slot. It may have prior invocations
        // from an interrupted run — their terminals render collapsed above (a pending step does
        // not auto-expand), so this prominent amber "queued" panel is the current signal and the
        // task reads as waiting-in-line, not a stuck blank you have to scroll up to explain.
        // Visibility comes from parkBanner (lib/step-banners) — gated on the wait marker, never on
        // the presence of the copy.
        <div className="flex items-center gap-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
          {park.text}
        </div>
      )}

      {/* The live browser belongs to the RUN, not to the record of it. Once 08a is done the
          agent's session is over and the next interactive surface is Gate 2's own panel, so the
          card keeps only its evidence gallery — same as Gate 2, whose panel disappears with the
          form when the user submits. Left mounted it read as a browser you could still open,
          and expanding it re-bridged (or cold-booted) a desktop nothing was driving. */}
      {!runtimeTornDown &&
        step.stepId === '08a-browser-verify' &&
        step.status !== 'failed' &&
        step.status !== 'done' &&
        step.status !== 'waiting_form' &&
        step.activeRole !== 'fixer' &&
        liveBrowserPanel(step, taskId, { autoCollapse: taskEnded, splitTerminal: true })}

      {!runtimeTornDown &&
        step.stepId === '08a-browser-verify' &&
        step.status !== 'waiting_form' &&
        screenshotGallery(step, taskId, 'output')}

      {step.stepId === '08a-browser-verify' && step.activeRole === 'fixer' && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          The browser test found issues — fixing them in the code now. The live browser is paused;
          follow the fix in the terminal above.
        </div>
      )}

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

// StepCard's handler props (onSubmit/onAction/…) are inline arrows recreated on
// every TaskDetailPage render, so a default React.memo never bails. They are pure
// derivations of the data props, and the 2s status poll re-renders every card with
// fresh handlers anyway — so the equality check safely skips them and compares only
// the data props. Net effect: the 1s user-active timer tick at the page root stops
// re-rendering all N step cards; only the active card (whose userActiveDisplayMs
// changes each second) re-renders. (Verified: the handlers close over only id/api/
// reload/setters/steps — none over the sub-2s timer state — so a skipped handler is
// never staler than the 2s poll that refreshes them.)
const STEP_CARD_FN_PROPS = new Set<keyof StepCardProps>([
  'onSubmit',
  'onAction',
  'onRetryStep',
  'onStop',
  'onCliLogin',
  'onChangeCli',
  'onToggleAutoContinue',
]);

function stepCardPropsEqual(prev: Readonly<StepCardProps>, next: Readonly<StepCardProps>): boolean {
  for (const key of Object.keys(next) as (keyof StepCardProps)[]) {
    if (STEP_CARD_FN_PROPS.has(key)) continue;
    if (!Object.is(prev[key], next[key])) return false;
  }
  return true;
}

const StepCard = memo(StepCardImpl, stepCardPropsEqual);

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
        Discovery hit-rate <span className="text-neutral-200">{ragUsedPct}%</span> — share of
        queries that returned at least one pointer · of retrieved chunks{' '}
        <span className="text-indigo-300">{kbPct}% KB</span> /{' '}
        <span className="text-emerald-300">{codePct}% code</span> /{' '}
        <span className="text-amber-300">{runbookPct}% runbook</span> /{' '}
        <span className="text-sky-300">{learningPct}% learning</span>
      </p>
      <p className="text-[11px] leading-relaxed text-neutral-500">
        RAG is a discovery tool: these counts measure pointers surfaced, not work done. The agent
        grounds every lead with the code-navigation tools available to its CLI plus exact file
        searches and direct reads — that step is intentionally not measured here, so a low hit-rate
        is not a low-quality signal.
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
