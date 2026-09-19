import { SANDBOX_CORE_IMAGE } from './image-composer.js';
import { createHash } from 'node:crypto';
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
/** Fingerprint of the USER volume this task's copy was taken from, written into the task
 *  volume at populate time and re-checked on every reuse. Absent on a volume populated before
 *  this existed, which is read as "fresh" — no backfill, same stance as every other marker. */
const SOURCE_MARKER = '.haive-source';
/** Recorded in {@link SOURCE_MARKER} when the volume was populated with NO source at all —
 *  an api-key provider row, or a CLI the user had not logged into yet.
 *
 *  It has to be written, and it has to be distinguishable from an ABSENT marker. Absent means
 *  "populated before this existed" and is read as fresh, so that a deploy invalidates nothing
 *  in flight. Without the sentinel an empty volume is indistinguishable from that, and stays
 *  "fresh" forever — so a task that later gains credentials (the user logs in, or the row is
 *  switched to a subscription) would keep mounting the empty snapshot and keep failing. Four
 *  characters, where a real fingerprint is 32 hex, so the two can never collide. */
const NO_SOURCE_SENTINEL = 'none';

/** What the readiness probe concluded. `source_moved` is separated from `not_ready` because
 *  the two are repaired the same way but mean different things, and only one of them is a
 *  fault: a half-built volume versus credentials that have since been refreshed. */
type VolumeReadiness = 'ready' | 'not_ready' | 'source_moved';

/** Exit code from the readiness probe for a volume that IS ready but whose source has moved
 *  on. Distinct from 1 (not ready) because the log lines differ and the distinction is the
 *  whole point: one is a half-built volume, the other is stale credentials. */
const VOLUME_SOURCE_MOVED_EXIT = 2;

/** Emit a stable fingerprint of a mounted directory's contents.
 *
 *  Hashes path + CONTENT. The obvious cheaper form — name, size and mtime via `stat -c '%n %s
 *  %Y'` — is what this had, and `%Y` is whole SECONDS: a credential rewritten in the same
 *  second at the same length is the normal shape of a fixed-size token replacement, and it
 *  fingerprinted identically, so the refresh this exists for would not fire. Subsecond `%y`
 *  would close that particular hole; content closes the question. These are a handful of small
 *  JSON files, the hash never leaves the helper container, and `cp -a` copies bytes, so the
 *  two sides still agree by construction.
 *
 *  `md5sum` prints `<hash>  <path>`, which is why one pass yields both halves. Both sides mount
 *  the source at the SAME target, so the paths line up; `LC_ALL=C` because a locale-dependent
 *  sort order would make the fingerprint host-dependent. */
/** The credential file this provider REFRESHES IN PLACE on the volume at `idx`, or null when
 *  there is none to single out. `CLI_CREDENTIAL_FILES` is already the registry of exactly
 *  that, and reusing it is the point: its own header warns that a blanket read of the volume
 *  sweeps in per-task mutations, which is the same mistake in the other direction. */
function credentialRelPath(providerName: CliProviderName, idx: number): string | null {
  const file = CLI_CREDENTIAL_FILES[providerName];
  return file && file.authPathIdx === idx ? file.relPath : null;
}

/** Sentinel for a credential file that is not there. Stable, and distinct from any hash, so a
 *  credential APPEARING later reads as a change and the snapshot is rebuilt. */
const CREDENTIAL_ABSENT = 'absent';

function sourceFingerprintSh(dir: string, relPath: string | null): string {
  // Narrowed to the credential wherever the registry names one. A whole-directory hash calls
  // any write a credential change, and these volumes are written by things that are not:
  // opening a Terminal runs `codex mcp add` against the USER volume, rewriting
  // `~/.codex/config.toml`. That reported `source_moved`, and the recopy that followed would
  // replace a task's OWN rotated credential with the user volume's older one — turning a
  // working task into an authentication failure, which is the exact opposite of the point.
  if (relPath) {
    const f = `${dir}/${relPath}`;
    return `[ -f '${f}' ] && md5sum '${f}' | cut -c1-32 || echo '${CREDENTIAL_ABSENT}'`;
  }
  return (
    `find ${dir} -type f ! -name '${READY_MARKER}' ! -name '${SOURCE_MARKER}' ` +
    // `-exec ... +` and not `... \;`: this is a TS template literal, where a single-backslash
    // escape does not survive, and a BARE `;` would read to the shell as a command separator
    // that silently truncates the pipeline. `+` needs no escape at all.
    `-exec md5sum {} + 2>/dev/null | LC_ALL=C sort | md5sum | cut -c1-32`
  );
}
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

