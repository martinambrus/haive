import { randomUUID } from 'node:crypto';
import { chmod, chown, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger, type CliNetworkPolicy } from '@haive/shared';
import {
  defaultDockerRunner,
  type DockerRunner,
  type DockerRunResult,
  type DockerVolumeMount,
} from './docker-runner.js';
import { createEgressGateway, type EgressGateway } from './egress-gateway.js';
import { OLLAMA_THINKING_PROXY_HOST } from '../cli-adapters/ollama-thinking-proxy.js';
import { OPENROUTER_COMPAT_PROXY_HOST } from '../cli-adapters/openrouter-proxy.js';
import { SANDBOX_GID, SANDBOX_UID } from './sandbox-identity.js';
import { resolveRunnerCaps } from './runtime-caps.js';

export { SANDBOX_GID, SANDBOX_UID } from './sandbox-identity.js';

const log = logger.child({ module: 'sandbox-runner' });

const DEFAULT_SANDBOX_IMAGE = process.env.SANDBOX_IMAGE ?? 'haive-cli-sandbox:latest';
const DEFAULT_WRAPPER_VOLUME = process.env.SANDBOX_WRAPPER_HOST_VOLUME ?? 'haive_wrappers';
const DEFAULT_WRAPPER_WORKER_PATH =
  process.env.SANDBOX_WRAPPER_WORKER_PATH ?? '/var/lib/haive/wrappers';
const DEFAULT_WRAPPER_SANDBOX_PATH = '/haive/wrappers';
export const SANDBOX_WORKDIR = '/haive/workdir';
export const SANDBOX_USER = 'node';
export const SANDBOX_USER_HOME = '/home/node';
const DEFAULT_WORKDIR = SANDBOX_WORKDIR;
// uid:gid the sandbox runs as (SANDBOX_USER = node). A captured-log dir is chowned
// to this so the CLI (running as node) can write its log into the writable mount.
// Exported so worktree creation can chown the tree to the same owner: the sandbox
// runs as node and never chowns its own workdir (unlike the terminal container), so a
// root-owned worktree is silently unwritable to the agent.
// Only the tail of a captured CLI log is needed for fatal-error classification (the
// provider-fatal line is near the end); cap the readback so a verbose debug log
// can't balloon memory.
const CAPTURE_TAIL_LIMIT = 32_768;

// In-stack Ollama daemon hostnames. When a CLI's ANTHROPIC_BASE_URL targets one
// of these, the sandbox joins the models network to reach the daemon directly,
// and the host is excluded from the egress proxy (NO_PROXY).
const IN_STACK_MODEL_HOSTS = new Set(['ollama', 'haive-ollama']);

/** The in-stack Ollama host a spec targets via ANTHROPIC_BASE_URL, or null when
 *  it targets an external/cloud endpoint (or none). Drives the models-network
 *  attach + NO_PROXY bypass so a local Ollama model is reachable directly rather
 *  than through the egress proxy. */
function inStackModelsHost(env: Record<string, string> | undefined): string | null {
  const base = env?.ANTHROPIC_BASE_URL;
  if (!base) return null;
  try {
    const host = new URL(base).hostname;
    return IN_STACK_MODEL_HOSTS.has(host) ? host : null;
  } catch {
    return null;
  }
}

export interface SandboxExtraFile {
  /** Absolute path inside the sandbox container. */
  containerPath: string;
  content: string;
}

/**
 * Collapse extra files that claim the same container path, keeping the FIRST.
 *
 * A duplicate target is not a soft warning to docker — it refuses to start the container
 * at all ("Duplicate mount point: <path>"), so a single collision between two independent
 * mask sources fails every CLI invocation on the affected repo. Deduping here rather than
 * at each composition site means the invariant holds for callers that have not been
 * written yet.
 *
 * Exported for unit testing.
 */
export function dedupeExtraFilesByPath(files: SandboxExtraFile[]): SandboxExtraFile[] {
  const seen = new Set<string>();
  const out: SandboxExtraFile[] = [];
  for (const f of files) {
    if (seen.has(f.containerPath)) {
      log.debug({ containerPath: f.containerPath }, 'dropped a duplicate sandbox mask mount');
      continue;
    }
    seen.add(f.containerPath);
    out.push(f);
  }
  return out;
}

