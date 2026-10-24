import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, h, payload, REPO, PULL_BUSY, setup } from './support/plan-mirror-failure.js';
import { pull } from '../src/queues/plan-mirror-queue.js';

let fixture: ReturnType<typeof setup>;
beforeEach(() => {
  fixture = setup();
});
afterEach(cleanup);

describe('plan Pull records a failed move', () => {
  it.each(['integrate', 'reconcile', 'flush', 'resync', 'metadata'] as const)(
    'records and rethrows the same error from %s',
    async (phase) => {
      const error = new Error(`${phase} failed`);
      if (phase === 'integrate') h.fetch.mockRejectedValueOnce(error);
      else h[phase].mockRejectedValueOnce(error);

      await expect(pull(payload)).rejects.toBe(error);

      expect(h.record).toHaveBeenCalledExactlyOnceWith(h.db, REPO, error);
      expect(fixture.state().lastError).toBe(error.message);
    },
  );

  it('records an ordinary Error even when its message matches a refusal', async () => {
    const error = new Error(PULL_BUSY);
    h.fetch.mockRejectedValueOnce(error);

    await expect(pull(payload)).rejects.toBe(error);

    expect(h.record).toHaveBeenCalledExactlyOnceWith(h.db, REPO, error);
    expect(fixture.state().lastError).toBe(error.message);
  });

  it('records the AggregateError when the move and put-back both fail', async () => {
    fixture.keep();
    const error = new Error('move failed');
    const putError = new Error('put-back failed');
    h.restore.mockRejectedValueOnce(error);
    h.putBack.mockRejectedValueOnce(putError);

    const thrown = await pull(payload).catch((err: unknown) => err);

    expect(h.putBack).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([error, putError]);
    expect(h.record).toHaveBeenCalledExactlyOnceWith(h.db, REPO, thrown);
    expect(fixture.state().lastError).toBe((thrown as AggregateError).message);
  });
});
