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
const SANDBOX_UID = 1000;
const SANDBOX_GID = 1000;
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
      for (let i = 0; i < spec.extraFiles.length; i++) {
        const ef = spec.extraFiles[i]!;
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
    const env = mergeProxyEnv(spec.env, gateway, modelsHost);

    const result = await runner.run({
      image,
      cmd: [resolvedCommand, ...spec.args],
      env,
      mounts,
      workdir,
      network,
      connectNetworks: resolveApiConnectNetworks(policy, gateway, modelsHost !== null),
      user: 'node',
      labels: options.taskId ? { 'haive.task.id': options.taskId } : undefined,
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

function mergeProxyEnv(
  base: Record<string, string> | undefined,
  gateway: EgressGateway | null,
  modelsHost: string | null,
): Record<string, string> | undefined {
  if (!gateway) return base;
  const proxyUrl = gateway.proxyUrl;
  // `api` is reached directly over the internal sandbox<->API network, never via
  // the squid proxy (which only allows the user's allowlisted domains). An
  // in-stack Ollama host is likewise reached directly over the models network.
  // The thinking-disable proxy is an internal sandbox-network hostname (like
  // `api`), reached directly — never via the squid allowlist proxy.
  const noProxyHosts = ['localhost', '127.0.0.1', '::1', 'api', OLLAMA_THINKING_PROXY_HOST];
  if (modelsHost) noProxyHosts.push(modelsHost);
  const noProxy = noProxyHosts.join(',');
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
