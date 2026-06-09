import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chmod } from 'node:fs/promises';
import { logger, type CliNetworkPolicy } from '@haive/shared';
import {
  defaultDockerRunner,
  type DockerRunner,
  type DockerRunResult,
  type DockerVolumeMount,
} from './docker-runner.js';
import { createEgressGateway, type EgressGateway } from './egress-gateway.js';

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

    const network = resolveDockerNetwork(policy, gateway);
    const env = mergeProxyEnv(spec.env, gateway);

    const result = await runner.run({
      image,
      cmd: [resolvedCommand, ...spec.args],
      env,
      mounts,
      workdir,
      network,
      connectNetworks: resolveApiConnectNetworks(policy, gateway),
      user: 'node',
      labels: options.taskId ? { 'haive.task.id': options.taskId } : undefined,
      timeoutMs: spec.timeoutMs,
      onStdoutChunk: spec.onStdoutChunk,
      onStderrChunk: spec.onStderrChunk,
      signal: spec.signal,
    });
    return { ...result, resolvedCommand, wrapperId };
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
): string[] {
  if (policy?.mode === 'none' && !gateway) return [];
  return process.env.SANDBOX_NETWORK ? [process.env.SANDBOX_NETWORK] : [];
}

function mergeProxyEnv(
  base: Record<string, string> | undefined,
  gateway: EgressGateway | null,
): Record<string, string> | undefined {
  if (!gateway) return base;
  const proxyUrl = gateway.proxyUrl;
  // `api` is reached directly over the internal sandbox<->API network, never via
  // the squid proxy (which only allows the user's allowlisted domains).
  const noProxy = 'localhost,127.0.0.1,::1,api';
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
