import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@haive/shared';
import type { MountSpec, RunContainerOptions } from '@haive/shared';

const execFileAsync = promisify(execFile);
const log = logger.child({ module: 'clawker-client' });

export class ClawkerBinaryMissingError extends Error {
  readonly code = 'clawker_binary_missing';
  constructor(public readonly binary: string) {
    super(
      `clawker binary not found at "${binary}". ` +
        `Install from https://github.com/schmitthub/clawker or set CLAWKER_BIN to an absolute path.`,
    );
    this.name = 'ClawkerBinaryMissingError';
  }
}

export class ClawkerExecError extends Error {
  readonly code = 'clawker_exec_failed';
  constructor(
    public readonly args: readonly string[],
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: number | null,
    cause?: unknown,
  ) {
    const preview = stderr.trim() || stdout.trim() || `<no output; exit ${exitCode ?? 'null'}>`;
    super(`clawker ${args.slice(0, 2).join(' ')} failed: ${preview}`);
    this.name = 'ClawkerExecError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export interface ClawkerClientOptions {
  binary?: string;
  project?: string;
  defaultTimeoutMs?: number;
}

export interface ClawkerExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ClawkerRunParams extends RunContainerOptions {
  agent: string;
}

export interface ClawkerRunResult {
  agent: string;
  project: string;
  containerName: string;
  rawOutput: string;
}

export interface ClawkerBuildResult {
  imageTag: string;
  rawOutput: string;
}

export class ClawkerClient {
  readonly binary: string;
  readonly project: string;
  readonly defaultTimeoutMs: number;
  private availabilityState: 'unknown' | 'ok' | 'missing' = 'unknown';

  constructor(opts: ClawkerClientOptions = {}) {
    this.binary = opts.binary ?? process.env.CLAWKER_BIN ?? 'clawker';
    this.project = opts.project ?? process.env.CLAWKER_PROJECT ?? 'haive';
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
  }

  async ensureAvailable(): Promise<void> {
    if (this.availabilityState === 'ok') return;
    try {
      await execFileAsync(this.binary, ['--version'], { timeout: 5_000 });
      this.availabilityState = 'ok';
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      this.availabilityState = 'missing';
      if (e.code === 'ENOENT') {
        throw new ClawkerBinaryMissingError(this.binary);
      }
      throw new ClawkerExecError(['--version'], '', e.message, null, err);
    }
  }

  isKnownAvailable(): boolean {
    return this.availabilityState === 'ok';
  }

  async version(): Promise<string> {
    const { stdout } = await this.exec(['--version']);
    return stdout.trim();
  }

  async ensureProjectInitialized(
    repoPath: string,
    opts: { projectName?: string; overwrite?: boolean } = {},
  ): Promise<{ created: boolean; configPath: string }> {
    const project = opts.projectName ?? this.project;
    const configPath = join(repoPath, '.clawker.yaml');
    const exists = await pathExists(configPath);
    if (exists && !opts.overwrite) {
      return { created: false, configPath };
    }
    await writeFile(configPath, defaultClawkerYaml(project), 'utf8');
    log.info({ repoPath, project }, 'wrote default .clawker.yaml');
    return { created: true, configPath };
  }

  async build(
    repoPath: string,
    opts: { project?: string; timeoutMs?: number } = {},
  ): Promise<ClawkerBuildResult> {
    const project = opts.project ?? this.project;
    const { stdout } = await this.exec(['build', '--project', project], {
      cwd: repoPath,
      timeoutMs: opts.timeoutMs ?? 600_000,
    });
    return { imageTag: `clawker-${project}:latest`, rawOutput: stdout };
  }

  async run(params: ClawkerRunParams): Promise<ClawkerRunResult> {
    const project = params.project ?? this.project;
    const args = this.buildRunArgs({ ...params, project });
    const { stdout } = await this.exec(['run', ...args]);
    return {
      agent: params.agent,
      project,
      containerName: `clawker.${project}.${params.agent}`,
      rawOutput: stdout,
    };
  }

  attach(
    agent: string,
    opts: { project?: string; cmd?: string[] } = {},
  ): ChildProcessWithoutNullStreams {
    const project = opts.project ?? this.project;
    const args = ['attach', '--project', project, '--agent', agent];
    if (opts.cmd && opts.cmd.length > 0) {
      args.push('--', ...opts.cmd);
    }
    return spawn(this.binary, args, {
      stdio: 'pipe',
    }) as ChildProcessWithoutNullStreams;
  }

