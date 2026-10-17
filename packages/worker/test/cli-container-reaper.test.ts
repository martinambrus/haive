import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installId } from '@haive/shared';

const h = vi.hoisted(() => {
  const log = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  const fake = {
    calls: [] as Array<{ args: string[]; kill: ReturnType<typeof vi.fn> }>,
    route: (_verb: string, _filter: string): { stdout: string; hang: boolean } => ({
      stdout: '',
      hang: false,
    }),
  };
  return { log, fake };
});

vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  logger: h.log,
}));

vi.mock('node:child_process', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    spawn: (_cmd: string, args: string[]) => {
      const stdout = new Emitter();
      const kill = vi.fn();
      const child = Object.assign(new Emitter(), { stdout, stderr: new Emitter(), kill });
      h.fake.calls.push({ args, kill });
      const verb = args[0] ?? '';
      const filter = args[args.indexOf('--filter') + 1] ?? '';
      const plan = h.fake.route(verb, filter);
      if (!plan.hang) {
        Promise.resolve().then(() => {
          if (plan.stdout) stdout.emit('data', Buffer.from(plan.stdout));
          child.emit('close', 0);
        });
      }
      return child;
    },
  };
});

const { reapAllCliSandboxes, SHUTDOWN_REAP_BUDGET_MS } =
  await import('../src/sandbox/cli-container-reaper.js');

const BUDGET = 3_000;
const CUT = 'cli sandbox reap cut at its shutdown budget; the next worker boot reaps the rest';

const verbs = (verb: string) => h.fake.calls.filter((c) => c.args[0] === verb);

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function track(p: Promise<number>): { settled: () => number | undefined } {
  let value: number | undefined;
  void p.then((v) => {
    value = v;
  });
  return { settled: () => value };
}

const cutLogs = () => h.log.warn.mock.calls.filter((c) => c[1] === CUT);

beforeEach(() => {
  vi.useFakeTimers();
  h.fake.calls.length = 0;
  h.fake.route = () => ({ stdout: '', hang: false });
  h.log.warn.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reapAllCliSandboxes shutdown budget', () => {
  it('C1 cuts a listing that hangs, kills the listings and never removes', async () => {
    h.fake.route = (verb) => ({ stdout: '', hang: verb === 'ps' });
    const r = track(reapAllCliSandboxes('worker SIGTERM', BUDGET));

    await vi.advanceTimersByTimeAsync(BUDGET - 1);
    await flush();
    expect(r.settled()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(r.settled()).toBe(0);

    expect(h.log.warn).toHaveBeenCalledTimes(1);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'worker SIGTERM',
        budgetMs: BUDGET,
        unlisted: expect.any(Array),
        unremoved: [],
      }),
      CUT,
    );
    const [ctx] = h.log.warn.mock.calls[0] as [{ unlisted: string[] }];
    expect(ctx.unlisted).toHaveLength(5);

    const ps = verbs('ps');
    expect(ps).toHaveLength(5);
    for (const c of ps) expect(c.kill).toHaveBeenCalledWith('SIGKILL');

    await vi.advanceTimersByTimeAsync(40_000);
    await flush();
    expect(verbs('rm')).toHaveLength(0);
  });

  it('C2 cuts a removal that hangs and kills the rm child', async () => {
    const owned = `abc123\t${installId()}\n`;
    h.fake.route = (verb, filter) => {
      if (verb === 'rm') return { stdout: '', hang: true };
      if (filter === 'label=haive.task.id') return { stdout: owned, hang: false };
      return { stdout: '', hang: false };
    };
    const r = track(reapAllCliSandboxes('worker SIGTERM', BUDGET));

    await vi.advanceTimersByTimeAsync(BUDGET);
    await flush();
    expect(r.settled()).toBe(0);

    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ budgetMs: BUDGET, unlisted: [], unremoved: ['abc123'] }),
      CUT,
    );
    const rm = verbs('rm');
    expect(rm).toHaveLength(1);
    expect(rm[0]!.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('C3 keeps the boot reap unbounded: no budget, no cut', async () => {
    h.fake.route = (verb) => ({ stdout: '', hang: verb === 'ps' });
    const r = track(reapAllCliSandboxes('worker boot'));

    await vi.advanceTimersByTimeAsync(9_999);
    await flush();
    expect(r.settled()).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(r.settled()).toBe(0);
    expect(cutLogs()).toHaveLength(0);
  });

  it('C4 returns the count when the reap finishes in time and never cuts it', async () => {
    const owned = `abc123\t${installId()}\n`;
    h.fake.route = (verb, filter) => {
      if (verb === 'ps' && filter === 'label=haive.task.id') return { stdout: owned, hang: false };
      return { stdout: '', hang: false };
    };
    const r = track(reapAllCliSandboxes('worker SIGTERM', BUDGET));

    await vi.advanceTimersByTimeAsync(BUDGET - 1);
    await flush();
    expect(r.settled()).toBe(1);

    await vi.advanceTimersByTimeAsync(BUDGET);
    await flush();
    expect(cutLogs()).toHaveLength(0);
    for (const c of h.fake.calls) expect(c.kill).not.toHaveBeenCalled();
  });
});

describe('SHUTDOWN_REAP_BUDGET_MS', () => {
  it('C5 is 3 s', () => {
    expect(SHUTDOWN_REAP_BUDGET_MS).toBe(3_000);
  });
});
