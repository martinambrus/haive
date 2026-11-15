import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { DockerVolumeMount } from '../src/sandbox/docker-runner.js';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService, type CliExecInvocationKind, type CliExecJobPayload } from '@haive/shared';

// WORKER_REPO_STORAGE_ROOT is read from the environment once, at import time, so the
// fixture root has to exist and be exported before exec-core.js is pulled in.
const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-exec-boundary-'));
process.env.REPO_STORAGE_ROOT = storageRoot;

const stubs = vi.hoisted(() => ({
  runInSandbox: vi.fn(),
  error: null as Error | null,
  invocation: { repoMount: null as unknown, hasWorktree: false, hasRepo: true } as {
    repoMount: unknown;
    hasWorktree: boolean;
    hasRepo: boolean;
    workspaceKind?: string;
    baseMount?: DockerVolumeMount;
    snapshots?: { target: { tracked: Set<string> }; base: { tracked: Set<string> } };
  },
  ensureRepoMountWritable: vi.fn(),
  mcp: vi.fn(async (..._args: unknown[]) => ({ files: [], extraArgs: [] })),
}));

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    lstat: (...args: Parameters<typeof real.lstat>) => {
      if (stubs.error && String(args[0]).endsWith('/.git')) throw stubs.error;
      return real.lstat(...args);
    },
  };
});
afterEach(() => {
  stubs.error = null;
});

vi.mock('../src/sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox: stubs.runInSandbox,
}));
// Replaced whole, not spread over importOriginal: loading the real resolvers re-enters exec-core
// through a cycle, and the sub-agent runner then keeps the unmocked binding.
vi.mock('../src/queues/cli-exec/resolvers.js', () => ({
  WORKER_REPO_STORAGE_ROOT: process.env.REPO_STORAGE_ROOT,
  resolveInvocationRepoMount: async () => stubs.invocation,
  ensureRepoMountWritable: stubs.ensureRepoMountWritable,
  loadProviderRuntimeConfig: async () => ({
    wrapperContent: null,
    sandboxImage: null,
    networkPolicy: null,
    egressDomains: [],
  }),
  resolveAuthMounts: async () => [],
  resolveMcpExtraFiles: stubs.mcp,
  resolveEffectiveEgressDomains: () => [],
  networkPolicyReachesPackageRegistries: () => false,
  createStepStatusUpdater: () => undefined,
  tryJsonParse: (raw: string) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  },
}));
vi.mock('../src/queues/cli-exec/images.js', () => ({ resolveSandboxImageTag: async () => null }));
vi.mock('../src/queues/cli-exec/secret-mask.js', () => ({
  resolveSecretMasks: async () => [],
  assertPastedPersonasStillAllowed: async () => undefined,
}));
vi.mock('../src/queues/cli-exec/ddev-generated-mask.js', () => ({
  resolveDdevGeneratedMasks: async () => [],
}));
vi.mock('../src/queues/cli-exec/agent-definition-mask.js', () => ({
  resolveAgentDefinitionMasks: async () => ({ mounts: [], records: [] }),
  dropMasksUnderAgentDirs: (files: unknown[]) => files,
  removeAgentMaskStubs: async () => undefined,
}));
vi.mock('../src/queues/cli-exec/app-reach.js', () => ({ resolveAppReach: async () => null }));

const { executeByKind } = await import('../src/queues/cli-exec/exec-core.js');
const { NPM_CACHE_ENV, NPM_CACHE_SEED_PRELUDE, npmCacheMount } =
  await import('../src/sandbox/npm-cache.js');

const USER_ID = '11111111-1111-1111-1111-111111111111';
const REPO_ID = '22222222-2222-2222-2222-222222222222';
const SUBPATH = `${USER_ID}/${REPO_ID}`;
const WORKTREE_SUBPATH = `${SUBPATH}/.haive/worktrees/feature`;
const WORKDIR = '/haive/workdir';

const repoDir = path.join(storageRoot, SUBPATH);
const treeDir = path.join(repoDir, '.haive/worktrees/feature');

afterAll(async () => {
  await rm(storageRoot, { recursive: true, force: true });
});

const provider = {
  id: 'prov-1',
  name: 'claude-code',
  wrapperPath: null,
  wrapperContent: null,
  executablePath: null,
  cliArgs: [],
  envVars: {},
  effortLevel: null,
  model: null,
  networkPolicy: null,
  egressDomains: [],
};

// No invocation id: the stream, steer and supersede machinery stays out of a test that is about
// which mounts reach the sandbox.
const db = {
  query: {
    cliProviders: { findFirst: async () => provider },
    taskAttachments: { findMany: async () => [] },
  },
  update: () => ({ set: () => ({ where: async () => undefined }) }),
} as never;