/**
 * Refuse to bind an extra file at a path inside a CLI auth-volume mount.
 *
 * Docker materialises a missing file mount target INSIDE the volume, owned by root, and that stub
 * outlives the container — the CLI, running as uid 1000, then cannot write its own config. That is
 * how a grok task reached `Permission denied (os error 13)` on `plugin marketplace add`: earlier
 * invocations had bind-mounted an MCP config at `~/.grok/config.toml`. The mount is also opaque
 * while it is up, so anything else the real file held (grok's marketplace sources and installed
 * plugins, gemini's `selectedAuthType`) is invisible to that run.
 *
 * Scoped to `kind: 'auth'` on purpose. Nesting under the REPO mount is not a mistake — it is
 * exactly how secret masking and the worktree gitfile mask work, and both must keep working.
 *
 * Fails loud rather than degrading: the alternative is a root-owned stub in a volume that only
 * surfaces as an unrelated permission error, several steps later. Exported for unit testing.
 */
export function assertNoAuthVolumeNesting(
  files: SandboxExtraFile[],
  mounts: DockerVolumeMount[],
): void {
  const authTargets = mounts.filter((m) => m.kind === 'auth').map((m) => m.target);
  for (const file of files) {
    const conflict = authTargets.find((target) => file.containerPath.startsWith(`${target}/`));
    if (!conflict) continue;
    throw new Error(
      `sandbox extra file ${file.containerPath} is inside the auth-volume mount ${conflict}. ` +
        'Bind-mounting there leaves a root-owned stub in the volume that the CLI cannot write, ' +
        "and hides the real file's other contents for the length of the run. Deliver it through " +
        "the CLI's own config writer instead (see McpDelivery in sandbox/mcp-config.ts).",
    );
  }
}

export interface SandboxRunSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  wrapperContent?: string | null;
  /** Files to inject into the container via bind-mount from the wrappers volume. */
  extraFiles?: SandboxExtraFile[];
  timeoutMs?: number;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  signal?: AbortSignal;
  /** Interactive mode: open the container's stdin (docker `-i`) for mid-run
   *  steering. Default off keeps the one-shot path. */
  interactive?: boolean;
  /** Written to the container's stdin immediately after start (the prompt as an
   *  NDJSON user-message). Only used when interactive. */
  stdinInitial?: string;
  /** Receives the container's writable stdin so the caller can inject more
   *  input mid-run. Only invoked when interactive. */
  onStdinWritable?: (writable: NodeJS.WritableStream) => void;
  /** When set, mount a WRITABLE dir at `containerDir` and read
   *  `<containerDir>/<fileName>` back out as `SandboxRunResult.capturedLog` after the
   *  run. Recovers a CLI's own log file from the `--rm` sandbox — agy logs
   *  provider-fatal errors there while exiting 0 with empty stdout. */
  captureDir?: { containerDir: string; fileName: string };
}

export interface SandboxRunnerOptions {
  image?: string;
  wrapperVolumeName?: string;
  wrapperWorkerPath?: string;
  wrapperSandboxPath?: string;
  workdir?: string;
  docker?: DockerRunner;
  extraMounts?: DockerVolumeMount[];
  networkPolicy?: CliNetworkPolicy | null;
  /** Egress allow-set for the CLI's own model/auth servers (adapter defaults ∪
   *  provider extras). Under `allowlist` these are added to the user's domains;
   *  under `none` they become the ONLY domains the squid gateway permits. Empty
   *  under `none` keeps the no-internet fast path (no gateway). */
  egressDomains?: string[];
  /** Stamped onto the spawned container as `haive.task.id=<taskId>` so cancel can find and kill it. */
  taskId?: string;
  /** Stamped as `haive.invocation.id=<invocationId>`. The task label alone can only kill a
   *  task's ENTIRE fan-out, which is right for Stop/cancel and wrong for preemption: the
   *  sweeper frees exactly one agent slot, so it has to name exactly one container. Container
   *  names are `haive-cli-<randomUUID>` and carry no invocation identity, so this label is the
   *  only handle on a single run. */
  invocationId?: string;
  /** `hostname:ip` entries resolving the task's own runtime, which no DNS the container can
   *  see knows about. */
  addHosts?: string[];
  /** Hostnames the squid egress proxy must NOT be asked for. The task's runtime lives on the
   *  internal sandbox network and is reached directly; sent through the proxy it would be
   *  denied, since the allow-set covers the user's external domains. Inert when no gateway
   *  is in play (policy `full` sets no proxy at all). */
  noProxyHosts?: string[];
}

