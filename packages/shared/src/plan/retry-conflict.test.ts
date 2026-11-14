import { expect, it, vi } from 'vitest';
import { PlanPatchError } from './errors.js';
import { PLAN_CONFLICT_ATTEMPTS, retryPlanConflict } from './retry-conflict.js';

it('bounds conflict attempts and propagates the final refusal', async () => {
  expect(PLAN_CONFLICT_ATTEMPTS).toBe(3);
  const err = new PlanPatchError('conflict', 'raced');
  const apply = vi.fn().mockRejectedValue(err);
  await expect(retryPlanConflict(apply, 2)).rejects.toBe(err);
  expect(apply).toHaveBeenCalledTimes(2);
});

it('never retries any other refusal', async () => {
  const err = new PlanPatchError('not_found', 'gone');
  const apply = vi.fn().mockRejectedValue(err);
  await expect(retryPlanConflict(apply)).rejects.toBe(err);
  expect(apply).toHaveBeenCalledOnce();
});
