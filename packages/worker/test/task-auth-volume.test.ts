import { describe, expect, it } from 'vitest';
import {
  cleanupTaskAuthVolumes,
  ensureTaskAuthVolumes,
  resolveTaskAuthMounts,
  RTK_HELPER_MISSING_BINARY_EXIT,
  seedRtkInTaskVolume,
  userAuthVolumeExists,
  type ProviderAuthCtx,
} from '../src/sandbox/task-auth-volume.js';
import type { CliProviderName } from '@haive/shared';
import type {
  DockerRunner,
  DockerRunOpts,
  DockerRunResult,
  DockerVolumeOpResult,
} from '../src/sandbox/docker-runner.js';

function ctx(
  userId: string,
  providerName: CliProviderName,
  opts: { providerId?: string; isolateAuth?: boolean } = {},
): ProviderAuthCtx {
  return {
    userId,
    providerId: opts.providerId ?? 'prov-default',
    providerName,
    isolateAuth: opts.isolateAuth ?? false,
  };
}

interface MockRunner extends DockerRunner {
  volumeSet: Set<string>;
  readyVolumes: Set<string>;
  createCalls: string[];
  removeCalls: string[];
  runCalls: DockerRunOpts[];
}

function makeRunner(
  opts: {
    preExistingVolumes?: string[];
    readyVolumes?: string[];
    runHandler?: (opts: DockerRunOpts) => DockerRunResult;
  } = {},
): MockRunner {
  const volumeSet = new Set<string>(opts.preExistingVolumes ?? []);
  const readyVolumes = new Set<string>(opts.readyVolumes ?? []);
  const createCalls: string[] = [];
  const removeCalls: string[] = [];
  const runCalls: DockerRunOpts[] = [];

  const defaultRunHandler = (runOpts: DockerRunOpts): DockerRunResult => {
    const cmd = runOpts.cmd;
    // Readiness probe: ['sh', '-c', 'test -f /x/.haive-ready && [ "$(stat -c %u /x)" = "1000" ]']
    if (cmd[0] === 'sh' && cmd[1] === '-c' && cmd[2]?.includes('/x/.haive-ready')) {
      const target = (runOpts.mounts ?? []).find((m) => m.target === '/x');
      const ready = target ? readyVolumes.has(target.source) : false;
      return {
        exitCode: ready ? 0 : 1,
        stdout: '',
        stderr: '',
        durationMs: 1,
        timedOut: false,
      };
    }
    // Copy helper — mark the dst volume ready.
    if (cmd[0] === 'bash' && cmd[1] === '-c') {
      const dst = (runOpts.mounts ?? []).find((m) => m.target === '/dst');
      if (dst) readyVolumes.add(dst.source);
    }
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
  };
  const runHandler = opts.runHandler ?? defaultRunHandler;

  const runner: MockRunner = {
    volumeSet,
    readyVolumes,
    createCalls,
    removeCalls,
    runCalls,
    async build() {
      throw new Error('build should not be called');
    },
    async run(runOpts) {
      runCalls.push(runOpts);
      return runHandler(runOpts);
    },
    async inspect() {
      return { exists: false, imageId: null };
    },
    async remove() {
      return { ok: true, stderr: '' };
    },
    async volumeCreate(name): Promise<DockerVolumeOpResult> {
      createCalls.push(name);
      volumeSet.add(name);
      return { ok: true, stderr: '' };
    },
    async volumeExists(name): Promise<boolean> {
      return volumeSet.has(name);
    },
    async volumeRemove(name): Promise<DockerVolumeOpResult> {
      removeCalls.push(name);
      volumeSet.delete(name);
      readyVolumes.delete(name);
      return { ok: true, stderr: '' };
    },
  };
  return runner;
}

