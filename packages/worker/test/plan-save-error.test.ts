import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, h, payload, REPO, SAVE_BUSY, setup } from './support/plan-mirror-failure.js';
import { save } from '../src/queues/plan-mirror-queue.js';

let fixture: ReturnType<typeof setup>;
beforeEach(() => {
  fixture = setup();
});
afterEach(cleanup);

describe('plan Save records a failed move', () => {
  it('T121 Save without push commits no project state', async () => {
    await save({ ...payload, push: false });
    expect(h.prepareProjectState).not.toHaveBeenCalled();
    expect(h.commitProjectState).not.toHaveBeenCalled();
  });
  it('T121 Save and push commits state once after a successful integration', async () => {
    await save(payload).catch(() => undefined); // the fixture deliberately has no real branch tip
    expect(h.prepareProjectState).toHaveBeenCalledTimes(1);
    expect(h.commitProjectState).toHaveBeenCalledTimes(1);
    expect(h.commitProjectState.mock.calls[0]![1]).toMatchObject({
      repositoryId: REPO,
      sourcePath: '/repo',
      targetPath: '/repo',
    });
    expect(h.commitProjectState.mock.invocationCallOrder[0]).toBeGreaterThan(
      h.fetch.mock.invocationCallOrder[0]!,
    );
  });

  it.each(['integrate', 'reconcile', 'flush', 'commit', 'resync', 'metadata'] as const)(
    'records and rethrows the same error from %s',
    async (phase) => {
      const error = new Error(`${phase} failed`);
      if (phase === 'integrate') h.fetch.mockRejectedValueOnce(error);
      else if (phase === 'flush') {
        h.flush.mockResolvedValueOnce({ files: ['.haive-data/plan.json'], repoPath: '/repo' });
        h.flush.mockRejectedValueOnce(error);
      } else if (phase === 'commit') {
        h.commit.mockResolvedValueOnce({ committed: true, commitSha: 'saved' });
        h.commit.mockRejectedValueOnce(error);
      } else h[phase].mockRejectedValueOnce(error);

      await expect(save(payload)).rejects.toBe(error);

      expect(h.record).toHaveBeenCalledExactlyOnceWith(h.db, REPO, error);
      expect(fixture.state().lastError).toBe(error.message);
    },
  );

  it('records an ordinary Error even when its message matches a refusal', async () => {
    const error = new Error(SAVE_BUSY);
    h.fetch.mockRejectedValueOnce(error);

    await expect(save(payload)).rejects.toBe(error);

    expect(h.record).toHaveBeenCalledExactlyOnceWith(h.db, REPO, error);
    expect(fixture.state().lastError).toBe(error.message);
  });

  it('records the AggregateError when the move and put-back both fail', async () => {
    fixture.keep();
    const error = new Error('move failed');
    const putError = new Error('put-back failed');
    h.restore.mockRejectedValueOnce(error);
    h.putBack.mockRejectedValueOnce(putError);

    const thrown = await save(payload).catch((err: unknown) => err);

    expect(h.putBack).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([error, putError]);
    expect(h.record).toHaveBeenCalledExactlyOnceWith(h.db, REPO, thrown);
    expect(fixture.state().lastError).toBe((thrown as AggregateError).message);
  });
});
