import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  h,
  payload,
  PULL_BUSY,
  REASON,
  REPO,
  SAVE_BUSY,
  setup,
} from './support/plan-mirror-failure.js';
import { pull, save } from '../src/queues/plan-mirror-queue.js';

let fixture: ReturnType<typeof setup>;
beforeEach(() => {
  fixture = setup();
});
afterEach(cleanup);

describe('plan move refusals stay out of last_error', () => {
  it.each([
    ['save held', save, false, { outcome: 'held', holding: 1 }, SAVE_BUSY],
    [
      'save refused',
      save,
      false,
      { outcome: 'refused', reason: REASON },
      `${REASON}; the plan commit stays local and nothing was pushed`,
    ],
    ['pull aside held', pull, true, { outcome: 'held', holding: 1 }, PULL_BUSY],
    [
      'pull aside refused',
      pull,
      true,
      { outcome: 'refused', reason: REASON },
      `${REASON}; nothing was pulled and the checkout was not moved`,
    ],
    ['pull integrate held', pull, false, { outcome: 'held', holding: 1 }, PULL_BUSY],
    [
      'pull integrate refused',
      pull,
      false,
      { outcome: 'refused', reason: REASON },
      `${REASON}; nothing was pulled and the checkout was not moved`,
    ],
  ] as const)(
    '%s keeps its exact message without recording an error',
    async (_name, run, early, aside, message) => {
      if (run === pull && !early) h.aside.mockResolvedValueOnce({ outcome: 'clean' });
      h.aside.mockResolvedValueOnce(aside);

      const thrown = await run(payload).catch((err: unknown) => err);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(message);
      expect(h.record).not.toHaveBeenCalled();
      expect(fixture.state().lastError).toBeNull();
    },
  );

  it.each([
    ['save', save],
    ['pull', pull],
  ] as const)(
    '%s refuses a merge conversation opened during integration without recording it',
    async (_name, run) => {
      h.fetch.mockImplementationOnce(async () => fixture.openConversation());

      const thrown = await run(payload).catch((err: unknown) => err);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('A merge conversation is open for this repository');
      expect(h.record).not.toHaveBeenCalled();
      expect(fixture.state().lastError).toBeNull();
    },
  );

  it('does not record the initial busy Pull refusal', async () => {
    fixture.busy();
    await expect(pull(payload)).rejects.toThrow(PULL_BUSY);
    expect(h.aside).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(fixture.state().lastError).toBeNull();
  });

  it.each([
    ['save', save],
    ['pull', pull],
  ] as const)('records a failed put-back after a %s integration refusal', async (_name, run) => {
    fixture.keep();
    h.restore.mockResolvedValueOnce({ outcome: 'refused', reason: REASON });
    const putError = new Error('put-back failed after refusal');
    h.putBack.mockResolvedValueOnce(undefined).mockRejectedValueOnce(putError);

    const thrown = await run(payload).catch((err: unknown) => err);

    expect(h.putBack).toHaveBeenCalledTimes(2);
    expect(thrown).toBeInstanceOf(AggregateError);
    const [refusal, recoveryError] = (thrown as AggregateError).errors as Error[];
    expect(refusal?.message).toBe(
      run === save
        ? `${REASON}; the plan commit stays local and nothing was pushed`
        : `${REASON}; nothing was pulled and the checkout was not moved`,
    );
    expect(recoveryError).toBe(putError);
    expect(h.record).toHaveBeenCalledExactlyOnceWith(h.db, REPO, thrown);
    expect(fixture.state().lastError).toBe((thrown as AggregateError).message);
  });
});
