import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({
  db: undefined as unknown,
  add: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({
  getCliExecQueue: () => ({ add: h.add }),
  getUsagePollQueue: () => ({ add: vi.fn() }),
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { CLI_EXEC_JOB_NAMES } from '@haive/shared';
import { cliProviderRoutes } from '../src/routes/cli-providers.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const PROVIDER = '00000000-0000-4000-8000-0000000000b1';
const TAG = `haive-cli-sandbox:provider-${PROVIDER}-abc`;

const app = new Hono<AppEnv>();
app.route('/', cliProviderRoutes);
app.onError(errorHandler);

function setup(sandboxImageTag: string | null) {
  const fake = createFakeDb({ cliProviders: schema.cliProviders });
  fake.insert(schema.cliProviders, {
    id: PROVIDER,
    userId: USER,
    name: 'claude-code',
    label: 'claude',
    sandboxImageTag,
  });
  h.db = fake.db;
  return fake;
}

beforeEach(() => {
  h.add.mockReset();
  h.add.mockResolvedValue(undefined);
});

describe('deleting a CLI provider', () => {
  it('queues the removal of the image it named', async () => {
    const fake = setup(TAG);
    const res = await app.request(`/${PROVIDER}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(fake.rows(schema.cliProviders)).toHaveLength(0);
    expect(h.add).toHaveBeenCalledWith(
      CLI_EXEC_JOB_NAMES.REMOVE_SANDBOX_IMAGE,
      { providerId: PROVIDER, imageTag: TAG },
      expect.anything(),
    );
  });

  it('queues nothing for a provider that had no image', async () => {
    setup(null);
    const res = await app.request(`/${PROVIDER}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('still answers the delete when the removal cannot be queued', async () => {
    const fake = setup(TAG);
    h.add.mockRejectedValue(new Error('redis down'));
    const res = await app.request(`/${PROVIDER}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(fake.rows(schema.cliProviders)).toHaveLength(0);
  });
});
