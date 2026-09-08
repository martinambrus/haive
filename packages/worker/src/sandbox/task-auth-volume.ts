import { SANDBOX_CORE_IMAGE } from './image-composer.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CLI_PROVIDER_LIST,
  cliAuthTaskVolumeName,
  getCliProviderMetadata,
  logger,
  resolveCliAuthUserVolumeName,
} from '@haive/shared';
import type { AuthMode, CliProviderName } from '@haive/shared';
import { defaultDockerRunner, type DockerRunner, type DockerVolumeMount } from './docker-runner.js';
import { expandTildeToSandbox } from './cli-auth-volume.js';
import { buildMcpAddArgv, type McpServerSpec } from './mcp-config.js';
import { SANDBOX_GID, SANDBOX_UID } from './sandbox-identity.js';
import { ensureSandboxCoreImage } from './sandbox-core-image.js';
import { SANDBOX_USER, SANDBOX_USER_HOME } from './sandbox-runner.js';
import { CLI_CREDENTIAL_FILES } from '../usage-window/credential-files.js';
import { readVolumeFile } from '../usage-window/token-source.js';

export interface ProviderAuthCtx {
  userId: string;
  providerId: string;
  providerName: CliProviderName;
  authMode: AuthMode;
  isolateAuth: boolean;
}

function userVolumeForCtx(ctx: ProviderAuthCtx, idx: number): string {
  return resolveCliAuthUserVolumeName(ctx, idx);
}

/** The `rtk init -g` arguments for one provider, or `undefined` when rtk has no mode for it
 *  (amp is not in rtk's agent list, so the project-level RTK.md + AGENTS.md @-ref written by
 *  step 07 is its only integration).
 *
 *  Whole argument lists rather than one mode flag, because `--auto-patch` is NOT universal
 *  and pretending it was is what broke this. MEASURED against rtk 0.37.2 in the sandbox
 *  image, each combination run against a scratch HOME:
 *
 *    `-g --auto-patch`            exit 0  writes ~/.claude/{RTK.md,settings.json,CLAUDE.md}
 *    `-g --auto-patch --gemini`   exit 0  writes ~/.gemini/{GEMINI.md,hooks/,settings.json}
 *    `-g --gemini`                exit 0  but PROMPTS for the settings.json patch, and the
 *                                        helper has no tty, so the hook is never registered
 *    `-g --auto-patch --codex`    exit 1  "--codex cannot be combined with --auto-patch"
 *    `-g --codex`                 exit 0  writes ~/.codex/{RTK.md,AGENTS.md}
 *
 *  `--auto-patch` patches Claude Code's settings.json, and `--codex` is documented as "no
 *  Claude hook patching", so rtk rejects the pair outright — codex had been asking for both
 *  since this was written and rtk never ran for it. It is REQUIRED for the other two, which
 *  otherwise stop at an interactive prompt nothing can answer.
 *
 *  `ollama` sits with the claude family because it IS the claude binary pointed at another
 *  endpoint (see AGENTS.md) and its authConfigPaths are `~/.claude`, the same mount rtk
 *  writes into for the rest of them. It was the one family member missing here, so it had
 *  been silently skipped. `grok` and `antigravity` stay out: rtk has an `--agent antigravity`
 *  mode, but where it writes has not been measured against antigravity's own
 *  `~/.gemini/antigravity-cli` mount, and a guess here writes into a live auth volume. */
function rtkInitArgsFor(providerName: CliProviderName): string[] | undefined {
  switch (providerName) {
    case 'claude-code':
    case 'zai':
    case 'ollama':
    case 'muse':
    case 'openrouter':
      return ['--auto-patch'];
    case 'gemini':
      return ['--gemini', '--auto-patch'];
    case 'codex':
      return ['--codex'];
    case 'amp':
      return undefined;
    default:
      return undefined;
  }
}

const log = logger.child({ module: 'task-auth-volume' });

const HELPER_IMAGE = process.env.SANDBOX_IMAGE ?? SANDBOX_CORE_IMAGE;
const READY_MARKER = '.haive-ready';
const HELPER_TIMEOUT_MS = 60_000;
const VOLUME_READY_POLL_MS = 1_500;
// A concurrent sibling agent's populate helper finishes well within this; bounded so a
// genuinely-stale volume still gets recreated promptly.
const VOLUME_READY_MAX_WAIT_MS = 30_000;
const VOLUME_REMOVE_RETRIES = 5;

/**
 * Fan-out agents share one writable auth volume per (task, CLI). Coalesce the
 * preparation writes inside this worker process: without this, twelve sibling
 * invocations can simultaneously create/copy the volume and run RTK / MCP
 * writers as root while another sibling is already starting the CLI. The
 * measured result was an intermittently root-owned config.toml and four
 * `Permission denied` terminals in one plan wave.
 *
 * Separate maps keep the phases ordered by their callers while coalescing each
 * identical phase. This applies to provider metadata, never a particular CLI's
 * file layout.
 */
const ensureVolumeRuns = new Map<string, Promise<void>>();
const rtkSeedRuns = new Map<string, Promise<void>>();
const cliMcpMergeRuns = new Map<string, Promise<void>>();
const geminiMcpMergeRuns = new Map<string, Promise<void>>();
const mcpFileWriteRuns = new Map<string, Promise<void>>();

function coalesceAuthPreparation(
  runs: Map<string, Promise<void>>,
  key: string,
  work: () => Promise<void>,
): Promise<void> {
  const existing = runs.get(key);
  if (existing) return existing;
  let tracked: Promise<void>;
  tracked = work().finally(() => {
    if (runs.get(key) === tracked) runs.delete(key);
  });
  runs.set(key, tracked);
  return tracked;
}

