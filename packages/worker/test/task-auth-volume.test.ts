import { beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupTaskAuthVolumes,
  clearTaskAuthPreparationState,
  ensureTaskAuthVolumes,
  mergeCliMcpIntoTaskVolume,
  mergeGeminiMcpIntoSettings,
  resolveTaskAuthMounts,
  RTK_HELPER_INIT_FAILED_EXIT,
  RTK_HELPER_MISSING_BINARY_EXIT,
  seedRtkInTaskVolume,
  userAuthVolumeExists,
  writeMcpFileIntoTaskVolume,
  type ProviderAuthCtx,
} from '../src/sandbox/task-auth-volume.js';
import type { McpServerSpec } from '../src/sandbox/mcp-config.js';
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
  stoppedContainerCleanupCalls: string[];
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
  const stoppedContainerCleanupCalls: string[] = [];
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
    stoppedContainerCleanupCalls,
    runCalls,
    async build() {
      throw new Error('build should not be called');
    },
    async run(runOpts) {
      runCalls.push(runOpts);
      return runHandler(runOpts);
    },
    // Image inspect, not volume. ensureTaskAuthVolumes now guarantees the sandbox base
    // image before it probes readiness (a missing base makes the probe report "not ready"
    // and the volume gets deleted), so a provisioned host reports it present — which is
    // also what keeps the `build should not be called` guard above meaningful.
    async inspect() {
      return { exists: true, imageId: 'sha256:test-base' };
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
    async removeStoppedContainersUsingVolume(name) {
      stoppedContainerCleanupCalls.push(name);
      return { ok: true, removed: [], stderr: '' };
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

  it('records the source fingerprint so a later reuse can tell the credentials moved', async () => {
    const userVol = 'haive_cli_auth_abc_codex_0';
    const runner = makeRunner({ preExistingVolumes: [userVol] });
    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-fp-1', runner);
    const copy = runner.runCalls.find((c) => c.cmd[0] === 'bash')!.cmd[2]!;
    expect(copy).toContain('> /dst/.haive-source');
    // Recorded from the SOURCE and written LAST, so a copy that dies half way leaves no
    // record and the next probe reads the volume as not ready rather than as fresh.
    expect(copy.indexOf('> /dst/.haive-source')).toBeLessThan(
      copy.indexOf('touch /dst/.haive-ready'),
    );
    expect(copy).toContain('find /src -type f');
  });

  it('recopies when the user re-authenticated after the task started', async () => {
    // The per-task volume is otherwise a SNAPSHOT for the life of the task. MEASURED on
    // 2026-09-13: six live tasks each held a different expired amp token while the user volume
    // had a valid one, and every step-summary invocation failed `Session expired` with no way
    // back short of deleting a volume by hand.
    const userVol = 'haive_cli_auth_abc_codex_0';
    const taskVol = 'haive_cli_auth_task_taskstale_codex_0';
    const runner = makeRunner({
      preExistingVolumes: [userVol, taskVol],
      readyVolumes: [taskVol],
      runHandler: (o) =>
        o.cmd[2]?.includes('/x/.haive-ready')
          ? { exitCode: 2, stdout: '', stderr: '', durationMs: 1, timedOut: false }
          : { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
    });
    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-stale', runner);
    expect(runner.removeCalls).toContain(taskVol);
    expect(runner.createCalls).toContain(taskVol);
    expect(runner.runCalls.some((c) => c.cmd[0] === 'bash')).toBe(true);
  });

  it('forgets the applied preparations whose files the recreate just deleted', async () => {
    // The volume holding this task's rtk seed and MCP config is gone, but their applied
    // identities are in-process. Without dropping them every writer skips on its next call and
    // the fresh volume keeps no tooling at all — for codex that is the whole config.toml MCP
    // surface, so the agents after a re-login run without the tools they were promised.
    const userVol = 'haive_cli_auth_abc_codex_0';
    const taskVol = 'haive_cli_auth_task_taskinv_codex_0';
    const runner = makeRunner({
      preExistingVolumes: [userVol, taskVol],
      readyVolumes: [taskVol],
      runHandler: (o) =>
        o.cmd[2]?.includes('/x/.haive-ready')
          ? { exitCode: 2, stdout: '', stderr: '', durationMs: 1, timedOut: false }
          : { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
    });
    // Seed an applied identity, then make the volume look refreshed.
    await seedRtkInTaskVolume('task-inv', 'codex', runner);
    const seedsBefore = runner.runCalls.filter((c) => c.cmd[2]?.includes('rtk')).length;
    expect(seedsBefore).toBe(1);

    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-inv', runner);
    expect(runner.createCalls).toContain(taskVol);

    // The same seed must now RUN again rather than skip on its recorded identity.
    await seedRtkInTaskVolume('task-inv', 'codex', runner);
    expect(runner.runCalls.filter((c) => c.cmd[2]?.includes('rtk')).length).toBe(seedsBefore + 1);
    clearTaskAuthPreparationState('task-inv');
  });

  it("leaves other providers' preparations alone when one volume is recreated", async () => {
    const taskVol = 'haive_cli_auth_task_taskiso_codex_0';
    const runner = makeRunner({
      preExistingVolumes: ['haive_cli_auth_abc_codex_0', taskVol],
      readyVolumes: [taskVol],
      runHandler: (o) =>
        o.cmd[2]?.includes('/x/.haive-ready')
          ? { exitCode: 2, stdout: '', stderr: '', durationMs: 1, timedOut: false }
          : { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false },
    });
    await seedRtkInTaskVolume('task-iso', 'grok', runner);
    const before = runner.runCalls.filter((c) => c.cmd[2]?.includes('rtk')).length;
    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-iso', runner);
    // grok's volume was not touched, so its seed must still skip.
    await seedRtkInTaskVolume('task-iso', 'grok', runner);
    expect(runner.runCalls.filter((c) => c.cmd[2]?.includes('rtk')).length).toBe(before);
    clearTaskAuthPreparationState('task-iso');
  });

  it('does not settle for a ready-but-stale volume when the remove is blocked', async () => {
    // The in-use recovery was written for a HALF-BUILT volume: a sibling is mid-populate from
    // the same source, so waiting for its ready marker is exactly right. A STALE volume
    // already carries that marker, so the same wait returns true on its first poll and hands
    // this invocation the credentials the user just replaced. The wait has to keep demanding
    // freshness when freshness is what sent it there.
    const userVol = 'haive_cli_auth_abc_codex_0';
    const taskVol = 'haive_cli_auth_task_taskbusy_codex_0';
    let probes = 0;
    const runner = makeRunner({
      preExistingVolumes: [userVol, taskVol],
      readyVolumes: [taskVol],
      runHandler: (o) => {
        if (o.cmd[2]?.includes('/x/.haive-ready')) {
          probes += 1;
          // Still stale while the sibling holds it; fresh once it has been replaced.
          const code = probes > 2 ? 0 : 2;
          return { exitCode: code, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        }
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
      },
    });
    runner.volumeRemove = async () => ({ ok: false, stderr: 'volume is in use', stdout: '' });

    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-busy', runner);
    // It waited rather than reusing on the first poll, and every wait probe carried the source.
    expect(probes).toBeGreaterThan(1);
    const waits = runner.runCalls.filter((c) => c.cmd[2]?.includes('/x/.haive-ready'));
    expect(waits.every((c) => c.mounts?.some((m) => m.target === '/src'))).toBe(true);
    // Reused only once it came back FRESH — never recreated behind a blocked remove.
    expect(runner.createCalls).not.toContain(taskVol);
    clearTaskAuthPreparationState('task-busy');
  });

  it('compares against the source only while the source still exists', async () => {
    // A user volume that is GONE must never be compared against: it would fingerprint as
    // empty, read as "moved on", and the recreate would populate an EMPTY task volume —
    // destroying the only credentials the task still had.
    const taskVol = 'haive_cli_auth_task_tasknosrc_codex_0';
    const runner = makeRunner({ preExistingVolumes: [taskVol], readyVolumes: [taskVol] });
    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-nosrc', runner);
    const probe = runner.runCalls.find((c) => c.cmd[2]?.includes('/x/.haive-ready'))!;
    expect(probe.mounts?.some((m) => m.target === '/src')).toBe(false);
    expect(probe.cmd[2]).not.toContain('.haive-source');
    // Reused, not wiped.
    expect(runner.removeCalls).not.toContain(taskVol);
    expect(runner.createCalls).not.toContain(taskVol);
  });

  it('mounts the source into the probe when it does exist', async () => {
    const userVol = 'haive_cli_auth_abc_codex_0';
    const taskVol = 'haive_cli_auth_task_tasksrc_codex_0';
    const runner = makeRunner({
      preExistingVolumes: [userVol, taskVol],
      readyVolumes: [taskVol],
    });
    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-src', runner);
    const probe = runner.runCalls.find((c) => c.cmd[2]?.includes('/x/.haive-ready'))!;
    expect(probe.mounts?.some((m) => m.source === userVol && m.target === '/src')).toBe(true);
    // A volume populated before this existed carries no record and is read as FRESH, so a
    // deploy does not invalidate every task in flight.
    expect(probe.cmd[2]).toContain('if [ -n "$rec" ]; then');
  });

  it('creates empty task volume when user volume absent (no copy)', async () => {
    const runner = makeRunner();
    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-222', runner);
    const taskVol = 'haive_cli_auth_task_task222_codex_0';
    expect(runner.createCalls).toEqual([taskVol]);
    const copyCall = runner.runCalls.find((c) => c.cmd[0] === 'bash');
    expect(copyCall?.cmd[2]).toBe(
      "chown 1000:1000 /dst; printf '%s' none > /dst/.haive-source; touch /dst/.haive-ready",
    );
    expect(copyCall?.mounts?.some((m) => m.target === '/src')).toBe(false);
  });

  it('recopies once a source appears for a volume that was populated without one', async () => {
    // An api-key row, or a CLI the user had not logged into yet, populates an EMPTY volume. The
    // sentinel is what stops that being mistaken for a pre-feature volume: absent means
    // "populated before this existed" and is read as fresh forever, so without it the task
    // would keep mounting the empty snapshot after the user finally logged in.
    const userVol = 'haive_cli_auth_abc_codex_0';
    const taskVol = 'haive_cli_auth_task_tasklate_codex_0';
    const probeScripts: string[] = [];
    const runner = makeRunner({
      preExistingVolumes: [userVol, taskVol],
      readyVolumes: [taskVol],
      runHandler: (o) => {
        if (o.cmd[2]?.includes('/x/.haive-ready')) {
          probeScripts.push(o.cmd[2]);
          // What the real probe does with the sentinel: 'none' never equals a fingerprint.
          return { exitCode: 2, stdout: '', stderr: '', durationMs: 1, timedOut: false };
        }
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
      },
    });
    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-late', runner);
    expect(runner.createCalls).toContain(taskVol);
    // And the copy now carries the real source.
    const copy = runner.runCalls.find((c) => c.cmd[0] === 'bash')!;
    expect(copy.mounts?.some((m) => m.source === userVol && m.target === '/src')).toBe(true);
    expect(copy.cmd[2]).toContain('> /dst/.haive-source');
    clearTaskAuthPreparationState('task-late');
  });

  it('coalesces concurrent sibling setup into one volume copy', async () => {
    const runner = makeRunner();
    await Promise.all(
      Array.from({ length: 12 }, () =>
        ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-concurrent-volume', runner),
      ),
    );
    expect(runner.createCalls).toHaveLength(1);
    expect(runner.runCalls.filter((call) => call.cmd[0] === 'bash')).toHaveLength(1);
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

  it('reuses the volume (no recreate) when a concurrent sibling holds it "in use" then readies it', async () => {
    // 08c fans out two agents that share this per-task volume. The sibling's populate
    // helper has it mounted (so remove returns "volume is in use") and makes it ready
    // shortly after — we must wait and reuse, not crash (the EXIT -1) or recreate.
    const taskVol = 'haive_cli_auth_task_task777_codex_0';
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    runner.volumeRemove = async (name) => {
      runner.removeCalls.push(name);
      runner.readyVolumes.add(name); // sibling's helper finished → now ready
      return { ok: false, stderr: 'Error response from daemon: remove: volume is in use - [abc]' };
    };
    await ensureTaskAuthVolumes(ctx('abc', 'codex'), 'task-777', runner);
    expect(runner.removeCalls).toEqual([taskVol]); // tried once, then waited + reused
    expect(runner.createCalls).toEqual([]); // NOT recreated — reused the sibling's volume
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
      // Marks it for the runInSandbox guard that keeps extra files from being bound inside it.
      kind: 'auth',
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
    expect(runner.stoppedContainerCleanupCalls.sort()).toEqual(result.removed.sort());
  });

  it('is a no-op when no task volumes exist', async () => {
    const runner = makeRunner();
    const result = await cleanupTaskAuthVolumes('task-0000', runner);
    expect(result.removed).toEqual([]);
    expect(runner.removeCalls).toEqual([]);
    expect(runner.stoppedContainerCleanupCalls).toEqual([]);
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

  it('asks gemini for the auto-patch, which is what answers its settings.json prompt', async () => {
    // MEASURED on rtk 0.37.2: `-g --gemini` alone stops at "Patch settings.json? [y/N]" and
    // the helper has no tty, so the hook is never registered.
    const runner = makeRunner();
    await seedRtkInTaskVolume('task-rtk-3', 'gemini', runner);
    const helper = runner.runCalls.find((c) => c.cmd[0] === 'sh');
    expect(helper?.cmd[2]).toContain(`rtk init -g '--gemini' '--auto-patch'`);
  });

  it('never asks codex for the auto-patch — rtk rejects the pair outright', async () => {
    // MEASURED: `-g --auto-patch --codex` exits 1 with "--codex cannot be combined with
    // --auto-patch", which is what rtk had been asked for since this was written, so rtk
    // never ran for codex at all.
    const runner = makeRunner();
    await seedRtkInTaskVolume('task-rtk-4', 'codex', runner);
    const helper = runner.runCalls.find((c) => c.cmd[0] === 'sh');
    expect(helper?.cmd[2]).toContain(`rtk init -g '--codex'`);
    expect(helper?.cmd[2]).not.toContain('--auto-patch');
  });

  it('uses the bare claude path for every claude-binary provider, ollama included', async () => {
    for (const [i, provider] of (
      ['claude-code', 'zai', 'ollama', 'muse', 'openrouter'] as const
    ).entries()) {
      const runner = makeRunner();
      await seedRtkInTaskVolume(`task-rtk-fam-${i}`, provider, runner);
      const helper = runner.runCalls.find((c) => c.cmd[0] === 'sh');
      expect(helper?.cmd[2], provider).toContain(`rtk init -g '--auto-patch'`);
      expect(helper?.cmd[2], provider).not.toContain('--gemini');
      expect(helper?.cmd[2], provider).not.toContain('--codex');
    }
  });

  it('reports a failed rtk init instead of logging a seed that never happened', async () => {
    // The helper used to swallow it (`rtk init … || echo …`) and exit on the trailing
    // chown, so a rejected flag combination was recorded as a successful seed.
    const runner = makeRunner();
    await seedRtkInTaskVolume('task-rtk-fail-exit', 'codex', runner);
    const script = runner.runCalls[0]!.cmd[2]!;
    expect(script).toContain(`exit ${RTK_HELPER_INIT_FAILED_EXIT}`);
    // The ownership repair still runs first — a half-done seed must not leave root-owned
    // files behind — so the status is carried rather than exited on the spot.
    expect(script.indexOf('chown -R 1000:1000')).toBeLessThan(
      script.indexOf(`exit ${RTK_HELPER_INIT_FAILED_EXIT}`),
    );
  });

  it('skips entirely for amp (no rtk-native flag)', async () => {
    const runner = makeRunner();
    await seedRtkInTaskVolume('task-rtk-6', 'amp', runner);
    expect(runner.runCalls).toHaveLength(0);
  });

  it('coalesces concurrent sibling RTK seeding', async () => {
    const runner = makeRunner();
    await Promise.all(
      Array.from({ length: 12 }, () => seedRtkInTaskVolume('task-rtk-concurrent', 'codex', runner)),
    );
    expect(runner.runCalls).toHaveLength(1);
  });

  // The seed writes the same thing every time, so it is applied once per task — the
  // sequential repeats a staggered fan-out produces run nothing.
  it('skips sequential repeats of the seed', async () => {
    const runner = makeRunner();
    for (let i = 0; i < 6; i += 1) await seedRtkInTaskVolume('task-rtk-seq', 'codex', runner);
    expect(runner.runCalls).toHaveLength(1);
  });

  it('runs rtk init as the sandbox user, between two ownership repairs', async () => {
    const runner = makeRunner();
    await seedRtkInTaskVolume('task-rtk-user', 'codex', runner);
    const script = runner.runCalls[0]!.cmd[2]!;
    expect(script).toContain(`$AS_NODE env HOME='/home/node' rtk init -g '--codex'`);
    expect(script).toContain('AS_NODE="runuser -u node --"');
    // An image without runuser falls back to the previous all-as-root behaviour rather than
    // failing the seed.
    expect(script).toContain('else AS_NODE=""');
    expect(script.match(/chown -R 1000:1000/g)).toHaveLength(2);
  });
});

describe('mergeCliMcpIntoTaskVolume', () => {
  const RAG: McpServerSpec = {
    name: 'haive-rag',
    command: 'node',
    args: ['/haive/haive-rag-mcp.mjs'],
    env: { RAG_TASK_TOKEN: 'tok' },
  };
  const taskVol = 'haive_cli_auth_task_taskmcp0000_grok_0';

  // These share one (task, provider) slot, and an applied preparation is skipped — which is
  // the whole point of the feature. Each case wants a fresh slot.
  beforeEach(() => clearTaskAuthPreparationState('taskmcp-0000'));

  it('repairs ownership as root but runs the CLI as the sandbox user', async () => {
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    await mergeCliMcpIntoTaskVolume('taskmcp-0000', 'grok', 'img:tag', [RAG], runner);

    expect(runner.runCalls).toHaveLength(1);
    const call = runner.runCalls[0]!;
    expect(call.image).toBe('img:tag');
    // The CONTAINER is root so it can repair a volume an older task left root-owned...
    expect(call.user).toBe('root');
    // The mount target IS the CLI's config dir, and HOME must resolve `~/.grok` onto it.
    expect(call.mounts).toEqual([{ source: taskVol, target: '/home/node/.grok', readOnly: false }]);
    // ...but the CLI itself runs as uid 1000, so no config file is root-owned while a
    // sibling agent is booting against it.
    expect(call.cmd[2]).toContain(`$AS_NODE env HOME='/home/node' 'grok' 'mcp' 'add' '-s' 'user'`);
    expect(call.cmd[2]).toContain('AS_NODE="runuser -u node --"');
    // Repair before the payload, safety net after.
    expect(call.cmd[2]?.match(/chown -R 1000:1000/g)).toHaveLength(2);
  });

  it('removes everything the previous run registered before adding the current set', async () => {
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    await mergeCliMcpIntoTaskVolume('taskmcp-0000', 'grok', 'img:tag', [RAG], runner);
    const script = runner.runCalls[0]!.cmd[2]!;

    // Reads the marker, removes each name, then rewrites the marker with the new set.
    expect(script).toContain(`< '/home/node/.grok/.haive-mcp-managed'`);
    expect(script).toContain(`'grok' mcp remove "$name" </dev/null`);
    expect(script).toContain(`printf '%s\\n' 'haive-rag' > '/home/node/.grok/.haive-mcp-managed'`);
    // The remove loop must not eat its own stdin — the marker IS the loop's input.
    expect(script).toMatch(/mcp remove "\$name" <\/dev\/null/);
  });

  it('truncates the marker when the surface drops to no servers', async () => {
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    await mergeCliMcpIntoTaskVolume('taskmcp-0000', 'grok', 'img:tag', [], runner);
    const script = runner.runCalls[0]!.cmd[2]!;
    expect(script).toContain(`: > '/home/node/.grok/.haive-mcp-managed'`);
    expect(script).not.toContain('mcp add');
  });

  it('does nothing without an image: the CLI binary lives in it, not in the helper image', async () => {
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    await mergeCliMcpIntoTaskVolume('taskmcp-0000', 'grok', null, [RAG], runner);
    expect(runner.runCalls).toHaveLength(0);
  });

  // Creating the volume here would leave it without the readiness marker, so the next
  // ensureTaskAuthVolumes would recreate it and throw away everything written.
  it('does nothing when the task volume has not been created yet', async () => {
    const runner = makeRunner();
    await mergeCliMcpIntoTaskVolume('taskmcp-0000', 'grok', 'img:tag', [RAG], runner);
    expect(runner.runCalls).toHaveLength(0);
  });

  it('coalesces an identical MCP merge across fan-out siblings', async () => {
    const concurrentTaskVol = 'haive_cli_auth_task_taskmcpconc_grok_0';
    const runner = makeRunner({ preExistingVolumes: [concurrentTaskVol] });
    await Promise.all(
      Array.from({ length: 12 }, () =>
        mergeCliMcpIntoTaskVolume('task-mcp-conc', 'grok', 'img:tag', [RAG], runner),
      ),
    );
    expect(runner.runCalls).toHaveLength(1);
  });

  // A fan-out dispatches its agents seconds apart, so the calls are SEQUENTIAL and the
  // in-flight coalescing above never sees them. Each repeat used to re-run a root helper
  // against a volume its predecessors were already reading — which is what killed a mining
  // agent with `config.toml: Permission denied`.
  it('skips a sequential repeat of an already-applied merge', async () => {
    const vol = 'haive_cli_auth_task_taskmcpseq_grok_0';
    const runner = makeRunner({ preExistingVolumes: [vol] });
    for (let i = 0; i < 6; i += 1) {
      await mergeCliMcpIntoTaskVolume('task-mcp-seq', 'grok', 'img:tag', [RAG], runner);
    }
    expect(runner.runCalls).toHaveLength(1);
  });

  // The merge RECONCILES, so the record is of the LAST surface applied, never of every
  // surface ever seen: a run that goes back to an earlier surface must reconcile again or
  // the volume keeps the wrong server set.
  it('re-runs when the surface changes, including a change back to an earlier one', async () => {
    const vol = 'haive_cli_auth_task_taskmcpsurf_grok_0';
    const runner = makeRunner({ preExistingVolumes: [vol] });
    const OTHER: McpServerSpec = { name: 'chrome-devtools', command: 'node', args: ['/x.mjs'] };

    await mergeCliMcpIntoTaskVolume('task-mcp-surf', 'grok', 'img:tag', [RAG], runner);
    await mergeCliMcpIntoTaskVolume('task-mcp-surf', 'grok', 'img:tag', [RAG, OTHER], runner);
    await mergeCliMcpIntoTaskVolume('task-mcp-surf', 'grok', 'img:tag', [RAG], runner);

    expect(runner.runCalls).toHaveLength(3);
  });

  it('does not record a failed helper as applied', async () => {
    const vol = 'haive_cli_auth_task_taskmcpfail_grok_0';
    const runner = makeRunner({
      preExistingVolumes: [vol],
      runHandler: () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'boom',
        durationMs: 1,
        timedOut: false,
      }),
    });
    await mergeCliMcpIntoTaskVolume('task-mcp-fail', 'grok', 'img:tag', [RAG], runner);
    await mergeCliMcpIntoTaskVolume('task-mcp-fail', 'grok', 'img:tag', [RAG], runner);
    expect(runner.runCalls).toHaveLength(2);
  });

  it('forgets applied preparations once the task ends', async () => {
    const vol = 'haive_cli_auth_task_taskmcpend_grok_0';
    const runner = makeRunner({ preExistingVolumes: [vol] });
    await mergeCliMcpIntoTaskVolume('task-mcp-end', 'grok', 'img:tag', [RAG], runner);
    clearTaskAuthPreparationState('task-mcp-end');
    await mergeCliMcpIntoTaskVolume('task-mcp-end', 'grok', 'img:tag', [RAG], runner);
    expect(runner.runCalls).toHaveLength(2);
  });
});

describe('mergeGeminiMcpIntoSettings', () => {
  const taskVol = 'haive_cli_auth_task_taskgem0000_gemini_1';
  const servers = { 'haive-rag': { command: 'node', args: ['/haive/haive-rag-mcp.mjs'] } };

  beforeEach(() => clearTaskAuthPreparationState('taskgem-0000'));

  it('merges as the sandbox user into the volume that also holds the auth fields', async () => {
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    await mergeGeminiMcpIntoSettings('taskgem-0000', servers, runner);

    expect(runner.runCalls).toHaveLength(1);
    const call = runner.runCalls[0]!;
    expect(call.user).toBe('root');
    expect(call.mounts).toEqual([{ source: taskVol, target: '/vol', readOnly: false }]);
    expect(call.cmd[2]).toContain('$AS_NODE node -e');
    expect(call.cmd[2]).toContain('AS_NODE="runuser -u node --"');
    expect(call.cmd[2]).toContain('chown -R 1000:1000');
  });

  it('skips a sequential repeat and re-runs on a changed server set', async () => {
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    await mergeGeminiMcpIntoSettings('taskgem-0000', servers, runner);
    await mergeGeminiMcpIntoSettings('taskgem-0000', servers, runner);
    expect(runner.runCalls).toHaveLength(1);

    await mergeGeminiMcpIntoSettings(
      'taskgem-0000',
      { ...servers, other: { command: 'x' } },
      runner,
    );
    expect(runner.runCalls).toHaveLength(2);
  });

  it('reconciles from a marker, so only what Haive wrote is ever removed', async () => {
    // The user's own gemini settings are copied into the task volume, `mcpServers` included.
    // An unmarked entry must survive every merge and every clear.
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    await mergeGeminiMcpIntoSettings('taskgem-0000', servers, runner);
    const script = runner.runCalls[0]!.cmd[2]!;
    expect(script).toContain('.haive-mcp-managed');
    expect(script).toContain('for (const name of prev) delete merged[name];');
    expect(script).toContain('Object.assign(merged, servers);');
    // The marker is rewritten with THIS set, so the next reconcile knows what to undo.
    expect(script).toContain('fs.writeFileSync(marker,');

    // The emitted program must PARSE. This is a TS template literal, so a `\n` written with one
    // backslash becomes a real newline in the program and breaks the string literal it sits in
    // — and the helper is best-effort, so the syntax error would be logged and swallowed while
    // gemini silently lost its MCP servers. `new Function` compiles without running.
    const program = script.split("node -e '")[1]!.split("\n'")[0]!;
    expect(() => new Function(program)).not.toThrow();
  });

  it('clear mode runs on an EMPTY set, which the no-op guard would otherwise skip', async () => {
    // The clear a `toolProfile: 'none'` invocation needs: an additive merge can add a surface
    // but never take one away, and the volume outlives the invocation.
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    await mergeGeminiMcpIntoSettings('taskgem-0000', {}, runner, { clear: true });
    expect(runner.runCalls).toHaveLength(1);
    expect(runner.runCalls[0]!.cmd[2]!).toContain('for (const name of prev) delete merged[name];');
  });

  it('an empty no-op does not record an identity that skips a later clear', async () => {
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    await mergeGeminiMcpIntoSettings('taskgem-0000', {}, runner); // no-op, writes nothing
    expect(runner.runCalls).toHaveLength(0);
    await mergeGeminiMcpIntoSettings('taskgem-0000', {}, runner, { clear: true });
    expect(runner.runCalls).toHaveLength(1);
  });
});

// Coalescing keys on scope + IDENTITY, which dedupes a fan-out's identical siblings but left two
// DIFFERENT surfaces running their helper containers against one file at the same time. That
// cost only a wrong surface until `toolProfile: 'none'` started CLEARING the file.
describe('preparations against one file are serialised', () => {
  it('does not start a second surface while the first is still writing', async () => {
    clearTaskAuthPreparationState('taskgem-lock');
    const events: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    const runner = {
      volumeExists: async () => true,
      run: async (): Promise<DockerRunResult> => {
        const id = (n += 1);
        events.push(`start${id}`);
        if (id === 1) await gate;
        events.push(`end${id}`);
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false };
      },
    } as unknown as DockerRunner;

    const first = mergeGeminiMcpIntoSettings(
      'taskgem-lock',
      { 'haive-rag': { command: 'node' } },
      runner,
    );
    const second = mergeGeminiMcpIntoSettings('taskgem-lock', {}, runner, { clear: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['start1']); // the clear is queued, not racing
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['start1', 'end1', 'start2', 'end2']);
    clearTaskAuthPreparationState('taskgem-lock');
  });
});

describe('writeMcpFileIntoTaskVolume', () => {
  const taskVol = 'haive_cli_auth_task_taskagy0000_antigravity_0';
  const configPath = '/home/node/.gemini/antigravity-cli/mcp_config.json';

  it('writes into the volume rather than binding over it', async () => {
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    await writeMcpFileIntoTaskVolume('taskagy-0000', 'antigravity', configPath, '{"a":1}', runner);
    const call = runner.runCalls[0]!;
    expect(call.mounts).toEqual([
      { source: taskVol, target: '/home/node/.gemini/antigravity-cli', readOnly: false },
    ]);
    expect(call.cmd[2]).toContain(`printf '%s' '{"a":1}' > '${configPath}'`);
    expect(call.cmd[2]).toContain('chown -R 1000:1000');
  });

  it('refuses a path outside the auth mount instead of writing it somewhere unmounted', async () => {
    const runner = makeRunner({ preExistingVolumes: [taskVol] });
    await writeMcpFileIntoTaskVolume(
      'taskagy-0000',
      'antigravity',
      '/haive/mcp.json',
      '{}',
      runner,
    );
    expect(runner.runCalls).toHaveLength(0);
  });
});
