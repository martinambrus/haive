import assert from 'node:assert/strict';
import { test } from 'node:test';
import { comparePresence, newFootprint, parseExpect, scanLayerNames } from '../channel-gate.mjs';

const expect = parseExpect(
  JSON.stringify({
    version: '1.0.0',
    images: { api: 'api:1', worker: 'worker:1' },
    modules: [{ packageName: '@haive/module-example', source: 'local' }],
  }),
);

test('image footprints retain both module trees independently, across every layer', () => {
  const footprint = newFootprint();
  scanLayerNames(footprint, 0, [
    'app/modules/example/package.json',
    './app/external-modules/example/package.json',
    'app/external-modules/.gitkeep',
  ]);
  scanLayerNames(footprint, 1, ['app/external-modules/example/package.json']);
  assert.deepEqual(
    [...footprint.folders],
    [
      ['example', [{ layer: 0, member: 'app/modules/example/package.json' }]],
      [
        'external-modules/example',
        [
          { layer: 0, member: './app/external-modules/example/package.json' },
          { layer: 1, member: 'app/external-modules/example/package.json' },
        ],
      ],
    ],
  );
  assert.equal(footprint.notDirs.size, 0);
});

test('presence checks reject unentitled external modules in an overwritten lower layer', () => {
  const folders = new Map([
    [
      'external-modules/example',
      [
        { layer: 0, name: '@haive/module-private-one' },
        { layer: 1, name: '@haive/module-example' },
      ],
    ],
  ]);
  for (const key of ['api', 'worker', 'builder', 'web']) {
    const offenders = comparePresence(key, newFootprint(), folders, expect);
    assert.ok(
      offenders.some(
        ({ what }) =>
          what.includes('app/external-modules/example in layer 0') && what.includes('not expected'),
      ),
    );
  }
});

test('an entitled external folder satisfies api, worker and builder presence checks', () => {
  const folders = new Map([
    ['external-modules/example', [{ layer: 0, name: '@haive/module-example' }]],
  ]);
  for (const key of ['api', 'worker', 'builder'])
    assert.deepEqual(comparePresence(key, newFootprint(), folders, expect), []);
});

test('external directories without manifests and non-directory entries fail presence checks', () => {
  const footprint = newFootprint();
  scanLayerNames(footprint, 0, [
    'app/external-modules/empty/',
    'app/external-modules/link',
    'app/external-modules/.wh.old',
    'app/external-modules/.gitkeep',
  ]);
  const offenders = comparePresence('api', footprint, footprint.folders, expect).map(
    ({ what }) => what,
  );
  assert.ok(offenders.includes('app/external-modules/empty has no package.json'));
  assert.ok(offenders.includes('app/external-modules/link is not a directory'));
});
