import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { TerminalOpenResult } from '@haive/shared';

vi.mock('../src/queues/cli-exec-queue.js', () => ({
  resolveRepoMount: vi.fn(async () => ({ source: 'repo', target: '/haive/workdir' })),
  resolveTaskRepoMount: vi.fn(async () => ({ source: 'repo', target: '/haive/workdir' })),
  resolveTaskSandboxWorkdir: vi.fn(async () => '/haive/workdir'),
}));
vi.mock('../src/queues/cli-exec/gitfile-mask.js', () => ({
  repoGitDataBoundary: vi.fn(async () => ({ mounts: [] })),
}));
vi.mock('../src/terminal/terminal-container.js', () => ({
  ensureShellContainer: vi.fn(async () => ({ containerName: 'haive-shell-1', shell: 'bash' })),
  seedShellTrust: vi.fn(async () => undefined),
}));

import { TerminalSessionManager } from '../src/terminal/terminal-session-manager.js';

const NOT_READY = 'task worktree not ready - terminal preparing';
const CUSTOM = ['01-worktree-setup', '07-phase-2-implement', '08c-code-review'];

/** `setup` is the status of the task's 01-worktree-setup row, or null when it has none yet. */
function open(
  type: string,
  runListSnapshot: string[] | null,
  setup: string | null,
): Promise<TerminalOpenResult> {
  const docker = {
    getContainer: () => ({
      exec: async () => ({
        start: async () => {
          const stream = new PassThrough();
          setImmediate(() => stream.end());
          return stream;
        },
        inspect: async () => ({ ExitCode: null }),
        resize: async () => undefined,
      }),
    }),
  };
  const db = {
    query: {
      tasks: {
        findFirst: async () => ({
          id: 'task-1',
          userId: 'user-1',
          status: 'running',
          type,
          runListSnapshot,
          repositoryId: 'repo-1',
        }),
      },
      taskSteps: { findFirst: async () => (setup === null ? undefined : { status: setup }) },
      cliProviders: { findFirst: async () => undefined },
    },
  };
  const redis = {
    publish: vi.fn(async () => 0),
    set: vi.fn(async () => 'OK'),
    hset: vi.fn(async () => 0),
    hsetnx: vi.fn(async () => 0),
  };
  const subscriber = {
    subscribe: vi.fn(async () => undefined),
    unsubscribe: vi.fn(async () => undefined),
    on: vi.fn(),
  };
  const mgr = new TerminalSessionManager({
    db: db as never,
    redis: redis as never,
    subscriberRedis: subscriber as never,
    docker: docker as never,
    buildMcpServers: async () => [],
  });
  return (
    mgr as unknown as { openSession: (req: unknown) => Promise<TerminalOpenResult> }
  ).openSession({
    op: 'open',
    correlationId: 'c1',
    userId: 'user-1',
    cliProviderId: 'prov-1',
    scope: 'task',
    taskId: 'task-1',
  });
}

const refusal = (r: TerminalOpenResult): string | null => (r.ok ? null : r.error);

describe('task terminal worktree gate', () => {
  it('holds a custom type that sets up a worktree until that step is done', async () => {
    expect(refusal(await open('review_only', CUSTOM, null))).toBe(NOT_READY);
    expect(refusal(await open('review_only', CUSTOM, 'running'))).toBe(NOT_READY);
  });

  it('opens it once the step is done or skipped', async () => {
    expect(refusal(await open('review_only', CUSTOM, 'done'))).toBeNull();
    expect(refusal(await open('review_only', CUSTOM, 'skipped'))).toBeNull();
  });

  it('does not gate a custom type that has no worktree step', async () => {
    expect(refusal(await open('review_only', ['07-phase-2-implement'], null))).toBeNull();
    expect(refusal(await open('review_only', null, null))).toBeNull();
  });

  it('keeps gating workflow and run_app, with or without a list', async () => {
    for (const type of ['workflow', 'run_app']) {
      expect(refusal(await open(type, null, null))).toBe(NOT_READY);
      expect(refusal(await open(type, CUSTOM, 'running'))).toBe(NOT_READY);
      expect(refusal(await open(type, null, 'done'))).toBeNull();
    }
  });

  it('does not gate other built-in types', async () => {
    expect(refusal(await open('onboarding', null, null))).toBeNull();
  });
});