/**
 * What each preparation slot has already been APPLIED with: `scope` (task + provider +
 * phase) -> the identity of the last preparation that SUCCEEDED there.
 *
 * Coalescing alone dedupes only CONCURRENT calls — the map entry is dropped when the
 * promise settles — and a fan-out dispatches its agents seconds apart, so each sibling
 * re-ran an identical root helper against a volume its predecessors were already reading.
 * MEASURED on a 7-agent discovery fan-out: 6 rtk seeds and 6 MCP merges, one of which
 * overlapped an agent's codex boot and killed it with `config.toml: Permission denied`.
 *
 * LAST-applied, not ever-seen: {@link mergeCliMcpIntoTaskVolume} RECONCILES (it removes
 * every server named in the marker and re-adds the current set), so a surface that goes
 * 4 -> 2 -> 4 must run all three times. An ever-seen cache would skip the third and leave
 * the volume holding the wrong set.
 *
 * In-process, like the coalescing above and for the same reason: one worker owns a task
 * (compose pins `container_name`, no replicas, and usage-poll/pr-poll already depend on
 * it). A restart empties this and costs one extra helper run — the safe direction.
 * Cleared per task by {@link clearTaskAuthPreparationState}.
 */
const appliedAuthPreparations = new Map<string, string>();

/** Coalesce like {@link coalesceAuthPreparation}, and additionally SKIP a preparation whose
 *  exact identity is the one already applied to that slot. `work` reports whether it
 *  actually applied: a best-effort helper that logged and returned changed nothing, so the
 *  slot is forgotten rather than recorded and the next caller tries again. */
async function applyAuthPreparationOnce(
  runs: Map<string, Promise<void>>,
  scope: string,
  key: string,
  work: () => Promise<boolean>,
): Promise<void> {
  if (appliedAuthPreparations.get(scope) === key) return;
  await coalesceAuthPreparation(runs, `${scope}|${key}`, async () => {
    if (await work()) appliedAuthPreparations.set(scope, key);
    else appliedAuthPreparations.delete(scope);
  });
}

/** Forget every applied-preparation slot for one task. Called from the task-end funnel that
 *  destroys the volumes themselves — the slots describe volumes that no longer exist. */
export function clearTaskAuthPreparationState(taskId: string): void {
  const prefix = `${taskId}|`;
  for (const scope of appliedAuthPreparations.keys()) {
    if (scope.startsWith(prefix)) appliedAuthPreparations.delete(scope);
  }
}

/** Defines `$AS_NODE`, the privilege-drop prefix {@link asSandboxUser} expands to.
 *
 *  The helpers need root only to REPAIR a volume left root-owned by an older task, and they
 *  used to do the whole job as root and chown back at the end — which leaves every file they
 *  touch root-owned for as long as the payload runs. That is seconds for `rtk init` or a
 *  string of `mcp add` calls, and a sibling agent booting in that window reads a config file
 *  it cannot open. Repair first, drop privileges for the payload, keep the trailing chown as
 *  a safety net.
 *
 *  Empty when `runuser` is absent, which restores the previous all-as-root behaviour exactly.
 *  It ships with util-linux and is present in the sandbox image and everything composed from
 *  it, but the merge helper runs in the TASK's image, which an operator can pin to anything —
 *  and a merge that fails there costs the run its MCP servers. */
const SANDBOX_USER_PREFIX_INIT = `if command -v runuser >/dev/null 2>&1; then AS_NODE="runuser -u ${SANDBOX_USER} --"; else AS_NODE=""; fi`;

/** Run one command of a root helper's payload as the sandbox user. Unquoted on purpose:
 *  `$AS_NODE` must word-split into argv, and is empty when the fallback above applies. */
function asSandboxUser(command: string): string {
  return `$AS_NODE ${command}`;
}

/** Repair pass for a volume an older task may have left root-owned; harmless otherwise. */
function repairOwnership(path: string): string {
  return `chown -R ${SANDBOX_UID}:${SANDBOX_GID} ${shellQuote(path)} 2>/dev/null || true`;
}

function contentKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/** Distinct exit code from the rtk seed helper script when the sandbox image
 *  has no rtk binary on PATH. Exported so tests can assert on the boundary. */
export const RTK_HELPER_MISSING_BINARY_EXIT = 2;

/** Distinct exit code for `rtk init` itself failing. The helper used to swallow it
 *  (`rtk init … || echo "rtk init exit=$?" >&2`) and then exit on the trailing chown, so a
 *  seed that did nothing was logged as "rtk seeded in task auth volume" — which is how a
 *  flag combination rtk rejects outright survived unnoticed. Exported for the test. */
export const RTK_HELPER_INIT_FAILED_EXIT = 3;

// Worker bind-mounts user HOME read-only at /host-fs. HOST_REPO_ROOT_REAL is
// the same directory as seen by the docker daemon (i.e. the absolute host path)
// — required when emitting bind mounts back out to per-task sandbox containers.
const HOST_FS_ROOT = process.env.HOST_REPO_ROOT ?? '/host-fs';
const HOST_REAL_ROOT = process.env.HOST_REPO_ROOT_REAL ?? process.env.HOME ?? '/';

function hostRelativeOfTilde(p: string): string | null {
  if (p === '~') return '';
  if (p.startsWith('~/')) return p.slice(2);
  return null;
}

export function ensureTaskAuthVolumes(
  ctx: ProviderAuthCtx,
  taskId: string,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  return coalesceAuthPreparation(ensureVolumeRuns, `${taskId}:${ctx.providerName}`, () =>
    ensureTaskAuthVolumesUnlocked(ctx, taskId, runner),
  );
}

