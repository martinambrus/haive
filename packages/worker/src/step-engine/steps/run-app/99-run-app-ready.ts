import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import { CONFIG_KEYS, configService } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { ensureAppServing } from '../workflow/_app-runtime.js';
import { runnerExec, startBrowserDesktop } from '../../../sandbox/ddev-runner.js';
import {
  appRunnerExec,
  startBrowserDesktop as startAppBrowserDesktop,
} from '../../../sandbox/app-runner.js';
import { buildCommitDiffArtifact } from '../workflow/_commit-diff.js';
import { resolveUserGitEnv } from '../../../secrets/user-git-identity.js';
import { detectOrigin, gitRun, pushBranch } from '../../../repo/git-push.js';
import { gitWorkspaceStatus } from '../../../repo/git-workspace.js';

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
  /** Drives the in-app VNC panel (BrowserVncPanel); offered whenever a runtime is up. */
  liveBrowser: { available: boolean; appUrl: string | null } | null;
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
  dirtyFiles: number;
  diffArtifactPath: string | null;
  changedFileCount: number;
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
    try {
      const runtime = await ensureAppServing(ctx);
      mode = runtime.mode;
      appUrl = runtime.url;
      // Navigate the in-runner headed browser to the app so the VNC view opens ON
      // the running app instead of a blank browser (mirrors 08a/gate-2). VNC mode
      // only — own-browser mode skips the desktop entirely. Best-effort: a
      // navigation failure must not block the gate from rendering.
      if (viewMode === 'vnc' && runtime.mode === 'ddev') {
        await startBrowserDesktop(runtime.handle);
        await runnerExec(runtime.handle, `node /opt/browser-probe-connect.js '${appUrl}'`, {
          timeoutMs: 60_000,
        });
      } else if (viewMode === 'vnc' && runtime.mode === 'app-runner') {
        await startAppBrowserDesktop(runtime.handle);
        await appRunnerExec(
          runtime.handle,
          `node /opt/browser/browser-probe-connect.js '${appUrl}'`,
          { timeoutMs: 60_000 },
        );
      }
    } catch (err) {
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
    const worktreeOutput = prev?.output as { worktreePath?: string } | null;
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
    let dirtyFiles = 0;
    let diffArtifactPath: string | null = null;
    let changedFileCount = 0;
    if (hasGit) {
      const branchRes = await gitRun(workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      branch = branchRes.code === 0 ? branchRes.stdout.trim() : null;
      hasOrigin = await detectOrigin(workspacePath);
      const status = await gitRun(workspacePath, ['status', '--porcelain']);
      dirtyFiles = status.stdout.split('\n').filter((l) => l.trim().length > 0).length;
      if (dirtyFiles > 0) {
        // Never fail the gate on a diff-build error — the viewer is simply hidden.
        try {
          const res = await buildCommitDiffArtifact(workspacePath, gitRun);
          diffArtifactPath = res.artifactPath;
          changedFileCount = res.changedFileCount;
        } catch (err) {
          ctx.logger.warn({ err }, 'run-app-ready: failed to build commit diff artifact');
        }
      }
    }

    return {
      mode,
      appUrl,
      liveBrowser: viewMode === 'vnc' && mode !== 'none' ? { available: true, appUrl } : null,
      directAccess,
      dbAccess,
      workspacePath,
      hasGit,
      branch,
      hasOrigin,
      dirtyFiles,
      diffArtifactPath,
      changedFileCount,
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
    const fields: FormSchema['fields'] = [
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
    ];
    if (detected.hasOrigin) {
      fields.push({
        type: 'checkbox',
        id: 'push',
        label: `Push ${detected.branch ?? 'this branch'} to origin after committing`,
        default: false,
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

    if (!values.commit || !detected.hasGit) {
      return {
        finished: true,
        committed: false,
        commitSha: null,
        pushed: false,
        message: values.commit ? 'no git repo' : 'finished without committing',
      };
    }

    const workspace = detected.workspacePath;
    const add = await gitRun(workspace, ['add', '-A']);
    if (add.code !== 0) {
      throw new Error(`git add failed: ${add.stderr || add.stdout}`);
    }
    const message = (values.commitMessage ?? '').trim() || 'chore: run-app session edits';
    const userEnv = await resolveUserGitEnv(ctx.db, ctx.userId);
    const commitEnv = Object.keys(userEnv).length > 0 ? userEnv : FALLBACK_GIT_IDENTITY;
    const commit = await gitRun(workspace, ['commit', '-m', message], commitEnv);
    if (commit.code !== 0) {
      const stderr = commit.stderr || commit.stdout;
      if (/nothing to commit/i.test(stderr)) {
        return {
          finished: true,
          committed: false,
          commitSha: null,
          pushed: false,
          message: 'nothing to commit',
        };
      }
      throw new Error(`git commit failed: ${stderr}`);
    }
    const shaRes = await gitRun(workspace, ['rev-parse', 'HEAD']);
    const commitSha = shaRes.code === 0 ? shaRes.stdout.trim() : null;

    // Optional best-effort push: the commit is already safe on the branch, so a
    // push failure must never block teardown. Uses the repo's bound credential.
    let pushed = false;
    let pushNote = '';
    if (values.push && detected.hasOrigin && detected.branch) {
      try {
        const task = await ctx.db.query.tasks.findFirst({
          where: eq(schema.tasks.id, ctx.taskId),
          columns: { repositoryId: true },
        });
        const repo = task?.repositoryId
          ? await ctx.db.query.repositories.findFirst({
              where: eq(schema.repositories.id, task.repositoryId),
              columns: { credentialsSecretId: true },
            })
          : null;
        await pushBranch({
          cwd: workspace,
          branch: detected.branch,
          setUpstream: true,
          credentialId: repo?.credentialsSecretId ?? undefined,
          db: ctx.db,
          userId: ctx.userId,
        });
        pushed = true;
      } catch (err) {
        pushNote = ` (push failed: ${err instanceof Error ? err.message : String(err)})`;
        ctx.logger.warn({ err, taskId: ctx.taskId }, 'run-app-ready: push failed');
      }
    }

    ctx.logger.info({ commitSha, pushed }, 'run-app session committed');
    return {
      finished: true,
      committed: true,
      commitSha,
      pushed,
      message: `committed${pushed ? ' and pushed' : ''}${pushNote}`,
    };
  },
};