  async stop(agent: string, opts: { project?: string; timeoutSec?: number } = {}): Promise<void> {
    const project = opts.project ?? this.project;
    const args = ['container', 'stop', '--project', project, '--agent', agent];
    if (opts.timeoutSec !== undefined) {
      args.push('--time', String(opts.timeoutSec));
    }
    try {
      await this.exec(args);
    } catch (err) {
      if (err instanceof ClawkerExecError && isNotFoundStderr(err.stderr)) {
        return;
      }
      throw err;
    }
  }

  async destroy(agent: string, opts: { project?: string; force?: boolean } = {}): Promise<void> {
    const project = opts.project ?? this.project;
    const args = ['container', 'rm', '--project', project, '--agent', agent];
    if (opts.force ?? true) args.push('--force');
    try {
      await this.exec(args);
    } catch (err) {
      if (err instanceof ClawkerExecError && isNotFoundStderr(err.stderr)) {
        return;
      }
      throw err;
    }
  }

  async firewallAdd(domain: string): Promise<void> {
    await this.exec(['firewall', 'add', domain]);
  }

  async firewallRemove(domain: string): Promise<void> {
    await this.exec(['firewall', 'remove', domain]);
  }

  async firewallBypass(
    agent: string,
    duration: string,
    opts: { project?: string } = {},
  ): Promise<void> {
    const project = opts.project ?? this.project;
    await this.exec(['firewall', 'bypass', duration, '--project', project, '--agent', agent]);
  }

  async runRaw(
    args: readonly string[],
    options?: ClawkerExecOptions,
  ): Promise<{ stdout: string; stderr: string }> {
    return this.exec(args, options);
  }

  buildRunArgs(opts: ClawkerRunParams & { project: string }): string[] {
    const args: string[] = ['--project', opts.project, '--agent', opts.agent, '--detach'];
    if (opts.name) args.push('--name', opts.name);
    if (opts.workingDir) args.push('--workdir', opts.workingDir);
    if (opts.tty) args.push('--tty');
    if (opts.openStdin) args.push('--interactive');
    for (const [k, v] of Object.entries(opts.envVars ?? {})) {
      args.push('--env', `${k}=${v}`);
    }
    for (const m of opts.mounts ?? []) {
      args.push('--mount', formatMount(m));
    }
    for (const d of opts.allowedDomains ?? []) {
      args.push('--firewall-allow', d);
    }
    if (opts.memoryLimitMb !== undefined) {
      args.push('--memory', `${opts.memoryLimitMb}m`);
    }
    if (opts.cpuLimitMilli !== undefined) {
      args.push('--cpus', (opts.cpuLimitMilli / 1000).toFixed(3));
    }
    args.push(opts.image);
    if (opts.command && opts.command.length > 0) {
      args.push('--', ...opts.command);
    }
    return args;
  }

  private async exec(
    args: readonly string[],
    opts: ClawkerExecOptions = {},
  ): Promise<{ stdout: string; stderr: string }> {
    await this.ensureAvailable();
    try {
      const result = await execFileAsync(this.binary, [...args], {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? this.defaultTimeoutMs,
        env: { ...process.env, ...opts.env },
        maxBuffer: 32 * 1024 * 1024,
        signal: opts.signal,
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        code?: string | number;
      };
      if (e.code === 'ENOENT') {
        this.availabilityState = 'missing';
        throw new ClawkerBinaryMissingError(this.binary);
      }
      const stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? '');
      const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? e.message);
      throw new ClawkerExecError(
        args,
        stdout,
        stderr,
        typeof e.code === 'number' ? e.code : null,
        err,
      );
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isNotFoundStderr(stderr: string): boolean {
  return /no such container|not found|does not exist/i.test(stderr);
}

function formatMount(m: MountSpec): string {
  const parts: string[] = [`type=${m.mode}`, `source=${m.source}`, `target=${m.target}`];
  if (m.readOnly) parts.push('readonly');
  return parts.join(',');
}

function defaultClawkerYaml(project: string): string {
  return [
    `# Generated by @haive/worker ClawkerClient.ensureProjectInitialized`,
    `project: ${project}`,
    `base: debian`,
    `claude:`,
    `  copy_host_settings: false`,
    `  skip_permissions: false`,
    `firewall:`,
    `  enabled: true`,
    ``,
  ].join('\n');
}
