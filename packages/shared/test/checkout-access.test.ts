import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  acquireRootClaim,
  ROOT_CLAIM_RENEW_MS,
  ROOT_CLAIM_STALE_MS,
  rootClaimRefusal,
  schema,
  type Database,
  type RootClaimHandle,
} from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import {
  assertCheckoutMutationOwner,
  requireCheckoutAccess,
  withCheckoutMutation,
} from '../src/checkout-access.js';
const id = '00000000-0000-4000-8000-000000007810';
const userId = '00000000-0000-4000-8000-000000007811';
let fake: ReturnType<typeof createFakeDb>;
let db: Database;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
beforeEach(() => {
  fake = createFakeDb({ repositories: schema.repositories });
  fake.insert(schema.repositories, { id, userId, status: 'ready' });
  db = fake.db as unknown as Database;
});
it('keeps read-only UI available across an ordinary ready refresh', async () => {
  fake.patch(schema.repositories, id, {
    rootClaimedAt: new Date(),
    rootClaimKind: 'refresh',
    rootClaimOwner: 'foreign',
  });
  await expect(requireCheckoutAccess(db, id, { mode: 'read' })).resolves.toMatchObject({ id });
  await expect(requireCheckoutAccess(db, id, { mode: 'mutation' })).rejects.toMatchObject({
    code: 'checkout_unavailable',
  });
});
it.each(['cloning', 'error'])('never reads an unavailable %s checkout as empty', async (status) => {
  fake.patch(schema.repositories, id, { status });
  await expect(requireCheckoutAccess(db, id, { mode: 'read' })).rejects.toMatchObject({
    code: 'checkout_unavailable',
  });
});
it('allows explicit repair on an error checkout but refuses preparation', async () => {
  fake.patch(schema.repositories, id, { status: 'error' });
  await expect(
    withCheckoutMutation(db, id, userId, async () => 'repaired', 'repair'),
  ).resolves.toBe('repaired');
  fake.patch(schema.repositories, id, { status: 'cloning' });
  await expect(
    withCheckoutMutation(db, id, userId, async () => 'unsafe', 'repair'),
  ).rejects.toMatchObject({ code: 'checkout_unavailable' });
});
it('authorizes private replacement work only with the actual renewing owner', async () => {
  const owner = (await acquireRootClaim(db, id, 'rebuild'))!;
  fake.patch(schema.repositories, id, { status: 'cloning' });
  try {
    await expect(
      requireCheckoutAccess(db, id, { mode: 'preparation', owner }),
    ).resolves.toMatchObject({ id });
    const forged = { release: async () => {}, lost: () => false };
    for (const invalid of [forged, true, {}]) {
      await expect(
        requireCheckoutAccess(db, id, { mode: 'preparation', owner: invalid as RootClaimHandle }),
      ).rejects.toMatchObject({ code: 'checkout_unavailable' });
    }
    fake.insert(schema.repositories, {
      id: userId,
      userId,
      status: 'cloning',
      rootClaimedAt: new Date(),
      rootClaimOwner: fake.rows(schema.repositories)[0]!.rootClaimOwner,
    });
    await expect(
      requireCheckoutAccess(db, userId, { mode: 'preparation', owner }),
    ).rejects.toMatchObject({ code: 'checkout_unavailable' });
    fake.patch(schema.repositories, id, { rootClaimOwner: 'successor' });
    await expect(
      requireCheckoutAccess(db, id, { mode: 'preparation', owner }),
    ).rejects.toMatchObject({ code: 'checkout_unavailable' });
  } finally {
    await owner.release();
  }
});
it('rejects released capabilities and releases on a failed operation', async () => {
  const owner = (await acquireRootClaim(db, id, 'rebuild'))!;
  await owner.release();
  await expect(requireCheckoutAccess(db, id, { mode: 'preparation', owner })).rejects.toMatchObject(
    { code: 'checkout_unavailable' },
  );
  await expect(
    withCheckoutMutation(db, id, userId, async () => {
      throw new Error('failed');
    }),
  ).rejects.toThrow('failed');
  expect(fake.rows(schema.repositories)[0]!.rootClaimOwner).toBeNull();
});
it('cannot acquire a claim for another user', async () => {
  await expect(withCheckoutMutation(db, id, id, async () => 'unsafe')).rejects.toMatchObject({
    code: 'checkout_unavailable',
  });
  expect(fake.rows(schema.repositories)[0]!.rootClaimOwner).toBeNull();
});

it('refuses independent mutations while preparation is owed, including post-ready imports', async () => {
  fake.patch(schema.repositories, id, { refreshPending: true });
  await expect(withCheckoutMutation(db, id, userId, async () => 'unsafe')).rejects.toMatchObject({
    code: 'checkout_unavailable',
  });
  expect(fake.rows(schema.repositories)[0]!.rootClaimOwner).toBeNull();
});
it.each(['edit', 'mutation'] as const)('rejects a %s capability for preparation', async (kind) => {
  const owner = (await acquireRootClaim(db, id, kind))!;
  fake.patch(schema.repositories, id, { status: 'cloning' });
  try {
    await expect(
      requireCheckoutAccess(db, id, { mode: 'preparation', owner }),
    ).rejects.toMatchObject({ code: 'checkout_unavailable' });
  } finally {
    await owner.release();
  }
});
it('uses distinct truthful copy for long mutations and short knowledge edits', () => {
  expect(rootClaimRefusal('edit')).toContain('knowledge file');
  expect(rootClaimRefusal('mutation')).toContain('being changed');
});
it('holds long independent work as a mutation claim', async () => {
  await withCheckoutMutation(db, id, userId, async () => {
    expect(fake.rows(schema.repositories)[0]!.rootClaimKind).toBe('mutation');
  });
});

