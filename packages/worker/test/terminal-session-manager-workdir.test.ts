import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TERMINAL_CTL_CHANNEL_PREFIX, type TerminalOpenResult } from '@haive/shared';

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
}));

import { TerminalSessionManager } from '../src/terminal/terminal-session-manager.js';
import { resolveTaskSandboxWorkdir } from '../src/queues/cli-exec-queue.js';

const WORKTREE = '/haive/workdir/.haive-worktrees/task-1';
const ROOT = '/haive/workdir';

interface ExecCall {
  container: string;
  cmd: string[];
  workingDir?: string;
}

interface Harness {
  mgr: TerminalSessionManager;
  execs: ExecCall[];
  openTask: (userId?: string) => Promise<TerminalOpenResult>;
  openRepo: () => Promise<TerminalOpenResult>;
  sendCtl: (sessionId: string, frame: unknown) => Promise<void>;
  attaches: PassThrough[];
  published: () => string[];
}

/** `probe` is what `tmux display-message` prints, or null for a non-zero exit (no session). */
function harness(probe: string | null, killExit = 0): Harness {
  const execs: ExecCall[] = [];
  const attaches: PassThrough[] = [];
  const docker = {
    getContainer: (container: string) => ({
      exec: async (opts: { Cmd: string[]; WorkingDir?: string }) => {
        execs.push({ container, cmd: opts.Cmd, workingDir: opts.WorkingDir });
        const isAttach = opts.Cmd[1] === 'new-session';
        const isProbe = opts.Cmd[1] === 'display-message';
        return {
          start: async () => {
            const stream = new PassThrough();
            if (isAttach) attaches.push(stream);
            if (!isAttach) {
              setImmediate(() => {
                if (isProbe && probe !== null) stream.write(`${probe}\r\n`);
                stream.end();
              });
            }
            return stream;
          },
          inspect: async () => ({
            ExitCode: isProbe ? (probe === null ? 1 : 0) : isAttach ? null : killExit,
          }),
          resize: async () => undefined,
        };
      },
    }),
  };
  const db = {
    query: {
      tasks: {
        findFirst: async () => ({
          id: 'task-1',
          userId: 'user-1',
          status: 'running',
          type: 'onboarding',
          repositoryId: 'repo-1',
        }),
      },
      taskSteps: { findFirst: async () => ({ status: 'done' }) },
      cliProviders: { findFirst: async () => undefined },
    },
  };
  const redis = {
    publish: vi.fn(async () => 0),
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
  const priv = mgr as unknown as {
    openSession: (req: unknown) => Promise<TerminalOpenResult>;
    handleSubscriberMessage: (channel: string, raw: string) => Promise<void>;
  };
  return {
    mgr,
    execs,
    attaches,
    published: () => redis.publish.mock.calls.map((c) => (c as unknown[])[1] as string),
    openTask: (userId = 'user-1') =>
      priv.openSession({
        op: 'open',
        correlationId: 'c1',
        userId,
        cliProviderId: 'prov-1',
        scope: 'task',
        taskId: 'task-1',
      }),
    openRepo: () =>
      priv.openSession({
        op: 'open',
        correlationId: 'c2',
        userId: 'user-1',
        cliProviderId: 'prov-1',
        scope: 'repo',
        repositoryId: 'repo-1',
      }),
    sendCtl: (sessionId, frame) =>
      priv.handleSubscriberMessage(
        `${TERMINAL_CTL_CHANNEL_PREFIX}${sessionId}`,
        JSON.stringify(frame),
      ),
  };
}

const killCalls = (execs: ExecCall[]) => execs.filter((e) => e.cmd[1] === 'kill-session');
const probeCalls = (execs: ExecCall[]) => execs.filter((e) => e.cmd[1] === 'display-message');

describe('task shell start directory', () => {
  beforeEach(() => {
    vi.mocked(resolveTaskSandboxWorkdir).mockResolvedValue(ROOT);
  });

  it('reports the session path when the live session started elsewhere', async () => {
    const h = harness(WORKTREE);
    const reply = await h.openTask();
    expect(reply).toMatchObject({
      ok: true,
      workdirMismatch: { sessionPath: WORKTREE, expected: ROOT },
    });
  });

  it('reports nothing when the session started in the expected directory', async () => {
    const h = harness(ROOT);
    const reply = await h.openTask();
    expect(reply.ok && reply.workdirMismatch).toBeFalsy();
  });

  it('reports nothing when no session exists yet', async () => {
    const h = harness(null);
    const reply = await h.openTask();
    expect(reply.ok && reply.workdirMismatch).toBeFalsy();
  });

  it('probes read-only, before it attaches', async () => {
    const h = harness(WORKTREE);
    await h.openTask();
    const order = h.execs.map((e) => e.cmd[1]);
    expect(order).toEqual(['display-message', 'new-session']);
    expect(probeCalls(h.execs)[0]?.cmd).toEqual([
      'tmux',
      'display-message',
      '-p',
      '-t',
      'haive-task',
      '#{session_path}',
    ]);
  });

  it('never probes a repo shell', async () => {
    const h = harness(WORKTREE);
    const reply = await h.openRepo();
    expect(reply.ok && reply.workdirMismatch).toBeFalsy();
    expect(probeCalls(h.execs)).toHaveLength(0);
  });
});

describe('restart shell', () => {
  it('kills only the tmux session in that container', async () => {
    const h = harness(ROOT);
    const reply = await h.openTask();
    if (!reply.ok) throw new Error('open failed');
    await h.sendCtl(reply.sessionId, { type: 'restart_shell', userId: 'user-1' });
    const kills = killCalls(h.execs);
    expect(kills).toHaveLength(1);
    expect(kills[0]).toMatchObject({
      container: 'haive-shell-1',
      cmd: ['tmux', 'kill-session', '-t', 'haive-task'],
    });
  });

  // tmux detaches every client of the killed session, so every tab on it must learn why.
  it('tells every shell on the restarted session that its end was the restart', async () => {
    const h = harness(ROOT);
    const first = await h.openTask();
    const second = await h.openTask();
    if (!first.ok || !second.ok) throw new Error('open failed');
    await h.sendCtl(first.sessionId, { type: 'restart_shell', userId: 'user-1' });
    for (const a of h.attaches) a.end();
    await new Promise((r) => setImmediate(r));
    const exits = h.published().filter((m) => m.startsWith('{"type":"exit"'));
    expect(exits).toEqual([
      JSON.stringify({ type: 'exit', reason: 'restart' }),
      JSON.stringify({ type: 'exit', reason: 'restart' }),
    ]);
  });

  it('ends a shell that exits on its own without the restart reason', async () => {
    const h = harness(ROOT);
    const reply = await h.openTask();
    if (!reply.ok) throw new Error('open failed');
    h.attaches[0]!.end();
    await new Promise((r) => setImmediate(r));
    expect(h.published().filter((m) => m.startsWith('{"type":"exit"'))).toEqual([
      JSON.stringify({ type: 'exit' }),
    ]);
  });

  it("refuses another user's request", async () => {
    const h = harness(ROOT);
    const reply = await h.openTask();
    if (!reply.ok) throw new Error('open failed');
    await h.sendCtl(reply.sessionId, { type: 'restart_shell', userId: 'user-2' });
    expect(killCalls(h.execs)).toHaveLength(0);
  });

  it('refuses a frame without a user', async () => {
    const h = harness(ROOT);
    const reply = await h.openTask();
    if (!reply.ok) throw new Error('open failed');
    await h.sendCtl(reply.sessionId, { type: 'restart_shell' });
    expect(killCalls(h.execs)).toHaveLength(0);
  });

  it('refuses a repo shell', async () => {
    const h = harness(ROOT);
    const reply = await h.openRepo();
    if (!reply.ok) throw new Error('open failed');
    await h.sendCtl(reply.sessionId, { type: 'restart_shell', userId: 'user-1' });
    expect(killCalls(h.execs)).toHaveLength(0);
  });

  it('ignores a session id it does not hold', async () => {
    const h = harness(ROOT);
    await h.sendCtl('nope', { type: 'restart_shell', userId: 'user-1' });
    expect(h.execs).toHaveLength(0);
  });
});
