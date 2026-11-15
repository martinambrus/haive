import { expect, it, vi } from 'vitest';
import { insightAutoEnabled } from './_insight-auto.js';

vi.mock('@haive/shared/schemas', async (original) => ({
  ...(await original<object>()),
  INSIGHT_AUTO_ACTION_AVAILABLE: false,
}));

it('the rollout switch stops automatic starts for tasks already opted in', async () => {
  const read = vi.fn().mockResolvedValue([{ auto: true }]);
  const db = { select: () => ({ from: () => ({ where: read }) }) };
  expect(await insightAutoEnabled(db as never, 'task')).toBe(false);
});
