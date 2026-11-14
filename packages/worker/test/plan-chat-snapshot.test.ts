import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInSandbox } from '../src/sandbox/sandbox-runner.js';
import type { DockerRunner, DockerRunOpts } from '../src/sandbox/docker-runner.js';
import {
  assertSnapshotOwner,
  createPlanChatSnapshot,
  reapPlanChatSnapshots,
  type PlanChatSnapshot,
} from '../src/plan/chat-snapshot.js';
import { codexExecFallbackSpec } from '../src/cli-adapters/codex.js';
import { PLAN_CHAT_SNAPSHOT_PATH } from '../src/step-engine/steps/plan/_plan-chat-context.js';

let root: string;
const snapshot: PlanChatSnapshot = {
  schemaVersion: 1,
  userId: 'owner',
  repositoryId: 'repo',
  taskId: 'task',
  invocationId: 'run',
  nodes: [],
  edges: [],
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'plan-chat-snapshot-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const empty = { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false };

describe('owned dispatch plan snapshot', () => {
  it('uses the same configured wrapper root for sandbox files and boot reaping', async () => {
    vi.stubEnv('SANDBOX_WRAPPER_WORKER_PATH', root);
    await runInSandbox(
      { command: 'cli', args: [], planSnapshot: snapshot },
      {
        image: 'test-image',
        docker: { run: vi.fn(async () => empty) } as unknown as DockerRunner,
      },
    );
    expect(await readdir(join(root, 'plan-chat-snapshots'))).toEqual([]);
    await createPlanChatSnapshot(root, snapshot);
    await reapPlanChatSnapshots();
    expect(await readdir(join(root, 'plan-chat-snapshots'))).toEqual([]);
  });
  it('lays out node ids, versions and bodies on separate lines for file tools', async () => {
    const read = {
      ...snapshot,
      nodes: [{ id: 'find-this-node', version: 7, body: 'line one\nline two' }],
    } as unknown as PlanChatSnapshot;
    const file = await createPlanChatSnapshot(root, read);
    const text = await readFile(join(root, file.subpath), 'utf8');
    expect(JSON.parse(text)).toEqual(read);
    expect(text.split('\n')).toContain('      "id": "find-this-node",');
    expect(text.split('\n')).toContain('      "version": 7,');
    expect(text.split('\n')).toContain('      "body": "line one\\nline two"');
    await file.remove();
  });
  it('keeps the same owned read when codex falls back before accepting a turn', () => {
    const fallback = codexExecFallbackSpec({
      command: 'codex',
      args: [],
      env: {},
      planSnapshot: snapshot,
      codexAppServer: {
        prompt: 'Use the dispatch snapshot',
        model: null,
        effort: null,
        execArgs: [],
      },
    } as never);
    expect(fallback?.planSnapshot).toBe(snapshot);
  });

  it.each(['success', 'failure', 'cancel'] as const)(
    'mounts only its private read-only file and removes it after %s',
    async (outcome) => {
      const run = vi.fn(async (opts: DockerRunOpts) => {
        const mount = opts.mounts!.find((m) => m.target === PLAN_CHAT_SNAPSHOT_PATH)!;
        expect(mount.readOnly).toBe(true);
        expect(mount.source).toBe('test-wrappers');
        expect(mount.subpath).toMatch(/^plan-chat-snapshots\/[\da-f-]+\/plan.json$/);
        expect(JSON.parse(await readFile(join(root, mount.subpath!), 'utf8'))).toEqual(snapshot);
        if (outcome === 'failure') throw new Error('spawn failed');
        return empty;
      });
      const promise = runInSandbox(
        {
          command: 'cli',
          args: [],
          planSnapshot: snapshot,
          ...(outcome === 'cancel' ? { beforeRun: async () => false } : {}),
        },
        {
          image: 'test-image',
          docker: { run } as unknown as DockerRunner,
          wrapperVolumeName: 'test-wrappers',
          wrapperWorkerPath: root,
        },
      );
      if (outcome === 'failure') await expect(promise).rejects.toThrow('spawn failed');
      else await promise;
      expect(run).toHaveBeenCalledTimes(outcome === 'cancel' ? 0 : 1);
      expect(await readdir(join(root, 'plan-chat-snapshots'))).toEqual([]);
    },
  );
  it('reaps a dead worker snapshot without reading any repository path', async () => {
    await createPlanChatSnapshot(root, snapshot);
    await reapPlanChatSnapshots(root);
    expect(await readdir(join(root, 'plan-chat-snapshots'))).toEqual([]);
  });
  it('does not replace or follow a planted snapshot-root link', async () => {
    const other = join(root, 'other');
    await symlink(other, join(root, 'plan-chat-snapshots'));
    await expect(createPlanChatSnapshot(root, snapshot)).rejects.toThrow();
  });
  it.each(['userId', 'repositoryId', 'taskId', 'invocationId'] as const)(
    'refuses a snapshot belonging to another %s',
    (key) => {
      expect(() => assertSnapshotOwner(snapshot, { ...snapshot, [key]: 'another' })).toThrow(
        'owned dispatch',
      );
    },
  );
  it('gives concurrent dispatches different files and independent cleanup', async () => {
    const a = await createPlanChatSnapshot(root, snapshot);
    const b = await createPlanChatSnapshot(root, { ...snapshot, invocationId: 'other-run' });
    expect(a.subpath).not.toBe(b.subpath);
    await a.remove();
    expect(JSON.parse(await readFile(join(root, b.subpath), 'utf8')).invocationId).toBe(
      'other-run',
    );
    await b.remove();
  });
});