it.each(['reset', 'rebuild', 'refresh', 'edit', 'mutation', 'verify'] as const)(
  'keeps the stable refusal code with %s copy',
  async (kind) => {
    const owner = (await acquireRootClaim(db, id, kind))!;
    try {
      await expect(
        withCheckoutMutation(db, id, userId, async () => 'unsafe'),
      ).rejects.toMatchObject({ code: 'checkout_unavailable', message: rootClaimRefusal(kind) });
    } finally {
      await owner.release();
    }
  },
);
it('lets an admitted owner finish after a preparation becomes owed', async () => {
  await withCheckoutMutation(db, id, userId, async (owner) => {
    fake.patch(schema.repositories, id, { refreshPending: true });
    await expect(requireCheckoutAccess(db, id, { mode: 'mutation', owner })).resolves.toMatchObject(
      { id },
    );
  });
});

it.each([false, true])(
  'stops independent writes before lease expiry while renewal keeps trying (read-back fails=%s)',
  async (readFails) => {
    vi.useFakeTimers();
    const started = Date.now();
    const owner = (await acquireRootClaim(db, id, 'mutation'))!;
    const update = vi.spyOn(db, 'update').mockImplementation(() => {
      throw new Error('renewal cannot reach the database');
    });
    if (readFails)
      vi.spyOn(db, 'select').mockImplementation(() => {
        throw new Error('read-back cannot reach the database');
      });
    try {
      await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
      expect(owner.lost()).toBe(false);
      expect(() => assertCheckoutMutationOwner(owner)).not.toThrow();
      // Inject the physical write's clock, between timer ticks, with 30 seconds still left
      // before PostgreSQL can admit a takeover. Failed attempts are never confirmations.
      expect(() =>
        assertCheckoutMutationOwner(owner, () => started + ROOT_CLAIM_STALE_MS - 30_001),
      ).not.toThrow();
      expect(() =>
        assertCheckoutMutationOwner(owner, () => started + ROOT_CLAIM_STALE_MS - 30_000),
      ).toThrow(expect.objectContaining({ code: 'checkout_unavailable' }));
      const attempts = update.mock.calls.length;
      await vi.advanceTimersByTimeAsync(ROOT_CLAIM_STALE_MS);
      expect(update.mock.calls.length).toBeGreaterThan(attempts);
      expect(owner.lost()).toBe(false);
      vi.restoreAllMocks();
      await vi.advanceTimersByTimeAsync(ROOT_CLAIM_RENEW_MS);
      expect(() => assertCheckoutMutationOwner(owner)).not.toThrow();
    } finally {
      vi.restoreAllMocks();
      await owner.release();
    }
  },
);

it('allows writes beyond the initial stale window after confirmed renewals, and rejects release', async () => {
  vi.useFakeTimers();
  const owner = (await acquireRootClaim(db, id, 'mutation'))!;
  try {
    await vi.advanceTimersByTimeAsync(ROOT_CLAIM_STALE_MS * 2);
    expect(() => assertCheckoutMutationOwner(owner)).not.toThrow();
  } finally {
    await owner.release();
  }
  expect(() => assertCheckoutMutationOwner(owner)).toThrow(
    expect.objectContaining({ code: 'checkout_unavailable' }),
  );
});

it('permits locked projections during owed ready scans, but never under a foreign live claim', async () => {
  fake.patch(schema.repositories, id, { refreshPending: true });
  await expect(requireCheckoutAccess(db, id, { mode: 'projection' })).resolves.toMatchObject({
    id,
  });
  const owner = (await acquireRootClaim(db, id, 'refresh'))!;
  try {
    await expect(requireCheckoutAccess(db, id, { mode: 'projection' })).rejects.toMatchObject({
      code: 'checkout_unavailable',
    });
  } finally {
    await owner.release();
  }
  fake.patch(schema.repositories, id, { status: 'cloning' });
  await expect(requireCheckoutAccess(db, id, { mode: 'projection' })).rejects.toMatchObject({
    code: 'checkout_unavailable',
  });
});

it('admits a projection under its own live claim of any kind, and refuses a released handle', async () => {
  const owner = (await acquireRootClaim(db, id, 'edit', userId))!;
  await expect(requireCheckoutAccess(db, id, { mode: 'projection', owner })).resolves.toMatchObject(
    { id },
  );
  await expect(requireCheckoutAccess(db, id, { mode: 'projection' })).rejects.toMatchObject({
    code: 'checkout_unavailable',
  });
  await owner.release();
  await expect(requireCheckoutAccess(db, id, { mode: 'projection', owner })).rejects.toMatchObject({
    code: 'checkout_unavailable',
  });
});
