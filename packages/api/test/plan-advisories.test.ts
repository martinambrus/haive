import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import type { Database } from '@haive/database';
import { loadOpenPlanAdvisories, OPEN_PLAN_TASK_STATES } from '../src/lib/plan-advisories.js';

describe('open plan advisories', () => {
  it('finds node metadata across every open state without conflating other repos or task types', async () => {
    const fake = createFakeDb({ tasks: schema.tasks });
    const repositoryId = randomUUID();
    for (const status of [...OPEN_PLAN_TASK_STATES, 'completed', 'failed', 'cancelled']) {
      fake.insert(schema.tasks, {
        id: randomUUID(),
        repositoryId,
        type: 'advisory',
        status,
        metadata: { planNodeId: `node-${status}` },
      });
    }
    fake.insert(schema.tasks, {
      id: randomUUID(),
      repositoryId: randomUUID(),
      type: 'advisory',
      status: 'running',
      metadata: { planNodeId: 'other-node' },
    });
    fake.insert(schema.tasks, {
      id: randomUUID(),
      repositoryId,
      type: 'plan_chat',
      status: 'running',
      metadata: { planNodeId: 'chat-node' },
    });
    fake.insert(schema.tasks, {
      id: randomUUID(),
      repositoryId,
      type: 'advisory',
      status: 'running',
      metadata: {},
    });
    const tasks = await loadOpenPlanAdvisories(fake.db as unknown as Database, repositoryId);
    expect(tasks.map((t) => t.nodeId)).toEqual(
      OPEN_PLAN_TASK_STATES.map((status) => `node-${status}`),
    );
  });
});
