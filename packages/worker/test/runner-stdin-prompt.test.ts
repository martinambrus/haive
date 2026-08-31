import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock, calls } = vi.hoisted(() => {
  const calls: { args: string[]; stdio: unknown; written: string[]; ended: boolean }[] = [];
  const spawnMock = vi.fn((_cmd: string, _args: string[], opts: { stdio: unknown }) => {
    const rec = { args: _args, stdio: opts.stdio, written: [] as string[], ended: false };
    calls.push(rec);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const mkStream = () => Object.assign(new EventEmitter(), { setEncoding: () => {} });
    child.stdout = mkStream();
    child.stderr = mkStream();
    child.stdin = Object.assign(new EventEmitter(), {
      write: (c: string) => rec.written.push(c),
      end: (c?: string) => {
        if (typeof c === 'string') rec.written.push(c);
        rec.ended = true;
      },
    });
    child.kill = () => {};
    setImmediate(() => child.emit('close', 0));
    return child;
  });
  return { spawnMock, calls };
});

vi.mock('node:child_process', () => ({ spawn: spawnMock }));

const { defaultDockerRunner } = await import('../src/sandbox/docker-runner.js');

const run = (opts: Record<string, unknown>) =>
  defaultDockerRunner.run({ image: 'img', cmd: ['exec'], timeoutMs: 5_000, ...opts } as never);

describe('a prompt delivered over stdin', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('opens the pipe, writes it, and CLOSES it', async () => {
    // The close is the load-bearing part: a CLI left waiting on an open stdin
    // never sees end-of-prompt and dies on the timeout, which reads as a slow
    // model rather than a wiring bug.
    await run({ stdinPrompt: 'a huge prompt' });
    const call = calls[0]!;
    expect((call.stdio as string[])[0]).toBe('pipe');
    expect(call.written.join('')).toBe('a huge prompt');
    expect(call.ended).toBe(true);
  });

  it('leaves stdin ignored when there is no prompt to write', async () => {
    // Every ordinary run: unchanged.
    await run({});
    expect((calls[0]!.stdio as string[])[0]).toBe('ignore');
    expect(calls[0]!.ended).toBe(false);
  });

  it('does not close stdin on a steerable run', async () => {
    // Steering needs the stream open for the life of the run so a steer can
    // arrive mid-turn; closing it would end the conversation.
    await run({ interactive: true, stdinInitial: '{"type":"user"}\n' });
    expect(calls[0]!.ended).toBe(false);
    expect(calls[0]!.written.join('')).toContain('user');
  });
});

describe('the container gets a stdin to read', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  // The node-side pipe above is only half the wiring. Docker gives a container no
  // stdin unless asked, so without these the prompt was written into a stream
  // nothing was reading: the pipe existed, the write succeeded, and the CLI still
  // hung until the run timed out. Asserting the pipe alone is what hid it.
  it('passes -i to docker run when a prompt goes over stdin', async () => {
    await run({ stdinPrompt: 'a huge prompt' });
    const args = calls[0]!.args;
    expect(args[0]).toBe('run');
    expect(args).toContain('-i');
  });

  it('passes -i to docker create on the multi-network path', async () => {
    // `docker start -a` cannot attach stdin to a container created without
    // OpenStdin, so the flag has to be on create — it cannot be added later.
    await run({ stdinPrompt: 'a huge prompt', connectNetworks: ['net-a'] });
    const create = calls.find((c) => c.args[0] === 'create')!;
    expect(create.args).toContain('-i');
    const start = calls.find((c) => c.args[0] === 'start')!;
    expect(start.args).toContain('--interactive');
  });

  it('adds no stdin flag to an ordinary run', async () => {
    // Every run that sends nothing on stdin must spawn exactly as before.
    await run({});
    expect(calls[0]!.args).not.toContain('-i');
  });
});