/**
 * Tail of the in-flight chain for one preparation SCOPE, i.e. one file in one task's volume.
 *
 * The coalescing below keys on scope + IDENTITY, which dedupes a fan-out's identical siblings
 * but leaves two DIFFERENT surfaces free to run their helper containers against the same file
 * at the same time. That used to cost only a wrong surface; with `toolProfile: 'none'` clearing
 * a volume it costs interleaved writes to a file another invocation is about to read. Ordering
 * them is not the same as choosing the order — the later WRITE still wins, which is why the
 * step-summary pass is kept out of MCP resolution entirely rather than raced with.
 */
const authPreparationLocks = new Map<string, Promise<void>>();

/** Run `fn` after every preparation already queued for `scope`, whatever their outcomes. */
function withScopeLock(scope: string, fn: () => Promise<void>): Promise<void> {
  const prev = authPreparationLocks.get(scope) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  authPreparationLocks.set(scope, tail);
  void tail.finally(() => {
    if (authPreparationLocks.get(scope) === tail) authPreparationLocks.delete(scope);
  });
  return run;
}

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
  await coalesceAuthPreparation(runs, `${scope}|${key}`, () =>
    withScopeLock(scope, async () => {
      // Re-checked INSIDE the lock: an identical preparation may have been applied while
      // this one waited, which is the whole point of queueing behind it.
      if (appliedAuthPreparations.get(scope) === key) return;
      if (await work()) appliedAuthPreparations.set(scope, key);
      else appliedAuthPreparations.delete(scope);
    }),
  );
}

/** Forget applied-preparation slots whose volume no longer holds what they recorded.
 *
 *  Called from two places, and the difference matters. The task-end funnel passes no provider:
 *  every volume for the task is being destroyed, so the in-flight LOCKS go too. A volume
 *  RECREATE passes the provider, and then only the applied identities are dropped — a sibling
 *  may be queued on that scope's lock, and removing the lock mid-flight would let its
 *  preparation run concurrently with the next one, which is the whole thing the lock exists to
 *  stop.
 *
 *  Scopes are `taskId|provider|phase` for exactly this reason: a per-provider prefix is then
 *  an exact match rather than a substring search over four differently-shaped keys.
 *
 *  Without the recreate call, refreshed credentials cost a task its tooling: the copy helper
 *  replaces the volume, the rtk seed and every MCP write still read their prior identity from
 *  this map and SKIP, and the agent that follows runs against a volume where those files no
 *  longer exist. The identities are dropped rather than re-applied here because each writer
 *  already re-applies itself on the next invocation that needs it. */
