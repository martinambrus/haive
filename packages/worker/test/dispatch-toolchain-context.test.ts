import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import type { CliProviderRecord } from '../src/cli-adapters/types.js';
const h = vi.hoisted(() => ({ facets: vi.fn(), peek: vi.fn(), probe: vi.fn() }));
vi.mock('@haive/shared/global-kb', async (original) => ({
  ...(await original<object>()),
  resolveTaskFacets: h.facets,
}));
vi.mock('../src/queues/cli-exec/images.js', () => ({ peekSandboxImageTag: h.peek }));
vi.mock('../src/sandbox/toolchain-probe.js', async (original) => ({
  ...(await original<object>()),
  sandboxToolchainProbe: { get: h.probe },
}));
import {
  resolveDispatchSandboxToolchain,
  TOOLCHAIN_DISPATCH_WAIT_MS,
} from '../src/orchestrator/sandbox-toolchain.js';
import { SandboxToolchainProbe } from '../src/sandbox/toolchain-probe.js';
import { fakeDockerRunner } from './fake-docker-runner.js';
const db = {} as Database;
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
  const nextId = `sha256:${'b'.repeat(64)}`;
  h.peek.mockResolvedValueOnce({ tag: 'provider-one:tag', imageId: nextId });
  expect((await resolveDispatchSandboxToolchain(db, 't', [providers[0]!])).p0).toEqual({
    imageId: nextId,
    php: 'found',
    version: '8.4.2',
  });
  expect(run).toHaveBeenCalledTimes(2);
});
