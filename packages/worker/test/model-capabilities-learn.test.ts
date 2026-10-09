import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { learnModelLimitFromFailure } from '../src/cli-adapters/model-capabilities.js';
import { MODEL_CAPABILITY_HEADLINES } from '../src/queues/cli-exec/failure-class.js';

describe('learnModelLimitFromFailure', () => {
  it('reads and writes the provider limits under the row lock, in one transaction', async () => {
    const ops: string[] = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: async (mode: string) => {
              ops.push(`select for ${mode}`);
              return [{ name: 'claude-code', model: 'claude-x', modelLimits: null }];
            },
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            ops.push('update');
          },
        }),
      }),
    };
    const db = {
      transaction: async (fn: (t: typeof tx) => unknown) => {
        ops.push('begin');
        return fn(tx);
      },
    } as unknown as Database;

    const learned = await learnModelLimitFromFailure(
      db,
      'prov-1',
      `${MODEL_CAPABILITY_HEADLINES.no_image_support} — hint.`,
    );
    expect(learned).toMatchObject({ vision: false });
    expect(ops).toEqual(['begin', 'select for update', 'update']);
  });

  it('moves learnedAt strictly forward even when the clock has not', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    let written: { learnedAt?: string } | undefined;
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: async () => [
              {
                name: 'claude-code',
                model: 'claude-x',
                modelLimits: { model: 'claude-x', maxOutputTokens: 131072, learnedAt: future },
              },
            ],
          }),
        }),
      }),
      update: () => ({
        set: (patch: { modelLimits: { learnedAt?: string } }) => ({
          where: async () => {
            written = patch.modelLimits;
          },
        }),
      }),
    };
    const db = {
      transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
    } as unknown as Database;

    await learnModelLimitFromFailure(
      db,
      'prov-1',
      `${MODEL_CAPABILITY_HEADLINES.no_image_support} — hint.`,
    );
    expect(new Date(written!.learnedAt!).getTime()).toBe(new Date(future).getTime() + 1);
  });
});