export function clearTaskAuthPreparationState(taskId: string, providerName?: string): void {
  const prefix = providerName ? `${taskId}|${providerName}|` : `${taskId}|`;
  for (const scope of appliedAuthPreparations.keys()) {
    if (scope.startsWith(prefix)) appliedAuthPreparations.delete(scope);
  }
  if (providerName) return;
  for (const scope of authPreparationLocks.keys()) {
    if (scope.startsWith(prefix)) authPreparationLocks.delete(scope);
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
    // Resolved BEFORE the probe, because a source that no longer exists must not be compared
    // against: it would fingerprint as empty, read as "moved on", and the recreate below would
    // then populate an EMPTY volume — destroying the only credentials the task still had.
    const userHasData = await runner.volumeExists(userVol);
    const credRelPath = credentialRelPath(ctx.providerName, idx);

    if (await runner.volumeExists(taskVol)) {
      const readiness = await isTaskVolumeReady(
        taskVol,
        runner,
        userHasData ? userVol : null,
        credRelPath,
      );
      if (readiness === 'ready') {
        continue;
      }
      if (readiness === 'source_moved') {
        // Not a fault: the user re-authenticated after this task started. Recreated through
        // exactly the same path a half-built volume takes, so there is one repair, not two.
        log.info({ taskVol, userVol }, 'task auth credentials were refreshed, recopying');
      } else {
        log.warn({ taskVol }, 'task auth volume exists but not ready, recreating');
      }
      let removed = await runner.volumeRemove(taskVol);
      if (!removed.ok && /in use/i.test(removed.stderr)) {
        // In use → a CONCURRENT sibling agent (08c fans out 2 agents that share this
        // per-task volume) is mid-setup with the volume mounted by its populate helper,
        // which is what produced the EXIT -1. Wait for it to make the volume ready and
        // reuse it; only if it stays unready do we retry the remove (the sibling's
        // helper has exited by then) and recreate.
        // Keep demanding freshness when that is what sent us here: a stale volume already has
        // its ready marker, so a readiness-only wait would succeed immediately and hand this
        // invocation the very credentials the user just replaced.
        if (
          await waitForTaskVolumeReady(
            taskVol,
            runner,
            readiness === 'source_moved' && userHasData ? userVol : null,
            credRelPath,
          )
        ) {
          continue;
        }
        removed = await removeVolumeWithRetry(taskVol, runner);
      }
      if (!removed.ok) {
        // A volume Docker will not let go of is held by a RUNNING sibling, and a CLI turn can
        // hold it for the length of its timeout — far past any wait worth doing inside a job
        // that is occupying a queue slot. What to do about it depends on WHICH verdict sent
        // us here, and the two are not close.
        //
        // `source_moved` degrades: carry on with the copy we have. A moved source is not
        // proof this task's credentials are dead — it is most often ANOTHER task ending,
        // because `syncRefreshedAuthToUserVolumes` writes a rotated token back to the user
        // volume at teardown and codex rotates its OAuth token single-use. That fires far
        // more often than a re-login, and this task's own copy is the token this task has
        // been using. Failing the invocation would deny the task work AND not refresh
        // anything; the next dispatch after the sibling exits replaces the volume properly.
        if (readiness === 'source_moved') {
          log.warn(
            { taskVol, userVol, stderr: removed.stderr.slice(-200) },
            'auth source moved but the volume is held by a running invocation; ' +
              'continuing on the existing copy and refreshing at the next dispatch',
          );
          continue;
        }
        // `not_ready` is a half-built volume: unusable, so there is nothing to degrade to.
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
    // The volume this task's rtk seed and MCP config were written into is gone. Their applied
    // identities are in-process and would otherwise make every writer skip, leaving the fresh
    // volume without the tooling the next agent expects — for codex that is the whole
    // `config.toml` MCP surface. Always reached on a recreate, whether it was a half-built
    // volume or refreshed credentials.
    clearTaskAuthPreparationState(taskId, ctx.providerName);

    const mounts: DockerVolumeMount[] = [{ source: taskVol, target: '/dst', readOnly: false }];
    if (userHasData) {
      mounts.push({ source: userVol, target: '/src', readOnly: true });
    }

    // Docker creates the named-volume mountpoint owned by root. The CLI sandbox
    // runs as node (uid 1000), so we must chown the volume root (and any copied
    // contents) to 1000:1000 before the CLI can write into the mount.
    // The fingerprint is recorded LAST and from the source, so a copy that died half way
    // leaves no record and the next probe reads the volume as not ready rather than as fresh.
    // One rule, decided INSIDE the helper where the mount actually happens: an EMPTY source is
    // no source. Both ways of arriving there want the same thing, and neither wants a failure.
    //
    // A declared auth path can be legitimately empty — gemini declares `~/.config/gemini` and
    // `~/.gemini`, keeps its credential in the second, and the login flow creates volumes for
    // both — so refusing on an empty mount would leave that volume unready on every retry and
    // break the provider outright. And a volume that VANISHED mid-run (handleSignOutJob runs
    // in the same worker, and a `-v` mount recreates a missing name) lands in exactly the same
    // state. Recording the sentinel is what makes both self-healing: it can never equal a
    // fingerprint, so the copy is redone the moment a credential is there to copy.
    const emptyCopy =
      `chown 1000:1000 /dst; printf '%s' ${NO_SOURCE_SENTINEL} > /dst/${SOURCE_MARKER}; ` +
      `touch /dst/${READY_MARKER}`;
    const copyScript = userHasData
      ? `if [ -z "$(ls -A /src 2>/dev/null)" ]; then ${emptyCopy}; else ` +
        // Fingerprint BEFORE the copy. Hashing afterwards records what the source is NOW
        // against bytes that may already be older — a concurrent harvest or re-login landing
        // between the two would make every later probe see marker == source and accept the
        // stale copy forever. Taken first, the same race records a fingerprint that no longer
        // matches, so the next probe retries: one wasted recopy instead of a permanent miss.
        `fp=$(${sourceFingerprintSh('/src', credRelPath)}); ` +
        `cp -a /src/. /dst/ 2>/dev/null || true; ` +
        `printf '%s' "$fp" > /dst/${SOURCE_MARKER}; ` +
        `chown -R 1000:1000 /dst; touch /dst/${READY_MARKER}; fi`
      : emptyCopy;

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
async function waitForTaskVolumeReady(
  taskVol: string,
  runner: DockerRunner,
  /** The source to keep demanding, or null to wait on readiness alone.
   *
   *  Which one is right depends on WHY the remove was attempted, and getting it wrong is how
   *  a refreshed credential gets thrown away. Waiting on readiness is correct for a half-built
   *  volume: a sibling is mid-populate from the same source, so its finished volume is exactly
   *  what this caller wanted. It is WRONG for a stale one — that volume already carries a
   *  `.haive-ready` marker, so the wait returns true on its first poll and the caller reuses
   *  the expired credentials the refresh was supposed to replace. Passing the source keeps the
   *  freshness requirement, and still lets a sibling that recreates the volume satisfy it. */
  userVol: string | null,
  credRelPath: string | null,
): Promise<boolean> {
  const deadline = Date.now() + VOLUME_READY_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, VOLUME_READY_POLL_MS));
    if ((await isTaskVolumeReady(taskVol, runner, userVol, credRelPath)) === 'ready') return true;
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

async function isTaskVolumeReady(
  taskVol: string,
  runner: DockerRunner,
  /** The volume this copy was taken from, when it still exists. Passing it turns the probe
   *  into a freshness check as well; passing null keeps the old readiness-only behaviour.
   *
   *  NULL when the user volume is GONE, and that case must not recreate: a missing source
   *  would fingerprint as empty, read as "moved on", and the recreate would then populate an
   *  EMPTY task volume — deleting the only credentials the task still had. */
  userVol: string | null,
  /** Which file to compare, from {@link credentialRelPath}; null hashes the whole directory. */
  credRelPath: string | null,
): Promise<VolumeReadiness> {
  // Verify both the readiness marker AND that the volume root is owned by the
  // sandbox user (1000). Early versions of ensureTaskAuthVolumes left the mount
  // root owned by root, which the CLI cannot write to. Treating those as stale
  // forces a recreate on first use.
  //
  // Then, when a source is given, compare the fingerprint recorded at populate time against
  // the source's current one. The per-task volume is otherwise a SNAPSHOT for the life of the
  // task, so a `cli login` performed after the task started reached new tasks only — MEASURED
  // on 2026-09-13, six live tasks each held a different expired amp token while the user
  // volume had a valid one, and every step-summary invocation failed `Session expired and
  // could not be refreshed` with no way back short of deleting a volume by hand.
  const checks = [
    `test -f /x/${READY_MARKER} || exit 1`,
    `[ "$(stat -c %u /x)" = "1000" ] || exit 1`,
  ];
  if (userVol) {
    checks.push(
      // A volume populated with no source carries NO_SOURCE_SENTINEL here, which can never
      // equal a fingerprint — so the comparison below recreates it the moment a source appears,
      // with no branch of its own.
      `rec=$(cat /x/${SOURCE_MARKER} 2>/dev/null || echo '')`,
      // No record: populated before this existed. Read as fresh rather than recreated, so a
      // deploy does not invalidate every task in flight.
      `if [ -n "$rec" ]; then`,
      // An EMPTY source is never evidence that credentials moved on, and the guard has to be
      // HERE rather than in the caller's existence check: mounting a named volume CREATES it
      // when it is missing, so a sign-out landing between that check and this run materialises
      // an empty `/src` that would fingerprint as "moved" — and the recreate would then replace
      // the task's only credential snapshot with nothing. Reading it as unchanged keeps the
      // snapshot, which is the same direction the caller's null-source case already takes.
      `  if [ -n "$(ls -A /src 2>/dev/null)" ]; then`,
      `    cur=$(${sourceFingerprintSh('/src', credRelPath)})`,
      // Only a source that HAS the credential can say the credentials moved on. Present ->
      // absent is not a refresh: grok is documented to give up and DELETE auth.json, and
      // replacing a task's still-usable snapshot with a source that has no credential at all
      // destroys the one copy that still works. Absent -> present is still a refresh, because
      // `rec` is then the sentinel and cannot equal a hash — one condition, both directions.
      `    if [ "$cur" != '${CREDENTIAL_ABSENT}' ]; then`,
      `      [ "$rec" = "$cur" ] || exit ${VOLUME_SOURCE_MOVED_EXIT}`,
      '    fi',
      '  fi',
      'fi',
    );
  }
  const mounts: DockerVolumeMount[] = [{ source: taskVol, target: '/x', readOnly: true }];
  if (userVol) mounts.push({ source: userVol, target: '/src', readOnly: true });
  const result = await runner.run({
    image: HELPER_IMAGE,
    cmd: ['sh', '-c', checks.join('\n')],
    mounts,
    entrypoint: '',
    user: 'root',
    timeoutMs: 15_000,
  });
  if (result.exitCode === 0) return 'ready';
  return result.exitCode === VOLUME_SOURCE_MOVED_EXIT ? 'source_moved' : 'not_ready';
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
  return applyAuthPreparationOnce(rtkSeedRuns, `${taskId}|${providerName}|rtk`, 'seeded', () =>
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
 *  RECONCILES from a marker, exactly like {@link mergeCliMcpIntoTaskVolume}: the names Haive
 *  wrote last time are removed and the current set added, so a surface that shrinks actually
 *  shrinks and — the reason it matters — a `toolProfile: 'none'` invocation can take it to
 *  nothing. A purely additive merge could add a surface but never take one away, while the
 *  volume outlives the invocation. The marker is what keeps the user's OWN `mcpServers`, copied
 *  in with the rest of their gemini settings, out of it: unmarked entries are never touched.
 *
 *  `clear` only says "run even though the map is empty"; the reconcile is the same either way.
 *
 *  Best-effort: failures are logged and the spawn proceeds — the user sees the MCP-related
 *  error from the CLI rather than a hard worker failure. */
export function mergeGeminiMcpIntoSettings(
  taskId: string,
  mcpServers: Record<string, unknown>,
  runner: DockerRunner = defaultDockerRunner,
  opts: { clear?: boolean } = {},
): Promise<void> {
  const content = JSON.stringify(mcpServers);
  const clear = opts.clear === true;
  return applyAuthPreparationOnce(
    geminiMcpMergeRuns,
    `${taskId}|gemini|mcp`,
    // The MODE is part of the identity: a clear and an empty no-op both carry `{}`, so a key
    // on the content alone would let the recorded no-op skip a later clear.
    contentKey(`${clear ? 'clear' : 'merge'}|${content}`),
    () => mergeGeminiMcpIntoSettingsUnlocked(taskId, mcpServers, content, clear, runner),
  );
}

async function mergeGeminiMcpIntoSettingsUnlocked(
  taskId: string,
  mcpServers: Record<string, unknown>,
  mcpJson: string,
  clear: boolean,
  runner: DockerRunner,
): Promise<boolean> {
  if (Object.keys(mcpServers).length === 0 && !clear) return true;
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
// Newline escapes below are written with a DOUBLED backslash: this program is built from a
// TS template literal, where a single backslash escape becomes a real newline and breaks the
// string literal it sits in. The helper then exits non-zero and the best-effort merge
// swallows it, so gemini loses its MCP servers silently.
const marker = "/vol/${MCP_MANAGED_MARKER}";
let prev = [];
if (fs.existsSync(marker)) {
  try { prev = fs.readFileSync(marker, "utf8").split("\\n").filter(Boolean); } catch (err) {}
}
const merged = { ...(cur.mcpServers || {}) };
for (const name of prev) delete merged[name];
Object.assign(merged, servers);
cur.mcpServers = merged;
fs.writeFileSync(path, JSON.stringify(cur, null, 2));
fs.writeFileSync(marker, Object.keys(servers).join("\\n"));
'
chown 1000:1000 /vol/settings.json /vol/${MCP_MANAGED_MARKER}
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
    { taskId, count: Object.keys(mcpServers).length, clear },
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
    `${taskId}|${providerName}|cli-mcp`,
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
    `${taskId}|${providerName}|mcp-file|${containerPath}`,
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
