import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));

const { moduleJobsStarted, startModuleJobs } = await import('../src/modules/loader.js');

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

  it('reports the modules whose jobs it started, and forgets them once they are stopped', async () => {
    const off = moduleWithJobs('quiet');
    const on = moduleWithJobs('busy');
    const bare = { loaded: { manifest: { id: 'bare' } } as unknown as Loaded, entry: {} as Entry };
    const stopAll = await startModuleJobs(
      [off.loaded, on.loaded, bare.loaded],
      [off.entry, on.entry, bare.entry],
      new Set(['quiet']),
    );
    expect(['quiet', 'busy', 'bare', 'ghost'].map(moduleJobsStarted)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    await stopAll();
    expect(moduleJobsStarted('busy')).toBe(false);
  });

  it('forgets the jobs it started when a later module fails to start', async () => {
    const ok = moduleWithJobs('first');
    const bad = {
      loaded: { manifest: { id: 'second' } } as unknown as Loaded,
      entry: {
        jobs: vi.fn(async () => {
          throw new Error('no queue');
        }),
      } as unknown as Entry,
    };
    await expect(startModuleJobs([ok.loaded, bad.loaded], [ok.entry, bad.entry])).rejects.toThrow(
      /Module second jobs failed to start: no queue/,
    );
    expect(ok.stop).toHaveBeenCalledOnce();
    expect(moduleJobsStarted('first')).toBe(false);
  });
});
