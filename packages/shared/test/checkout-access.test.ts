import { beforeEach, expect, it } from 'vitest';
import { acquireRootClaim, schema, type Database, type RootClaimHandle } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { requireCheckoutAccess, withCheckoutMutation } from '../src/checkout-access.js';
const id = '00000000-0000-4000-8000-000000007810';
const userId = '00000000-0000-4000-8000-000000007811';
let fake: ReturnType<typeof createFakeDb>;
let db: Database;
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
