import { expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { personaProviderNameFor } from '../src/queues/task-queue.js';
import type { ResolvedTaskContext } from '../src/queues/run-list.js';

vi.mock('../src/db.js', () => ({ getDb: () => undefined }));
vi.mock('../src/redis.js', () => ({ getBullRedis: () => ({}) }));
vi.mock('bullmq', async (original) => ({ ...(await original<object>()), Queue: class {} }));

it.each([true, false])(
  'persona check names the substitute for a saved outside pick, enabled=%s',
  async (enabled) => {
    const fake = createFakeDb({
      tasks: schema.tasks,
      envTemplates: schema.envTemplates,
      cliProviders: schema.cliProviders,
      taskStepCliChoices: schema.taskStepCliChoices,
      userStepCliPreferences: schema.userStepCliPreferences,
    });
    const userId = '00000000-0000-4000-8000-000000000001';
    const taskId = '00000000-0000-4000-8000-000000000002';
    const template = '00000000-0000-4000-8000-000000000003';
    const own = '00000000-0000-4000-8000-000000000004';
    const saved = '00000000-0000-4000-8000-000000000005';
    const stepId = 'custom.test.persona';
    fake.insert(schema.tasks, { id: taskId, userId, cliProviderId: own, envTemplateId: template });
    fake.insert(schema.envTemplates, {
      id: template,
      declaredDeps: { lspInstallContractVersion: 2 },
    });
    fake.insert(schema.cliProviders, {
      id: own,
      userId,
      name: 'claude-code',
      label: 'Claude',
      enabled: true,
      createdAt: new Date(2),
    });
    fake.insert(schema.cliProviders, {
      id: saved,
      userId,
      name: 'codex',
      label: 'Codex',
      enabled,
      createdAt: new Date(1),
    });
    fake.insert(schema.userStepCliPreferences, {
      userId,
      stepId,
      cliProviderId: saved,
      explicit: true,
    });
    const db = fake.db as unknown as Database;
    const providers = await db.select().from(schema.cliProviders);
    const ctx = {
      userId,
      taskId,
      cliProviderId: own,
      ignoreSavedStepClis: false,
    } as ResolvedTaskContext;
    expect(await personaProviderNameFor(db, ctx, stepId, providers)).toBe('claude-code');
  },
);
