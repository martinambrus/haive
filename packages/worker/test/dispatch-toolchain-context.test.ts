import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyProjectFacetSet } from '@haive/shared/global-kb';
import type { Database } from '@haive/database';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
const h = vi.hoisted(() => ({ facets: vi.fn(), peek: vi.fn(), probe: vi.fn() }));
vi.mock('../src/queues/cli-exec/images.js', () => ({
  peekSandboxImageTag: h.peek,
  createSandboxImagePeekBatch: () => ({}),
}));
vi.mock('../src/sandbox/toolchain-probe.js', async (original) => ({
  ...(await original<object>()),
  sandboxToolchainProbe: { get: h.probe },
}));
import {
  resolveDispatchSandboxToolchain as resolveWithFacets,
  TOOLCHAIN_DISPATCH_WAIT_MS,
} from '../src/orchestrator/sandbox-toolchain.js';
import { SandboxToolchainProbe } from '../src/sandbox/toolchain-probe.js';
import { fakeDockerRunner } from './fake-docker-runner.js';
const resolveDispatchSandboxToolchain = (
  db: Database,
  taskId: string,
  providers: CliProviderRecord[],
  opts: Partial<Parameters<typeof resolveWithFacets>[3]> = {},
) => resolveWithFacets(db, taskId, providers, { resolveFacets: h.facets, ...opts });
let db = {} as Database;
const ID = `sha256:${'a'.repeat(64)}`;
const providers = [0, 1].map(
  (n) =>
    ({
      id: `p${n}`,
      enabled: true,
      name: 'codex',
      wrapperContent: null,
      envVars: null,
    }) as CliProviderRecord,
);
beforeEach(() => {
  db = {} as Database;
  vi.useFakeTimers();
  h.facets.mockReset().mockResolvedValue({ language: ['php'] });
  h.peek.mockReset().mockResolvedValue({ tag: 'image:tag', imageId: ID });
  h.probe.mockReset().mockResolvedValue({ imageId: ID, php: 'absent' });
});
afterEach(() => vi.useRealTimers());
it('resolves every enabled provider and never probes an unmapped language or a PATH/wrapper override', async () => {
  expect(Object.keys(await resolveDispatchSandboxToolchain(db, 't', providers))).toEqual([
    'p0',
    'p1',
  ]);
  expect(h.peek).toHaveBeenCalledTimes(2);
  h.peek.mockClear();
  h.facets.mockResolvedValueOnce({ language: ['typescript'] });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await resolveDispatchSandboxToolchain(db, 't', providers)).toEqual({});
  const overridden = [
    { ...providers[0]!, wrapperContent: 'exec cli' },
    { ...providers[1]!, envVars: { PATH: '/custom' } },
  ];
  expect(await resolveDispatchSandboxToolchain(db, 't', overridden)).toEqual({});
  expect(h.peek).not.toHaveBeenCalled();
});
it('bounds the entire dispatch wait and starts no late probe after inspect finally resolves', async () => {
  expect(TOOLCHAIN_DISPATCH_WAIT_MS).toBe(2500);
  let release!: (image: { tag: string; imageId: string }) => void;
  h.peek.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const work = resolveDispatchSandboxToolchain(db, 't', providers.slice(0, 1), { waitMs: 10 });
  await vi.advanceTimersByTimeAsync(10);
  const answer = await work;
  expect(answer).toEqual({});
  release({ tag: 'image:tag', imageId: ID });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.probe).not.toHaveBeenCalled();
  expect(answer).toEqual({});
});
it('keeps a timed-out probe result out of the returned batch and retries on a later dispatch', async () => {
  let release!: (fact: { imageId: string; php: 'absent' }) => void;
  h.probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const work = resolveDispatchSandboxToolchain(db, 't', providers.slice(0, 1), { waitMs: 10 });
  await vi.advanceTimersByTimeAsync(10);
  const answer = await work;
  release({ imageId: ID, php: 'absent' });
  await vi.advanceTimersByTimeAsync(0);
  expect(answer).toEqual({});
  expect(Object.keys(await resolveDispatchSandboxToolchain(db, 't', providers))).toHaveLength(2);
});

