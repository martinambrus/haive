import type Docker from 'dockerode';
import { logger } from '@haive/shared';
import type { CliProviderName } from '@haive/shared';
import { buildMcpConfigForCli, type McpConfigFile, type McpServerSpec } from './mcp-config.js';

const log = logger.child({ module: 'mcp-injector' });

export interface InjectMcpConfigOptions {
  container: Docker.Container;
  cliProvider: CliProviderName;
  servers: McpServerSpec[];
  targetHome?: string;
}

export interface InjectMcpConfigResult {
  written: string | null;
  skipped: boolean;
  reason?: string;
}

export async function injectMcpConfig(
  opts: InjectMcpConfigOptions,
): Promise<InjectMcpConfigResult> {
  const config = buildMcpConfigForCli(opts.cliProvider, opts.servers, opts.targetHome);
  if (!config) {
    return { written: null, skipped: true, reason: 'no_mcp_support_or_empty_servers' };
  }

  try {
    await ensureParentDir(opts.container, config.path);
    await writeFileToContainer(opts.container, config);
    log.info(
      { cli: opts.cliProvider, path: config.path, format: config.format },
      'injected mcp config',
    );
    return { written: config.path, skipped: false };
  } catch (err) {
    log.warn({ err, cli: opts.cliProvider, path: config.path }, 'mcp config injection failed');
    return {
      written: null,
      skipped: true,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function ensureParentDir(container: Docker.Container, filePath: string): Promise<void> {
  const parent = dirname(filePath);
  if (parent === '/' || parent === '') return;
  const exitCode = await runExec(container, ['mkdir', '-p', parent]);
  if (exitCode !== 0) {
    throw new Error(`mkdir -p ${parent} failed with exit ${exitCode}`);
  }
}

async function writeFileToContainer(
  container: Docker.Container,
  config: McpConfigFile,
): Promise<void> {
  const exec = await container.exec({
    Cmd: ['sh', '-c', `cat > ${shellQuote(config.path)}`],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  stream.write(config.content);
  stream.end();
  await new Promise<void>((resolve, reject) => {
    stream.on('end', () => resolve());
    stream.on('error', (err) => reject(err));
    stream.resume();
  });
  const info = await exec.inspect();
  const code = info.ExitCode ?? -1;
  if (code !== 0) {
    throw new Error(`write failed with exit ${code}`);
  }
}

async function runExec(container: Docker.Container, cmd: string[]): Promise<number> {
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  await new Promise<void>((resolve, reject) => {
    stream.on('end', () => resolve());
    stream.on('error', (err) => reject(err));
    stream.resume();
  });
  const info = await exec.inspect();
  return info.ExitCode ?? -1;
}

function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