const step = (id: string) => ({ id, prompt: id, expectJsonOutput: false });
const SPECS: Record<CliExecInvocationKind, unknown> = {
  cli: { command: 'claude', args: ['-p', 'x'], env: {} },
  agent_mining: { command: 'claude', args: ['-p', 'x'], env: {} },
  subagent_sequential: { mode: 'sequential', steps: [step('a')], synthesis: step('z') },
  subagent_native: { mode: 'native', steps: [step('a')], synthesis: step('z') },
};

const payloadFor = (kind: CliExecInvocationKind): CliExecJobPayload =>
  ({
    invocationId: '',
    taskId: 'task-1',
    taskStepId: null,
    userId: USER_ID,
    cliProviderId: 'prov-1',
    kind,
    spec: SPECS[kind],
    timeoutMs: 1000,
  }) as CliExecJobPayload;

const ro = (subpath: string, rel: string) => ({
  source: 'haive_repos',
  target: `${WORKDIR}/${rel}`,
  subpath: `${subpath}/${rel}`,
  readOnly: true,
});
const rw = (subpath: string, rel: string) => ({
  source: 'haive_repos',
  target: `${WORKDIR}/${rel}`,
  subpath: `${subpath}/${rel}`,
});

beforeEach(async () => {
  vi.spyOn(configService, 'getBoolean').mockResolvedValue(false);
  stubs.ensureRepoMountWritable.mockClear();
  stubs.mcp.mockClear();
  stubs.runInSandbox.mockReset();
  stubs.runInSandbox.mockResolvedValue({
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    resolvedCommand: 'claude',
    wrapperId: null,
  });
  await rm(repoDir, { recursive: true, force: true });
  for (const tree of [repoDir, treeDir]) {
    for (const name of ['state', 'knowledge_base', 'learnings']) {
      await mkdir(path.join(tree, '.haive-data', name), { recursive: true });
    }
  }
  await mkdir(path.join(repoDir, '.git'));
});

const KINDS: CliExecInvocationKind[] = [
  'cli',
  'agent_mining',
  'subagent_sequential',
  'subagent_native',
];

