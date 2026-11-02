import { afterEach, expect, it } from 'vitest';
import { schema, type Database } from '@haive/database';
import {
  loadResolverContext,
  registerModuleIntegrations,
  resolveTarget,
} from '../src/integrations/index.js';
import { asLoadedModule, fixtureManifest } from './module-integrations-fixtures.js';

// A recording query result stub: the SQL filters and joins remain covered by the Postgres suite.
// This control follows the real bulk state loader through context loading into the pure resolver.
function loaderDb() {
  const reads: unknown[] = [];
  const rows = new Map<unknown, unknown[]>([
    [schema.modules, [{ moduleId: 'fx' }]],
    [schema.integrationProviderConfigs, [{ providerId: 'module.fx.crm', enabled: true }]],
    [
      schema.integrationConnections,
      [
        {
          id: 'account',
          providerId: 'module.fx.crm',
          scope: 'user',
          ownerUserId: 'owner',
          status: 'connected',
          credentialHost: null,
          credentialProvider: null,
        },
      ],
    ],
    [schema.integrationCategoryPreferences, []],
  ]);
  const db = {
    select: () => ({
      from: (table: unknown) => {
        reads.push(table);
        if (!rows.has(table)) throw new Error('unexpected loader query');
        const query = {
          leftJoin: () => query,
          where: () => query,
          orderBy: () => query,
          then: (resolve: (value: unknown[]) => unknown) =>
            Promise.resolve(rows.get(table)!).then(resolve),
        };
        return query;
      },
    }),
  } as unknown as Database;
  return { db, reads };
}

afterEach(() => registerModuleIntegrations([]));

it('preserves provider and declared category states through loadResolverContext, and sees removal next call', async () => {
  registerModuleIntegrations([asLoadedModule(fixtureManifest('fx'))] as never);
  const { db, reads } = loaderDb();
  const subject = {
    draft: {
      userId: 'owner',
      repositoryId: null,
      choices: new Map([['rich-documents', 'account']]),
    },
  };

  const context = await loadResolverContext(db, subject);
  expect(resolveTarget(context, { category: 'rich-documents' })).toMatchObject({
    reason: 'provider-deactivated',
    providerId: 'module.fx.crm',
  });
  expect(resolveTarget(context, { category: 'module.fx.docs' })).toMatchObject({
    reason: 'provider-deactivated',
  });
  expect(reads.filter((table) => table === schema.modules)).toHaveLength(1);
  expect(reads.filter((table) => table === schema.integrationProviderConfigs)).toHaveLength(1);

  registerModuleIntegrations([]);
  const removed = await loadResolverContext(db, subject);
  expect(resolveTarget(removed, { category: 'rich-documents' })).toMatchObject({
    reason: 'provider-missing',
    providerId: 'module.fx.crm',
  });
  expect(resolveTarget(removed, { category: 'module.fx.docs' })).toMatchObject({
    reason: 'provider-missing',
    providerId: null,
  });
});
