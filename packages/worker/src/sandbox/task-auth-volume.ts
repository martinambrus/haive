import { existsSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CLI_PROVIDER_LIST,
  cliAuthProviderVolumeName,
  cliAuthTaskVolumeName,
  cliAuthVolumeName,
  getCliProviderMetadata,
  logger,
} from '@haive/shared';
import type { CliProviderName } from '@haive/shared';
import { defaultDockerRunner, type DockerRunner, type DockerVolumeMount } from './docker-runner.js';
import { expandTildeToSandbox } from './cli-auth-volume.js';
import { USAGE_PROVIDERS } from '../usage-window/fetchers/index.js';
import { readVolumeFile } from '../usage-window/token-source.js';

export interface ProviderAuthCtx {
  userId: string;
  providerId: string;
  providerName: CliProviderName;
  isolateAuth: boolean;
}

function userVolumeForCtx(ctx: ProviderAuthCtx, idx: number): string {
  return ctx.isolateAuth
    ? cliAuthProviderVolumeName(ctx.providerId, ctx.providerName, idx)
    : cliAuthVolumeName(ctx.userId, ctx.providerName, idx);
}

/** Map our CLI provider names to the corresponding `rtk init` flag. Returns
 *  `undefined` when the provider has no rtk-native init mode (amp today —
 *  not in rtk's supported agent list, so the project-level RTK.md +
 *  AGENTS.md @-ref written by step 07 is the only integration). Empty string
 *  is the bare `rtk init -g` (claude-family). */
function rtkInitFlagFor(providerName: CliProviderName): string | undefined {
  switch (providerName) {
    case 'claude-code':
    case 'zai':
    case 'muse':
      return '';
    case 'gemini':
      return '--gemini';
    case 'codex':
      return '--codex';
    case 'amp':
      return undefined;
    default:
      return undefined;
  }
}

const log = logger.child({ module: 'task-auth-volume' });

const HELPER_IMAGE = process.env.SANDBOX_IMAGE ?? 'haive-cli-sandbox:latest';
const READY_MARKER = '.haive-ready';
const HELPER_TIMEOUT_MS = 60_000;
const VOLUME_READY_POLL_MS = 1_500;
// A concurrent sibling agent's populate helper finishes well within this; bounded so a
// genuinely-stale volume still gets recreated promptly.
const VOLUME_READY_MAX_WAIT_MS = 30_000;
const VOLUME_REMOVE_RETRIES = 5;

/** Distinct exit code from the rtk seed helper script when the sandbox image
 *  has no rtk binary on PATH. Exported so tests can assert on the boundary. */
export const RTK_HELPER_MISSING_BINARY_EXIT = 2;

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