describe.each(KINDS)('exec-core, kind %s: the boundary mounts an agent sandbox gets', (kind) => {
  it.each(['EMFILE', 'ENFILE', 'EACCES', 'EIO'])(
    'starts no container when the .git lookup fails with %s',
    async (code) => {
      const repoMount = { source: 'haive_repos', target: WORKDIR, subpath: SUBPATH };
      stubs.invocation = { repoMount, hasWorktree: false, hasRepo: true };
      const err = Object.assign(new Error('injected boundary lookup failure'), { code });
      stubs.error = err;
      await expect(executeByKind(db, payloadFor(kind), {} as never, {})).rejects.toBe(err);
      expect(stubs.runInSandbox).not.toHaveBeenCalled();
    },
  );

  it.each(['ENOENT', 'ENOTDIR'])('runs without a .git boundary on %s', async (code) => {
    const repoMount = { source: 'haive_repos', target: WORKDIR, subpath: SUBPATH };
    stubs.invocation = { repoMount, hasWorktree: false, hasRepo: true };
    stubs.error = Object.assign(new Error('injected absent lookup'), { code });
    await executeByKind(db, payloadFor(kind), {} as never, {});
    expect(stubs.runInSandbox).toHaveBeenCalled();
    for (const [spec, options] of stubs.runInSandbox.mock.calls) {
      expect(options.extraMounts).not.toContainEqual(ro(SUBPATH, '.git'));
      expect(spec.extraFiles ?? []).not.toContainEqual({
        containerPath: `${WORKDIR}/.git`,
        content: '',
      });
    }
  });

  it('mounts .git, .haive-data and .haive/worktrees under the repository root, ahead of the repository mount', async () => {
    const repoMount = { source: 'haive_repos', target: WORKDIR, subpath: SUBPATH };
    stubs.invocation = { repoMount, hasWorktree: false, hasRepo: true };

    await executeByKind(db, payloadFor(kind), {} as never, {});

    expect(stubs.runInSandbox).toHaveBeenCalled();
    for (const [, options] of stubs.runInSandbox.mock.calls) {
      expect(options.extraMounts).toEqual([
        ro(SUBPATH, '.git'),
        ro(SUBPATH, '.haive-data'),
        rw(SUBPATH, '.haive-data/knowledge_base'),
        rw(SUBPATH, '.haive-data/learnings'),
        rw(SUBPATH, '.haive'),
        ro(SUBPATH, '.haive/worktrees'),
        repoMount,
        npmCacheMount(),
      ]);
    }
  });

  it('creates an absent .haive/worktrees before mounting it, and refuses to start on a link there', async () => {
    const repoMount = { source: 'haive_repos', target: WORKDIR, subpath: SUBPATH };
    stubs.invocation = { repoMount, hasWorktree: false, hasRepo: true };
    await rm(path.join(repoDir, '.haive'), { recursive: true });

    await executeByKind(db, payloadFor(kind), {} as never, {});

    expect((await lstat(path.join(repoDir, '.haive/worktrees'))).isDirectory()).toBe(true);
    for (const [, options] of stubs.runInSandbox.mock.calls) {
      expect(options.extraMounts).toContainEqual(ro(SUBPATH, '.haive/worktrees'));
    }

    stubs.runInSandbox.mockClear();
    await mkdir(path.join(repoDir, 'elsewhere/worktrees'), { recursive: true });
    await rm(path.join(repoDir, '.haive'), { recursive: true });
    await symlink(path.join(repoDir, 'elsewhere'), path.join(repoDir, '.haive'));

    await expect(executeByKind(db, payloadFor(kind), {} as never, {})).rejects.toThrow(
      /^\.haive in .* is a file or a link/,
    );
    expect(stubs.runInSandbox).not.toHaveBeenCalled();
    expect(await readdir(path.join(repoDir, 'elsewhere/worktrees'))).toEqual([]);
  });

  it('masks the worktree gitfile and mounts the worktree’s own .haive-data', async () => {
    const repoMount = { source: 'haive_repos', target: WORKDIR, subpath: WORKTREE_SUBPATH };
    stubs.invocation = { repoMount, hasWorktree: true, hasRepo: true };

    await executeByKind(db, payloadFor(kind), {} as never, {});

    expect(stubs.runInSandbox).toHaveBeenCalled();
    for (const [spec, options] of stubs.runInSandbox.mock.calls) {
      expect(options.extraMounts).toEqual([
        ro(WORKTREE_SUBPATH, '.haive-data'),
        rw(WORKTREE_SUBPATH, '.haive-data/knowledge_base'),
        rw(WORKTREE_SUBPATH, '.haive-data/learnings'),
        repoMount,
        npmCacheMount(),
      ]);
      expect(spec.extraFiles).toContainEqual({ containerPath: `${WORKDIR}/.git`, content: '' });
    }
  });

  it('seeds the private npm cache before the command runs, and points npm at it', async () => {
    const repoMount = { source: 'haive_repos', target: WORKDIR, subpath: SUBPATH };
    stubs.invocation = { repoMount, hasWorktree: false, hasRepo: true };

    await executeByKind(db, payloadFor(kind), {} as never, {});

    expect(stubs.runInSandbox).toHaveBeenCalled();
    for (const [spec] of stubs.runInSandbox.mock.calls) {
      expect(spec.prelude.startsWith(NPM_CACHE_SEED_PRELUDE)).toBe(true);
      expect(spec.env).toMatchObject(NPM_CACHE_ENV);
    }
  });

  it('mounts neither for a task with no repository', async () => {
    const scratchSubpath = `${USER_ID}/_scratch/33333333-3333-3333-3333-333333333333`;
    await mkdir(path.join(storageRoot, scratchSubpath), { recursive: true });
    const repoMount = { source: 'haive_repos', target: WORKDIR, subpath: scratchSubpath };
    stubs.invocation = { repoMount, hasWorktree: false, hasRepo: false };

    await executeByKind(db, payloadFor(kind), {} as never, {});

    expect(stubs.runInSandbox).toHaveBeenCalled();
    for (const [, options] of stubs.runInSandbox.mock.calls) {
      expect(options.extraMounts).toEqual([repoMount, npmCacheMount()]);
    }
  });
});

