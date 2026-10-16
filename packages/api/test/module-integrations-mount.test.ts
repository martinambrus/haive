import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Database } from '@haive/database';
import { getIntegrationProvider, registerModuleIntegrations } from '@haive/shared/integrations';
import type { AppEnv } from '../src/context.js';
import { mountModules } from '../src/modules/loader.js';

const untouchable = new Proxy(
  {},
  {
    get: (_target, property) => {
      throw new Error(`ctx.db was used: ${String(property)}`);
    },
  },
) as Database;

const listDocs = { args: z.object({}), run: async () => ({}) };

const entryOf = (id: string, over: Record<string, unknown> = {}) => {
  const manifest = {
    id,
    name: `Module ${id}`,
    version: '1.0.0',
    schemaVersion: 1,
    categories: [{ id: `module.${id}.docs`, label: 'Docs' }],
    integrations: [
      {
        id: `module.${id}.crm`,
        displayName: 'Crm',
        categories: [`module.${id}.docs`],
        selfHosted: false,
        auth: [
          {
            kind: 'device',
            deviceCodeUrl: 'https://login.example.com/device/code',
            tokenUrl: 'https://login.example.com/token',
            scopes: { read: ['read'], write: ['write'] },
            userInfo: {
              url: 'https://api.example.com/me',
              idPointer: '/id',
              labelPointer: '/name',
            },
          },
        ],
        operations: [{ opId: 'list_docs', description: 'List', inputSchema: {}, access: 'read' }],
        apiHosts: ['api.example.com'],
      },
    ],
    ...over,
  };
  const executors = { [`module.${id}.crm`]: { list_docs: listDocs } };
  return {
    packageName: `@haive/module-${id}`,
    manifest,
    ...(manifest.integrations === undefined ? {} : { integrations: executors }),
  };
};

describe('mountModules and the integrations of the modules', () => {
  afterEach(() => registerModuleIntegrations([]));

  it('registers them without reading or writing the database it was given', async () => {
    await mountModules(new Hono<AppEnv>(), [entryOf('fx')], { db: untouchable });

    expect(getIntegrationProvider('module.fx.crm')).toMatchObject({ id: 'module.fx.crm' });
  });

  it('registers none for a module that declares none, and drops what an earlier call registered', async () => {
    await mountModules(new Hono<AppEnv>(), [entryOf('fx')], { db: untouchable });
    await mountModules(
      new Hono<AppEnv>(),
      [entryOf('gx', { integrations: undefined, categories: undefined })],
      { db: untouchable },
    );

    expect(getIntegrationProvider('module.fx.crm')).toBeUndefined();
    expect(getIntegrationProvider('module.gx.crm')).toBeUndefined();
  });

  it('refuses a provider id of another module, naming the package and the id', async () => {
    const stolen = entryOf('fx');
    (stolen.manifest.integrations as Array<{ id: string }>)[0]!.id = 'module.gx.crm';

    await expect(mountModules(new Hono<AppEnv>(), [stolen], { db: untouchable })).rejects.toThrow(
      /@haive\/module-fx.*module\.gx\.crm/,
    );
  });
});