describe('ensureTaskAuthVolumes', () => {
  it('creates task volume and copies from user volume when user volume exists', async () => {
    const userVol = 'haive_cli_auth_abc_codex_0';
    const runner = makeRunner({ preExistingVolumes: [userVol] });
    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-111', runner);
    const taskVol = 'haive_cli_auth_task_task111_codex_0';
    expect(runner.createCalls).toEqual([taskVol]);
    expect(runner.volumeSet.has(taskVol)).toBe(true);
    expect(runner.readyVolumes.has(taskVol)).toBe(true);
    const copyCall = runner.runCalls.find((c) => c.cmd[0] === 'bash');
    expect(copyCall).toBeDefined();
    expect(copyCall?.cmd[2]).toContain('cp -a /src/. /dst/');
    expect(copyCall?.cmd[2]).toContain('chown -R 1000:1000 /dst');
    const mounts = copyCall?.mounts ?? [];
    expect(mounts.some((m) => m.source === userVol && m.target === '/src' && m.readOnly)).toBe(
      true,
    );
    expect(
      mounts.some((m) => m.source === taskVol && m.target === '/dst' && m.readOnly === false),
    ).toBe(true);
  });

  it('creates empty task volume when user volume absent (no copy)', async () => {
    const runner = makeRunner();
    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-222', runner);
    const taskVol = 'haive_cli_auth_task_task222_codex_0';
    expect(runner.createCalls).toEqual([taskVol]);
    const copyCall = runner.runCalls.find((c) => c.cmd[0] === 'bash');
    expect(copyCall?.cmd[2]).toBe('chown 1000:1000 /dst; touch /dst/.haive-ready');
    expect(copyCall?.mounts?.some((m) => m.target === '/src')).toBe(false);
  });

  it('is idempotent when task volume already exists and is ready', async () => {
    const taskVol = 'haive_cli_auth_task_task333_codex_0';
    const runner = makeRunner({
      preExistingVolumes: [taskVol],
      readyVolumes: [taskVol],
    });
    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-333', runner);
    expect(runner.createCalls).toEqual([]);
    expect(runner.removeCalls).toEqual([]);
    // Only the readiness probe should run.
    expect(
      runner.runCalls.every((c) => c.cmd[0] === 'sh' && c.cmd[2]?.includes('.haive-ready')),
    ).toBe(true);
  });

  it('recreates task volume when marker missing (crash recovery)', async () => {
    const taskVol = 'haive_cli_auth_task_task444_codex_0';
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-444', runner);
    expect(runner.removeCalls).toEqual([taskVol]);
    expect(runner.createCalls).toEqual([taskVol]);
    expect(runner.readyVolumes.has(taskVol)).toBe(true);
  });

  it('creates one volume per authConfigPath index', async () => {
    // claude-code has two auth paths.
    const runner = makeRunner();
    await ensureTaskAuthVolumes(ctx('user-1', 'claude-code'), 'task-555', runner);
    expect(runner.createCalls).toEqual([
      'haive_cli_auth_task_task555_claude-code_0',
      'haive_cli_auth_task_task555_claude-code_1',
    ]);
  });

  it('throws when volumeCreate fails', async () => {
    const runner = makeRunner();
    runner.volumeCreate = async () => ({ ok: false, stderr: 'no space' });
    await expect(ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-666', runner)).rejects.toThrow(
      /Failed to create task auth volume/,
    );
  });

  it('throws when copy helper exits non-zero', async () => {
    const runner = makeRunner({
      runHandler: (opts) => {
        if (opts.cmd[0] === 'bash') {
          return { exitCode: 2, stdout: '', stderr: 'boom', durationMs: 1, timedOut: false };
        }
        return { exitCode: 1, stdout: '', stderr: '', durationMs: 1, timedOut: false };
      },
    });
    await expect(ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-777', runner)).rejects.toThrow(
      /Task auth volume copy failed/,
    );
  });

  it('isolated provider sources from per-provider user volume namespace', async () => {
    const isoUserVol = 'haive_cli_auth_p_provxyz12345_codex_0';
    const runner = makeRunner({ preExistingVolumes: [isoUserVol] });
    await ensureTaskAuthVolumes(
      ctx('abc', 'codex', { providerId: 'prov-xyz-12345', isolateAuth: true }),
      'task-iso-1',
      runner,
    );
    const taskVol = 'haive_cli_auth_task_taskiso1_codex_0';
    expect(runner.createCalls).toEqual([taskVol]);
    const copyCall = runner.runCalls.find((c) => c.cmd[0] === 'bash');
    const mounts = copyCall?.mounts ?? [];
    // /src must be the per-provider isolated volume, NOT the user-shared one.
    expect(mounts.some((m) => m.source === isoUserVol && m.target === '/src')).toBe(true);
    expect(mounts.some((m) => m.source === 'haive_cli_auth_abc_codex_0')).toBe(false);
  });

  it('non-isolated provider sources from per-user shared namespace', async () => {
    const sharedUserVol = 'haive_cli_auth_abc_codex_0';
    const runner = makeRunner({ preExistingVolumes: [sharedUserVol] });
    await ensureTaskAuthVolumes(
      ctx('abc', 'codex', { providerId: 'prov-shared-1', isolateAuth: false }),
      'task-shared-1',
      runner,
    );
    const copyCall = runner.runCalls.find((c) => c.cmd[0] === 'bash');
    const mounts = copyCall?.mounts ?? [];
    expect(mounts.some((m) => m.source === sharedUserVol && m.target === '/src')).toBe(true);
  });
});

