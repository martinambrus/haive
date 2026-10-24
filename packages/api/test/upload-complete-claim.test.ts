import { describe, expect, it } from 'vitest';
import { schema } from '@haive/database';
import { HttpError } from '../src/context.js';
import { withCompleteClaim } from '../src/lib/upload-complete-claim.js';

const ID = '00000000-0000-4000-8000-0000000000b1';

// The claiming UPDATE misses, and the re-read finds whatever the winner left behind.
const missedClaim = (rows: { status: string }[]) => ({
  update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  select: () => ({ from: () => ({ where: async () => rows }) }),
});

const loses = async (rows: { status: string }[]) => {
  const err = await withCompleteClaim(
    missedClaim(rows) as never,
    schema.repoUploads,
    ID,
    async () => 'ran',
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  return { status: (err as HttpError).status, message: (err as HttpError).message };
};

describe('a complete whose claim misses answers by what the re-read finds', () => {
  it.each([
    ['complete', 'session already completed'],
    ['consumed', 'session already completed'],
    ['completing', 'a complete of this session is already running'],
    ['uploading', 'a complete of this session ended without finishing it; try again'],
    ['cancelled', 'session cancelled'],
    ['reaping', 'session cancelled'],
  ])('%s -> 409 %s', async (status, message) => {
    expect(await loses([{ status }])).toEqual({ status: 409, message });
  });

  it('a row that is gone -> 409 session cancelled', async () => {
    expect(await loses([])).toEqual({ status: 409, message: 'session cancelled' });
  });
});