async function ensureTaskAuthVolumesUnlocked(
  ctx: ProviderAuthCtx,
  taskId: string,
  runner: DockerRunner,
): Promise<void> {
  // Before isTaskVolumeReady, not just before the copy helper: that probe reports
  // readiness as `exitCode === 0` of a container run on HELPER_IMAGE, so a pruned base
  // reads as "not ready" and the branch below DELETES an already-populated auth volume
  // before anything fails. Losing credentials to a missing image is not a fair trade.
  await ensureSandboxCoreImage(HELPER_IMAGE, runner);

  const meta = getCliProviderMetadata(ctx.providerName);
  for (let idx = 0; idx < meta.authConfigPaths.length; idx += 1) {
    const userVol = userVolumeForCtx(ctx, idx);
    const taskVol = cliAuthTaskVolumeName(taskId, ctx.providerName, idx);

    if (await runner.volumeExists(taskVol)) {
      if (await isTaskVolumeReady(taskVol, runner)) {
        continue;
      }
      log.warn({ taskVol }, 'task auth volume exists but not ready, recreating');
      let removed = await runner.volumeRemove(taskVol);
      if (!removed.ok && /in use/i.test(removed.stderr)) {
        // In use → a CONCURRENT sibling agent (08c fans out 2 agents that share this
        // per-task volume) is mid-setup with the volume mounted by its populate helper,
        // which is what produced the EXIT -1. Wait for it to make the volume ready and
        // reuse it; only if it stays unready do we retry the remove (the sibling's
        // helper has exited by then) and recreate.
        if (await waitForTaskVolumeReady(taskVol, runner)) {
          continue;
        }
        removed = await removeVolumeWithRetry(taskVol, runner);
      }
      if (!removed.ok) {
        throw new Error(
          `Failed to remove stale task auth volume ${taskVol}: ${removed.stderr || 'unknown error'}`,
        );
      }
    }

    const created = await runner.volumeCreate(taskVol);
    if (!created.ok) {
      throw new Error(
        `Failed to create task auth volume ${taskVol}: ${created.stderr || 'unknown error'}`,
      );
    }

    const userHasData = await runner.volumeExists(userVol);
    const mounts: DockerVolumeMount[] = [{ source: taskVol, target: '/dst', readOnly: false }];
    if (userHasData) {
      mounts.push({ source: userVol, target: '/src', readOnly: true });
    }

    // Docker creates the named-volume mountpoint owned by root. The CLI sandbox
    // runs as node (uid 1000), so we must chown the volume root (and any copied
    // contents) to 1000:1000 before the CLI can write into the mount.
    const copyScript = userHasData
      ? `cp -a /src/. /dst/ 2>/dev/null || true; chown -R 1000:1000 /dst; touch /dst/${READY_MARKER}`
      : `chown 1000:1000 /dst; touch /dst/${READY_MARKER}`;

    const result = await runner.run({
      image: HELPER_IMAGE,
      cmd: ['bash', '-c', copyScript],
      mounts,
      entrypoint: '',
      user: 'root',
      timeoutMs: HELPER_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      log.warn(
        { taskVol, userVol, exitCode: result.exitCode, stderr: result.stderr.slice(-500) },
        'task auth volume copy helper exited non-zero',
      );
      throw new Error(
        `Task auth volume copy failed for ${taskVol} (exit ${result.exitCode ?? 'unknown'})`,
      );
    }

    log.info({ taskVol, userVol, userHasData }, 'task auth volume ready');
  }
}

/** Poll until the volume is ready or the wait elapses. A concurrent sibling agent
 *  (08c fan-out shares this per-task volume) may be mid-setup; wait for it rather than
 *  racing a remove against its mounted populate helper. */
async function waitForTaskVolumeReady(taskVol: string, runner: DockerRunner): Promise<boolean> {
  const deadline = Date.now() + VOLUME_READY_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, VOLUME_READY_POLL_MS));
    if (await isTaskVolumeReady(taskVol, runner)) return true;
  }
  return false;
}

/** Remove a volume, retrying on a transient "volume is in use" (a sibling's populate
 *  helper exiting). Returns the last attempt's result. */
async function removeVolumeWithRetry(
  taskVol: string,
  runner: DockerRunner,
): Promise<{ ok: boolean; stderr: string }> {
  let last = await runner.volumeRemove(taskVol);
  for (
    let attempt = 0;
    !last.ok && /in use/i.test(last.stderr) && attempt < VOLUME_REMOVE_RETRIES;
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, VOLUME_READY_POLL_MS));
    last = await runner.volumeRemove(taskVol);
  }
  return last;
}

async function isTaskVolumeReady(taskVol: string, runner: DockerRunner): Promise<boolean> {
  // Verify both the readiness marker AND that the volume root is owned by the
  // sandbox user (1000). Early versions of ensureTaskAuthVolumes left the mount
  // root owned by root, which the CLI cannot write to. Treating those as stale
  // forces a recreate on first use.
  const result = await runner.run({
    image: HELPER_IMAGE,
    cmd: ['sh', '-c', `test -f /x/${READY_MARKER} && [ "$(stat -c %u /x)" = "1000" ]`],
    mounts: [{ source: taskVol, target: '/x', readOnly: true }],
    entrypoint: '',
    user: 'root',
    timeoutMs: 15_000,
  });
  return result.exitCode === 0;
}

/** True when at least one of the provider's per-path user auth volumes exists.
 *  Branches on `ctx.isolateAuth`: isolated providers check their per-provider
 *  volume namespace, shared providers check the legacy per-user namespace. */
export async function userAuthVolumeExists(
  ctx: ProviderAuthCtx,
  runner: DockerRunner = defaultDockerRunner,
): Promise<boolean> {
  const meta = getCliProviderMetadata(ctx.providerName);
  for (let idx = 0; idx < meta.authConfigPaths.length; idx += 1) {
    const userVol = userVolumeForCtx(ctx, idx);
    if (await runner.volumeExists(userVol)) return true;
  }
  return false;
}

export function resolveTaskAuthMounts(
  providerName: CliProviderName,
  taskId: string,
): DockerVolumeMount[] {
  const meta = getCliProviderMetadata(providerName);
  return meta.authConfigPaths.map((raw, idx) => ({
    source: cliAuthTaskVolumeName(taskId, providerName, idx),
    target: expandTildeToSandbox(raw),
    readOnly: false,
    kind: 'auth' as const,
  }));
}

/**
 * Build per-CLI bind mounts for user-level skills dirs, with a host-side
 * fallback chain. For each `userSkillsPaths` entry the canonical host path is
 * checked first; if absent and a `fallbackHost` is configured (e.g. codex
 * falling back to `~/.claude/skills`), the fallback is bound at the same
 * container path. Missing on both = no mount emitted, which is correct — the
 * container simply has no pre-existing user skills and onboarding will seed
 * the repo-level dir.
 *
 * Read-only is enforced: the task sandbox must never write back into the
 * user's host skills directory.
 */