export interface SandboxRunResult extends DockerRunResult {
  resolvedCommand: string;
  wrapperId: string | null;
  /** Tail of the captured CLI log when `spec.captureDir` was set, else null. */
  capturedLog?: string | null;
}

/**
 * Execute a command inside the haive-cli-sandbox image.
 *
 * If `wrapperContent` is provided, the content is materialized to a
 * unique path on the shared haive_wrappers volume, chmod +x, and used as
 * the invoked executable in place of spec.command. The wrapper file is
 * cleaned up after the run regardless of exit code.
 *
 * Mounts only the wrapper volume (read-only); no worker fs leaks into
 * the sandbox. Host Docker daemon resolves the named volume.
 */
export async function runInSandbox(
  spec: SandboxRunSpec,
  options: SandboxRunnerOptions = {},
): Promise<SandboxRunResult> {
  const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
  const volumeName = options.wrapperVolumeName ?? DEFAULT_WRAPPER_VOLUME;
  const wrapperWorkerRoot = options.wrapperWorkerPath ?? DEFAULT_WRAPPER_WORKER_PATH;
  const wrapperSandboxRoot = options.wrapperSandboxPath ?? DEFAULT_WRAPPER_SANDBOX_PATH;
  const workdir = options.workdir ?? DEFAULT_WORKDIR;
  const runner = options.docker ?? defaultDockerRunner;

  const mounts: DockerVolumeMount[] = [
    { source: volumeName, target: wrapperSandboxRoot, readOnly: true },
    ...(options.extraMounts ?? []),
  ];

  const policy = options.networkPolicy ?? null;

  let wrapperId: string | null = null;
  let wrapperWorkerPath: string | null = null;
  let resolvedCommand = spec.command;
  let gateway: EgressGateway | null = null;
  const extraFileDirs: string[] = [];
  let captureHostDir: string | null = null;

  try {
    const egress = options.egressDomains ?? [];
    if (policy?.mode === 'allowlist') {
      // Allowlist: the user's domains plus the CLI's own model/auth domains, so
      // the agent reaches its model without the user hand-listing the host.
      gateway = await createEgressGateway({
        domains: [...new Set([...policy.domains, ...egress])],
        ips: policy.ips,
      });
    } else if (policy?.mode === 'none' && egress.length > 0) {
      // `none` blocks all internet, but the CLI still needs its model/auth
      // servers. Spin up the same squid gateway allowing ONLY those domains; the
      // internal api network is attached as a 2nd NIC (resolveApiConnectNetworks).
      gateway = await createEgressGateway({ domains: [...new Set(egress)], ips: [] });
    }

    if (spec.wrapperContent && spec.wrapperContent.trim().length > 0) {
      wrapperId = randomUUID();
      const fileName = 'wrapper.sh';
      wrapperWorkerPath = join(wrapperWorkerRoot, wrapperId, fileName);
      const wrapperSandboxPath = `${wrapperSandboxRoot}/${wrapperId}/${fileName}`;
      await mkdir(dirname(wrapperWorkerPath), { recursive: true });
      await writeFile(wrapperWorkerPath, normalizeWrapperContent(spec.wrapperContent), 'utf8');
      await chmod(wrapperWorkerPath, 0o755);
      resolvedCommand = wrapperSandboxPath;
    }

    if (spec.extraFiles && spec.extraFiles.length > 0) {
      assertNoAuthVolumeNesting(spec.extraFiles, mounts);
      // Docker rejects the WHOLE `docker run` with "Duplicate mount point" if two mounts
      // share a target, so one container path may be claimed only once. Independent mask
      // sources can legitimately pick the same file — `.ddev/traefik/certs/<project>.key`
      // is both a `#ddev-generated` file and a `**/*.key` secret — and neither knows what
      // the other selected. First entry wins, which makes the composition ORDER at the
      // call site the precedence rule: exec-core lists secret masks first, so an empty
      // secrecy mask always beats a real-bytes integrity mask on a collision (hiding the
      // contents also prevents writing them, so nothing is lost either way).
      const deduped = dedupeExtraFilesByPath(spec.extraFiles);
      for (let i = 0; i < deduped.length; i++) {
        const ef = deduped[i]!;
        const efId = randomUUID();
        const efDir = join(wrapperWorkerRoot, efId);
        const efHostPath = join(efDir, `extra-${i}`);
        await mkdir(efDir, { recursive: true });
        await writeFile(efHostPath, ef.content, 'utf8');
        extraFileDirs.push(efDir);
        mounts.push({
          source: volumeName,
          subpath: `${efId}/extra-${i}`,
          target: ef.containerPath,
          readOnly: true,
        });
      }
    }

    // Writable capture dir: mount a fresh per-run subdir of the wrappers volume at
    // `containerDir` so the CLI can write its log into it (agy reports provider-fatal
    // errors ONLY to its log, exiting 0). Chowned to the sandbox uid because the CLI
    // runs as node; read back + cleaned up after the run.
    if (spec.captureDir) {
      const captureId = randomUUID();
      captureHostDir = join(wrapperWorkerRoot, captureId);
      await mkdir(captureHostDir, { recursive: true });
      await chown(captureHostDir, SANDBOX_UID, SANDBOX_GID).catch((err: unknown) => {
        log.warn({ err, captureHostDir }, 'failed to chown capture dir');
      });
      mounts.push({
        source: volumeName,
        subpath: captureId,
        target: spec.captureDir.containerDir,
        readOnly: false,
      });
    }

    const modelsHost = inStackModelsHost(spec.env);
    const network = resolveDockerNetwork(policy, gateway);
    const env = mergeProxyEnv(spec.env, gateway, modelsHost, options.noProxyHosts ?? []);

    // Per-container caps for the CLI-exec sandbox (same governor as the runtime runners;
    // null when disabled). The per-task tasks.memoryLimitMb/cpuLimitMilli override — which
    // POST /tasks resourceLimits was built for — applies here.
    const sandboxCaps = options.taskId ? await resolveRunnerCaps(options.taskId) : null;

    const result = await runner.run({
      image,
      cmd: [resolvedCommand, ...spec.args],
      env,
      mounts,
      workdir,
      network,
      connectNetworks: resolveApiConnectNetworks(policy, gateway, modelsHost !== null),
      addHosts: options.addHosts,
      user: 'node',
      labels:
        options.taskId || options.invocationId
          ? {
              ...(options.taskId ? { 'haive.task.id': options.taskId } : {}),
              ...(options.invocationId ? { 'haive.invocation.id': options.invocationId } : {}),
            }
          : undefined,
      ...(sandboxCaps
        ? {
            memoryLimitMb: sandboxCaps.memoryMb,
            cpuLimitMilli: Math.round(sandboxCaps.cpus * 1000),
            pidsLimit: sandboxCaps.pidsLimit,
          }
        : {}),
      timeoutMs: spec.timeoutMs,
      onStdoutChunk: spec.onStdoutChunk,
      onStderrChunk: spec.onStderrChunk,
      signal: spec.signal,
      interactive: spec.interactive,
      stdinInitial: spec.stdinInitial,
      onStdinWritable: spec.onStdinWritable,
    });
    // Read the captured log back out of the volume (best-effort, tail-capped). Done
    // before the `finally` removes the dir. A missing file (CLI wrote nothing) or a
    // read error yields null — never throws.
    let capturedLog: string | null = null;
    if (captureHostDir && spec.captureDir) {
      capturedLog = await readFile(join(captureHostDir, spec.captureDir.fileName), 'utf8')
        .then((t) => (t.length > CAPTURE_TAIL_LIMIT ? t.slice(-CAPTURE_TAIL_LIMIT) : t))
        .catch(() => null);
    }
    return { ...result, resolvedCommand, wrapperId, capturedLog };
  } finally {
    if (wrapperWorkerPath) {
      const wrapperDir = dirname(wrapperWorkerPath);
      rm(wrapperDir, { recursive: true, force: true }).catch((err: unknown) => {
        log.warn({ err, wrapperDir }, 'failed to cleanup wrapper dir');
      });
    }
    for (const efDir of extraFileDirs) {
      rm(efDir, { recursive: true, force: true }).catch((err: unknown) => {
        log.warn({ err, efDir }, 'failed to cleanup extra file dir');
      });
    }
    if (captureHostDir) {
      rm(captureHostDir, { recursive: true, force: true }).catch((err: unknown) => {
        log.warn({ err, captureHostDir }, 'failed to cleanup capture dir');
      });
    }
    if (gateway) {
      gateway.cleanup().catch((err: unknown) => {
        log.warn({ err }, 'egress gateway cleanup failed');
      });
    }
  }
}

