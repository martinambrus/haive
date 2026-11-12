import { expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';

vi.mock('../repo/checkout-head.js', () => ({ checkoutMissing: async () => false }));
vi.mock('./set-aside.js', () => ({ resyncHaiveProjections: async () => true }));
vi.mock('../step-engine/merge-projections.js', () => ({ settleProjections: async () => true }));
import { sweepKeptProjectionMetadata } from './kept-metadata-recovery.js';

it.each(['outbox', 'legacy'] as const)('%s counts only fully settled captures', async (source) => {
  const capture = { '/repo': { 'plan.json': { mode: 0o600 } } };
  let remaining: typeof capture | null = capture;
  const db = {
    select: (fields: Record<string, unknown>) => {
      let table: unknown;
      const query = {
        from: (from: unknown) => {
          table = from;
          return query;
        },
        innerJoin: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async () => {
          if (table === schema.taskSteps)
            return source === 'legacy'
              ? [{ id: 'step', repositoryId: 'repo', state: { mergeDir: '/repo' } }]
              : [];
          if ('storagePath' in fields)
            return source === 'outbox'
              ? [{ repositoryId: 'repo', storagePath: '/repo', kept: capture }]
              : [];
          return [{ kept: remaining }];
        },
      };
      return query;
    },
    update: () => ({ set: () => ({ where: async () => [] }) }),
  } as unknown as Database;
  expect(await sweepKeptProjectionMetadata(db)).toBe(0);
  remaining = null;
  expect(await sweepKeptProjectionMetadata(db)).toBe(1);
});
