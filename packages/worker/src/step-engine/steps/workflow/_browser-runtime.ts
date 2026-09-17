import { lstatNoFollow, readTextNoFollow } from '@haive/shared/fs-safe';
import { workspaceAnchor } from '../../../repo/worktree-paths.js';
import type { StepContext } from '../../step-definition.js';
import { getTaskEnvTemplate } from '../env-replicate/_shared.js';
import { loadAppBootOutput, resolveDdevWorkspace } from './_task-meta.js';
import { ddevUrlFromConfigText } from '../_ddev-config.js';
import { ddevPrimaryUrl, runnerHandleForTask } from '../../../sandbox/ddev-runner.js';

/** Per-task browser-test runtime resolved WITHOUT bringing anything up: whether
 *  browser testing is available, whether the app runs in the per-task DDEV runner
 *  or the non-DDEV app-runner, and its URL. Shared by 08a-browser-setup (which
 *  offers the method options) and 08a-browser-verify (which brings the browser up
 *  and tests). The bring-up + spec/changed-files live in 08a, not here. */
export interface BrowserRuntimeInfo {
  browserTesting: boolean;
  available: boolean;
  skipReason: string | null;
  /** App runs in the per-task DDEV runner (headless check runs inside it). */
  ddevMode: boolean;
  /** App runs in the per-task non-DDEV app-runner (also hosts the headed desktop). */
  appRunnerMode: boolean;
  appUrl: string | null;
  appBooted: boolean;
  /** env-replicate image tag, needed to (re)start the app-runner. */
  envImageTag: string | null;
  repoSubpath: string | null;
  /** DDEV worktree path (where `.ddev` lives), for collecting changed files; null
   *  on the non-DDEV path (08a falls back to ctx.workspacePath). */
  workspace: string | null;
}

/** The project's `.ddev/config.yaml`, split for the anchored walk. The workspace is a WORKTREE —
 *  under `.haive/`, which the sandbox mounts read-write — so it is never the anchor itself. Same
 *  split `01c-ddev-env`, `07c-ddev-reconcile` and `classifyRuntime` make for this same file. */
function ddevConfigRef(workspace: string): { anchor: string; rel: string } {
  const { anchor, prefix } = workspaceAnchor(workspace);
  return { anchor, rel: `${prefix}.ddev/config.yaml` };
}

export async function resolveBrowserRuntime(ctx: StepContext): Promise<BrowserRuntimeInfo> {
  const envTemplate = await getTaskEnvTemplate(ctx.db, ctx.taskId);
  const deps = (envTemplate?.declaredDeps as Record<string, unknown>) ?? {};
  const browserTesting = !!deps.browserTesting;
  const base: BrowserRuntimeInfo = {
    browserTesting,
    available: false,
    skipReason: null,
    ddevMode: false,
    appRunnerMode: false,
    appUrl: null,
    appBooted: false,
    envImageTag: null,
    repoSubpath: null,
    workspace: null,
  };

  if (!browserTesting) {
    return { ...base, skipReason: 'Browser testing not enabled in environment template' };
  }

  // DDEV path: the runner targets the worktree (where `.ddev` lives). Prefer the
  // live primary_url; else derive https://<name>.ddev.site from the booted config
  // so callers get a real URL, never the meaningless http://localhost.
  const ws = await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath);
  // The probe and the fallback read collapse into one: the config is only needed when there is no
  // live URL, and "no readable config" is the same answer the probe gave. A linked config no longer
  // selects the ddev branch, matching 01c, 07c and classifyRuntime.
  const cfgRef = ws ? ddevConfigRef(ws.workspace) : null;
  const configured = cfgRef
    ? (await lstatNoFollow(cfgRef.anchor, cfgRef.rel))?.kind === 'file'
    : false;
  if (ws && cfgRef && configured) {
    const liveUrl = await ddevPrimaryUrl(runnerHandleForTask(ctx.taskId, ws.repoSubpath));
    const cfgText = liveUrl ? null : await readTextNoFollow(cfgRef.anchor, cfgRef.rel);
    const url = liveUrl ?? (cfgText ? ddevUrlFromConfigText(cfgText) : null);
    return {
      browserTesting: true,
      available: true,
      skipReason: null,
      ddevMode: true,
      appRunnerMode: false,
      appUrl: url,
      appBooted: liveUrl !== null,
      envImageTag: null,
      repoSubpath: ws.repoSubpath,
      workspace: ws.workspace,
    };
  }

  // Legacy / non-DDEV path: rely on 01a-app-boot. A non-DDEV app may run in its
  // per-task app-runner container, which hosts the headed-browser desktop when the
  // env image was built with browser testing.
  const boot = await loadAppBootOutput(ctx.db, ctx.taskId);
  const appBooted = boot !== null && boot.booted && !boot.skipped;
  if (!appBooted) {
    return { ...base, skipReason: 'Application was not booted (app-boot step skipped or failed)' };
  }
  const appRunnerMode = boot?.containerized === true && !!boot.runtimeContainer;
  const appRunnerWs = appRunnerMode
    ? await resolveDdevWorkspace(ctx.db, ctx.taskId, ctx.repoPath)
    : null;
  return {
    browserTesting: true,
    available: true,
    skipReason: null,
    ddevMode: false,
    appRunnerMode,
    appUrl: boot?.appUrl ?? null,
    appBooted: true,
    envImageTag: appRunnerMode ? (envTemplate?.imageTag ?? null) : null,
    repoSubpath: appRunnerWs?.repoSubpath ?? null,
    workspace: appRunnerWs?.workspace ?? null,
  };
}
