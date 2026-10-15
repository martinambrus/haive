import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Database } from '@haive/database';
import { moduleManifestSchema } from '@haive/shared/modularity';
import type { AppEnv } from '../src/context.js';
import { mountModules } from '../src/modules/loader.js';

const manifestOf = (id: string) =>
  moduleManifestSchema.parse({ id, name: id, version: '1.2.3', schemaVersion: 1 });

const mount = (entries: Parameters<typeof mountModules>[1]) =>
  mountModules(new Hono<AppEnv>(), entries, { db: {} as Database });

describe('the package name a module is loaded under', () => {
  it('loads @haive-module/<id> when its manifest declares that id', async () => {
    const [loaded] = await mount([
      { packageName: '@haive-module/x', source: 'registry', manifest: manifestOf('x') },
    ]);
    expect(loaded).toMatchObject({ packageName: '@haive-module/x', manifest: { id: 'x' } });
  });

  it('refuses @haive-module/x whose manifest declares y, naming the package and both spellings of y', async () => {
    await expect(
      mount([{ packageName: '@haive-module/x', manifest: manifestOf('y') }]),
    ).rejects.toThrow(
      'Module @haive-module/x declares id "y"; its package must be named @haive/module-y or @haive-module/y',
    );
  });

  it('loads @haive/module-<id> as before', async () => {
    const [loaded] = await mount([
      { packageName: '@haive/module-x', source: 'local', manifest: manifestOf('x') },
    ]);
    expect(loaded).toMatchObject({ packageName: '@haive/module-x', manifest: { id: 'x' } });
  });

  it('refuses @haive/module-x whose manifest declares y', async () => {
    await expect(
      mount([{ packageName: '@haive/module-x', manifest: manifestOf('y') }]),
    ).rejects.toThrow(/Module @haive\/module-x declares id "y"/);
  });

  it.each(['@haive/x', '@acme/module-x', '@haive-modules/x', 'x'])(
    'refuses the package name %s',
    async (packageName) => {
      await expect(mount([{ packageName, manifest: manifestOf('x') }])).rejects.toThrow(
        new RegExp(`Module ${packageName} declares id "x"`),
      );
    },
  );

  it('refuses one id from both spellings', async () => {
    await expect(
      mount([
        { packageName: '@haive/module-x', manifest: manifestOf('x') },
        { packageName: '@haive-module/x', manifest: manifestOf('x') },
      ]),
    ).rejects.toThrow('Duplicate module id "x" (@haive-module/x)');
  });
});
