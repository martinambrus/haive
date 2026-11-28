import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));

import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { errorHandler } from '../src/middleware/error-handler.js';
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/repositories', toolingUpgradeRoutes);
app.onError(errorHandler);

let keys: string[];
beforeEach(() => {
  keys = [];
});

/** A fake database whose transactions record every advisory key they are asked for. */
function useDb(ownerId?: string): string {
  const repositoryId = randomUUID();
  const fake = createFakeDb({
    repositories: schema.repositories,
    integrationGrants: schema.integrationGrants,
    auditEvents: schema.auditEvents,
    projectStateOutbox: schema.projectStateOutbox,
    tasks: schema.tasks,
  });
  if (ownerId)
    fake.insert(schema.repositories, {
      id: repositoryId,
      userId: ownerId,
      name: 'repo',
      source: 'local_path',
    });
  h.db = {
    ...fake.db,
    transaction: (work: (tx: unknown) => Promise<unknown>) =>
      fake.db.transaction(async (tx) =>
        work(
          new Proxy(tx, {
            get(target, prop) {
              if (prop !== 'execute') return Reflect.get(target, prop);
              return (query: SQL) => {
                const q = new PgDialect().sqlToQuery(query);
                if (/advisory/i.test(q.sql)) keys.push(String(q.params[0]));
                return target.execute(query);
              };
            },
          }),
        ),
      ),
  };
  return repositoryId;
}

const remove = (repositoryId: string) =>
  app.request(`/repositories/${repositoryId}/cli-targets/remove`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providers: ['x'], expectedTargets: [] }),
  });

describe('POST /repositories/:id/cli-targets/remove owner read', () => {
  it('answers 404 without taking a key for a repository another user owns', async () => {
    const repositoryId = useDb(randomUUID());
    expect((await remove(repositoryId)).status).toBe(404);
    expect(keys).toEqual([]);
  });

  it('answers 404 without taking a key for an id with no row', async () => {
    useDb();
    expect((await remove(randomUUID())).status).toBe(404);
    expect(keys).toEqual([]);
  });

  it('takes both keys, in order, for the owner', async () => {
    const repositoryId = useDb(USER);
    await remove(repositoryId);
    expect(keys).toEqual([`onboarding-upgrade:${repositoryId}`, `project-state:${repositoryId}`]);
  });
});
