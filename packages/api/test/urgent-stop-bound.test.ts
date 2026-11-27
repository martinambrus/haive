import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  kill: vi.fn(async (_id: string) => 0),
  add: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  stop: vi.fn(async (_tx: unknown, _id: string, _opts: unknown) => ({
    cancelled: 1,
    stopped: 1,
    failedAt: '2026-11-01T00:00:00.000Z',
  })),
  tasks: [] as Record<string, unknown>[],
}));
vi.mock('../src/lib/sandbox-kill.js', () => ({ killTaskSandboxesOrThrow: h.kill }));
vi.mock('../src/lib/task-control.js', () => ({ supersedeLiveRuns: h.stop }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({ add: h.add }) }));
vi.mock('@haive/shared/modularity-server', () => ({
  moduleDependents: async () => ({ tasks: h.tasks, capped: false }),
  moduleDependentRows: async () => h.tasks,
}));
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { deactivateUrgently, URGENT_STOP_CONCURRENCY } from '../src/modules/activation.js';

function run(concurrency = 2) {
  const fake = createFakeDb({
    modules: schema.modules,
    moduleDrainTasks: schema.moduleDrainTasks,
    auditEvents: schema.auditEvents,
    taskEvents: schema.taskEvents,
  });
  fake.insert(schema.modules, { moduleId: 'alpha', name: 'Alpha' });
  return deactivateUrgently(fake.db as never, 'alpha', '00000000-0000-4000-8000-0000000000a1', {
    concurrency,
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  h.tasks = [1, 2, 3].map((n) => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    title: `Task ${n}`,
    status: 'running',
    ownerId: '00000000-0000-4000-8000-0000000000a2',
    currentStepId: 'module.alpha.work',
  }));
  h.kill.mockReset().mockResolvedValue(0);
  h.add.mockReset().mockResolvedValue({ id: 'job' });
  h.stop.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('urgent stop bounds', () => {
  it('pins the production concurrency', () => expect(URGENT_STOP_CONCURRENCY).toBe(8));
  it.each([0, -1, 1.5, Infinity])(
    'refuses invalid concurrency %s before stopping anything',
    async (limit) => {
      await expect(run(limit)).rejects.toBeInstanceOf(RangeError);
      expect(h.stop).not.toHaveBeenCalled();
    },
  );
  it('keeps independent stops and settlement requests after a failed transaction or kill', async () => {
    h.stop.mockRejectedValueOnce(new Error('stop refused'));
    h.kill.mockRejectedValueOnce(new Error('kill refused'));
    const result = await run();
    expect(result).toMatchObject({
      kind: 'ok',
      failed: [expect.objectContaining({ id: '00000000-0000-4000-8000-000000000001' })],
      stopped: expect.arrayContaining([
        expect.objectContaining({ killError: 'kill refused' }),
        expect.objectContaining({ id: '00000000-0000-4000-8000-000000000003' }),
      ]),
    });
    expect(h.add).toHaveBeenCalledTimes(2);
  });
  it('7: starts at most the injected number of stops together and keeps processing', async () => {
    const starts: number[] = [];
    h.kill.mockImplementation(async (id) => {
      starts.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, id.endsWith('1') ? 200 : 100));
      return 0;
    });
    const pending = run();
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(starts).toEqual([0, 0, 100]);
    expect(result).toMatchObject({
      kind: 'ok',
      stopped: [
        expect.objectContaining({ id: '00000000-0000-4000-8000-000000000001' }),
        expect.objectContaining({ id: '00000000-0000-4000-8000-000000000002' }),
        expect.objectContaining({ id: '00000000-0000-4000-8000-000000000003' }),
      ],
      failed: [],
    });
  });
  it('12: queues all settlements together after stops, with one Redis outage wait', async () => {
    const starts: number[] = [];
    h.add.mockImplementation(async () => {
      starts.push(Date.now());
      return await new Promise(() => undefined);
    });
    const pending = run();
    await vi.runAllTimersAsync();
    expect((await pending).kind).toBe('ok');
    expect(starts).toEqual([0, 0, 0]);
    expect(Date.now()).toBe(2_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