export function resolveTaskSkillMounts(providerName: CliProviderName): DockerVolumeMount[] {
  const meta = getCliProviderMetadata(providerName);
  const mounts: DockerVolumeMount[] = [];
  for (const spec of meta.userSkillsPaths) {
    const primaryRel = hostRelativeOfTilde(spec.host);
    if (primaryRel !== null && existsSync(pathJoin(HOST_FS_ROOT, primaryRel))) {
      mounts.push({
        source: pathJoin(HOST_REAL_ROOT, primaryRel),
        target: spec.containerPath,
        readOnly: true,
      });
      continue;
    }
    if (!spec.fallbackHost) continue;
    const fallbackRel = hostRelativeOfTilde(spec.fallbackHost);
    if (fallbackRel !== null && existsSync(pathJoin(HOST_FS_ROOT, fallbackRel))) {
      mounts.push({
        source: pathJoin(HOST_REAL_ROOT, fallbackRel),
        target: spec.containerPath,
        readOnly: true,
      });
    }
  }
  return mounts;
}

/**
 * Inject RTK hook configs into the per-task auth volume(s) for `providerName`.
 * Uses the rtk binary baked into the sandbox image; calls
 * `rtk init -g --auto-patch [--gemini|--codex]` so rtk's own merge logic
 * handles idempotency, JSON deep-merge into a pre-existing settings.json
 * (claude-code creates one with theme/onboarding state on first login), and
 * the CLAUDE.md / AGENTS.md `@RTK.md` reference injection.
 *
 * No-op when the provider has no rtk-supported flag (amp); callers should
 * additionally skip this entirely when `repositories.rtk_enabled=false`.
 *
 * Idempotent on re-run: rtk's `hook_already_present` check elides duplicate
 * insertions. Failures are logged but do not throw — rtk seeding is a
 * best-effort layer over the auth-restore path.
 */
export function seedRtkInTaskVolume(
  taskId: string,
  providerName: CliProviderName,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  // The seed writes the same thing every time for a given provider, so its identity is the
  // slot itself: applied once per task, not once per invocation.
  return applyAuthPreparationOnce(rtkSeedRuns, `${taskId}|rtk|${providerName}`, 'seeded', () =>
    seedRtkInTaskVolumeUnlocked(taskId, providerName, runner),
  );
}

async function seedRtkInTaskVolumeUnlocked(
  taskId: string,
  providerName: CliProviderName,
  runner: DockerRunner,
): Promise<boolean> {
  const initArgs = rtkInitArgsFor(providerName);
  if (initArgs === undefined) {
    log.debug({ providerName }, 'rtk seed skipped: provider has no rtk-native mode');
    // Nothing to do for this provider, ever — record it so siblings do not re-derive it.
    return true;
  }
  const meta = getCliProviderMetadata(providerName);
  if (meta.authConfigPaths.length === 0) {
    log.debug({ providerName }, 'rtk seed skipped: provider has no auth config paths');
    return true;
  }

  const mounts: DockerVolumeMount[] = meta.authConfigPaths.map((raw, idx) => ({
    source: cliAuthTaskVolumeName(taskId, providerName, idx),
    target: expandTildeToSandbox(raw),
    readOnly: false,
  }));

  // The container is root so it can repair a volume an older task left root-owned, but the
  // seed itself runs as the sandbox user — `rtk init` takes seconds and a sibling agent
  // booting against root-owned config in that window dies on it (see asSandboxUser).
  //
  // Both failure modes exit with their own code so the worker can tell them apart from
  // success, which is the whole point: the missing-binary one (that mistake hid stale
  // per-CLI sandbox images during rtk integration testing) and rtk init's own. The chown
  // still runs in between — a seed that failed halfway must not leave root-owned files
  // behind — so the status is carried in a variable rather than exiting on the spot.
  const initCommand = `rtk init -g ${initArgs.map(shellQuote).join(' ')}`;
  const script =
    `${SANDBOX_USER_PREFIX_INIT}; ` +
    `${repairOwnership(SANDBOX_USER_HOME)}; ` +
    `command -v rtk >/dev/null 2>&1 || { echo "rtk: binary missing in sandbox image" >&2; exit ${RTK_HELPER_MISSING_BINARY_EXIT}; }; ` +
    // `rtk_code=$?` must be the FIRST statement of the else branch: `$?` there is rtk's own
    // status, and any command in front of it — an assignment included — overwrites it with 0.
    `if ${asSandboxUser(`env HOME=${shellQuote(SANDBOX_USER_HOME)} ${initCommand}`)}; then rtk_failed=0; else rtk_code=$?; rtk_failed=1; echo "rtk init exit=$rtk_code" >&2; fi; ` +
    `${repairOwnership(SANDBOX_USER_HOME)}; ` +
    `[ "$rtk_failed" = 0 ] || exit ${RTK_HELPER_INIT_FAILED_EXIT}; ` +
    `exit 0`;

  const result = await runner.run({
    image: HELPER_IMAGE,
    cmd: ['sh', '-c', script],
    mounts,
    entrypoint: '',
    user: 'root',
    timeoutMs: HELPER_TIMEOUT_MS,
  });
  if (result.exitCode === RTK_HELPER_MISSING_BINARY_EXIT) {
    log.warn(
      { taskId, providerName },
      'rtk seed skipped: rtk binary missing in sandbox image — rebuild via pnpm sandbox:build and recompose per-CLI images',
    );
    // A missing binary will not appear mid-task; record it so the warning is logged once
    // rather than once per invocation of the fan-out.
    return true;
  }
  if (result.exitCode === RTK_HELPER_INIT_FAILED_EXIT) {
    log.warn(
      { taskId, providerName, args: initArgs, stderr: result.stderr.slice(-500) },
      'rtk init failed — this CLI runs without rtk for the rest of the task',
    );
    // A rejected flag combination or a broken rtk will not repair itself mid-task, so record
    // it: one warning per task rather than one per invocation of a fan-out.
    return true;
  }
  if (result.exitCode !== 0) {
    log.warn(
      { taskId, providerName, exitCode: result.exitCode, stderr: result.stderr.slice(-500) },
      'rtk seed helper exited non-zero',
    );
    return false;
  }
  log.info({ taskId, providerName, args: initArgs }, 'rtk seeded in task auth volume');
  return true;
}

