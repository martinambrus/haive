import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  TERMINAL_CTL_CHANNEL_PREFIX,
  TERMINAL_EXIT_KEY_PREFIX,
  TERMINAL_REPLY_CHANNEL_PREFIX,
  TERMINAL_REQUEST_CHANNEL,
  type TerminalOpenResult,
} from '@haive/shared';

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
import { ensureShellContainer, seedShellTrust } from '../src/terminal/terminal-container.js';
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
  stored: () => [string, string][];
  /** Each entry holds back the start of the next attach until it resolves. */
  attachGates: Promise<void>[];
}

/** `probe` is what `tmux display-message` prints, or null for a non-zero exit (no session). */
function harness(probe: string | null, killExit: number | number[] = 0): Harness {
  const killExits = Array.isArray(killExit) ? [...killExit] : null;
  const execs: ExecCall[] = [];
  const attaches: PassThrough[] = [];
  const attachGates: Promise<void>[] = [];
  const docker = {
    getContainer: (container: string) => ({
      exec: async (opts: { Cmd: string[]; WorkingDir?: string }) => {
        execs.push({ container, cmd: opts.Cmd, workingDir: opts.WorkingDir });
        const isAttach = opts.Cmd[1] === 'new-session';
        const isProbe = opts.Cmd[1] === 'display-message';
        return {
          start: async () => {
            if (isAttach && attachGates.length > 0) await attachGates.shift();
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
            ExitCode: isProbe
              ? probe === null
                ? 1
                : 0
              : isAttach
                ? null
                : killExits
                  ? (killExits.shift() ?? 0)
                  : killExit,
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
  const priv = mgr as unknown as {
    openSession: (req: unknown) => Promise<TerminalOpenResult>;
    handleSubscriberMessage: (channel: string, raw: string) => Promise<void>;
  };
  return {
    mgr,
    execs,
    attaches,
    attachGates,
    published: () => redis.publish.mock.calls.map((c) => (c as unknown[])[1] as string),
    stored: () => redis.set.mock.calls.map((c) => (c as unknown[]).slice(0, 2) as [string, string]),
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

  it('answers a later probe with the workspace the task has moved to since the open', async () => {
    vi.mocked(resolveTaskSandboxWorkdir).mockResolvedValue(WORKTREE);
    const h = harness(WORKTREE);
    const reply = await h.openTask();
    if (!reply.ok) throw new Error('open failed');
    expect(reply.workdirMismatch).toBeUndefined();

    vi.mocked(resolveTaskSandboxWorkdir).mockResolvedValue(ROOT);
    await h.sendCtl(reply.sessionId, { type: 'probe_workdir' });

    expect(h.published()).toContain(
      JSON.stringify({ workdirMismatch: { sessionPath: WORKTREE, expected: ROOT } }),
    );
  });

  it('attaches at the workspace current when its turn comes, not when the open began', async () => {
    vi.mocked(resolveTaskSandboxWorkdir).mockResolvedValueOnce(WORKTREE).mockResolvedValue(ROOT);
    const h = harness(null);
    await h.openTask();
    expect(h.execs.find((e) => e.cmd[1] === 'new-session')?.workingDir).toBe(ROOT);
  });

  it('trusts the workdir it attaches at in a reused container', async () => {
    vi.mocked(ensureShellContainer).mockResolvedValueOnce({
      containerName: 'haive-shell-1',
      shell: 'bash',
      created: false,
      imageTag: 'img',
      cliName: 'claude-code',
    } as never);
    vi.mocked(resolveTaskSandboxWorkdir).mockResolvedValue(WORKTREE);
    const h = harness(null);
    await h.openTask();
    expect(vi.mocked(seedShellTrust)).toHaveBeenCalledWith(
      expect.anything(),
      'haive-shell-1',
      'claude-code',
      [WORKTREE],
    );
  });

  it('answers no probe for a repo shell', async () => {
    const h = harness(WORKTREE);
    const reply = await h.openRepo();
    if (!reply.ok) throw new Error('open failed');
    await h.sendCtl(reply.sessionId, { type: 'probe_workdir' });
    expect(h.published().filter((m) => m.includes('workdirMismatch'))).toEqual([]);
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

  it('keeps the end of a shell for an api that subscribes after the publish', async () => {
    const h = harness(ROOT);
    const reply = await h.openTask();
    if (!reply.ok) throw new Error('open failed');
    for (const a of h.attaches) a.end();
    await vi.waitFor(() =>
      expect(h.published().filter((m) => m.startsWith('{"type":"exit"'))).toHaveLength(1),
    );
    expect(h.stored()).toEqual([
      [`${TERMINAL_EXIT_KEY_PREFIX}${reply.sessionId}`, JSON.stringify({ type: 'exit' })],
    ]);
  });

  it('tells a shell whose attach was still in flight during the restart', async () => {
    const h = harness(ROOT);
    const first = await h.openTask();
    if (!first.ok) throw new Error('open failed');
    let release!: () => void;
    h.attachGates.push(new Promise<void>((r) => (release = r)));
    const pending = h.openTask();
    await vi.waitFor(() =>
      expect(h.execs.filter((e) => e.cmd[1] === 'new-session')).toHaveLength(2),
    );
    const restart = h.sendCtl(first.sessionId, { type: 'restart_shell', userId: 'user-1' });
    release();
    await restart;
    if (!(await pending).ok) throw new Error('open failed');
    for (const a of h.attaches) a.end();
    await new Promise((r) => setImmediate(r));
    expect(h.published().filter((m) => m.startsWith('{"type":"exit"'))).toEqual([
      JSON.stringify({ type: 'exit', reason: 'restart' }),
      JSON.stringify({ type: 'exit', reason: 'restart' }),
    ]);
  });

  it('runs a restart only after an open has attached, never between its probe and its attach', async () => {
    const h = harness('/haive/workdir/.haive/worktrees/old');
    const first = await h.openTask();
    if (!first.ok) throw new Error('open failed');
    let release!: () => void;
    h.attachGates.push(new Promise<void>((r) => (release = r)));
    const pending = h.openTask();
    await vi.waitFor(() =>
      expect(h.execs.filter((e) => e.cmd[1] === 'new-session')).toHaveLength(2),
    );
    const restart = h.sendCtl(first.sessionId, { type: 'restart_shell', userId: 'user-1' });
    await new Promise((r) => setTimeout(r, 10));
    expect(killCalls(h.execs)).toHaveLength(0);
    release();
    await restart;
    await pending;
    const order = h.execs.map((e) => e.cmd[1]);
    expect(order.lastIndexOf('new-session')).toBeLessThan(order.indexOf('kill-session'));
  });

  it('keeps the mark of a restart that killed the session when a concurrent one finds it gone', async () => {
    const h = harness(ROOT, [1, 0]);
    const a = await h.openTask();
    const b = await h.openTask();
    if (!a.ok || !b.ok) throw new Error('open failed');
    await Promise.all([
      h.sendCtl(a.sessionId, { type: 'restart_shell', userId: 'user-1' }),
      h.sendCtl(b.sessionId, { type: 'restart_shell', userId: 'user-1' }),
    ]);
    for (const att of h.attaches) att.end();
    await new Promise((r) => setImmediate(r));
    expect(h.published().filter((m) => m.startsWith('{"type":"exit"'))).toEqual([
      JSON.stringify({ type: 'exit', reason: 'restart' }),
      JSON.stringify({ type: 'exit', reason: 'restart' }),
    ]);
  });

  it('does not tell a shell attached after the restart', async () => {
    const h = harness(ROOT);
    const first = await h.openTask();
    if (!first.ok) throw new Error('open failed');
    await h.sendCtl(first.sessionId, { type: 'restart_shell', userId: 'user-1' });
    h.attaches[0]!.end();
    await new Promise((r) => setTimeout(r, 5));
    const later = await h.openTask();
    if (!later.ok) throw new Error('open failed');
    h.attaches[1]!.end();
    await new Promise((r) => setImmediate(r));
    expect(h.published().filter((m) => m.startsWith('{"type":"exit"'))).toEqual([
      JSON.stringify({ type: 'exit', reason: 'restart' }),
      JSON.stringify({ type: 'exit' }),
    ]);
  });

  it('does not tell a shell attached in the same millisecond as the restart', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const h = harness(ROOT);
      const first = await h.openTask();
      if (!first.ok) throw new Error('open failed');
      await h.sendCtl(first.sessionId, { type: 'restart_shell', userId: 'user-1' });
      h.attaches[0]!.end();
      const later = await h.openTask();
      if (!later.ok) throw new Error('open failed');
      h.attaches[1]!.end();
      await new Promise((r) => setImmediate(r));
      expect(h.published().filter((m) => m.startsWith('{"type":"exit"'))).toEqual([
        JSON.stringify({ type: 'exit', reason: 'restart' }),
        JSON.stringify({ type: 'exit' }),
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it('does not blame a later exit on a restart whose kill failed', async () => {
    const h = harness(ROOT, 1);
    const reply = await h.openTask();
    if (!reply.ok) throw new Error('open failed');
    await h.sendCtl(reply.sessionId, { type: 'restart_shell', userId: 'user-1' });
    h.attaches[0]!.end();
    await new Promise((r) => setImmediate(r));
    expect(h.published().filter((m) => m.startsWith('{"type":"exit"'))).toEqual([
      JSON.stringify({ type: 'exit' }),
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

describe('an open that fails after it added its session', () => {
  const internals = (h: Harness) =>
    h.mgr as unknown as {
      sessions: Map<string, unknown>;
      subscriber: { subscribe: Mock };
      redis: { hset: Mock; publish: Mock };
      handleSubscriberMessage: (channel: string, raw: string) => Promise<void>;
    };

  it.each(['subscribe', 'hset'] as const)(
    'drops that session and ends its shell when the %s after the attach fails',
    async (failing) => {
      const h = harness(ROOT);
      const mgr = internals(h);
      const call = failing === 'subscribe' ? mgr.subscriber.subscribe : mgr.redis.hset;
      call.mockRejectedValueOnce(new Error('Connection is closed.'));

      await expect(h.openTask()).rejects.toThrow('Connection is closed.');

      expect(mgr.sessions.size).toBe(0);
      expect(h.attaches).toHaveLength(1);
      expect(h.attaches[0]!.destroyed).toBe(true);
    },
  );

  it('answers the failure, once that session is gone, while no stop has begun', async () => {
    const h = harness(ROOT);
    const mgr = internals(h);
    await h.mgr.start();
    mgr.redis.hset.mockRejectedValueOnce(new Error('OOM command not allowed'));
    const replyChannel = `${TERMINAL_REPLY_CHANNEL_PREFIX}c-fail`;
    let sessionsAtReply = -1;
    mgr.redis.publish.mockImplementation(async (channel: string) => {
      if (channel === replyChannel) sessionsAtReply = mgr.sessions.size;
      return 0;
    });

    await mgr.handleSubscriberMessage(
      TERMINAL_REQUEST_CHANNEL,
      JSON.stringify({
        op: 'open',
        correlationId: 'c-fail',
        userId: 'user-1',
        cliProviderId: 'prov-1',
        scope: 'task',
        taskId: 'task-1',
      }),
    );

    const replies = mgr.redis.publish.mock.calls.filter(([channel]) => channel === replyChannel);
    expect(replies).toEqual([
      [replyChannel, JSON.stringify({ ok: false, error: 'OOM command not allowed' })],
    ]);
    expect(sessionsAtReply).toBe(0);
    expect(mgr.sessions.size).toBe(0);
    expect(h.attaches[0]!.destroyed).toBe(true);
  });

  it('keeps the session and the shell of an open that succeeds', async () => {
    const h = harness(ROOT);
    const reply = await h.openTask();
    expect(reply.ok).toBe(true);
    expect(internals(h).sessions.size).toBe(1);
    expect(h.attaches[0]!.destroyed).toBe(false);
  });
});
