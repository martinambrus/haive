import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ lock: vi.fn() }));
vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  lockNewWorkFenceShared: h.lock,
}));

import { schema, type Database, type RootClaimHandle } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { configService } from '@haive/shared';
import {
  acquireAdmittedRootClaim,
  withAdmittedCheckoutMutation,
} from '../src/lib/admitted-checkout-mutation.js';
import { NewWorkRefused } from '../src/middleware/maintenance.js';
import { HttpError } from '../src/context.js';

const REPO = '00000000-0000-4000-8000-0000000000b1';
const USER = '00000000-0000-4000-8000-0000000000a1';

let fake: ReturnType<typeof createFakeDb>;
let events: string[];
let claimWrites: number;
let fresh: ReturnType<typeof vi.spyOn>;

const claimed = () => fake.rows(schema.repositories)[0]!.rootClaimedAt != null;
const admit = (run: (owner: RootClaimHandle) => Promise<unknown>) =>
  withAdmittedCheckoutMutation(fake.db as unknown as Database, REPO, USER, run);

beforeEach(() => {
  fake = createFakeDb({ repositories: schema.repositories });
  fake.insert(schema.repositories, { id: REPO, userId: USER, name: 'repo', status: 'ready' });
  events = [];
  claimWrites = 0;
  fake.hooks.beforeUpdate = (table) => {
    if (table === schema.repositories) claimWrites += 1;
  };
  fake.hooks.beforeCommit = () => {
    events.push('fence-committed');
  };
  h.lock.mockReset().mockImplementation(async () => {
    events.push(claimed() ? 'fence-lock-after-claim' : 'fence-lock-before-claim');
  });
  fresh = vi.spyOn(configService, 'getFresh').mockResolvedValue('normal');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('withAdmittedCheckoutMutation', () => {
  it('hands the work the owner and releases the claim after it', async () => {
    const run = vi.fn(async (owner: unknown) => {
      events.push('run');
      expect(owner).toEqual(expect.objectContaining({ release: expect.any(Function) }));
      return 'done';
    });
    await expect(admit(run)).resolves.toBe('done');
    expect(claimWrites).toBeGreaterThan(0);
    expect(claimed()).toBe(false);
  });

  it('takes the claim, then the fence, and has released the fence before the work starts', async () => {
    await admit(async () => {
      events.push('run');
    });
    expect(events).toEqual(['fence-lock-after-claim', 'fence-committed', 'run']);
    expect(claimed()).toBe(false);
  });

  it.each(['draining', 'maintenance'])(
    'refuses at the precheck while %s, with no claim write and no work',
    async (state) => {
      fresh.mockResolvedValue(state);
      const run = vi.fn();
      await expect(admit(run)).rejects.toBeInstanceOf(NewWorkRefused);
      expect(claimWrites).toBe(0);
      expect(h.lock).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('releases the claim it took when the state turns draining after the precheck', async () => {
    fresh.mockResolvedValueOnce('normal').mockResolvedValue('draining');
    const run = vi.fn();
    await expect(admit(run)).rejects.toBeInstanceOf(NewWorkRefused);
    expect(claimWrites).toBeGreaterThan(0);
    expect(events).toEqual(['fence-lock-after-claim']);
    expect(claimed()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('answers 409 busy and releases the claim when the fence wait times out', async () => {
    vi.useFakeTimers();
    h.lock.mockImplementation(
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(Object.assign(new Error('lock wait'), { code: '55P03' })), 1_000),
        ),
    );
    const run = vi.fn();
    const outcome = admit(run).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await outcome;
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect(claimed()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('acquireAdmittedRootClaim', () => {
  const take = (kind: 'edit' | 'verify' | 'reset' = 'verify') =>
    acquireAdmittedRootClaim(fake.db as unknown as Database, REPO, kind, USER);

  it('hands back a held claim of the requested kind with the fence committed before it returns', async () => {
    const claim = await take('reset');
    expect(claim).not.toBeNull();
    expect(events).toEqual(['fence-lock-after-claim', 'fence-committed']);
    expect(claimed()).toBe(true);
    expect(fake.rows(schema.repositories)[0]!.rootClaimKind).toBe('reset');
    await claim!.release();
    expect(claimed()).toBe(false);
  });

  it('returns null and takes no fence when another holder has the claim', async () => {
    const other = await take('edit');
    events.length = 0;
    h.lock.mockClear();
    expect(await take('verify')).toBeNull();
    expect(h.lock).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(claimed()).toBe(true);
    await other!.release();
  });

  it.each(['draining', 'maintenance'])(
    'refuses at the precheck while %s, with no claim write and no fence',
    async (state) => {
      fresh.mockResolvedValue(state);
      await expect(take()).rejects.toBeInstanceOf(NewWorkRefused);
      expect(claimWrites).toBe(0);
      expect(h.lock).not.toHaveBeenCalled();
    },
  );

  it('releases the claim it took when the state turns draining after the precheck', async () => {
    fresh.mockResolvedValueOnce('normal').mockResolvedValue('draining');
    await expect(take()).rejects.toBeInstanceOf(NewWorkRefused);
    expect(claimWrites).toBeGreaterThan(0);
    expect(events).toEqual(['fence-lock-after-claim']);
    expect(claimed()).toBe(false);
  });

  it('answers 409 busy and releases the claim when the fence wait times out', async () => {
    vi.useFakeTimers();
    h.lock.mockImplementation(
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(Object.assign(new Error('lock wait'), { code: '55P03' })), 1_000),
        ),
    );
    const outcome = take().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = await outcome;
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect(claimed()).toBe(false);
  });
});
