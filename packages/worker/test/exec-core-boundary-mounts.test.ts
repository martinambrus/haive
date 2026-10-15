import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configService, type CliExecInvocationKind, type CliExecJobPayload } from '@haive/shared';

// WORKER_REPO_STORAGE_ROOT is read from the environment once, at import time, so the
// fixture root has to exist and be exported before exec-core.js is pulled in.
const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-exec-boundary-'));
process.env.REPO_STORAGE_ROOT = storageRoot;

const stubs = vi.hoisted(() => ({
  runInSandbox: vi.fn(),
  invocation: { repoMount: null as unknown, hasWorktree: false, hasRepo: true },
}));

vi.mock('../src/sandbox/sandbox-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sandbox/sandbox-runner.js')>()),
  runInSandbox: stubs.runInSandbox,
}));
// Replaced whole, not spread over importOriginal: loading the real resolvers re-enters exec-core
// through a cycle, and the sub-agent runner then keeps the unmocked binding.
vi.mock('../src/queues/cli-exec/resolvers.js', () => ({
  WORKER_REPO_STORAGE_ROOT: process.env.REPO_STORAGE_ROOT,
  resolveInvocationRepoMount: async () => stubs.invocation,
  ensureRepoMountWritable: async () => undefined,
  loadProviderRuntimeConfig: async () => ({
    wrapperContent: null,
    sandboxImage: null,
    networkPolicy: null,
    egressDomains: [],
  }),
  resolveAuthMounts: async () => [],
  resolveMcpExtraFiles: async () => ({ files: [], extraArgs: [] }),
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
const { npmCacheMount } = await import('../src/sandbox/npm-cache.js');

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
  it('mounts .git and .haive-data under the repository root, ahead of the repository mount', async () => {
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
        repoMount,
        npmCacheMount(),
      ]);
    }
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
