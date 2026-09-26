import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db.js', () => ({ getDb: () => null }));
vi.mock('../src/queues.js', () => ({ getTaskQueue: () => ({}) }));

import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { lastUpgradeRemovedFiles } from '../src/routes/upgrades.js';

const REPO = '00000000-0000-4000-8000-0000000000c1';

function upgrades(tasks: { mode?: string; completedAt: number; removedPaths?: string[] }[]) {
  const fake = createFakeDb({ tasks: schema.tasks, taskSteps: schema.taskSteps });
  for (const t of tasks) {
    const task = fake.insert(schema.tasks, {
      repositoryId: REPO,
      type: 'onboarding_upgrade',
      status: 'completed',
      completedAt: new Date(t.completedAt),
      metadata: t.mode ? { mode: t.mode } : null,
    });
    if (t.removedPaths) {
      fake.insert(schema.taskSteps, {
        taskId: task.id,
        stepId: '02-upgrade-apply',
        status: 'done',
        output: { removedPaths: t.removedPaths },
      });
    }
  }
  return lastUpgradeRemovedFiles(fake.db as never, REPO);
}

describe('offering the rollback of an upgrade that only removed files', () => {
  it('offers it while the latest upgrade removed something and nothing rolled it back', async () => {
    expect(await upgrades([{ completedAt: 1, removedPaths: ['.claude/settings.json'] }])).toBe(
      true,
    );
  });

  it('stops offering it once a rollback completes after that upgrade', async () => {
    expect(
      await upgrades([
        { completedAt: 1, removedPaths: ['.claude/settings.json'] },
        { mode: 'rollback', completedAt: 2 },
      ]),
    ).toBe(false);
  });

  it('does not offer it for an upgrade that removed nothing, or with no upgrade at all', async () => {
    expect(await upgrades([{ completedAt: 1, removedPaths: [] }])).toBe(false);
    expect(await upgrades([{ completedAt: 1 }])).toBe(false);
    expect(await upgrades([])).toBe(false);
  });
});
