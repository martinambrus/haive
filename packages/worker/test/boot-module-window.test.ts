import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, schema, type Database } from '@haive/database';
import { resolveTaskTypeAvailability } from '@haive/shared/modularity';

const url = process.env.BOOT_MODULE_WINDOW_TEST_URL;
if (url && !new URL(url).pathname.startsWith('/boot_module_window_test'))
  throw new Error('Use a dedicated boot_module_window_test database for the boot window test');

const h = vi.hoisted(() => ({
  db: undefined as unknown,
  seen: [] as { at: string; types: unknown[] }[],
  probe: undefined as unknown as (at: string) => Promise<{ at: string; types: unknown[] }>,
}));

vi.mock('../src/redis.js', () => ({ getRedis: () => ({ set: async () => 'OK' }) }));
vi.mock('../src/modules.generated.js', () => ({
  moduleRegistry: [
    {
      packageName: '@haive/module-fx',
      manifest: {
        id: 'fx',
        name: 'Fixture',
        version: '1.0.0',
        schemaVersion: 1,
        taskTypes: [
          {
            slug: 'weekly',
            displayName: 'Weekly report',
            runListStrategy: 'static',
            stepIds: ['module.fx.report'],
            selectable: true,
            requiresRepository: false,
          },
        ],
      },
      steps: [
        {
          metadata: {
            id: 'report',
            workflowType: 'x',
            index: 0,
            title: 'Report',
            description: 'boot window stub',
            requiresCli: false,
          },
          async detect() {
            return {};
          },
          async apply() {
            return {};
          },
        },
      ],
    },
  ],
}));
vi.mock('../src/step-engine/task-type-seed.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/step-engine/task-type-seed.js')>();
  return {
    ...original,
    syncTaskTypeDefinitions: async (
      ...args: Parameters<typeof original.syncTaskTypeDefinitions>
    ) => {
      h.seen.push(await h.probe('before the seed'));
      const outcome = await original.syncTaskTypeDefinitions(...args);
      h.seen.push(await h.probe('after the seed'));
      return outcome;
    },
  };
});

import { bootStepEngine } from '../src/step-engine/boot.js';

describe.skipIf(!url)('a module task type while the worker boots, on Postgres', () => {
  let db: Database;

  const reasons = async (at: string) => {
    const types = await db
      .select()
      .from(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.source, 'module:fx'));
    const [row] = await db.select().from(schema.modules).where(eq(schema.modules.moduleId, 'fx'));
    const modules = new Map(
      row
        ? [
            [
              'fx',
              { name: row.name, missing: row.missingAt !== null, deactivated: !!row.deactivatedAt },
            ] as const,
          ]
        : [],
    );
    return {
      at,
      types: types.map((definition) => {
        const verdict = resolveTaskTypeAvailability({
          definition,
          switches: { customEnabled: true, moduleEnabled: true },
          modules,
          catalog: null,
          generic: false,
        });
        return { slug: definition.slug, ...verdict };
      }),
    };
  };

  beforeAll(() => {
    db = createDatabase(url as string);
    h.db = db;
    h.probe = reasons;
  });

  beforeEach(async () => {
    h.seen = [];
    await db.delete(schema.modules);
    await db
      .delete(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.source, 'module:fx'));
  });

  afterAll(async () => {
    await db.delete(schema.modules);
    await db
      .delete(schema.taskTypeDefinitions)
      .where(eq(schema.taskTypeDefinitions.source, 'module:fx'));
    await db.$client.end({ timeout: 5 });
  });

  const AVAILABLE = { slug: 'fx__weekly', available: true };

  it('is available the moment a freshly installed module seeds it, and after the boot', async () => {
    await bootStepEngine(db);
    expect(h.seen).toEqual([
      { at: 'before the seed', types: [] },
      { at: 'after the seed', types: [AVAILABLE] },
    ]);
    expect((await reasons('after the boot')).types).toEqual([AVAILABLE]);
  });

  it('is available as the seed rewrites it for a module that loads again', async () => {
    await bootStepEngine(db);
    await db
      .update(schema.modules)
      .set({ missingAt: new Date() })
      .where(eq(schema.modules.moduleId, 'fx'));
    expect((await reasons('while it was missing')).types).toEqual([
      expect.objectContaining({ slug: 'fx__weekly', available: false, reason: 'module-missing' }),
    ]);

    h.seen = [];
    await bootStepEngine(db);
    expect(h.seen).toEqual([
      { at: 'before the seed', types: [AVAILABLE] },
      { at: 'after the seed', types: [AVAILABLE] },
    ]);
    expect((await reasons('after the boot')).types).toEqual([AVAILABLE]);
  });
});
