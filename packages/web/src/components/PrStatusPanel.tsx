'use client';

import { Badge, Card } from '@/components/ui';
import { BrowserDirectPanel } from '@/components/terminal/BrowserDirectPanel';

// Task-level pull-request panel, shown while a workflow task that chose "create a pull
// request" at step 12 parks in waiting_pr. Reads the pr_* columns spread onto the task
// by GET /tasks/:id; the background poller keeps prState/prMergedAt/prPollError live.
// The Finalize / "clean up without merging" actions live on the 13-pr-wait step form
// below (rendered by the normal StepCard FormRenderer) — this panel is the at-a-glance
// status plus the reopen-environment affordance for addressing review feedback.

interface PrStatusPanelProps {
  taskId: string;
  provider: string | null | undefined;
  url: string | null | undefined;
  number: string | null | undefined;
  state: 'open' | 'merged' | 'closed' | null | undefined;
  mergedAt: string | null | undefined;
  finalizeMode: 'auto' | 'manual' | null | undefined;
  pollError: string | null | undefined;
  /** Whether the environment can still be reopened — only while the task is parked in
   *  waiting_pr (the worktree is kept). Once the task completes/cancels, the worktree +
   *  runtime are reaped, so the reopen affordance is hidden (it would spin forever
   *  trying to warm a runtime that no longer exists). */
  reopenable: boolean;
}

const PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub',
  gitea: 'Gitea',
  gitlab: 'GitLab',
  bitbucket_cloud: 'Bitbucket',
  bitbucket_server: 'Bitbucket Server',
};

function stateBadge(state: PrStatusPanelProps['state']): {
  variant: 'warning' | 'success' | 'error';
  label: string;
} {
  switch (state) {
    case 'merged':
      return { variant: 'success', label: 'merged' };
    case 'closed':
      return { variant: 'error', label: 'closed without merging' };
    default:
      return { variant: 'warning', label: 'open — in review' };
  }
}

export function PrStatusPanel({
  taskId,
  provider,
  url,
  number,
  state,
  mergedAt,
  finalizeMode,
  pollError,
  reopenable,
}: PrStatusPanelProps) {
  const badge = stateBadge(state);
  const providerLabel = (provider && PROVIDER_LABELS[provider]) || provider || 'forge';
  const ref = number ? `#${number}` : '';

  return (
    <Card className="flex flex-col gap-3 border-indigo-800/60 bg-indigo-950/20">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-neutral-100">Pull request</span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="truncate font-mono text-sm text-indigo-300 underline"
          >
            {providerLabel} {ref}
          </a>
        ) : (
          <span className="text-sm text-neutral-400">
            {providerLabel} {ref}
          </span>
        )}
      </div>

      <p className="text-xs text-neutral-400">
        {state === 'merged'
          ? mergedAt
            ? `Merged ${new Date(mergedAt).toLocaleString()}.`
            : 'Merged.'
          : state === 'closed'
            ? 'The pull request was closed without merging. Use the step below to clean up or keep waiting.'
            : finalizeMode === 'manual'
              ? 'Waiting for the pull request to merge. This task will not auto-complete — click Finalize on the step below once it is merged.'
              : 'Waiting for the pull request to merge. This task auto-completes and cleans up the worktree once the merge is detected.'}
      </p>

      {pollError && (
        <p className="rounded-md border border-amber-600/40 bg-amber-950/30 px-2 py-1 text-xs text-amber-300">
          Status check failed: {pollError}
        </p>
      )}

      {/* Reopen the environment to address review feedback — only while the task is still
          parked in waiting_pr (worktree kept). Expanding this re-warms the torn-down
          runtime via the same /access-urls ensure handshake the browser panel uses.
          Hidden once the task completes/cancels: the worktree is gone, so an ensure would
          spin "starting…" forever against a runtime that can never come up. */}
      {reopenable && (
        <BrowserDirectPanel
          taskId={taskId}
          title="Reopen the app environment to address review feedback"
          persistId="pr-wait"
        />
      )}
    </Card>
  );
}
