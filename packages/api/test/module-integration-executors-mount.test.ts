import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Database } from '@haive/database';
import { getIntegrationProvider } from '@haive/shared/integrations';
import type { AppEnv } from '../src/context.js';
import { mountModules, type ApiModuleEntry } from '../src/modules/loader.js';
import * as fx from './support/module-executors-fixture.js';

const untouchable = new Proxy(
  {},
  {
    get: (_target, property) => {
      throw new Error(`ctx.db was used: ${String(property)}`);
    },
  },
) as Database;

const mount = (...entries: ApiModuleEntry[]) =>
  mountModules(new Hono<AppEnv>(), entries, { db: untouchable });

const idle: fx.FixtureExecutor = {
  args: z.object({}).strict(),
  async run() {
    return {};
  },
};

async function refusal(...entries: ApiModuleEntry[]): Promise<string> {
  const error = await mount(...entries).then(
    () => null,
    (err: unknown) => err,
  );
  expect(error, 'mountModules accepted the entry').toBeInstanceOf(Error);
  return (error as Error).message;
}

function expectNames(
  message: string,
  names: { module: string; provider: string; op?: string },
): void {
  expect(message, 'the message names the provider').toContain(names.provider);
  if (names.op !== undefined)
    expect(message, 'the message names the operation').toContain(names.op);
  expect(
    message.split(names.provider).join(''),
    'the message names the module apart from the provider id',
  ).toContain(names.module);
}

describe('mountModules and the executors of the modules', () => {
  afterEach(() => mount());

  it('[X9] mounts a module whose executors cover its operations, registers its provider, and leaves the database alone (PIN)', async () => {
    const loaded = await mount(fx.fxEntry());

    expect(loaded.map((module) => module.manifest.id)).toEqual([fx.FX_MODULE_ID]);
    expect(getIntegrationProvider(fx.FX_PROVIDER)).toMatchObject({ id: fx.FX_PROVIDER });
  });

  it.each(fx.ALL_OPS)(
    '[X9] refuses a declared operation with no executor, naming the module, the provider and the operation: %s',
    async (opId) => {
      const message = await refusal(fx.fxEntry({ omit: [opId] }));

      expectNames(message, { module: fx.FX_MODULE_ID, provider: fx.FX_PROVIDER, op: opId });
    },
  );

  it('[X9] refuses an executor for an operation the manifest does not declare, naming the module, the provider and the operation', async () => {
    const executors = fx.fxExecutors();
    executors[fx.FX_PROVIDER]!.delete_doc = idle;

    const message = await refusal(fx.fxEntry({ executors }));

    expectNames(message, { module: fx.FX_MODULE_ID, provider: fx.FX_PROVIDER, op: 'delete_doc' });
  });

  it('[X9] refuses an executor map that names a provider the manifest does not declare, naming the module and the provider', async () => {
    const ghost = 'module.fx.ghost';
    const executors = { ...fx.fxExecutors(), [ghost]: { ping: idle } };

    const message = await refusal(fx.fxEntry({ executors }));

    expectNames(message, { module: fx.FX_MODULE_ID, provider: ghost });
  });

  it('[X9+] refuses an executor map that names a provider another module declares', async () => {
    const executors = { ...fx.fxExecutors(), ...fx.fxExecutors(fx.providerOf('gx')) };

    const message = await refusal(fx.fxEntry({ moduleId: 'gx' }), fx.fxEntry({ executors }));

    expectNames(message, { module: fx.FX_MODULE_ID, provider: fx.providerOf('gx') });
  });

  it('[X9+] refuses an executor map for a module whose manifest declares no integration at all', async () => {
    const entry = {
      packageName: fx.FX_PACKAGE,
      manifest: { id: fx.FX_MODULE_ID, name: 'Module fx', version: '1.0.0', schemaVersion: 1 },
      integrations: fx.fxExecutors(),
    } as unknown as ApiModuleEntry;

    const message = await refusal(entry);

    expectNames(message, { module: fx.FX_MODULE_ID, provider: fx.FX_PROVIDER });
  });

  it('[X9+] checks every module of the mount: a complete module beside an incomplete one is refused, naming the incomplete one', async () => {
    const message = await refusal(fx.fxEntry(), fx.fxEntry({ moduleId: 'gx', omit: ['leak'] }));

    expectNames(message, { module: 'gx', provider: fx.providerOf('gx'), op: 'leak' });
  });

  it('[X9+] mounts a complete module after a refused one', async () => {
    await refusal(fx.fxEntry({ omit: ['big'] }));

    const loaded = await mount(fx.fxEntry());

    expect(loaded.map((module) => module.manifest.id)).toEqual([fx.FX_MODULE_ID]);
  });

  it('[X9] refuses an entry that declares operations and exports no executors at all, naming the module, the provider and an operation (driver decision: strict)', async () => {
    const error = await refusal(fx.fxEntry({ executors: null }));

    for (const part of [fx.FX_MODULE_ID, fx.FX_PROVIDER]) expect(error).toContain(part);
  });
});
