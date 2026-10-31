import { afterEach, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { logger } from '@haive/shared';

const h = vi.hoisted(() => ({ ownPlan: false, original: new Error('checkout read failed') }));
vi.mock('../src/plan/mirror.js', () => ({
  reconcilePlanFromCheckout: async () => {
    throw h.original;
  },
  importPlanMirror: async () => ({ imported: false, code: 'refused', reason: 'invalid JSON' }),
  recordPlanMirrorError: async () => {
    throw new Error('recording failed');
  },
  recordPlanReconcileFailure: async () => {
    throw new Error('recording failed');
  },
}));
import { syncPlanFromCheckout } from '../src/plan/sync-checkout.js';
const db = {
  select: () => ({
    from: () => ({ where: () => ({ limit: async () => (h.ownPlan ? [{ id: 'node' }] : []) }) }),
  }),
} as unknown as Database;
afterEach(() => vi.restoreAllMocks());

it('preserves the original reconcile failure if recording it fails', async () => {
  h.ownPlan = true;
  await expect(syncPlanFromCheckout(db, 'repo', '/unused')).rejects.toBe(h.original);
});
it('keeps an import refusal non-fatal if recording it fails', async () => {
  h.ownPlan = false;
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  await expect(syncPlanFromCheckout(db, 'repo', '/unused')).resolves.toBeUndefined();
});
