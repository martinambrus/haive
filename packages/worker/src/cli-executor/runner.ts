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
  /** Interactive mode: open a writable stdin pipe instead of ignoring stdin,
   *  so the caller can stream input to the running CLI (mid-run steering).
   *  Default off keeps stdin 'ignore' (the proven one-shot path). */
  interactive?: boolean;
  /** Written to the child's stdin immediately after spawn (e.g. the prompt as
   *  an NDJSON user-message). Only used when interactive. */
  stdinInitial?: string;
  /** Receives the child's writable stdin so a caller can inject more input
   *  mid-run. Only invoked when interactive. */
  onStdinWritable?: (writable: NodeJS.WritableStream) => void;
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

    const interactive = opts.interactive === true;
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    if (interactive && child.stdin) {
      // Swallow EPIPE on stdin: a steer write may race the stream closing
      // (process exits / we end it), and an unhandled 'error' on the stdin
      // stream would crash the worker process.
      child.stdin.on('error', () => {});
      if (opts.stdinInitial) child.stdin.write(opts.stdinInitial);
      opts.onStdinWritable?.(child.stdin);
    }

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
