import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));

const { startModuleJobs } = await import('../src/modules/loader.js');

type Loaded = Parameters<typeof startModuleJobs>[0][number];
type Entry = Parameters<typeof startModuleJobs>[1][number];

function moduleWithJobs(id: string) {
  const stop = vi.fn(async () => {});
  const jobs = vi.fn(async () => stop);
  return {
    loaded: { manifest: { id } } as unknown as Loaded,
    entry: { jobs } as unknown as Entry,
    jobs,
    stop,
  };
}

describe('startModuleJobs', () => {
  it('starts no job of a deactivated module and every job of an active one', async () => {
    const off = moduleWithJobs('alpha');
    const on = moduleWithJobs('beta');
    const stopAll = await startModuleJobs(
      [off.loaded, on.loaded],
      [off.entry, on.entry],
      new Set(['alpha']),
    );
    expect(off.jobs).not.toHaveBeenCalled();
    expect(on.jobs).toHaveBeenCalledOnce();
    await stopAll();
    expect(on.stop).toHaveBeenCalledOnce();
    expect(off.stop).not.toHaveBeenCalled();
  });

  it('starts every module when none is deactivated', async () => {
    const a = moduleWithJobs('alpha');
    await startModuleJobs([a.loaded], [a.entry]);
    expect(a.jobs).toHaveBeenCalledOnce();
  });
});
