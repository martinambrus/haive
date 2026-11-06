import { spawn } from 'node:child_process';

// Volatile Docker daemon wording for a local image inspect, with exit 1 and no spawn error.
export const LOCAL_IMAGE_NOT_FOUND = /No such image/i;

// Preserve each caller's output cap while sharing cancellation and process cleanup.
export function createCapture(outputMiB) {
  return function capture(command, args, { timeout, signal, ...options }) {
    return new Promise((resolveResult) => {
      const stdout = [];
      const stderr = [];
      let error;
      let bytes = 0;
      let forceTimer;
      const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = (cause) => {
        error ??= cause;
        child.kill('SIGTERM');
        forceTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000);
      };
      const abort = () => stop(new Error('interrupted'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(
        () => stop(Object.assign(new Error('command timed out'), { code: 'ETIMEDOUT' })),
        timeout,
      );
      const collect = (chunks) => (chunk) => {
        bytes += chunk.length;
        if (bytes > outputMiB * 1024 * 1024)
          stop(new Error(`command output exceeded ${outputMiB} MiB`));
        else chunks.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.on('error', (cause) => {
        error = cause;
      });
      child.on('close', (status) => {
        clearTimeout(timer);
        clearTimeout(forceTimer);
        signal?.removeEventListener('abort', abort);
        resolveResult({
          status,
          error,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
  };
}