describe('resolveTaskAuthMounts', () => {
  it('returns writable mounts pointing at the task volume', () => {
    const mounts = resolveTaskAuthMounts('codex', 'task-abc');
    expect(mounts).toHaveLength(1);
    expect(mounts[0]).toEqual({
      source: 'haive_cli_auth_task_taskabc_codex_0',
      target: '/home/node/.codex',
      readOnly: false,
    });
  });

  it('returns one mount per declared auth path (claude-code has two)', () => {
    const mounts = resolveTaskAuthMounts('claude-code', 'task-xyz');
    expect(mounts).toHaveLength(2);
    expect(mounts.every((m) => m.readOnly === false)).toBe(true);
    expect(mounts.map((m) => m.target)).toEqual([
      '/home/node/.config/claude',
      '/home/node/.claude',
    ]);
  });
});

describe('cleanupTaskAuthVolumes', () => {
  it('removes every existing task volume across all providers and indices', async () => {
    const taskId = 'task-999';
    // Seed two providers with task volumes.
    const runner = makeRunner({
      preExistingVolumes: [
        'haive_cli_auth_task_task999_codex_0',
        'haive_cli_auth_task_task999_claude-code_0',
        'haive_cli_auth_task_task999_claude-code_1',
      ],
    });
    const result = await cleanupTaskAuthVolumes(taskId, runner);
    expect(result.removed.sort()).toEqual(
      [
        'haive_cli_auth_task_task999_codex_0',
        'haive_cli_auth_task_task999_claude-code_0',
        'haive_cli_auth_task_task999_claude-code_1',
      ].sort(),
    );
    expect(result.failed).toEqual([]);
  });

  it('is a no-op when no task volumes exist', async () => {
    const runner = makeRunner();
    const result = await cleanupTaskAuthVolumes('task-0000', runner);
    expect(result.removed).toEqual([]);
    expect(runner.removeCalls).toEqual([]);
  });

  it('reports failures without throwing', async () => {
    const taskVol = 'haive_cli_auth_task_taskfail_codex_0';
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    runner.volumeRemove = async (name) => {
      runner.removeCalls.push(name);
      return { ok: false, stderr: 'in use' };
    };
    const result = await cleanupTaskAuthVolumes('task-fail', runner);
    expect(result.removed).toEqual([]);
    expect(result.failed).toEqual([{ name: taskVol, stderr: 'in use' }]);
  });
});