describe('committed snapshot execution admission', () => {
  it('NULL/NULL retains the normal live-checkout mount', async () => {
    const repoMount = { source: 'haive_repos', target: WORKDIR, subpath: SUBPATH };
    stubs.invocation = { repoMount, hasWorktree: false, hasRepo: true };
    await executeByKind(
      db,
      { ...payloadFor('agent_mining'), snapshotRef: null, baseSnapshotRef: null },
      {} as never,
      {},
    );
    expect(stubs.runInSandbox).toHaveBeenCalled();
    expect(stubs.runInSandbox.mock.calls[0]?.[1].extraMounts).toContainEqual(repoMount);
  });

  it.each(KINDS)(
    'mounts both pinned %s trees read-only with no writable metadata overlay',
    async (kind) => {
      const snapshotRef = {
        version: 1 as const,
        userId: randomUUID(),
        repositoryId: randomUUID(),
        taskId: randomUUID(),
        commitOid: 'a'.repeat(40),
        treeOid: 'b'.repeat(40),
        inventoryId: randomUUID(),
        inventorySha256: 'c'.repeat(64),
      };
      const repoMount = {
        source: 'haive_repos',
        target: WORKDIR,
        subpath: WORKTREE_SUBPATH,
        readOnly: true,
      };
      const baseMount = {
        source: 'haive_repos',
        target: '/haive/diff-base',
        subpath: `${SUBPATH}/base/tree`,
        readOnly: true,
      };
      stubs.invocation = {
        repoMount,
        hasWorktree: false,
        hasRepo: true,
        workspaceKind: 'snapshot',
        baseMount,
        snapshots: { target: { tracked: new Set(['.env']) }, base: { tracked: new Set() } },
      };
      await executeByKind(
        db,
        {
          ...payloadFor(kind),
          snapshotRef,
          baseSnapshotRef: { ...snapshotRef, inventoryId: randomUUID() },
        },
        {} as never,
        {},
      );
      expect(stubs.ensureRepoMountWritable).not.toHaveBeenCalled();
      expect(stubs.mcp.mock.calls[0]?.[5]).toBe('rag_only');
      expect(stubs.mcp.mock.calls[0]?.[10]).toBe('snapshot');
      expect(stubs.runInSandbox).toHaveBeenCalled();
      for (const [, options] of stubs.runInSandbox.mock.calls) {
        expect(options.extraMounts).toContainEqual(repoMount);
        expect(options.extraMounts).toContainEqual(baseMount);
        expect(
          options.extraMounts.filter((m: DockerVolumeMount) => m.target.startsWith(WORKDIR + '/')),
        ).toEqual([]);
      }
    },
  );
  it.skipIf(!process.env.SNAPSHOT_SANDBOX_TEST_IMAGE)(
    'enforces both actual Docker mounts and keeps metadata read-only',
    async () => {
      const run = promisify(execFile);
      const image = process.env.SNAPSHOT_SANDBOX_TEST_IMAGE!;
      const name = `committed-view-test-${randomUUID()}`;
      const baseRel = `${SUBPATH}/base/tree`;
      await mkdir(path.join(storageRoot, baseRel), { recursive: true });
      await writeFile(path.join(storageRoot, baseRel, 'content'), 'base');
      await writeFile(path.join(treeDir, 'content'), 'target');
      const target = {
        source: 'haive_repos',
        target: WORKDIR,
        subpath: WORKTREE_SUBPATH,
        readOnly: true,
      };
      const base = {
        source: 'haive_repos',
        target: '/haive/diff-base',
        subpath: baseRel,
        readOnly: true,
      };
      stubs.invocation = {
        repoMount: target,
        baseMount: base,
        workspaceKind: 'snapshot',
        hasWorktree: false,
        hasRepo: true,
        snapshots: { target: { tracked: new Set() }, base: { tracked: new Set() } },
      };
      stubs.runInSandbox.mockImplementation(async (_spec, options) => {
        const mounts: DockerVolumeMount[] = options.extraMounts.filter(
          (mount: DockerVolumeMount) => mount.source === 'haive_repos',
        );
        const args = mounts.flatMap((mount) => [
          '--mount',
          `type=bind,src=${path.join(storageRoot, mount.subpath!)},dst=${mount.target}${mount.readOnly ? ',readonly' : ''}`,
        ]);
        const program = `const fs = require('fs'), assert = require('assert/strict');
        assert.equal(fs.readFileSync('/haive/workdir/content', 'utf8'), 'target');
        assert.equal(fs.readFileSync('/haive/diff-base/content', 'utf8'), 'base');
        assert.equal(fs.existsSync('/haive/workdir/.git'), false);
        for (const file of ['/haive/workdir/content', '/haive/diff-base/content', '/haive/workdir/.haive-data/state/new']) {
          assert.throws(() => fs.writeFileSync(file, 'mutated'), e => e.code === 'EROFS');
        }
        assert.throws(() => fs.mkdirSync('/haive/workdir/.haive'), e => e.code === 'EROFS');`;
        await run(
          'docker',
          [
            'run',
            '--rm',
            '--pull',
            'never',
            '--name',
            name,
            '--network',
            'none',
            '--user',
            '1000:1000',
            ...args,
            '--entrypoint',
            'node',
            image,
            '-e',
            program,
          ],
          { timeout: 20_000 },
        );
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          durationMs: 1,
          timedOut: false,
          resolvedCommand: 'node',
          wrapperId: null,
        };
      });
      try {
        await executeByKind(db, payloadFor('agent_mining'), {} as never, {});
      } finally {
        await run('docker', ['rm', '-f', name]).catch(() => undefined);
      }
      expect(stubs.runInSandbox).toHaveBeenCalled();
    },
  );
  it.each([{ snapshotRef: {} }, { baseSnapshotRef: {} }])(
    'refuses malformed refs before live checkout resolution: %j',
    async (refs) => {
      await expect(
        executeByKind(
          {} as never,
          { ...payloadFor('agent_mining'), ...refs } as CliExecJobPayload,
          {} as never,
          {},
        ),
      ).rejects.toThrow('SNAPSHOT_INVALID:');
      expect(stubs.runInSandbox).not.toHaveBeenCalled();
    },
  );
});
