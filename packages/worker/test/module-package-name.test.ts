import { describe, expect, it } from 'vitest';
import { registerModuleSteps, type WorkerModuleEntry } from '../src/modules/loader.js';
import { StepRegistry } from '../src/step-engine/registry.js';

const manifestOf = (id: string) => ({
  id,
  name: `Module ${id}`,
  version: '1.2.3',
  schemaVersion: 1,
});

const load = (entries: WorkerModuleEntry[]) => registerModuleSteps(new StepRegistry(), entries);

describe('the package name a module is loaded under', () => {
  it('loads @haive-module/<id> when its manifest declares that id', () => {
    const [loaded] = load([{ packageName: '@haive-module/x', manifest: manifestOf('x') }]);
    expect(loaded).toMatchObject({ packageName: '@haive-module/x', manifest: { id: 'x' } });
  });

  it('refuses @haive-module/x whose manifest declares y, naming the package and both spellings of y', () => {
    expect(() => load([{ packageName: '@haive-module/x', manifest: manifestOf('y') }])).toThrow(
      'Module @haive-module/x declares id "y"; its package must be named @haive/module-y or @haive-module/y',
    );
  });

  it('loads @haive/module-<id> as before', () => {
    const [loaded] = load([{ packageName: '@haive/module-x', manifest: manifestOf('x') }]);
    expect(loaded).toMatchObject({ packageName: '@haive/module-x', manifest: { id: 'x' } });
  });

  it('refuses @haive/module-x whose manifest declares y', () => {
    expect(() => load([{ packageName: '@haive/module-x', manifest: manifestOf('y') }])).toThrow(
      /Module @haive\/module-x declares id "y"/,
    );
  });

  it.each(['@haive/x', '@acme/module-x', '@haive-modules/x', 'x'])(
    'refuses the package name %s',
    (packageName) => {
      expect(() => load([{ packageName, manifest: manifestOf('x') }])).toThrow(
        new RegExp(`Module ${packageName} declares id "x"`),
      );
    },
  );

  it('refuses one id from both spellings', () => {
    expect(() =>
      load([
        { packageName: '@haive/module-x', manifest: manifestOf('x') },
        { packageName: '@haive-module/x', manifest: manifestOf('x') },
      ]),
    ).toThrow('Duplicate module id "x" (@haive-module/x)');
  });

  it('carries the source each entry names onto the loaded module, and none when it names none', () => {
    const loaded = load([
      { packageName: '@haive/module-x', source: 'local', manifest: manifestOf('x') },
      { packageName: '@haive-module/y', source: 'registry', manifest: manifestOf('y') },
      { packageName: '@haive/module-z', manifest: manifestOf('z') },
    ]);
    expect(loaded.map((m) => m.source)).toEqual(['local', 'registry', undefined]);
  });
});
