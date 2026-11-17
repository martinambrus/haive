import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BINARY_MISSING_EXIT } from '../src/sandbox/binary-missing.js';
import { SandboxToolchainProbe } from '../src/sandbox/toolchain-probe.js';
import { fakeDockerRunner } from './fake-docker-runner.js';

it.each([true, false])(
  'a blocking php shim exits without the Docker client (timeout available: %s)',
  async (hasTimeout) => {
    const dir = await mkdtemp(join(tmpdir(), 'toolchain-watchdog-'));
    try {
      await writeFile(join(dir, 'php'), '#!/bin/sh\nexec /bin/sleep 30\n', { mode: 0o755 });
      await symlink('/bin/sleep', join(dir, 'sleep'));
      if (hasTimeout) await symlink('/usr/bin/timeout', join(dir, 'timeout'));
      let script = '';
      const probe = new SandboxToolchainProbe(
        fakeDockerRunner({
          run: async (opts) => {
            script = opts.cmd[1]!;
            // A PID namespace's init ignores an unhandled SIGKILL from its own children.
            // Model that restriction on the host; the deadline must still work.
            if (!hasTimeout)
              script =
                'kill() { if [ "$1" = "-KILL" ] && [ "$2" = "$$" ]; then return 1; fi; command kill "$@"; };\n' +
                script;
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0 };
          },
        }),
      );
      await probe.get(`sha256:${'a'.repeat(64)}`);
      const result = await new Promise<{
        deadline: boolean;
        code: number | null;
        signal: string | null;
      }>((resolve) => {
        const child = spawn('/bin/sh', ['-c', script], {
          env: { PATH: dir },
          stdio: 'ignore',
          detached: true,
        });
        let deadline = false;
        const timer = setTimeout(() => {
          deadline = true;
          process.kill(-child.pid!, 'SIGKILL');
        }, 2500);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          // A host process has no container PID namespace to reap its descendants.
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {}
          resolve({ deadline, code, signal });
        });
      });
      expect(result.deadline).toBe(false);
      // The exit status of a killed `timeout` depends on its implementation: GNU coreutils
      // signals its own process group and dies by SIGKILL, uutils exits with a status. Either
      // way the probe must read it as neither PHP found (0) nor PHP missing.
      expect(result.signal !== null || result.code !== null).toBe(true);
      expect(result.code).not.toBe(0);
      expect(result.code).not.toBe(BINARY_MISSING_EXIT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
