import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { logger } from '@haive/shared';
import { renderSquidConfig } from './squid-config.js';

const log = logger.child({ module: 'egress-gateway' });

const SQUID_IMAGE = process.env.SANDBOX_SQUID_IMAGE ?? 'ubuntu/squid:latest';
const CONFIG_VOLUME = process.env.SANDBOX_SQUID_CONFIG_VOLUME ?? 'haive_squid_configs';
const CONFIG_WORKER_ROOT =
  process.env.SANDBOX_SQUID_CONFIG_WORKER_PATH ?? '/var/lib/haive/squid-configs';
const CONFIG_SANDBOX_ROOT = '/haive/squid-config';
const SQUID_PORT = 3128;
const SQUID_READY_TIMEOUT_MS = 15_000;
const SQUID_UPSTREAM_NETWORK = process.env.SANDBOX_SQUID_UPSTREAM_NETWORK ?? 'bridge';

export interface EgressGatewayOptions {
  domains: string[];
  ips: string[];
}

export interface EgressGateway {
  networkName: string;
  proxyHost: string;
  proxyPort: number;
  proxyUrl: string;
  cleanup: () => Promise<void>;
}

type LifecycleStage =
  | 'init'
  | 'config_written'
  | 'network_created'
  | 'squid_created'
  | 'squid_connected'
  | 'squid_started';

export async function createEgressGateway(opts: EgressGatewayOptions): Promise<EgressGateway> {
  const id = randomUUID();
  const networkName = `haive-egress-${id}`;
  const squidName = `haive-squid-${id}`;
  const configWorkerDir = join(CONFIG_WORKER_ROOT, id);
  const configWorkerPath = join(configWorkerDir, 'squid.conf');
  const configSandboxPath = `${CONFIG_SANDBOX_ROOT}/squid.conf`;

  let stage: LifecycleStage = 'init';

  const cleanup = async (): Promise<void> => {
    if (stage === 'squid_started' || stage === 'squid_connected' || stage === 'squid_created') {
      try {
        await runDocker(['rm', '-f', squidName], { ignoreFailure: true });
      } catch (err) {
        log.warn({ err, squidName }, 'failed to remove squid container');
      }
    }
    if (stage !== 'init' && stage !== 'config_written') {
      try {
        await runDocker(['network', 'rm', networkName], { ignoreFailure: true });
      } catch (err) {
        log.warn({ err, networkName }, 'failed to remove egress network');
      }
    }
    try {
      await rm(configWorkerDir, { recursive: true, force: true });
    } catch (err) {
      log.warn({ err, configWorkerDir }, 'failed to clean up squid config dir');
    }
  };

  try {
    await mkdir(configWorkerDir, { recursive: true });
    const config = renderSquidConfig({ domains: opts.domains, ips: opts.ips });
    await writeFile(configWorkerPath, config, 'utf8');
    stage = 'config_written';

    await runDocker(['network', 'create', '--internal', networkName]);
    stage = 'network_created';

    await runDocker([
      'create',
      '--name',
      squidName,
      '--network',
      networkName,
      '--mount',
      `type=volume,source=${CONFIG_VOLUME},destination=${CONFIG_SANDBOX_ROOT},volume-subpath=${id},readonly`,
      SQUID_IMAGE,
      '-N',
      '-d',
      '1',
      '-f',
      configSandboxPath,
    ]);
    stage = 'squid_created';

    await runDocker(['network', 'connect', SQUID_UPSTREAM_NETWORK, squidName]);
    stage = 'squid_connected';

    await runDocker(['start', squidName]);
    stage = 'squid_started';

    await waitForSquidReady(squidName, SQUID_READY_TIMEOUT_MS);

    log.info(
      { networkName, squidName, domains: opts.domains.length, ips: opts.ips.length },
      'egress gateway ready',
    );

    return {
      networkName,
      proxyHost: squidName,
      proxyPort: SQUID_PORT,
      proxyUrl: `http://${squidName}:${SQUID_PORT}`,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function waitForSquidReady(containerName: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastLog = '';
  while (Date.now() < deadline) {
    const result = await runDocker(['logs', containerName], { ignoreFailure: true });
    lastLog = `${result.stdout}\n${result.stderr}`;
    if (/Accepting\s+HTTP\s+Socket\s+connections/i.test(lastLog)) return;
    if (/FATAL/i.test(lastLog)) {
      throw new Error(`squid startup failed:\n${tail(lastLog, 1000)}`);
    }
    const inspect = await runDocker(
      ['inspect', '--format', '{{.State.Running}} {{.State.ExitCode}}', containerName],
      { ignoreFailure: true },
    );
    if (inspect.exitCode === 0 && inspect.stdout.trim().startsWith('false ')) {
      throw new Error(`squid container exited before becoming ready:\n${tail(lastLog, 1000)}`);
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`squid not ready after ${timeoutMs}ms; last logs:\n${tail(lastLog, 1000)}`);
}

function tail(text: string, length: number): string {
  return text.length > length ? text.slice(-length) : text;
}

interface DockerResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface DockerOpts {
  ignoreFailure?: boolean;
  timeoutMs?: number;
}

function runDocker(args: string[], opts: DockerOpts = {}): Promise<DockerResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result: DockerResult = { exitCode: code, stdout, stderr };
      if (code === 0 || opts.ignoreFailure) {
        resolve(result);
        return;
      }
      reject(
        new Error(
          `docker ${args.join(' ')} failed: exit ${code}${stderr ? `, stderr: ${tail(stderr, 500)}` : ''}`,
        ),
      );
    });
  });
}
