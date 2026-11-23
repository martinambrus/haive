import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { definitionForCreate } from '../src/lib/task-type-definition.js';

vi.mock('@haive/shared', async (original) => ({
  ...(await original<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => true },
}));

const CANARY = '00-model-health-workflow';
const AGENT = 'module.fx.agent';

async function snapshot(
  source: string,
  selectsOwnProviders?: boolean,
  steps = [AGENT],
  cli = true,
) {
  const definition = {
    slug: 'fx__report',
    source,
    runListStrategy: 'static',
    stepIds: steps,
    enabled: true,
    selectable: true,
    requiresRepository: false,
    preAnswerDefaults: {},
    stepLoopLimitDefaults: {},
    selectsOwnProviders,
  };
  const catalog = [CANARY, AGENT].map((stepId) => ({
    stepId,
    source: 'module:fx',
    dispatchesCli: cli,
    composable: true,
    entry: {
      stepId,
      label: stepId,
      group: 'build',
      dispatchesCli: cli,
      requires: [],
      provides: [],
    },
  }));
  const result = (values: unknown[]) =>
    Object.assign(Promise.resolve(values), { for: async () => values });
  const handle = {
    select: () => ({
      from: (table: unknown) =>
        table === schema.stepCatalog
          ? { orderBy: () => result(catalog) }
          : table === schema.modules
            ? {
                where: () =>
                  result([
                    {
                      moduleId: 'fx',
                      name: 'Fixture',
                      missingAt: null,
                      deactivatedAt: null,
                      drainingAt: null,
                    },
                  ]),
              }
            : { where: () => ({ limit: () => result([definition]) }) },
    }),
  } as unknown as Pick<Database, 'select' | 'execute'>;
  return (await definitionForCreate(handle, 'fx__report', { generic: true, locked: false }))
    .runListSnapshot;
}

describe('module-owned provider selection', () => {
  it('adds no automatic canary for a module type selecting its own providers', async () => {
    expect(await snapshot('module:fx', true)).toEqual([AGENT]);
  });

  it.each([undefined, false])('keeps the canary when the module flag is %s', async (flag) => {
    expect(await snapshot('module:fx', flag)).toEqual([CANARY, AGENT]);
  });

  it('keeps an explicitly listed canary even for a module selecting its own providers', async () => {
    expect(await snapshot('module:fx', true, [CANARY, AGENT])).toEqual([CANARY, AGENT]);
  });

  it('does not give an admin type this module-only exemption', async () => {
    expect(await snapshot('admin', true)).toEqual([CANARY, AGENT]);
  });

  it('preserves builtin and non-CLI behavior', async () => {
    expect(await snapshot('builtin', true)).toEqual([AGENT]);
    expect(await snapshot('module:fx', false, [AGENT], false)).toEqual([AGENT]);
  });
});