/** The sandbox's PRIMARY network, which governs internet egress per policy:
 *  allowlist / none-with-egress → the squid gateway net; full → default bridge;
 *  none-without-egress → SANDBOX_NETWORK itself (Docker forbids a 2nd network on
 *  a 'none'-mode container, so the internal api net IS the sole network — api
 *  access, no internet). The internal api net is attached as a 2nd NIC in every
 *  case EXCEPT that last one (see resolveApiConnectNetworks). */
function resolveDockerNetwork(
  policy: CliNetworkPolicy | null,
  gateway: EgressGateway | null,
): string | undefined {
  if (gateway) return gateway.networkName; // allowlist: squid egress (proxied internet)
  if (policy?.mode === 'none') return process.env.SANDBOX_NETWORK || 'none';
  return undefined; // 'full' / null: default bridge (NAT internet)
}

/** The internal api-only network attached as a SECOND NIC so the sandbox can
 *  reach rag_search's API target regardless of its internet policy — postgres/
 *  redis are NOT on it. Skipped only for a gateway-less 'none' run, where
 *  SANDBOX_NETWORK is already the sole (primary) network; a gatewayed 'none'
 *  (CLI egress domains set) attaches it as a second NIC like every other policy.
 *  Also empty when SANDBOX_NETWORK is unset. */
