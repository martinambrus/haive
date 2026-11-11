import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import { CONFIG_KEYS, configService } from '@haive/shared';
import {
  TaskCancelledError,
  ReopenStepFormError,
  type StepContext,
  type StepDefinition,
} from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { ensureAppServing } from '../workflow/_app-runtime.js';
import { ddevMailpitUrls, runnerExec, startBrowserDesktop } from '../../../sandbox/ddev-runner.js';
import {
  appRunnerExec,
  startBrowserDesktop as startAppBrowserDesktop,
} from '../../../sandbox/app-runner.js';
import { shellQuote } from '../../../sandbox/shell-quote.js';
import { buildCommitDiffArtifact } from '../workflow/_commit-diff.js';
import { resolveGitEnv } from '../../../secrets/user-git-identity.js';
import { detectOrigin, gitRun, pushBranch } from '../../../repo/git-push.js';
import {
  unregisteredGitlinks,
  unregisteredGitlinksMessage,
} from '../workflow/_gitlink-registration.js';
import {
  gitPreview,
  gitPreviewWasCommitted,
  commitGitPreview,
  assertGitPreviewBranch,
  RUN_APP_PATHSPECS,
  type GitPreview,
} from '../../../repo/git-preview.js';
import { gitWorkspaceStatus } from '../../../repo/git-workspace.js';
import {
  commitBeforeProjectionPutBack,
  putBackProjections,
  warnStep,
} from '../../../project-state/branch-revert.js';

// Git identity fallback when the user has no name/email on file — mirrors
// 10-gate-3-commit so a commit-back never fails for a missing identity.
const FALLBACK_GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Haive',
  GIT_AUTHOR_EMAIL: 'worker@haive.local',
  GIT_COMMITTER_NAME: 'Haive',
  GIT_COMMITTER_EMAIL: 'worker@haive.local',
};

interface RunAppReadyDetect {
  /** Runtime mode + URL the app is serving on (resolved via ensureAppServing). */
  mode: 'ddev' | 'app-runner' | 'host' | 'none';
  appUrl: string | null;
  /** Drives the in-app VNC panel (BrowserVncPanel); offered whenever a runtime is up.
   *  `mailpitUrl` is the DDEV project's mail catcher; OPTIONAL because detect_output is
   *  persisted and only rebuilt when null, so a step parked before the field existed
   *  replays a payload without it. Absent/null off DDEV or with no Mailpit reported. */
  liveBrowser: { available: boolean; appUrl: string | null; mailpitUrl?: string | null } | null;
  /** Drives the own-browser URL panel (BrowserDirectPanel); the global feature flag. */
  directAccess: boolean;
  /** Drives the DB connection panel (DatabaseAccessPanel) when the task opted into direct
   *  database access and the global switch is on. Independent of the viewing mode. */
  dbAccess: boolean;
  // Commit-back preview of the per-task worktree the runtime serves.
  workspacePath: string;
  hasGit: boolean;
  branch: string | null;
  hasOrigin: boolean;
  /** Why the origin could not be read, so the push is not offered. Optional: a parked step replays a payload without it. */
  originError?: string | null;
  /** Why the branch could not be read, so the push is not offered. Optional: a parked step replays a payload without it. */
  branchError?: string | null;
  dirtyFiles: number;
  diffArtifactPath: string | null;
  /** Absent on older parked forms or when the preview could not be read safely. */
  commitPreview?: GitPreview | null;
  /** Optional for forms parked before preview availability was recorded. */
  commitPreviewError?: string | null;
  changedFileCount: number;
  /** The branch 01 forked the worktree from; absent where 01 did not run or the output predates it. */
  baseBranch?: string | null;
}

interface RunAppReadyApply {
  finished: true;
  committed: boolean;
  commitSha: string | null;
  pushed: boolean;
  message: string;
}

/** Terminal "hold" gate for a run_app task: the runtime is up, so park here with
 *  the live app (VNC + own-browser) and the Terminal tab while the user browses,
 *  tests, and edits. On submit the user optionally commits the session edits back
 *  to the worktree branch (and pushes), then the step finishes — and because this
 *  is the LAST step, markTaskCompleted tears the whole runtime down. */