it('two dispatches and two image tags of one ID share a probe, and a rebuilt tag gets another', async () => {
  let release!: (value: {
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
  }) => void;
  const run = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({
      exitCode: 0,
      stdout: '8.4.2',
      stderr: '',
      durationMs: 1,
      timedOut: false,
    });
  const probe = new SandboxToolchainProbe(fakeDockerRunner({ run }));
  h.probe.mockImplementation((imageId) => probe.get(imageId));
  h.peek
    .mockResolvedValueOnce({ tag: 'provider-one:tag', imageId: ID })
    .mockResolvedValueOnce({ tag: 'provider-two:tag', imageId: ID });
  const first = resolveDispatchSandboxToolchain(db, 't', [providers[0]!]);
  const second = resolveDispatchSandboxToolchain(db, 't', [providers[1]!]);
  await vi.advanceTimersByTimeAsync(0);
  expect(run).toHaveBeenCalledTimes(1);
  release({ exitCode: 199, stdout: '', stderr: '', durationMs: 1, timedOut: false });
  expect((await first).p0?.php).toBe('absent');
  expect((await second).p1?.php).toBe('absent');
  await vi.advanceTimersByTimeAsync(10_000);
  const nextId = `sha256:${'b'.repeat(64)}`;
  h.peek.mockResolvedValueOnce({ tag: 'provider-one:tag', imageId: nextId });
  expect((await resolveDispatchSandboxToolchain(db, 't', [providers[0]!])).p0).toEqual({
    imageId: nextId,
    php: 'found',
    version: '8.4.2',
  });
  expect(run).toHaveBeenCalledTimes(2);
});

it('memoizes provider peeks for 10 seconds across serial and racing dispatches', async () => {
  await Promise.all([
    resolveDispatchSandboxToolchain(db, 't', providers),
    resolveDispatchSandboxToolchain(db, 't', providers),
  ]);
  await resolveDispatchSandboxToolchain(db, 't', providers);
  expect(h.peek).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10_000);
  await resolveDispatchSandboxToolchain(db, 't', providers);
  expect(h.peek).toHaveBeenCalledTimes(4);
});
it('uses facets already resolved by the dispatch', async () => {
  await resolveDispatchSandboxToolchain(db, 't', providers, {
    resolveFacets: async () => ({ ...emptyProjectFacetSet(), language: ['php'] }),
  });
  expect(h.facets).not.toHaveBeenCalled();
  expect(h.peek).toHaveBeenCalledTimes(2);
});

it('gives three overlapping identical dispatches the same prompt facts', async () => {
  let release!: (image: { tag: string; imageId: string }) => void;
  h.peek.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const requests = Array.from({ length: 3 }, () =>
    resolveDispatchSandboxToolchain(db, 't', [providers[0]!], { waitMs: 10 }),
  );
  await vi.advanceTimersByTimeAsync(0);
  release({ tag: 'image:tag', imageId: ID });
  await vi.advanceTimersByTimeAsync(10);
  const answers = await Promise.all(requests);
  expect(answers).toEqual(
    Array.from({ length: 3 }, () => ({ p0: { imageId: ID, php: 'absent' } })),
  );
});

it('bounds the peek cache and expires entries using injectable limits', async () => {
  const opts = { cacheLimits: { cacheLimit: 2, ttlMs: 10 } };
  for (const taskId of ['one', 'two', 'three', 'one'])
    await resolveDispatchSandboxToolchain(db, taskId, [providers[0]!], opts);
  expect(h.peek).toHaveBeenCalledTimes(4);
  await resolveDispatchSandboxToolchain(db, 'one', [providers[0]!], opts);
  expect(h.peek).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(10);
  await resolveDispatchSandboxToolchain(db, 'one', [providers[0]!], opts);
  expect(h.peek).toHaveBeenCalledTimes(5);
});