function resolveApiConnectNetworks(
  policy: CliNetworkPolicy | null,
  gateway: EgressGateway | null,
  attachModels: boolean,
): string[] {
  const sandboxNet = process.env.SANDBOX_NETWORK;
  const modelsNet = process.env.SANDBOX_MODELS_NETWORK;
  // Gateway-less 'none' makes SANDBOX_NETWORK the sole PRIMARY network (see
  // resolveDockerNetwork), so it is not re-added here as a 2nd NIC. If
  // SANDBOX_NETWORK is also unset the primary is literally 'none' and Docker
  // forbids attaching any further network.
  const noneNoGateway = policy?.mode === 'none' && !gateway;
  const primaryIsNone = noneNoGateway && !sandboxNet;
  const nets: string[] = [];
  if (sandboxNet && !noneNoGateway) nets.push(sandboxNet);
  // Ollama-backed CLIs (ANTHROPIC_BASE_URL → in-stack daemon) also join the
  // models network so they can reach http://ollama:11434 directly.
  if (attachModels && modelsNet && !primaryIsNone) nets.push(modelsNet);
  return nets;
}

/** The bypass list is built HERE rather than by the caller because this function overwrites
 *  any NO_PROXY already in `spec.env` — an upstream value would be silently dropped. */
function mergeProxyEnv(
  base: Record<string, string> | undefined,
  gateway: EgressGateway | null,
  modelsHost: string | null,
  extraNoProxyHosts: string[],
): Record<string, string> | undefined {
  if (!gateway) return base;
  const proxyUrl = gateway.proxyUrl;
  // `api` is reached directly over the internal sandbox<->API network, never via
  // the squid proxy (which only allows the user's allowlisted domains). An
  // in-stack Ollama host is likewise reached directly over the models network.
  // The thinking-disable proxy is an internal sandbox-network hostname (like
  // `api`), reached directly — never via the squid allowlist proxy.
  const noProxyHosts = [
    'localhost',
    '127.0.0.1',
    '::1',
    'api',
    OLLAMA_THINKING_PROXY_HOST,
    // Same shape as the thinking proxy: an internal sandbox-network hostname the
    // claude binary must reach directly. It forwards to openrouter.ai itself, so
    // the user's egress allowlist still governs what actually leaves the stack.
    OPENROUTER_COMPAT_PROXY_HOST,
  ];
  if (modelsHost) noProxyHosts.push(modelsHost);
  // The task's own runtime: an internal hostname on the sandbox network, same shape as the
  // two proxies above. Asked of squid it would be denied — the allow-set covers the user's
  // external domains, and this host is not one of them.
  noProxyHosts.push(...extraNoProxyHosts);
  const noProxy = [...new Set(noProxyHosts)].join(',');
  return {
    ...(base ?? {}),
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  };
}

function normalizeWrapperContent(content: string): string {
  const withShebang = content.startsWith('#!') ? content : `#!/bin/bash\n${content}`;
  return withShebang.endsWith('\n') ? withShebang : `${withShebang}\n`;
}
