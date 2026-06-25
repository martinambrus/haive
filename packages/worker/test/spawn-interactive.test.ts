import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:child_process so we can inspect how spawn is invoked (stdio mode,
// argv, stdin writes) without launching real processes. Both defaultCliSpawner
// and defaultDockerRunner import spawn from here, so one mock covers both.
// Real docker `-i` stdin forwarding is proven separately by the slice-1 live
// de-risk; this test guards the arg/stdio construction in our code.
const shared = vi.hoisted(() => ({
  calls: [] as Array<{
    cmd: string;
    args: string[];
    options: { stdio?: unknown[] };
    writes: string[];
    ended: boolean;
  }>,
}));

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    spawn: (cmd: string, args: string[], options: { stdio?: unknown[] }) => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const record = { cmd, args, options, writes: [] as string[], ended: false };
      child.stdin = {
        writable: true,
        write: (s: string) => {
          record.writes.push(s);
          return true;
        },
        on: () => {},
        end: () => {
          record.ended = true;
        },
      };
      child.kill = () => {};
      shared.calls.push(record);
      // resolve the spawn promise on the next tick with a clean exit
      setImmediate(() => child.emit('close', 0));
      return child;
    },
  };
});

const { defaultCliSpawner } = await import('../src/cli-executor/runner.js');
const { defaultDockerRunner } = await import('../src/sandbox/docker-runner.js');

const stdin0 = (i: number): unknown => (shared.calls[i]!.options.stdio as unknown[])[0];
const byVerb = (verb: string) => shared.calls.find((c) => c.args[0] === verb);

beforeEach(() => {
  shared.calls.length = 0;
});

describe('defaultCliSpawner interactive mode', () => {
  it('interactive: pipes stdin, writes stdinInitial, surfaces the writable', async () => {
    let surfaced: NodeJS.WritableStream | undefined;
    const result = await defaultCliSpawner(
      { command: 'claude', args: ['-p'], env: {} },
      {
        interactive: true,
        stdinInitial: '{"type":"user"}\n',
        onStdinWritable: (w) => {
          surfaced = w;
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(stdin0(0)).toBe('pipe');
    expect(shared.calls[0]!.writes).toEqual(['{"type":"user"}\n']);
    expect(surfaced).toBeDefined();
  });

  it('non-interactive (default): stdin is ignored, nothing written', async () => {
    await defaultCliSpawner({ command: 'claude', args: ['-p', 'hi'], env: {} }, {});
    expect(stdin0(0)).toBe('ignore');
    expect(shared.calls[0]!.writes).toEqual([]);
  });
});

describe('defaultDockerRunner.run interactive mode', () => {
  it('plain path: adds -i and pipes stdin when interactive', async () => {
    let surfaced = false;
    await defaultDockerRunner.run({
      image: 'img',
      cmd: ['claude', '-p'],
      interactive: true,
      stdinInitial: '{"type":"user"}\n',
      onStdinWritable: () => {
        surfaced = true;
      },
    });
    const run = byVerb('run')!;
    expect(run.args).toContain('-i');
    expect(run.args.indexOf('-i')).toBeLessThan(run.args.indexOf('img'));
    expect((run.options.stdio as unknown[])[0]).toBe('pipe');
    expect(run.writes).toEqual(['{"type":"user"}\n']);
    expect(surfaced).toBe(true);
  });

  it('plain path: no -i and stdin ignored when not interactive (default unchanged)', async () => {
    await defaultDockerRunner.run({ image: 'img', cmd: ['claude', '-p', 'hi'] });
    const run = byVerb('run')!;
    expect(run.args).not.toContain('-i');
    expect((run.options.stdio as unknown[])[0]).toBe('ignore');
  });

  it('multi-network path (Hole A): -i on create AND --interactive on start', async () => {
    await defaultDockerRunner.run({
      image: 'img',
      cmd: ['claude', '-p'],
      connectNetworks: ['haive-api-net'],
      interactive: true,
      stdinInitial: '{"type":"user"}\n',
    });
    const create = byVerb('create')!;
    const start = byVerb('start')!;
    expect(create.args).toContain('-i');
    expect(start.args).toContain('--interactive');
    // stdin is attached on START, not create
    expect((start.options.stdio as unknown[])[0]).toBe('pipe');
    expect(start.writes).toEqual(['{"type":"user"}\n']);
  });

  it('multi-network path: no -i / --interactive when not interactive', async () => {
    await defaultDockerRunner.run({
      image: 'img',
      cmd: ['claude', '-p', 'hi'],
      connectNetworks: ['haive-api-net'],
    });
    expect(byVerb('create')!.args).not.toContain('-i');
    expect(byVerb('start')!.args).not.toContain('--interactive');
  });
});
