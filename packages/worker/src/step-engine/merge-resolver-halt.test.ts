import { describe, expect, it, vi } from 'vitest';
import { haltFailed } from './merge-resolver.js';
import type { Database } from '@haive/database';
import type { AdvanceStepParams, TaskStepRow } from './step-runner.js';

const writes = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock('./step-ownership.js', async (original) => ({
  ...(await original<typeof import('./step-ownership.js')>()),
  updateOwnedStep: (...args: unknown[]) => writes.update(...args),
}));

describe('#280 fix2 haltFailed without merge state', () => {
  it.each(['success', 'beforeRecord failure', 'record failure'])(
    'keeps beforeRecord and the failed row in one transaction: %s',
    async (kind) => {
      const committed: string[] = [];
      let staged: string[] = [];
      const tx = {};
      const db = {
        transaction: async (fn: (conn: unknown) => Promise<unknown>) => {
          staged = [];
          const out = await fn(tx);
          committed.push(...staged);
          return out;
        },
      };
      writes.update.mockImplementation(async (conn, _id, patch) => {
        expect(conn).toBe(tx);
        expect(staged).toEqual(['audit']);
        expect(patch).toMatchObject({ status: 'failed', errorMessage: 'blocked' });
        if (kind === 'record failure') throw new Error(kind);
        staged.push('failed row');
        return { id: 's1', ...patch };
      });
      const beforeRecord = async (conn: unknown) => {
        expect(conn).toBe(tx);
        staged.push('audit');
        if (kind === 'beforeRecord failure') throw new Error(kind);
      };
      const run = () =>
        haltFailed(
          db as unknown as Database,
          { id: 's1' } as TaskStepRow,
          {} as AdvanceStepParams,
          null,
          'blocked',
          'fallback',
          beforeRecord,
        );
      if (kind === 'success') {
        expect(await run()).toMatchObject({
          resolved: false,
          result: { status: 'failed', error: 'blocked' },
        });
        expect(committed).toEqual(['audit', 'failed row']);
      } else {
        await expect(run()).rejects.toThrow(kind);
        expect(committed).toEqual([]);
      }
    },
  );
});