/** Merge `mcpServers` into the gemini task auth volume's settings.json
 *  (path index 1 == ~/.gemini). Gemini reads MCP server config from the SAME
 *  file that holds `selectedAuthType`, so writing the MCP config as an
 *  extraFile bind-mount overlays — and obscures — the auth-volume's
 *  settings.json, leaving the CLI without an auth method. Doing the merge
 *  on-volume preserves the auth fields and any other keys (rtk hooks,
 *  folderTrust, etc) that earlier seed steps wrote.
 *
 *  No-op when servers is empty. Best-effort: failures are logged and the
 *  spawn proceeds — the user sees the MCP-related error from the CLI rather
 *  than a hard worker failure. */
export function mergeGeminiMcpIntoSettings(
  taskId: string,
  mcpServers: Record<string, unknown>,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  const content = JSON.stringify(mcpServers);
  return applyAuthPreparationOnce(
    geminiMcpMergeRuns,
    `${taskId}|gemini-mcp`,
    contentKey(content),
    () => mergeGeminiMcpIntoSettingsUnlocked(taskId, mcpServers, content, runner),
  );
}

async function mergeGeminiMcpIntoSettingsUnlocked(
  taskId: string,
  mcpServers: Record<string, unknown>,
  mcpJson: string,
  runner: DockerRunner,
): Promise<boolean> {
  if (Object.keys(mcpServers).length === 0) return true;
  const meta = getCliProviderMetadata('gemini');
  // Index 1 is `~/.gemini` per shared catalog; skip if absent for some
  // reason (would mean the catalog drifted).
  if (meta.authConfigPaths.length < 2) return true;
  const taskVol = cliAuthTaskVolumeName(taskId, 'gemini', 1);
  // Not applied — the volume may exist by the time the next invocation asks.
  if (!(await runner.volumeExists(taskVol))) return false;

  // Embed the MCP servers JSON via a heredoc so any prompt-style content
  // can't accidentally inject shell. node is in the sandbox image and gives
  // us atomic JSON merge with parse-error tolerance. The merge itself runs as the
  // sandbox user (see asSandboxUser) so settings.json is never momentarily root-owned
  // under a sibling agent that is reading it.
  const script = `
set -e
${SANDBOX_USER_PREFIX_INIT}
mkdir -p /vol
${repairOwnership('/vol')}
cd /vol
${asSandboxUser('node')} -e '
const fs = require("fs");
const path = "/vol/settings.json";
let cur = {};
if (fs.existsSync(path)) {
  try { cur = JSON.parse(fs.readFileSync(path, "utf8")) || {}; }
  catch (err) { console.error("settings.json parse failed, replacing:", err.message); cur = {}; }
}
const incoming = ${JSON.stringify(mcpJson)};
const servers = JSON.parse(incoming);
cur.mcpServers = { ...(cur.mcpServers || {}), ...servers };
fs.writeFileSync(path, JSON.stringify(cur, null, 2));
'
chown 1000:1000 /vol/settings.json
`;

  const result = await runner.run({
    image: HELPER_IMAGE,
    cmd: ['sh', '-c', script],
    mounts: [{ source: taskVol, target: '/vol', readOnly: false }],
    entrypoint: '',
    user: 'root',
    timeoutMs: HELPER_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    log.warn(
      { taskId, exitCode: result.exitCode, stderr: result.stderr.slice(-500) },
      'gemini mcp merge helper exited non-zero',
    );
    return false;
  }
  log.info(
    { taskId, count: Object.keys(mcpServers).length },
    'merged mcpServers into gemini settings.json',
  );
  return true;
}

/** Names Haive wrote into the CLI's own MCP config last time, one per line. Lives in the
 *  per-task auth volume, so it dies with the task. */
const MCP_MANAGED_MARKER = '.haive-mcp-managed';

/** Shell-quote a value for the `sh -c` scripts the helper containers run. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Write Haive's MCP servers into the task auth volume using the CLI's OWN `mcp add`.
 *
 * grok and codex keep MCP servers in the same file as everything else they know —
 * `~/.grok/config.toml` also holds `[[marketplace.sources]]` and `[plugins]`, `~/.codex/config.toml`
 * holds user settings — and that file sits INSIDE the auth-volume mount. Bind-mounting an
 * MCP-only body over it does two silent kinds of damage. Docker materialises the missing mount
 * target inside the volume as a ROOT-owned stub that outlives the container, so the next
 * invocation that writes config as uid 1000 dies with `Permission denied (os error 13)` — that is
 * exactly how `01b-install-plugins` failed on grok. And for as long as the bind is in place it
 * HIDES the plugin registration, so the LSP plugins the step installed never load.
 *
 * Letting each CLI write its own config also keeps Haive out of the business of merging someone
 * else's TOML, which would drift the moment either format changes.
 *
 * Reconciles rather than only adding: the MCP surface varies per invocation (a rag-only mining
 * run, a step with no browser), and a server left behind points at a proxy script that is no
 * longer bind-mounted. Everything named in the marker is removed first and the current set
 * re-added — `mcp add` is add-or-update, so a survivor costs one redundant write and no
 * membership test.
 *
 * Repairs ownership as root, then runs the CLI's own `mcp` calls as the sandbox user and chowns
 * again as a safety net: same shape as {@link seedRtkInTaskVolume}, and the repair pass is what
 * fixes a root-owned stub left in the volume by a task that started before this existed.
 *
 * Best-effort by contract, like {@link mergeGeminiMcpIntoSettings}: every failure is logged and
 * swallowed. A missing MCP server degrades a run; throwing here would kill it.
 */
export function mergeCliMcpIntoTaskVolume(
  taskId: string,
  providerName: CliProviderName,
  image: string | null,
  servers: McpServerSpec[],
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  // The surface is the same for siblings of one fan-out. Include it in the key
  // so only byte-equivalent preparations coalesce or skip; a genuinely different
  // surface still runs its own reconciliation.
  const surfaceKey = contentKey(JSON.stringify({ image, servers }));
  return applyAuthPreparationOnce(
    cliMcpMergeRuns,
    `${taskId}|cli-mcp|${providerName}`,
    surfaceKey,
    () => mergeCliMcpIntoTaskVolumeUnlocked(taskId, providerName, image, servers, runner),
  );
}

async function mergeCliMcpIntoTaskVolumeUnlocked(
  taskId: string,
  providerName: CliProviderName,
  image: string | null,
  servers: McpServerSpec[],
  runner: DockerRunner,
): Promise<boolean> {
  const meta = getCliProviderMetadata(providerName);
  // Index 0 is the CLI's own home dir for both cli-merge providers (`~/.grok`, `~/.codex`).
  const authPath = meta.authConfigPaths[0];
  if (!authPath) return true;
  if (!image) {
    log.warn(
      { taskId, providerName },
      'mcp merge skipped: no sandbox image resolved, so the CLI binary is unreachable',
    );
    // Not applied: the image is resolved per invocation and a later one may have it.
    return false;
  }
  const taskVol = cliAuthTaskVolumeName(taskId, providerName, 0);
  // ensureTaskAuthVolumes (via resolveAuthMounts) is what creates this, and it must have run
  // first — creating the volume here would leave it without the readiness marker, so that call
  // would then RECREATE it and discard the servers just written. Warn rather than return quietly:
  // the symptom of a reversed call order is an agent with no MCP tools and nothing in the log.
  if (!(await runner.volumeExists(taskVol))) {
    log.warn(
      { taskId, providerName, taskVol },
      'mcp merge skipped: task auth volume does not exist yet — resolveAuthMounts must run first',
    );
    return false;
  }

  const home = expandTildeToSandbox(authPath);
  const marker = `${home}/${MCP_MANAGED_MARKER}`;
  const exec = shellQuote(meta.defaultExecutable);
  const quotedMarker = shellQuote(marker);
  // Every CLI call runs as the sandbox user with its own HOME, so the config file it writes
  // is owned by the uid that has to read it — a sibling agent booting mid-merge sees a file
  // it can open. Only the repair and the marker write need root.
  const runCli = asSandboxUser(`env HOME=${shellQuote(SANDBOX_USER_HOME)} ${exec}`);

  const script = [
    'set -u',
    SANDBOX_USER_PREFIX_INIT,
    repairOwnership(home),
    // `mcp remove <name>` is the same on grok and codex (measured against 1.0.3 / 0.147.0);
    // only `mcp add` differs, which is why that one goes through buildMcpAddArgv.
    `if [ -f ${quotedMarker} ]; then`,
    '  while IFS= read -r name; do',
    '    [ -n "$name" ] || continue',
    // `</dev/null` is load-bearing: the loop's stdin IS the marker file, and a CLI that reads
    // stdin would swallow the remaining names and silently skip their removal.
    `    ${runCli} mcp remove "$name" </dev/null >/dev/null 2>&1 || true`,
    `  done < ${quotedMarker}`,
    'fi',
    ...servers.map((server) => {
      const argv = buildMcpAddArgv(providerName, server).map(shellQuote).join(' ');
      const failure = shellQuote(`haive-mcp: add ${server.name} failed`);
      return `${runCli} ${argv} >/dev/null || echo ${failure} >&2`;
    }),
    // Written by the root shell (the redirection is the shell's, not the CLI's) and owned
    // back by the trailing repair. Nothing but this module reads it, so the sub-second
    // window in which it is root-owned reaches no CLI.
    servers.length > 0
      ? `printf '%s\\n' ${servers.map((s) => shellQuote(s.name)).join(' ')} > ${quotedMarker}`
      : `: > ${quotedMarker}`,
    repairOwnership(home),
  ].join('\n');

  const result = await runner.run({
    image,
    cmd: ['sh', '-c', script],
    mounts: [{ source: taskVol, target: home, readOnly: false }],
    entrypoint: '',
    user: 'root',
    timeoutMs: HELPER_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    log.warn(
      { taskId, providerName, exitCode: result.exitCode, stderr: result.stderr.slice(-500) },
      'mcp merge helper exited non-zero',
    );
    return false;
  }
  log.info({ taskId, providerName, count: servers.length }, 'merged mcp servers into CLI config');
  return true;
}

/**
 * Write a whole MCP config file INTO the task auth volume.
 *
 * For a CLI whose MCP file holds nothing else (antigravity's `mcp_config.json`) there is no merge
 * to do — but the path still sits inside the auth-volume mount, so it must not be bind-mounted
 * over. See {@link mergeCliMcpIntoTaskVolume} for what a nested bind costs.
 *
 * Best-effort, same contract as the merges above.
 */
export function writeMcpFileIntoTaskVolume(
  taskId: string,
  providerName: CliProviderName,
  containerPath: string,
  content: string,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  return applyAuthPreparationOnce(
    mcpFileWriteRuns,
    `${taskId}|mcp-file|${providerName}|${containerPath}`,
    contentKey(content),
    () => writeMcpFileIntoTaskVolumeUnlocked(taskId, providerName, containerPath, content, runner),
  );
}

async function writeMcpFileIntoTaskVolumeUnlocked(
  taskId: string,
  providerName: CliProviderName,
  containerPath: string,
  content: string,
  runner: DockerRunner,
): Promise<boolean> {
  const meta = getCliProviderMetadata(providerName);
  const authPath = meta.authConfigPaths[0];
  if (!authPath) return true;
  const home = expandTildeToSandbox(authPath);
  if (!containerPath.startsWith(`${home}/`)) {
    log.warn(
      { taskId, providerName, containerPath, home },
      'mcp file write skipped: path is not inside the auth volume mount',
    );
    return true;
  }
  const taskVol = cliAuthTaskVolumeName(taskId, providerName, 0);
  if (!(await runner.volumeExists(taskVol))) return false;

  const relDir = containerPath.slice(0, containerPath.lastIndexOf('/'));
  // No privilege drop here, unlike the two merges: this payload is one `printf` and the
  // file is root-owned for the microseconds before the chown, where `rtk init` and a string
  // of `mcp add` calls hold it for seconds. The leading repair still runs, because a volume
  // an older task left root-owned would otherwise fail the write itself.
  const script = [
    'set -e',
    `mkdir -p ${shellQuote(relDir)}`,
    repairOwnership(home),
    `printf '%s' ${shellQuote(content)} > ${shellQuote(containerPath)}`,
    `chown -R ${SANDBOX_UID}:${SANDBOX_GID} ${shellQuote(home)}`,
  ].join('\n');

  const result = await runner.run({
    image: HELPER_IMAGE,
    cmd: ['sh', '-c', script],
    mounts: [{ source: taskVol, target: home, readOnly: false }],
    entrypoint: '',
    user: 'root',
    timeoutMs: HELPER_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    log.warn(
      { taskId, providerName, containerPath, exitCode: result.exitCode },
      'mcp file write helper exited non-zero',
    );
    return false;
  }
  log.info({ taskId, providerName, containerPath }, 'wrote mcp config into task auth volume');
  return true;
}

/** Should the task copy's credential replace the user volume's?
 *
 *  The mtime test is the one that is easy to get wrong. A task volume starts as a byte copy
 *  of the user volume (`cp -a`, so mtimes carry over) and normally only the in-task CLI
 *  writes to it, which tempts the shortcut "a differing token means the CLI rotated it, so
 *  the task copy is newer". That is FALSE whenever the user volume is rewritten while the
 *  task is still in flight — a mid-task re-login, or an operator repairing a rotted token
 *  by hand. Both leave a task copy that differs and is OLDER, and syncing it back would
 *  overwrite a fresh login with a dead token: this function's own failure mode, inverted.
 *
 *  So: last writer wins, by mtime. A tie means the CLI never touched the file and there is
 *  nothing to carry back. An empty or unparseable task token is never written, because the
 *  thing at stake is the user's login and leaving it alone is always survivable. */
export function shouldSyncAuthBack(
  taskToken: string | null,
  userToken: string | null,
  taskMtimeMs: number | null,
  userMtimeMs: number | null,
): boolean {
  if (taskToken === null || taskToken.length === 0) return false;
  if (taskToken === userToken) return false;
  if (taskMtimeMs === null) return false;
  return userMtimeMs === null || taskMtimeMs > userMtimeMs;
}

/** Copy any credential the in-task CLI refreshed back onto the user auth volume, before
 *  the task volume is destroyed.
 *
 *  Without this the user volume keeps the exact token the task consumed and rots: codex
 *  rotates its OAuth tokens single-use, so once an in-task run refreshes, the user
 *  volume's copy is dead. Observed: a user volume 10 days and three in-task refreshes
 *  behind, which silently killed the usage meter (the poller reads the USER volume) and
 *  hands the next task an already-consumed refresh token.
 *
 *  Scope is deliberately narrow — only the files in CLI_CREDENTIAL_FILES, i.e. the
 *  credentials the CLIs refresh in place. Never a blanket copy of the volume: that would
 *  push per-task mutations (rtk seeds, the gemini MCP merge) onto the user's own settings.
 *
 *  That registry is NOT the usage-metering map, which is what this used to read. Keying
 *  the sync on USAGE_PROVIDERS silently meant "we only protect the credential of a CLI
 *  that also exposes a usage endpoint" — so grok, which has no such endpoint, was skipped
 *  and its refreshed token was dropped on every teardown until grok deleted auth.json
 *  outright. Add a CLI to CLI_CREDENTIAL_FILES, not to USAGE_PROVIDERS, to cover it here.
 *
 *  Best-effort by contract. Every failure is logged and swallowed so a teardown never
 *  fails on it; the cost of skipping is one more stale poll, not a broken task. */
export async function syncRefreshedAuthToUserVolumes(
  db: Database,
  taskId: string,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  // The provider ROWS this task actually used. The task volume name carries only
  // (taskId, providerName, idx), which cannot disambiguate two isolated rows of the same
  // CLI — the invocation ledger can, and it also skips providers the task never touched.
  const used = await db
    .selectDistinct({ providerId: schema.cliInvocations.cliProviderId })
    .from(schema.cliInvocations)
    .where(eq(schema.cliInvocations.taskId, taskId));

  for (const { providerId } of used) {
    if (!providerId) continue;
    const provider = await db.query.cliProviders.findFirst({
      where: eq(schema.cliProviders.id, providerId),
      // authMode is part of the auth-volume identity (resolveCliAuthUserVolumeName), so
      // omitting it here would resolve every row to the subscription volume.
      columns: { id: true, userId: true, name: true, isolateAuth: true, authMode: true },
    });
    if (!provider) continue;

    await syncProviderAuthBack(taskId, provider, runner);
  }
}

/** Provider identity the auth sync needs: enough to resolve the user volume
 *  (resolveCliAuthUserVolumeName) and to pick the credential file out of the registry. */
export interface AuthSyncProvider {
  id: string;
  userId: string;
  name: CliProviderName;
  authMode: AuthMode;
  isolateAuth: boolean;
}

/** Carry ONE provider's in-task credential back to its user volume, when the in-task CLI
 *  rotated it. Returns true only when bytes were actually written.
 *
 *  Split out of syncRefreshedAuthToUserVolumes so the mid-task harvest
 *  (usage-window/credential-harvest.ts) runs the identical rules. The guard ORDER is the
 *  whole safety argument — the task token must parse, then last-writer-wins by mtime, then
 *  copyAuthFileBack re-checks that ordering with `-nt` inside the container doing the copy —
 *  and a second copy of it elsewhere would drift from this one.
 *
 *  Best-effort by contract: every failure is logged and swallowed. */
export async function syncProviderAuthBack(
  taskId: string,
  provider: AuthSyncProvider,
  runner: DockerRunner = defaultDockerRunner,
): Promise<boolean> {
  const source = CLI_CREDENTIAL_FILES[provider.name];
  if (!source) return false;

  const ctx: ProviderAuthCtx = {
    userId: provider.userId,
    providerId: provider.id,
    providerName: provider.name,
    authMode: provider.authMode,
    isolateAuth: provider.isolateAuth,
  };
  const taskVol = cliAuthTaskVolumeName(taskId, provider.name, source.authPathIdx);
  const userVol = userVolumeForCtx(ctx, source.authPathIdx);

  try {
    const taskRaw = await readVolumeFile(taskVol, source.relPath, runner);
    if (!taskRaw) return false;
    const taskToken = extractToken(source.extract, taskRaw);
    const userRaw = await readVolumeFile(userVol, source.relPath, runner);
    const userToken = userRaw ? extractToken(source.extract, userRaw) : null;
    const [taskMtime, userMtime] = await Promise.all([
      readVolumeFileMtimeMs(taskVol, source.relPath, runner),
      readVolumeFileMtimeMs(userVol, source.relPath, runner),
    ]);
    if (!shouldSyncAuthBack(taskToken, userToken, taskMtime, userMtime)) return false;

    const copied = await copyAuthFileBack(taskVol, userVol, source.relPath, runner);
    if (copied) {
      log.info(
        { taskId, provider: provider.name, taskVol, userVol, relPath: source.relPath },
        'synced CLI-refreshed credential back to the user auth volume',
      );
    }
    return copied;
  } catch (err) {
    log.warn(
      { err, taskId, provider: provider.name, relPath: source.relPath },
      'auth sync-back failed; user volume left as-is',
    );
    return false;
  }
}

/** Last-modified time of a file inside a named volume, in epoch ms, or null when the
 *  volume or file is absent. Feeds the last-writer-wins half of shouldSyncAuthBack. */
async function readVolumeFileMtimeMs(
  vol: string,
  relPath: string,
  runner: DockerRunner,
): Promise<number | null> {
  if (!(await runner.volumeExists(vol))) return null;
  const safeRel = relPath.replace(/["'`$]/g, '');
  const result = await runner.run({
    image: HELPER_IMAGE,
    entrypoint: '',
    user: 'root',
    cmd: ['sh', '-c', `stat -c %Y "/vol/${safeRel}" 2>/dev/null || true`],
    mounts: [{ source: vol, target: '/vol', readOnly: true }],
    timeoutMs: HELPER_TIMEOUT_MS,
  });
  const secs = Number.parseInt((result.stdout ?? '').trim(), 10);
  return Number.isFinite(secs) ? secs * 1000 : null;
}

/** Run a `volumeJson` source's own extractor over raw file bytes. Returns null when the
 *  file is not parseable JSON, so a half-written credential can never pass the guard. */
function extractToken(
  extract: (json: unknown) => { token: string | null },
  raw: string,
): string | null {
  try {
    return extract(JSON.parse(raw)).token;
  } catch {
    return null;
  }
}

/** Distinct exit code from the sync-back helper when the user volume turned out to be at
 *  least as new as the task copy, so nothing was written. Not a failure: it is the correct
 *  outcome when a re-login landed between the worker's mtime read and this copy. */
const SYNC_SKIPPED_NOT_NEWER_EXIT = 3;

/** Replace one file on the user volume with the task volume's copy, atomically.
 *  Writes a sibling temp and renames it, so a crash mid-copy can never leave a truncated
 *  credential where a working login used to be, and restores the sandbox uid the CLI
 *  needs to read it back.
 *
 *  Re-checks the mtime ordering here rather than trusting the caller's: the worker read
 *  those timestamps in an earlier container, and a re-login in that gap must not be
 *  clobbered. `-nt` decides it in the same container that performs the copy. */
async function copyAuthFileBack(
  taskVol: string,
  userVol: string,
  relPath: string,
  runner: DockerRunner,
): Promise<boolean> {
  const safeRel = relPath.replace(/["'`$]/g, '');
  const script = [
    'set -e',
    `if [ -e "/dst/${safeRel}" ] && [ ! "/src/${safeRel}" -nt "/dst/${safeRel}" ]; then exit ${SYNC_SKIPPED_NOT_NEWER_EXIT}; fi`,
    `mkdir -p "$(dirname "/dst/${safeRel}")"`,
    `cp "/src/${safeRel}" "/dst/${safeRel}.haive-tmp"`,
    `chown 1000:1000 "/dst/${safeRel}.haive-tmp"`,
    `chmod 600 "/dst/${safeRel}.haive-tmp"`,
    `mv "/dst/${safeRel}.haive-tmp" "/dst/${safeRel}"`,
  ].join('; ');

  const result = await runner.run({
    image: HELPER_IMAGE,
    cmd: ['sh', '-c', script],
    mounts: [
      { source: taskVol, target: '/src', readOnly: true },
      { source: userVol, target: '/dst', readOnly: false },
    ],
    entrypoint: '',
    user: 'root',
    timeoutMs: HELPER_TIMEOUT_MS,
  });
  if (result.exitCode === SYNC_SKIPPED_NOT_NEWER_EXIT) {
    log.info(
      { taskVol, userVol, relPath },
      'auth sync-back skipped: user volume is not older than the task copy',
    );
    return false;
  }
  if (result.exitCode !== 0) {
    log.warn(
      { taskVol, userVol, relPath, exitCode: result.exitCode, stderr: result.stderr.slice(-300) },
      'auth sync-back helper exited non-zero',
    );
    return false;
  }
  return true;
}

export async function cleanupTaskAuthVolumes(
  taskId: string,
  runner: DockerRunner = defaultDockerRunner,
): Promise<{ removed: string[]; failed: { name: string; stderr: string }[] }> {
  const removed: string[] = [];
  const failed: { name: string; stderr: string }[] = [];
  for (const meta of CLI_PROVIDER_LIST) {
    for (let idx = 0; idx < meta.authConfigPaths.length; idx += 1) {
      const taskVol = cliAuthTaskVolumeName(taskId, meta.name, idx);
      if (!(await runner.volumeExists(taskVol))) continue;
      // `docker run --rm` cannot remove a container when the worker itself dies between
      // Docker's create and start phases. Those helpers remain in Created state, keep this
      // volume mounted, and make `docker volume rm --force` fail forever. Reap only STOPPED
      // users of this exact task volume before removing it; a running final step-summary is
      // deliberately spared and gets a second cleanup chance when it finishes.
      const containerCleanup = await runner.removeStoppedContainersUsingVolume?.(taskVol);
      if (containerCleanup && !containerCleanup.ok) {
        log.warn(
          { taskVol, stderr: containerCleanup.stderr },
          'stopped auth helper container cleanup failed',
        );
      } else if (containerCleanup && containerCleanup.removed.length > 0) {
        log.info(
          { taskVol, containers: containerCleanup.removed.length },
          'removed stopped auth helper containers',
        );
      }
      const result = await runner.volumeRemove(taskVol);
      if (result.ok) {
        removed.push(taskVol);
      } else {
        failed.push({ name: taskVol, stderr: result.stderr });
        log.warn({ taskVol, stderr: result.stderr }, 'task auth volume remove failed');
      }
    }
  }
  return { removed, failed };
}
