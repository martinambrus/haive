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
import { repositoryIntegrationRoutes } from '../src/routes/repository-integrations.js';
import { toolingUpgradeRoutes } from '../src/routes/tooling-upgrades.js';
import type { AppEnv } from '../src/context.js';

const app = new Hono<AppEnv>();
app.route('/repositories', toolingUpgradeRoutes);
app.route('/repositories', repositoryIntegrationRoutes);
// Only the lock keys are under test. After its locks a route may fail on a spelling the fake database
// refuses, which the real error handler would log as an error.
app.onError((_err, c) => c.body(null, 500));

const id = randomUUID();
const spellings = [
  ['uppercase', id.toUpperCase()],
  ['unhyphenated', id.replaceAll('-', '').toUpperCase()],
  ['braced', `{${id}}`],
] as const;

let keys: string[];
beforeEach(() => {
  keys = [];
});

/** A fake database whose transactions record every advisory key they are asked for. */
function useDb(repositoryId?: string) {
  const fake = createFakeDb({
    repositories: schema.repositories,
    integrationGrants: schema.integrationGrants,
    auditEvents: schema.auditEvents,
    projectStateOutbox: schema.projectStateOutbox,
    tasks: schema.tasks,
  });
  if (repositoryId)
    fake.insert(schema.repositories, {
      id: repositoryId,
      userId: USER,
      name: 'owned',
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
}

const send = (path: string, method: string, body: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const routes: Array<{
  name: string;
  /** The database holds a row spelled as the URL spells it (the fake compares ids as text, and
   *  rejects a non-hyphenated spelling outright), so only these spellings reach the lock. */
  rowSpellings: readonly string[];
  expected: (spelled: string) => string[];
  run: (spelled: string) => unknown;
}> = [
  {
    name: 'PUT /repositories/:id/integrations',
    rowSpellings: ['uppercase'],
    expected: (spelled) => [`integration-allow-list:${spelled}`],
    run: (spelled) =>
      send(`/repositories/${spelled}/integrations`, 'PUT', {
        restricted: false,
        connectionIds: [],
      }),
  },
  {
    name: 'POST /repositories/:id/cli-targets/remove',
    rowSpellings: ['uppercase'],
    expected: (spelled) => [`onboarding-upgrade:${spelled}`, `project-state:${spelled}`],
    run: (spelled) =>
      send(`/repositories/${spelled}/cli-targets/remove`, 'POST', {
        providers: ['x'],
        expectedTargets: [],
      }),
  },
];

describe('lock key spelling', () => {
  for (const route of routes) {
    const keysFor = async (spelled: string) => {
      keys = [];
      useDb(spelled);
      await route.run(spelled);
      return keys.join(' ');
    };
    describe(route.name, () => {
      it('keys a canonical id with the text it always keyed', async () => {
        expect(await keysFor(id)).toBe(route.expected(id).join(' '));
      });
      for (const [label, spelled] of spellings.filter(([l]) => route.rowSpellings.includes(l))) {
        it(`takes one key per lock for the ${label} spelling of one id`, async () => {
          expect(await keysFor(spelled)).toBe(await keysFor(id));
        });
      }
    });
  }
});