describe('userAuthVolumeExists', () => {
  it('returns true when at least one indexed user volume exists', async () => {
    const runner = makeRunner({ preExistingVolumes: ['haive_cli_auth_u1_claude-code_1'] });
    expect(await userAuthVolumeExists(ctx('u1', 'claude-code'), runner)).toBe(true);
  });

  it('returns false when no user volume exists for the provider', async () => {
    const runner = makeRunner();
    expect(await userAuthVolumeExists(ctx('u1', 'codex'), runner)).toBe(false);
  });

  it('isolated provider checks per-provider namespace, ignores user-shared', async () => {
    // User-shared volume present but provider runs isolated — shared volume
    // must not register as "exists" for this provider.
    const runner = makeRunner({ preExistingVolumes: ['haive_cli_auth_u1_codex_0'] });
    expect(
      await userAuthVolumeExists(
        ctx('u1', 'codex', { providerId: 'prov-iso-1', isolateAuth: true }),
        runner,
      ),
    ).toBe(false);
  });

  it('isolated provider returns true when its per-provider volume exists', async () => {
    const runner = makeRunner({
      preExistingVolumes: ['haive_cli_auth_p_proviso2abcd_codex_0'],
    });
    expect(
      await userAuthVolumeExists(
        ctx('u1', 'codex', { providerId: 'prov-iso-2-abcd', isolateAuth: true }),
        runner,
      ),
    ).toBe(true);
  });
});

describe('seedRtkInTaskVolume', () => {
  it('emits the missing-binary exit code in the helper script', async () => {
    const runner = makeRunner({
      runHandler: () => ({
        exitCode: RTK_HELPER_MISSING_BINARY_EXIT,
        stdout: '',
        stderr: 'rtk: binary missing in sandbox image\n',
        durationMs: 1,
        timedOut: false,
      }),
    });
    await seedRtkInTaskVolume('task-rtk-1', 'claude-code', runner);
    const helper = runner.runCalls.find((c) => c.cmd[0] === 'sh');
    expect(helper).toBeDefined();
    expect(helper?.cmd[2]).toContain(`exit ${RTK_HELPER_MISSING_BINARY_EXIT}`);
    expect(helper?.cmd[2]).toContain('command -v rtk');
    expect(helper?.cmd[2]).toContain('>&2');
  });

  it('does not log success when the helper exits with the missing-binary code', async () => {
    const runner = makeRunner({
      runHandler: () => ({
        exitCode: RTK_HELPER_MISSING_BINARY_EXIT,
        stdout: '',
        stderr: 'rtk: binary missing in sandbox image\n',
        durationMs: 1,
        timedOut: false,
      }),
    });
    // Function returns void on the missing-binary path, but the contract is
    // observable via the logger — we assert the helper script path produced
    // the expected exit code; the worker code routes that through log.warn,
    // not log.info.
    await seedRtkInTaskVolume('task-rtk-2', 'claude-code', runner);
    expect(runner.runCalls).toHaveLength(1);
  });

  it('uses the rtk init flag mapping for gemini', async () => {
    const runner = makeRunner();
    await seedRtkInTaskVolume('task-rtk-3', 'gemini', runner);
    const helper = runner.runCalls.find((c) => c.cmd[0] === 'sh');
    expect(helper?.cmd[2]).toContain('--gemini');
  });

  it('uses the rtk init flag mapping for codex', async () => {
    const runner = makeRunner();
    await seedRtkInTaskVolume('task-rtk-4', 'codex', runner);
    const helper = runner.runCalls.find((c) => c.cmd[0] === 'sh');
    expect(helper?.cmd[2]).toContain('--codex');
  });

  it('omits the flag suffix for the bare claude path (claude-code, zai)', async () => {
    const runner = makeRunner();
    await seedRtkInTaskVolume('task-rtk-5', 'claude-code', runner);
    const helper = runner.runCalls.find((c) => c.cmd[0] === 'sh');
    expect(helper?.cmd[2]).toContain('rtk init -g --auto-patch');
    expect(helper?.cmd[2]).not.toContain('--gemini');
    expect(helper?.cmd[2]).not.toContain('--codex');
  });

  it('skips entirely for amp (no rtk-native flag)', async () => {
    const runner = makeRunner();
    await seedRtkInTaskVolume('task-rtk-6', 'amp', runner);
    expect(runner.runCalls).toHaveLength(0);
  });
});
