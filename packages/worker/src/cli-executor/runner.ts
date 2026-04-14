import { spawn } from 'node:child_process';
import type { CliCommandSpec } from '../cli-adapters/types.js';

export interface CliExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

export interface SpawnOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
}

export type CliSpawner = (spec: CliCommandSpec, opts?: SpawnOptions) => Promise<CliExecutionResult>;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export const defaultCliSpawner: CliSpawner = (spec, opts = {}) => {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<CliExecutionResult>((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';

    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const abortHandler = () => {
      child.kill('SIGTERM');
    };
    opts.signal?.addEventListener('abort', abortHandler, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      opts.onStdoutChunk?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      opts.onStderrChunk?.(text);
    });

    const finish = (result: CliExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abortHandler);
      resolve(result);
    };

    child.on('error', (err) => {
      finish({
        exitCode: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        error: err.message,
      });
    });
    child.on('close', (code) => {
      finish({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
};