export const runAppReadyStep: StepDefinition<RunAppReadyDetect, RunAppReadyApply> = {
  needsRuntime: 'if-serving',
  metadata: {
    id: '99-run-app-ready',
    workflowType: 'run_app',
    index: 1,
    title: 'App is running',
    description:
      'The app is up. Browse or test it via the in-app VNC or your own browser, edit it from the Terminal tab, then finish to optionally commit your edits and tear everything down.',
    requiresCli: false,
  },

  async detect(ctx: StepContext): Promise<RunAppReadyDetect> {
    // The viewing-mode gate (98-choose-view) picked exactly one surface. Bring up
    // only that one: 'vnc' navigates the in-runner browser so the VNC view opens ON
    // the app; 'direct' shows the user a URL for their own browser and never starts
    // the VNC desktop (it only slows their session). Default 'vnc' (e.g. legacy rows
    // or direct-access globally off).
    const viewChoice = await loadPreviousStepOutput(ctx.db, ctx.taskId, '98-choose-view');
    const viewMode =
      (viewChoice?.output as { viewMode?: string } | null)?.viewMode === 'direct'
        ? 'direct'
        : 'vnc';

    // The preceding runtime step (01c-ddev-env / 01a-app-boot) brought the app up;
    // re-ensure here so a worker reload between steps can't leave the user staring
    // at a dead app. Idempotent; best-effort (a failure still renders the gate).
    let mode: RunAppReadyDetect['mode'] = 'none';
    let appUrl: string | null = null;
    let mailpitUrl: string | null = null;
    try {
      const runtime = await ensureAppServing(ctx);
      mode = runtime.mode;
      appUrl = runtime.url;
      // http, not https: opened in the runner's own Chromium, whose trust store is separate
      // from the system one, so https would risk an interstitial instead of the mailbox.
      if (runtime.mode === 'ddev')
        mailpitUrl = (await ddevMailpitUrls(runtime.handle))?.http ?? null;
      // Navigate the in-runner headed browser to the app so the VNC view opens ON
      // the running app instead of a blank browser (mirrors 08a/gate-2). VNC mode
      // only — own-browser mode skips the desktop entirely. Best-effort: a
      // navigation failure must not block the gate from rendering.
      if (viewMode === 'vnc' && runtime.mode === 'ddev') {
        await startBrowserDesktop(runtime.handle);
        await runnerExec(
          runtime.handle,
          `node /opt/browser-probe-connect.js ${shellQuote(String(appUrl))}`,
          {
            timeoutMs: 60_000,
          },
        );
      } else if (viewMode === 'vnc' && runtime.mode === 'app-runner') {
        await startAppBrowserDesktop(runtime.handle);
        await appRunnerExec(
          runtime.handle,
          `node /opt/browser/browser-probe-connect.js ${shellQuote(String(appUrl))}`,
          { timeoutMs: 60_000 },
        );
      }
    } catch (err) {
      if (err instanceof TaskCancelledError) throw err;
      ctx.logger.warn(
        { err, taskId: ctx.taskId },
        'run-app-ready: runtime/browser bring-up failed',
      );
    }

    // Surface exactly the chosen surface: own-browser only in 'direct' mode, VNC
    // only in 'vnc' mode. The web renders whichever is set, with no toggle.
    const directAccess = viewMode === 'direct';
    // Direct database access is independent of the viewing mode: show the DB panel whenever
    // the task opted in and the global switch is on.
    const dbTaskRow = await ctx.db.query.tasks.findFirst({
      where: eq(schema.tasks.id, ctx.taskId),
      columns: { exposeDbPort: true },
    });
    const dbAccess =
      (dbTaskRow?.exposeDbPort ?? false) &&
      (await configService.getBoolean(CONFIG_KEYS.DB_DIRECT_ACCESS, true));

    // The runtime live-binds the per-task worktree; commit-back acts on it.
    const prev = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
    const worktreeOutput = prev?.output as { worktreePath?: string; baseBranch?: string } | null;
    const workspacePath = worktreeOutput?.worktreePath ?? ctx.workspacePath;
    // The runtime must keep serving, so a corrupt repo degrades to "no git" (the
    // commit-back affordance hides) rather than failing the readiness step.
    const gitStatus = await gitWorkspaceStatus(workspacePath);
    if (gitStatus === 'broken') {
      ctx.logger.warn({ workspacePath }, 'worktree git is unusable; commit-back disabled');
    }
    const hasGit = gitStatus === 'ok';

    let branch: string | null = null;
    let hasOrigin = false;
    let originError: string | null = null;
    let branchError: string | null = null;
    let dirtyFiles = 0;
    let diffArtifactPath: string | null = null;
    let changedFileCount = 0;
    let commitPreview: GitPreview | null = null;
    let commitPreviewError: string | null = null;
    if (hasGit) {
      const branchRes = await gitRun(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      branch = branchRes.code === 0 ? branchRes.stdout.trim() : null;
      if (branchRes.code !== 0) {
        branchError = `could not read the checkout's current branch: ${(branchRes.stderr || branchRes.stdout).trim()}`;
        ctx.logger.warn(
          { workspacePath, branchError },
          'run-app-ready: branch unreadable; push not offered',
        );
      }
      try {
        hasOrigin = await detectOrigin(workspacePath);
      } catch (err) {
        originError = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(
          { err, workspacePath },
          'run-app-ready: origin remote unreadable; push not offered',
        );
      }
      // Never fail the gate on a diff-build error — the viewer is simply hidden.
      try {
        const status = await gitRun(workspacePath, [
          '--no-optional-locks',
          'status',
          '--porcelain',
        ]);
        if (status.code !== 0) {
          throw new Error(
            `git status failed in ${workspacePath}: ${status.stderr.trim() || status.stdout.trim()}`,
          );
        }
        dirtyFiles = status.stdout.split('\n').filter((l) => l.trim().length > 0).length;
        if (dirtyFiles > 0) {
          const before = await gitPreview(workspacePath);
          const res = await buildCommitDiffArtifact(workspacePath, (cwd, argv) =>
            gitRun(cwd, argv.includes('status') ? [...argv, '--', ...RUN_APP_PATHSPECS] : argv),
          );
          const after = await gitPreview(workspacePath);
          if (res.truncated) {
            commitPreviewError =
              'The commit preview is unavailable because not all changed files can be shown. Commit your edits from the Terminal tab, or finish without committing.';
            throw new Error(commitPreviewError);
          }
          if (
            before.head !== after.head ||
            before.ref !== after.ref ||
            before.tree !== after.tree
          ) {
            throw new Error(
              'The commit preview changed while it was being read; reopen it to review the current edits.',
            );
          }
          diffArtifactPath = res.artifactPath;
          changedFileCount = res.changedFileCount;
          commitPreview = before;
        } else {
          commitPreview = await gitPreview(workspacePath, []);
        }
      } catch (err) {
        commitPreviewError ??=
          'The commit preview is unavailable because the edits could not be read safely. Commit your edits from the Terminal tab, or finish without committing.';
        ctx.logger.warn({ err }, 'run-app-ready: failed to build commit diff artifact');
      }
    }

    return {
      mode,
      appUrl,
      liveBrowser:
        viewMode === 'vnc' && mode !== 'none' ? { available: true, appUrl, mailpitUrl } : null,
      directAccess,
      dbAccess,
      workspacePath,
      hasGit,
      branch,
      hasOrigin,
      originError,
      branchError,
      dirtyFiles,
      diffArtifactPath,
      commitPreview,
      commitPreviewError,
      changedFileCount,
      baseBranch: worktreeOutput?.baseBranch ?? null,
    };
  },

  form(_ctx, detected): FormSchema {
    // mode 'none' = the runtime tail found nothing to boot (no DDEV config and no
    // dev script/Dockerfile). Say so plainly + how to make it runnable, instead of
    // the misleading "starting" text that would otherwise strand the user here.
    const lines =
      detected.mode === 'none'
        ? [
            'No runnable runtime was detected for this project — there is nothing to browse, test, or edit here.',
            'To make it runnable: choose DDEV in the dependency step (Haive generates a .ddev config from the detected versions and boots it), or add a dev script / Dockerfile so the app-runner can start it — then Retry from the runtime step.',
            '',
            'You can finish now to tear everything down.',
          ]
        : [
            detected.appUrl
              ? `The app is running at ${detected.appUrl}.`
              : 'The app runtime is starting.',
            'Browse or test it in the panels below, or edit it from the Terminal tab — your edits are live in the running app.',
            '',
            'When you are done, finish to tear down the environment. Optionally commit your',
            'session edits back to this task’s branch first.',
          ];
    lines.push(
      '',
      'Only the edits shown below are committed. If they change, review the refreshed preview and finish again.',
    );
    const fields: FormSchema['fields'] =
      !detected.hasGit || detected.commitPreview
        ? [
            {
              type: 'checkbox',
              id: 'commit',
              label: 'Commit my session edits before finishing',
              default: false,
            },
            {
              type: 'textarea',
              id: 'commitMessage',
              label: 'Commit message',
              rows: 3,
              default: 'chore: run-app session edits',
            },
          ]
        : [];
    if (detected.hasGit && !detected.commitPreview) {
      fields.push({
        type: 'note',
        id: 'commitPreviewUnavailable',
        label: 'Commit preview unavailable',
        body:
          detected.commitPreviewError ??
          'The commit preview is unavailable. Commit your edits from the Terminal tab, or finish without committing.',
        variant: 'warning',
      });
    }
    if (detected.hasOrigin && !detected.branchError) {
      fields.push({
        type: 'checkbox',
        id: 'push',
        label: `Push ${detected.branch ?? 'this branch'} to origin before finishing`,
        default: false,
      });
    }
    if (detected.hasOrigin && detected.branchError) {
      fields.push({
        type: 'note',
        id: 'branchUnreadable',
        label: 'Branch not read',
        body: `Pushing is not offered: ${detected.branchError}. Retry this step to read it again.`,
        variant: 'warning',
      });
    }
    if (detected.originError) {
      fields.push({
        type: 'note',
        id: 'originUnreadable',
        label: 'Origin remote not read',
        body: `Pushing is not offered: ${detected.originError}. Fix the git configuration and Retry this step to see it.`,
        variant: 'warning',
      });
    }
    return {
      title: 'App is running',
      description: lines.join('\n'),
      fields,
      submitLabel: 'Finish and tear down',
    };
  },

  async apply(ctx: StepContext, args): Promise<RunAppReadyApply> {
    const values = args.formValues as {
      commit?: boolean;
      commitMessage?: string;
      push?: boolean;
    };
    const detected = args.detected;

    if ((!values.commit && !values.push) || !detected.hasGit) {
      return {
        finished: true,
        committed: false,
        commitSha: null,
        pushed: false,
        message: values.commit ? 'no git repo' : 'finished without committing',
      };
    }

    const workspace = detected.workspacePath;
    let nothing = true;
    let committedPreviewSha: string | null = null;
    // A push can publish commits already on the branch. Leaving commit unticked
    // must keep the user's index and uncommitted session edits untouched.
    if (values.commit) {
      const status = await gitRun(workspace, [
        '--no-optional-locks',
        'status',
        '--porcelain',
        '-z',
        '-uall',
      ]);
      if (status.code !== 0)
        throw new Error(`git status failed: ${status.stderr || status.stdout}`);
      const orphans = await unregisteredGitlinks(
        workspace,
        status.stdout,
        [],
        detected.commitPreview?.paths,
        detected.commitPreview ?? undefined,
      );
      if (orphans.length) throw new Error(unregisteredGitlinksMessage(orphans));
      const preview = detected.commitPreview;
      if (!preview?.ref) {
        throw new ReopenStepFormError(
          'The edits need a fresh commit preview. Review the refreshed preview before finishing.',
          { notice: true },
        );
      }
      let current: GitPreview;
      let alreadyCommitted = false;
      try {
        // Rebuild against the reviewed parent, including deletions already committed.
        // This also ignores the projection-only tree changes put-back may have made.
        current = await gitPreview(workspace, preview.paths, preview.head);
        if (current.head !== preview.head && current.ref === preview.ref) {
          alreadyCommitted = await gitPreviewWasCommitted(workspace, preview, current.head);
          if (alreadyCommitted) committedPreviewSha = current.head;
          if (!alreadyCommitted && detected.branch) {
            const beforePutBack = await commitBeforeProjectionPutBack(
              ctx,
              detected.branch,
              current.head,
            );
            alreadyCommitted =
              beforePutBack !== null &&
              (await gitPreviewWasCommitted(workspace, preview, beforePutBack));
            if (alreadyCommitted) committedPreviewSha = beforePutBack;
          }
        }
      } catch {
        throw new ReopenStepFormError(
          'The edits changed or could not be read. Review the refreshed preview before finishing.',
          { notice: true },
        );
      }
      if (
        (current.head !== preview.head && !alreadyCommitted) ||
        current.ref !== preview.ref ||
        current.tree !== preview.tree
      ) {
        throw new ReopenStepFormError(
          'The edits changed since the commit preview. Review the refreshed preview before finishing.',
          { notice: true },
        );
      }
      if (alreadyCommitted) {
        nothing = false;
      } else {
        const message = (values.commitMessage ?? '').trim() || 'chore: run-app session edits';
        const userEnv = await resolveGitEnv(ctx.db, { userId: ctx.userId, taskId: ctx.taskId });
        const commitEnv = Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY;
        nothing = !(await commitGitPreview(workspace, preview, message, commitEnv));
      }
    }
    const commitNote = values.commit
      ? nothing
        ? 'nothing to commit'
        : 'committed'
      : 'finished without committing';
    const pushTo = values.push && detected.hasOrigin ? detected.branch : null;
    if (values.push && detected.hasOrigin && !pushTo) {
      await warnStep(ctx, [
        `The push you asked for was not made: ${detected.branchError ?? "the checkout's current branch was not read"}.`,
      ]);
    }
    // With a push asked for, a Retry after a failed put-back finds its commit made and still pushes.
    if (nothing && !pushTo) {
      return {
        finished: true,
        committed: false,
        commitSha: null,
        pushed: false,
        message: commitNote,
      };
    }
    const shaRes = nothing ? null : await gitRun(workspace, ['rev-parse', 'HEAD']);
    const commitSha = committedPreviewSha ?? (shaRes?.code === 0 ? shaRes.stdout.trim() : null);

    // Optional best-effort push: existing commits are safe on the branch, so a
    // push failure must never block teardown. Uses the repo's bound credential.
    let pushed = false;
    let pushNote = '';
    if (pushTo) {
      // Not best effort: a put-back that fails fails the step, and its Retry finishes it.
      if (detected.baseBranch) {
        const target = detected.baseBranch;
        if (values.commit && detected.commitPreview)
          await assertGitPreviewBranch(workspace, detected.commitPreview, !nothing);
        await warnStep(
          ctx,
          await putBackProjections({ ctx, worktree: workspace, branch: pushTo, target }),
        );
      }
      try {
        const task = await ctx.db.query.tasks.findFirst({
          where: eq(schema.tasks.id, ctx.taskId),
          columns: { repositoryId: true },
        });
        const repo = task?.repositoryId
          ? await ctx.db.query.repositories.findFirst({
              where: eq(schema.repositories.id, task.repositoryId),
              columns: { credentialsSecretId: true, remoteUrl: true },
            })
          : null;
        if (values.commit && detected.commitPreview)
          await assertGitPreviewBranch(workspace, detected.commitPreview, !nothing);
        await pushBranch({
          cwd: workspace,
          branch: pushTo,
          setUpstream: true,
          credentialId: repo?.credentialsSecretId ?? undefined,
          remoteUrl: repo?.remoteUrl,
          db: ctx.db,
          userId: ctx.userId,
        });
        pushed = true;
      } catch (err) {
        pushNote = ` (push failed: ${err instanceof Error ? err.message : String(err)})`;
        ctx.logger.warn({ err, taskId: ctx.taskId }, 'run-app-ready: push failed');
      }
    }

    ctx.logger.info({ committed: !nothing, commitSha, pushed }, 'run-app session finished');
    return {
      finished: true,
      committed: !nothing,
      commitSha,
      pushed,
      message: `${commitNote}${pushed ? ' and pushed' : ''}${pushNote}`,
    };
  },
};
