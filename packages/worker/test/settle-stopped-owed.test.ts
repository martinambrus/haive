import { describe, expect, it } from 'vitest';
import { taskQueueOwed } from '../src/queues/stalled-redrive.js';

describe('taskQueueOwed and the settle job', () => {
  it('O1: a settle-stopped-task job owes no step and no start', () => {
    const owed = taskQueueOwed([
      { name: 'settle-stopped-task', data: { taskId: 'settling' } },
      { name: 'advance-step', data: { taskId: 'advancing' } },
      { name: 'cancel-task', data: { taskId: 'cancelling' } },
      { name: 'start-task', data: { taskId: 'claimed' } },
    ]);
    expect([...owed.steps].sort()).toEqual(['advancing', 'cancelling']);
    expect([...owed.starts]).toEqual(['claimed']);
    expect(owed.steps.has('settling')).toBe(false);
    expect(owed.starts.has('settling')).toBe(false);
  });
});