export async function ensureTaskAuthVolumes(
  ctx: ProviderAuthCtx,
  taskId: string,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
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
export async function seedRtkInTaskVolume(
  taskId: string,
  providerName: CliProviderName,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  const flag = rtkInitFlagFor(providerName);
  if (flag === undefined) {
    log.debug({ providerName }, 'rtk seed skipped: provider has no rtk-native flag');
    return;
  }
  const meta = getCliProviderMetadata(providerName);
  if (meta.authConfigPaths.length === 0) {
    log.debug({ providerName }, 'rtk seed skipped: provider has no auth config paths');
    return;
  }

  const mounts: DockerVolumeMount[] = meta.authConfigPaths.map((raw, idx) => ({
    source: cliAuthTaskVolumeName(taskId, providerName, idx),
    target: expandTildeToSandbox(raw),
    readOnly: false,
  }));

  // Run as root so we can write regardless of original volume ownership; chown
  // back to 1000:1000 after so the CLI runtime (which runs as the node user)
  // can read its own settings file. The missing-binary branch exits with a
  // distinct code (RTK_HELPER_MISSING_BINARY_EXIT) so the worker can log
  // "rtk binary missing" instead of falsely claiming success — that mistake
  // hid stale per-CLI sandbox images during rtk integration testing.
  const flagArg = flag.length > 0 ? ` ${flag}` : '';
  const script =
    `command -v rtk >/dev/null 2>&1 || { echo "rtk: binary missing in sandbox image" >&2; exit ${RTK_HELPER_MISSING_BINARY_EXIT}; }; ` +
    `HOME=/home/node rtk init -g --auto-patch${flagArg} || echo "rtk init exit=$?" >&2; ` +
    `chown -R 1000:1000 /home/node 2>/dev/null || true`;

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
    return;
  }
  if (result.exitCode !== 0) {
    log.warn(
      { taskId, providerName, exitCode: result.exitCode, stderr: result.stderr.slice(-500) },
      'rtk seed helper exited non-zero',
    );
    return;
  }
  log.info(
    { taskId, providerName, flag: flag.length > 0 ? flag : '<claude>' },
    'rtk seeded in task auth volume',
  );
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
export async function mergeGeminiMcpIntoSettings(
  taskId: string,
  mcpServers: Record<string, unknown>,
  runner: DockerRunner = defaultDockerRunner,
): Promise<void> {
  if (Object.keys(mcpServers).length === 0) return;
  const meta = getCliProviderMetadata('gemini');
  // Index 1 is `~/.gemini` per shared catalog; skip if absent for some
  // reason (would mean the catalog drifted).
  if (meta.authConfigPaths.length < 2) return;
  const taskVol = cliAuthTaskVolumeName(taskId, 'gemini', 1);
  if (!(await runner.volumeExists(taskVol))) return;

  // Embed the MCP servers JSON via a heredoc so any prompt-style content
  // can't accidentally inject shell. node is in the sandbox image and gives
  // us atomic JSON merge with parse-error tolerance.
  const mcpJson = JSON.stringify(mcpServers);
  const script = `
set -e
mkdir -p /vol
cd /vol
node -e '
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
    return;
  }
  log.info(
    { taskId, count: Object.keys(mcpServers).length },
    'merged mcpServers into gemini settings.json',
  );
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
 *  Scope is deliberately narrow — only the `volumeJson` files the usage poller reads,
 *  i.e. the credentials the CLIs refresh in place. Never a blanket copy of the volume:
 *  that would push per-task mutations (rtk seeds, the gemini MCP merge) onto the user's
 *  own settings.
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
      columns: { id: true, userId: true, name: true, isolateAuth: true },
    });
    if (!provider) continue;

    const source = USAGE_PROVIDERS[provider.name]?.token;
    if (source?.kind !== 'volumeJson') continue;

    const ctx: ProviderAuthCtx = {
      userId: provider.userId,
      providerId: provider.id,
      providerName: provider.name,
      isolateAuth: provider.isolateAuth,
    };
    const taskVol = cliAuthTaskVolumeName(taskId, provider.name, source.authPathIdx);
    const userVol = userVolumeForCtx(ctx, source.authPathIdx);

    try {
      const taskRaw = await readVolumeFile(taskVol, source.relPath, runner);
      if (!taskRaw) continue;
      const taskToken = extractToken(source.extract, taskRaw);
      const userRaw = await readVolumeFile(userVol, source.relPath, runner);
      const userToken = userRaw ? extractToken(source.extract, userRaw) : null;
      const [taskMtime, userMtime] = await Promise.all([
        readVolumeFileMtimeMs(taskVol, source.relPath, runner),
        readVolumeFileMtimeMs(userVol, source.relPath, runner),
      ]);
      if (!shouldSyncAuthBack(taskToken, userToken, taskMtime, userMtime)) continue;

      const copied = await copyAuthFileBack(taskVol, userVol, source.relPath, runner);
      if (copied) {
        log.info(
          { taskId, provider: provider.name, taskVol, userVol, relPath: source.relPath },
          'synced CLI-refreshed credential back to the user auth volume',
        );
      }
    } catch (err) {
      log.warn(
        { err, taskId, provider: provider.name, relPath: source.relPath },
        'auth sync-back failed; user volume left as-is',
      );
    }
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
