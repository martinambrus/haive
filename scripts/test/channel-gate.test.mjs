import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CouldNotLook,
  authLineNumbers,
  compareLists,
  comparePresence,
  compareStamp,
  compareToken,
  foldExit,
  formatOffender,
  idOf,
  newFootprint,
  packageNameOf,
  parseExpect,
  parseReading,
  parseRegistryComponent,
  parseToken,
  readerScript,
  scanLayerNames,
} from '../channel-gate.mjs';

const gate = join(dirname(fileURLToPath(import.meta.url)), '..', 'channel-gate.mjs');

const STATISTICS = {
  packageName: '@haive/module-statistics',
  source: 'local',
  webParts: ['dashboard', 'web'],
};
const ALPHA = {
  packageName: '@haive-module/alpha',
  source: 'registry',
  version: '0.1.0',
  webParts: ['web'],
};
const expectation = (over = {}) => ({
  version: '0.9.0.1',
  images: { api: 'a-api:1', worker: 'a-worker:1', web: 'a-web:1' },
  modules: [STATISTICS, ALPHA],
  ...over,
});
const expectA = (over) => parseExpect(JSON.stringify(expectation(over)));

const footprintOf = (...layers) => {
  const footprint = newFootprint();
  layers.forEach((names, i) => scanLayerNames(footprint, i, names));
  return footprint;
};
const whats = (offenders) => offenders.map((o) => o.what);
const STATISTICS_FOLDER = new Map([['statistics', '@haive/module-statistics']]);

const PNPM = 'app/node_modules/.pnpm';
const ALPHA_DIR = `${PNPM}/@haive-module+alpha@0.1.0/node_modules/@haive-module/alpha`;
const A_API_NAMES = [
  'app/.npmrc',
  'app/modules/',
  'app/modules/.gitkeep',
  'app/modules/statistics/',
  'app/modules/statistics/package.json',
  'app/modules/statistics/dist/manifest.js',
  `${PNPM}/@haive-module+alpha@0.1.0/`,
  `${ALPHA_DIR}/package.json`,
  `${PNPM}/node_modules/@haive-module/alpha`,
  'app/packages/api/node_modules/@haive-module/alpha',
  'app/packages/api/node_modules/@haive/module-statistics',
];

describe('idOf', () => {
  it('reads the id of a module package name, folder or registry', () => {
    assert.equal(idOf('@haive/module-statistics'), 'statistics');
    assert.equal(idOf('@haive-module/alpha'), 'alpha');
    assert.equal(idOf(`@haive-module/${'a'.repeat(23)}`), 'a'.repeat(23));
  });

  it('refuses everything else', () => {
    for (const name of [
      '@haive/statistics',
      '@haive-module/Alpha',
      '@haive-module/',
      '@haive-module/alpha/web',
      `@haive-module/${'a'.repeat(24)}`,
      ' @haive-module/alpha',
      '',
    ]) {
      assert.equal(idOf(name), null, name);
    }
  });
});

describe('parseExpect', () => {
  it('reads the expectation of a channel', () => {
    const parsed = expectA();
    assert.equal(parsed.version, '0.9.0.1');
    assert.deepEqual(parsed.images, expectation().images);
    assert.deepEqual(
      parsed.modules.map((m) => [m.id, m.source, m.version, m.webParts]),
      [
        ['statistics', 'local', undefined, ['dashboard', 'web']],
        ['alpha', 'registry', '0.1.0', ['web']],
      ],
    );
  });

  it('reads a missing images.web as no web image, and a module with no webParts as having none', () => {
    const parsed = expectA({
      images: { api: 'b-api:1', worker: 'b-worker:1' },
      modules: [{ packageName: '@haive-module/beta', source: 'registry', version: '0.1.0' }],
    });
    assert.equal(parsed.images.web, undefined);
    assert.deepEqual(parsed.modules[0].webParts, []);
  });

  it('accepts a channel with no module at all', () => {
    assert.deepEqual(expectA({ modules: [] }).modules, []);
  });

  const MALFORMED = [
    ['an unknown top-level key', { extra: 1 }],
    ['no version', { version: undefined }],
    ['an empty version', { version: '' }],
    ['no images', { images: undefined }],
    ['no api image', { images: { worker: 'w:1' } }],
    ['no worker image', { images: { api: 'a:1' } }],
    ['a mistyped web key', { images: { api: 'a:1', worker: 'w:1', Web: 'x:1' } }],
    ['an image ref that is an option', { images: { api: '-a', worker: 'w:1' } }],
    ['an image ref with a space', { images: { api: 'a b', worker: 'w:1' } }],
    ['an image ref that is not a string', { images: { api: 1, worker: 'w:1' } }],
    ['modules that is not a list', { modules: {} }],
    ['a module that is not an object', { modules: ['alpha'] }],
    ['a mistyped module key', { modules: [{ ...ALPHA, versions: '1' }] }],
    ['a package that is no module', { modules: [{ ...ALPHA, packageName: 'alpha' }] }],
    ['a source that is neither', { modules: [{ ...ALPHA, source: 'npm' }] }],
    [
      'a registry module under the folder scope',
      { modules: [{ ...ALPHA, packageName: '@haive/module-alpha' }] },
    ],
    ['a version on a local module', { modules: [{ ...STATISTICS, version: '1.0.0' }] }],
    ['a registry module with no version', { modules: [{ ...ALPHA, version: undefined }] }],
    ['an empty version on a registry module', { modules: [{ ...ALPHA, version: '' }] }],
    ['webParts that is not a list', { modules: [{ ...ALPHA, webParts: 'web' }] }],
    ['an unknown web part', { modules: [{ ...ALPHA, webParts: ['page'] }] }],
    ['a repeated web part', { modules: [{ ...ALPHA, webParts: ['web', 'web'] }] }],
    [
      'two modules with one id',
      { modules: [ALPHA, { ...STATISTICS, packageName: '@haive-module/alpha' }] },
    ],
  ];
  const refuses = (text) =>
    assert.throws(
      () => parseExpect(text),
      (error) => {
        assert.ok(error instanceof CouldNotLook);
        assert.match(error.message, /^malformed expectation: /);
        return true;
      },
    );
  for (const text of ['{ "version": ', '[]', 'null', '']) {
    it(`refuses the text ${JSON.stringify(text)}`, () => refuses(text));
  }
  for (const [name, over] of MALFORMED) {
    it(`refuses ${name}`, () => refuses(JSON.stringify(expectation(over))));
  }

  it('names the registry module that has no version', () => {
    const modules = [STATISTICS, { ...ALPHA, version: undefined }];
    assert.throws(
      () => parseExpect(JSON.stringify(expectation({ modules }))),
      /malformed expectation: .*@haive-module\/alpha/,
    );
  });
});

describe('parseToken', () => {
  it('trims the newline, a CRLF and a byte order mark', () => {
    assert.equal(parseToken('d2a2tok-ab18\n'), 'd2a2tok-ab18');
    assert.equal(parseToken('d2a2tok-ab18\r\n'), 'd2a2tok-ab18');
    assert.equal(parseToken('﻿d2a2tok-ab18'), 'd2a2tok-ab18');
    assert.equal(parseToken('d2a2tok-ab18'), 'd2a2tok-ab18');
  });

  for (const [name, text] of [
    ['empty', ''],
    ['only whitespace', ' \n\t\n'],
    ['two lines', 'abc\ndef\n'],
    ['a space inside', 'abc def'],
    ['a control character', 'abc\u0000def'],
  ]) {
    it(`refuses a token file that is ${name}`, () => {
      assert.throws(() => parseToken(text), CouldNotLook);
    });
  }
});

describe('parseRegistryComponent', () => {
  it('reads the module id and version of a virtual-store name', () => {
    assert.deepEqual(parseRegistryComponent('@haive-module+alpha@0.1.0'), {
      id: 'alpha',
      version: '0.1.0',
    });
    assert.deepEqual(parseRegistryComponent('@haive-module+deep-analysis@12.0.3-rc.1+build.5'), {
      id: 'deep-analysis',
      version: '12.0.3-rc.1+build.5',
    });
  });

  it('ends the version at the peer suffix, however long', () => {
    for (const name of [
      '@haive-module+alpha@0.1.0_react@19.0.0',
      '@haive-module+alpha@0.1.0_react@19.0.0_zod@4.1.0',
      '@haive-module+alpha@0.1.0_8f3a9c0d1e2b',
    ]) {
      assert.deepEqual(parseRegistryComponent(name), { id: 'alpha', version: '0.1.0' }, name);
    }
  });

  it('refuses a name that is not a module id at a version', () => {
    for (const name of [
      '@haive-module+',
      '@haive-module+alpha',
      '@haive-module+alpha@',
      '@haive-module+alpha@_react@19.0.0',
      '@haive-module+@0.1.0',
      '@haive-module+Alpha@0.1.0',
      `@haive-module+${'a'.repeat(24)}@0.1.0`,
    ]) {
      assert.equal(parseRegistryComponent(name), null, name);
    }
  });
});

describe('scanLayerNames', () => {
  it('finds what a clean customer api image holds', () => {
    const footprint = footprintOf(A_API_NAMES);
    assert.deepEqual([...footprint.registry], [['alpha', new Set(['0.1.0'])]]);
    assert.deepEqual([...footprint.links], ['alpha']);
    assert.deepEqual([...footprint.folders.keys()], ['statistics']);
    assert.deepEqual(footprint.folders.get('statistics'), {
      layer: 0,
      member: 'app/modules/statistics/package.json',
    });
    assert.deepEqual(footprint.npmrc, [{ layer: 0, member: 'app/.npmrc', name: 'app/.npmrc' }]);
    assert.equal(footprint.badComponents.size, 0);
  });

  it('counts only directories under app/modules: .gitkeep is a file shipped on purpose', () => {
    const footprint = footprintOf([
      'app/modules/',
      'app/modules/.gitkeep',
      'app/modules/README.md',
    ]);
    assert.equal(footprint.folders.size, 0);
  });

  it('ignores app/modules/.gitkeep, and counts a folder with its package.json as before', () => {
    const footprint = footprintOf([
      'app/modules/',
      'app/modules/.gitkeep',
      'app/modules/a/',
      'app/modules/a/package.json',
    ]);
    assert.deepEqual(
      [...footprint.folders],
      [['a', { layer: 0, member: 'app/modules/a/package.json' }]],
    );
  });

  it('records an app/modules/<x> that tar -t lists with no slash: a link or a file', () => {
    const footprint = footprintOf([
      'app/modules/',
      'app/modules/.gitkeep',
      'app/modules/evil',
      './app/modules/other',
      'app/modules/.wh.gone',
      'app/modules/a/package.json',
    ]);
    assert.deepEqual([...footprint.notDirs].sort(), ['evil', 'other']);
    assert.deepEqual([...footprint.folders.keys()], ['a']);
  });

  it('counts a folder seen as a directory entry, or only through something inside it', () => {
    assert.deepEqual([...footprintOf(['app/modules/beta/']).folders], [['beta', null]]);
    assert.deepEqual(
      [...footprintOf(['app/modules/beta/dist/manifest.js']).folders],
      [['beta', null]],
    );
  });

  it('ignores whiteout entries, the opaque marker included', () => {
    const footprint = footprintOf([
      'app/modules/.wh.beta',
      'app/modules/.wh..wh..opq',
      `${PNPM}/.wh.@haive-module+beta@0.1.0`,
      'app/packages/api/node_modules/@haive-module/.wh.beta',
      'app/.wh..npmrc',
    ]);
    assert.deepEqual(footprint, newFootprint());
  });

  it('still counts a module a later layer whites out: the earlier layer ships it', () => {
    const footprint = footprintOf(
      [`${PNPM}/@haive-module+beta@0.1.0/`, 'app/modules/beta/package.json'],
      [`${PNPM}/.wh.@haive-module+beta@0.1.0`, 'app/modules/.wh.beta'],
    );
    assert.deepEqual([...footprint.registry], [['beta', new Set(['0.1.0'])]]);
    assert.deepEqual(footprint.folders.get('beta'), {
      layer: 0,
      member: 'app/modules/beta/package.json',
    });
  });

  it('keeps the package.json of the topmost layer that holds one', () => {
    const footprint = footprintOf(
      ['app/modules/beta/package.json'],
      ['app/modules/beta/dist/a.js'],
      ['app/modules/beta/package.json'],
      ['app/modules/beta/dist/b.js'],
    );
    assert.equal(footprint.folders.get('beta').layer, 2);
  });

  it('reads names with a leading ./ and keeps the listed name for tar', () => {
    const footprint = footprintOf(['./app/modules/beta/package.json', './app/.npmrc']);
    assert.deepEqual(footprint.folders.get('beta'), {
      layer: 0,
      member: './app/modules/beta/package.json',
    });
    assert.deepEqual(footprint.npmrc, [{ layer: 0, member: './app/.npmrc', name: 'app/.npmrc' }]);
  });

  it('records a registry name that does not parse, wherever it sits', () => {
    const footprint = footprintOf([
      `${PNPM}/@haive-module+Alpha@0.1.0/package.json`,
      'somewhere/else/@haive-module+beta/x',
    ]);
    assert.deepEqual([...footprint.badComponents].sort(), [
      '@haive-module+Alpha@0.1.0',
      '@haive-module+beta',
    ]);
  });

  it('collects every version of one module, across layers and peer suffixes', () => {
    const footprint = footprintOf(
      [`${PNPM}/@haive-module+alpha@0.1.0/`],
      [`${PNPM}/@haive-module+alpha@0.2.0_react@19.0.0/`],
    );
    assert.deepEqual([...footprint.registry.get('alpha')].sort(), ['0.1.0', '0.2.0']);
  });

  it('lists a .npmrc file with its layer, and skips a directory of that name', () => {
    const footprint = footprintOf(['usr/lib/.npmrc/', 'a/b/.npmrc'], ['c/.npmrc']);
    assert.deepEqual(
      footprint.npmrc.map((f) => [f.layer, f.name]),
      [
        [0, 'a/b/.npmrc'],
        [1, 'c/.npmrc'],
      ],
    );
  });
});

describe('packageNameOf', () => {
  it('reads name, and an empty string where there is none', () => {
    assert.equal(packageNameOf('{"name":"@haive/module-statistics"}'), '@haive/module-statistics');
    assert.equal(packageNameOf('{"version":"1.0.0"}'), '');
    assert.equal(packageNameOf('{"name":7}'), '');
    assert.equal(packageNameOf('not json'), '');
    assert.equal(packageNameOf('null'), '');
  });
});

describe('comparePresence', () => {
  const check = (names, over = {}, { key = 'api', folders = STATISTICS_FOLDER, expect } = {}) =>
    whats(
      comparePresence(key, footprintOf(...[].concat([names])), folders, expect ?? expectA(over)),
    );

  it('passes the customer image it is given the expectation of', () => {
    assert.deepEqual(check(A_API_NAMES), []);
  });

  it('fails a registry module the channel did not buy, naming it', () => {
    const names = [
      ...A_API_NAMES,
      `${PNPM}/@haive-module+beta@0.1.0/node_modules/@haive-module/beta/package.json`,
    ];
    assert.deepEqual(check(names), ['registry module beta is in the image but not expected']);
  });

  it('fails a registry module that is expected and not there, naming it', () => {
    const names = A_API_NAMES.filter((n) => !n.includes('alpha'));
    assert.deepEqual(check(names), ['registry module alpha is expected but not in the image']);
  });

  it("fails B's image against A's expectation both ways", () => {
    const names = A_API_NAMES.map((n) => n.replaceAll('alpha', 'beta'));
    assert.deepEqual(check(names), [
      'registry module alpha is expected but not in the image',
      'registry module beta is in the image but not expected',
    ]);
  });

  it('fails a module folder that is installed nowhere, by the id its package.json names', () => {
    const folders = new Map([...STATISTICS_FOLDER, ['beta', '@haive-module/beta']]);
    const names = [...A_API_NAMES, 'app/modules/beta/', 'app/modules/beta/package.json'];
    assert.deepEqual(check(names, {}, { folders }), [
      'module folder beta (app/modules/beta) is in the image but not expected',
    ]);
  });

  it('fails a module folder that is expected and not there', () => {
    const names = A_API_NAMES.filter((n) => !n.startsWith('app/modules/statistics'));
    assert.deepEqual(check(names, {}, { folders: new Map() }), [
      'module folder statistics is expected but not in the image',
    ]);
  });

  it('fails a folder with no package.json, and one whose package.json is no module', () => {
    const folders = new Map([
      ...STATISTICS_FOLDER,
      ['empty', null],
      ['other', 'left-pad'],
      ['nameless', ''],
    ]);
    assert.deepEqual(check(A_API_NAMES, {}, { folders }), [
      'app/modules/empty has no package.json',
      'app/modules/nameless has a package.json named "", not a module package',
      'app/modules/other has a package.json named "left-pad", not a module package',
    ]);
  });

  it('passes app/modules/.gitkeep beside an expected folder with its package.json', () => {
    const local = { packageName: '@haive/module-a', source: 'local' };
    const names = [
      'app/modules/',
      'app/modules/.gitkeep',
      'app/modules/a/',
      'app/modules/a/package.json',
    ];
    const folders = new Map([['a', '@haive/module-a']]);
    assert.deepEqual(check(names, { modules: [local] }, { folders }), []);
  });

  it('fails a link or file named app/modules/<x>, which tar -t lists with no entry type', () => {
    const names = [...A_API_NAMES, 'app/modules/evil'];
    assert.deepEqual(comparePresence('api', footprintOf(names), STATISTICS_FOLDER, expectA()), [
      { key: 'api', check: 'presence', what: 'app/modules/evil is not a directory' },
    ]);
    assert.deepEqual(check(names, {}, { key: 'web', folders: new Map() }), [
      'app/modules/evil is not a directory',
    ]);
  });

  it('passes the peer-suffixed name of the expected version', () => {
    const names = A_API_NAMES.map((n) => n.replace('alpha@0.1.0', 'alpha@0.1.0_react@19.0.0'));
    assert.deepEqual(check(names), []);
  });

  it('fails another version of the right module, naming id and version', () => {
    const names = [
      ...A_API_NAMES,
      `${PNPM}/@haive-module+alpha@0.2.0/node_modules/@haive-module/alpha/package.json`,
    ];
    assert.deepEqual(check(names), ['alpha@0.2.0 is in the image, expected alpha@0.1.0']);
  });

  it('fails a module present at the wrong version only', () => {
    const names = A_API_NAMES.map((n) => n.replace('alpha@0.1.0', 'alpha@0.2.0'));
    assert.deepEqual(check(names), ['alpha@0.2.0 is in the image, expected alpha@0.1.0']);
  });

  it('fails the wrong version in a peer-suffixed name', () => {
    const names = [...A_API_NAMES, `${PNPM}/@haive-module+alpha@0.3.0_react@19.0.0/`];
    assert.deepEqual(check(names), ['alpha@0.3.0 is in the image, expected alpha@0.1.0']);
  });

  it('compares no version for a local module, which the expectation gives none', () => {
    const names = [...A_API_NAMES, `${PNPM}/@haive-module+statistics@9.9.9/`];
    assert.deepEqual(check(names), ['registry module statistics is in the image but not expected']);
  });

  it('fails an @haive-module+ name that does not parse, naming it', () => {
    const names = [...A_API_NAMES, `${PNPM}/@haive-module+Beta@0.1.0/package.json`];
    assert.deepEqual(check(names), [
      '@haive-module+Beta@0.1.0 is not a module package name and version',
    ]);
  });

  it('fails a node_modules/@haive-module link that is no module name', () => {
    const names = [...A_API_NAMES, 'app/packages/api/node_modules/@haive-module/Beta'];
    assert.deepEqual(check(names), [
      'node_modules/@haive-module/Beta is not a module package name',
    ]);
  });

  it('sees a registry module reachable only through a link', () => {
    const names = [...A_API_NAMES, 'app/packages/api/node_modules/@haive-module/beta'];
    assert.deepEqual(check(names), ['registry module beta is in the image but not expected']);
  });

  it('takes the workspace link of a local folder named @haive-module/<id> for that folder', () => {
    const local = { packageName: '@haive-module/foo', source: 'local' };
    const folders = new Map([['foo', '@haive-module/foo']]);
    const names = [
      'app/modules/foo/package.json',
      'app/packages/api/node_modules/@haive-module/foo',
    ];
    const over = { modules: [local] };
    assert.deepEqual(check(names, over, { folders }), []);
  });

  it('counts a module on the layer it ships on, a later whiteout notwithstanding', () => {
    const footprint = footprintOf(
      [...A_API_NAMES, `${PNPM}/@haive-module+beta@0.1.0/`],
      [`${PNPM}/.wh.@haive-module+beta@0.1.0`],
    );
    assert.deepEqual(whats(comparePresence('api', footprint, STATISTICS_FOLDER, expectA())), [
      'registry module beta is in the image but not expected',
    ]);
  });

  describe('the web image', () => {
    const web = (names, folders = new Map(), over = {}) =>
      check(names, over, { key: 'web', folders });

    it('passes an image that holds no module name at all', () => {
      assert.deepEqual(
        web(['app/packages/web/server.js', 'app/.next/server/chunks/ssr/page.js']),
        [],
      );
    });

    it('passes the names of the expected modules that have web parts, and does not demand them', () => {
      assert.deepEqual(web([`${PNPM}/@haive-module+alpha@0.1.0/`]), []);
      assert.deepEqual(web(['app/modules/statistics/package.json'], STATISTICS_FOLDER), []);
    });

    it('fails a module the channel did not buy', () => {
      assert.deepEqual(web([`${PNPM}/@haive-module+beta@0.1.0/`]), [
        'registry module beta is in the image but not expected',
      ]);
    });

    it('fails an expected module that has no web part', () => {
      const noParts = { modules: [STATISTICS, { ...ALPHA, webParts: undefined }] };
      assert.deepEqual(web([`${PNPM}/@haive-module+alpha@0.1.0/`], new Map(), noParts), [
        'registry module alpha is in the image but not expected',
      ]);
    });

    it('fails an expected module at another version', () => {
      assert.deepEqual(web([`${PNPM}/@haive-module+alpha@0.2.0/`]), [
        'alpha@0.2.0 is in the image, expected alpha@0.1.0',
      ]);
    });
  });
});

describe('compareLists', () => {
  const listed = (...modules) => ({
    entries: modules.map((m) => ({ packageName: m.packageName, source: m.source, problem: null })),
  });
  const web = (...entries) => ({ list: entries });
  const ENTRY_STATISTICS = { id: 'statistics', ...STATISTICS, parts: ['dashboard', 'web'] };
  const ENTRY_ALPHA = { id: 'alpha', ...ALPHA, parts: ['web'] };
  const BETA = { packageName: '@haive-module/beta', source: 'registry' };

  it('passes the exact set, in any order', () => {
    assert.deepEqual(compareLists('api', listed(ALPHA, STATISTICS), expectA()), []);
    assert.deepEqual(compareLists('worker', listed(STATISTICS, ALPHA), expectA()), []);
  });

  it('fails a module that is listed and not expected, and one expected and not listed', () => {
    assert.deepEqual(whats(compareLists('api', listed(STATISTICS, BETA), expectA())), [
      '@haive-module/alpha (registry) is expected but not listed',
      '@haive-module/beta (registry) is listed but not expected',
    ]);
  });

  it('fails a module listed with another source', () => {
    const local = { packageName: ALPHA.packageName, source: 'local' };
    assert.deepEqual(whats(compareLists('api', listed(STATISTICS, local), expectA())), [
      '@haive-module/alpha (local) is listed but not expected',
      '@haive-module/alpha (registry) is expected but not listed',
    ]);
  });

  it('fails an entry the loaders would refuse', () => {
    const reading = listed(STATISTICS, ALPHA);
    reading.entries[1].problem = 'an invalid manifest';
    assert.deepEqual(whats(compareLists('api', reading, expectA())), [
      '@haive-module/alpha (registry) is listed with an invalid manifest',
    ]);
  });

  it('fails a list file that is missing, per image', () => {
    assert.deepEqual(whats(compareLists('worker', { missing: true }, expectA())), [
      '/app/packages/worker/dist/modules.generated.js does not exist',
    ]);
    assert.deepEqual(whats(compareLists('web', { missing: true }, expectA())), [
      '/app/packages/web/modules.generated.json does not exist',
    ]);
  });

  it('passes the web list of the modules that have web parts, and no others', () => {
    assert.deepEqual(compareLists('web', web(ENTRY_ALPHA, ENTRY_STATISTICS), expectA()), []);
    assert.deepEqual(
      compareLists('web', web(), expectA({ modules: [{ ...ALPHA, webParts: [] }] })),
      [],
    );
  });

  it('fails a module web part the channel did not buy', () => {
    const beta = { id: 'beta', ...BETA, parts: ['web'] };
    assert.deepEqual(
      whats(compareLists('web', web(ENTRY_ALPHA, beta, ENTRY_STATISTICS), expectA())),
      ['@haive-module/beta (registry) web is listed but not expected'],
    );
  });

  it('fails a web part that is expected and not compiled in', () => {
    assert.deepEqual(whats(compareLists('web', web(ENTRY_STATISTICS), expectA())), [
      '@haive-module/alpha (registry) web is expected but not listed',
    ]);
  });

  it('fails another set of parts for the same module', () => {
    const wider = { ...ENTRY_ALPHA, parts: ['web', 'dashboard'] };
    assert.deepEqual(whats(compareLists('web', web(wider, ENTRY_STATISTICS), expectA())), [
      '@haive-module/alpha (registry) dashboard+web is listed but not expected',
      '@haive-module/alpha (registry) web is expected but not listed',
    ]);
  });

  it('fails a web list that is not a list of entries', () => {
    assert.deepEqual(whats(compareLists('web', { list: {} }, expectA())), [
      '/app/packages/web/modules.generated.json is not a list',
    ]);
    assert.match(
      whats(compareLists('web', web(ENTRY_ALPHA, 7, ENTRY_STATISTICS), expectA()))[0],
      /holds an entry that is not/,
    );
  });

  describe('the version of a registry module in the web list', () => {
    const at = (version) => ({ ...ENTRY_ALPHA, version });
    const UNVERSIONED = { ...ENTRY_ALPHA };
    delete UNVERSIONED.version;
    const check = (...entries) => whats(compareLists('web', web(...entries), expectA()));
    const listedWith = (found) =>
      `@haive-module/alpha (registry) web is listed with ${found}, expected 0.1.0`;
    const NONE = listedWith('no version');

    it('fails another version, naming the package and both versions, on one line', () => {
      assert.deepEqual(check(at('0.2.0'), ENTRY_STATISTICS), [listedWith('version "0.2.0"')]);
    });

    it('fails an entry with no version', () => {
      assert.deepEqual(check(UNVERSIONED, ENTRY_STATISTICS), [NONE]);
    });

    it('fails a version that is not a string', () => {
      assert.deepEqual(check(at(1), ENTRY_STATISTICS), [listedWith('version 1')]);
      assert.deepEqual(check(at(null), ENTRY_STATISTICS), [listedWith('version null')]);
    });

    it('ignores the listed version of a local module, whatever it is', () => {
      assert.deepEqual(check(ENTRY_ALPHA, ENTRY_STATISTICS), []);
      for (const version of ['9.9.9', '', null, 7]) {
        assert.deepEqual(check(ENTRY_ALPHA, { ...ENTRY_STATISTICS, version }), [], `${version}`);
      }
    });

    it('counts an entry listed twice once when both give the expected version', () => {
      assert.deepEqual(check(ENTRY_ALPHA, ENTRY_ALPHA, ENTRY_STATISTICS), []);
    });

    it('checks every entry of a module listed twice, in either order', () => {
      const wrong = [listedWith('version "0.2.0"')];
      assert.deepEqual(check(ENTRY_ALPHA, at('0.2.0'), ENTRY_STATISTICS), wrong);
      assert.deepEqual(check(at('0.2.0'), ENTRY_ALPHA, ENTRY_STATISTICS), wrong);
      assert.deepEqual(check(ENTRY_ALPHA, UNVERSIONED, ENTRY_STATISTICS), [NONE]);
      assert.deepEqual(check(UNVERSIONED, ENTRY_ALPHA, ENTRY_STATISTICS), [NONE]);
    });

    it('prints one line for each version found, and one for a version listed twice', () => {
      assert.deepEqual(check(at('0.2.0'), at('0.2.0'), ENTRY_STATISTICS), [
        listedWith('version "0.2.0"'),
      ]);
      assert.deepEqual(check(at('0.3.0'), at('0.2.0'), ENTRY_STATISTICS), [
        listedWith('version "0.2.0"'),
        listedWith('version "0.3.0"'),
      ]);
    });
  });
});

describe('parseReading', () => {
  it('takes the last line: a module may have logged while it was imported', () => {
    const reading = parseReading('api', 'listening on 3001\n\n{"entries":[]}\n');
    assert.deepEqual(reading, { entries: [] });
  });

  it('reads a missing file, and a web list of any content', () => {
    assert.deepEqual(parseReading('worker', '{"missing":true}\n'), { missing: true });
    assert.deepEqual(parseReading('web', '{"list":[]}\n'), { list: [] });
  });

  for (const [name, key, text] of [
    ['no output', 'api', ''],
    ['output that is not JSON', 'api', 'Error: boom\n'],
    ['a result that is not an object', 'api', '[]\n'],
    ['null', 'api', 'null\n'],
    ['entries that are not a list', 'api', '{"entries":{}}\n'],
    [
      'an entry with no source',
      'api',
      '{"entries":[{"packageName":"@haive-module/a","problem":null}]}\n',
    ],
    ['the web result on an api image', 'api', '{"list":[]}\n'],
    ['the api result on a web image', 'web', '{"entries":[]}\n'],
  ]) {
    it(`refuses ${name}`, () => {
      assert.throws(() => parseReading(key, text), CouldNotLook);
    });
  }
});

describe('readerScript', () => {
  it('reads the generated list of its own service, and the web list for web', () => {
    assert.match(readerScript('api'), /\/app\/packages\/api\/dist\/modules\.generated\.js/);
    assert.match(readerScript('worker'), /\/app\/packages\/worker\/dist\/modules\.generated\.js/);
    assert.match(readerScript('web'), /\/app\/packages\/web\/modules\.generated\.json/);
    assert.doesNotMatch(readerScript('api'), /process\.env/);
  });
});

describe('compareStamp', () => {
  const stamped = (...env) => whats(compareStamp('api', env, '0.9.0.1'));

  it('passes the channel version', () => {
    assert.deepEqual(stamped('PATH=/usr/bin', 'HAIVE_VERSION=0.9.0.1'), []);
    assert.deepEqual(stamped('HAIVE_VERSION=0.9.0.1', 'HAIVE_VERSION=0.9.0.1'), []);
  });

  it('fails another version, naming it', () => {
    assert.deepEqual(stamped('HAIVE_VERSION=9.9.9'), [
      'HAIVE_VERSION="9.9.9", the channel version is 0.9.0.1',
    ]);
  });

  it('fails an empty value, and a name that is not the variable', () => {
    assert.deepEqual(stamped('HAIVE_VERSION='), [
      'HAIVE_VERSION="", the channel version is 0.9.0.1',
    ]);
    assert.deepEqual(stamped('HAIVE_VERSIONS=0.9.0.1', 'X_HAIVE_VERSION=0.9.0.1'), [
      'HAIVE_VERSION is unset, the channel version is 0.9.0.1',
    ]);
  });

  it('fails an unset variable', () => {
    assert.deepEqual(stamped(), ['HAIVE_VERSION is unset, the channel version is 0.9.0.1']);
  });

  it('fails when any one of several values is wrong', () => {
    assert.deepEqual(stamped('HAIVE_VERSION=0.9.0.1', 'HAIVE_VERSION=0.8.0'), [
      'HAIVE_VERSION="0.8.0", the channel version is 0.9.0.1',
    ]);
  });
});

describe('authLineNumbers', () => {
  it('passes the project .npmrc: a scope line and no credential', () => {
    assert.deepEqual(authLineNumbers('@haive-module:registry=https://npm.pkg.github.com\n'), []);
    assert.deepEqual(authLineNumbers('registry=https://registry.npmjs.org/\nfund=false\n'), []);
    assert.deepEqual(authLineNumbers(''), []);
  });

  it('finds _auth, _authToken and _password lines by number', () => {
    const text = [
      'registry=https://registry.example/',
      '//registry.example/:_authToken=abc',
      '//registry.example/:_auth=YWJj',
      '//registry.example/:_password=abc',
      '_authToken=abc',
      '_auth = abc',
    ].join('\n');
    assert.deepEqual(authLineNumbers(text), [2, 3, 4, 5, 6]);
  });

  for (const line of ['  _authToken=abc', '\t_auth=abc', '  //registry.example/:_password=abc']) {
    it(`finds a key npm trims clear of its indent: ${JSON.stringify(line)}`, () => {
      assert.deepEqual(authLineNumbers(`${line}\n`), [1]);
    });
  }

  it('keeps ignoring a comment marker, with the key right behind it', () => {
    for (const line of ['#_authToken=x', '  ;_auth=x']) {
      assert.deepEqual(authLineNumbers(`${line}\n`), [], JSON.stringify(line));
    }
  });

  it('keeps finding an unindented scoped key and a user:password@ URL', () => {
    assert.deepEqual(authLineNumbers('//h/:_authToken=x\nregistry=https://u:p@h/\n'), [1, 2]);
  });

  it('ignores a comment line, # or ; and indented', () => {
    const text =
      '# //registry.example/:_authToken=abc\n; _authToken=abc\n  # _auth=abc\n\t;_password=abc\n';
    assert.deepEqual(authLineNumbers(text), []);
  });

  it('finds a user:password@ in a URL, and passes a URL with no credential', () => {
    assert.deepEqual(authLineNumbers('registry=https://user:pass@registry.example/\n'), [1]);
    assert.deepEqual(
      authLineNumbers('registry=https://registry.example:4873/\nproxy=http://proxy:3128\n'),
      [],
    );
    assert.deepEqual(authLineNumbers('registry=https://registry.example/a@b\n'), []);
  });

  it('numbers lines the way an editor does, CRLF included', () => {
    assert.deepEqual(authLineNumbers('a=1\r\n\r\n//h/:_authToken=x\r\n'), [3]);
  });

  it('applies the rule of scripts/module-dist-smoke.sh to every line, the same way', () => {
    const smoke = readFileSync(join(dirname(gate), 'module-dist-smoke.sh'), 'utf8');
    const program = /npmrc_credentials\(\) \{[\s\S]*?awk '([\s\S]*?)'/.exec(smoke)?.[1];
    assert.ok(program, 'module-dist-smoke.sh has no npmrc_credentials awk program');
    const literals = [...program.matchAll(/\/((?:[^/\\\n]|\\.)+)\//g)].map((m) => new RegExp(m[1]));
    assert.equal(
      literals.length,
      3,
      'the awk program is no longer a comment skip and two credential patterns',
    );
    const [comment, ...credentials] = literals;
    for (const line of [
      '',
      '# //h/:_authToken=abc',
      '; _authToken=abc',
      '  # _auth=abc',
      '//h/:_authToken=abc',
      '//h/:_auth=YWJj',
      '//h/:_password=abc',
      '  //h/:_authToken=abc',
      '_authToken=abc',
      '_auth = abc',
      '  _authToken=abc',
      '\t_auth=abc',
      '  //h/:_password=abc',
      '#_authToken=x',
      '  ;_auth=x',
      'registry=https://user:pass@registry.example/',
      'registry=https://registry.example:4873/',
      'proxy=http://proxy:3128',
      'registry=https://registry.example/a@b',
      '@haive-module:registry=https://npm.pkg.github.com',
    ]) {
      const flagged = !comment.test(line) && credentials.some((rule) => rule.test(line));
      assert.equal(authLineNumbers(line).length === 1, flagged, JSON.stringify(line));
    }
  });

  it('runs the npmrc_credentials of scripts/module-dist-smoke.sh to the lines the gate finds', (t) => {
    const smoke = readFileSync(join(dirname(gate), 'module-dist-smoke.sh'), 'utf8');
    const fn = /^npmrc_credentials\(\) \{\n[\s\S]*?\n\}$/m.exec(smoke)?.[0];
    assert.ok(fn, 'module-dist-smoke.sh has no npmrc_credentials function');
    const dir = mkdtempSync(join(tmpdir(), 'haive-npmrc-credentials-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const text = [
      '  _authToken=abc',
      '\t_auth=abc',
      '  //registry.example/:_password=abc',
      '#_authToken=x',
      '  ;_auth=x',
      '//h/:_authToken=x',
      'registry=https://u:p@h/',
      '',
    ].join('\n');
    writeFileSync(join(dir, '.npmrc'), text);
    const ran = spawnSync('bash', ['-c', `${fn}\nnpmrc_credentials "$1"`, '_', dir], {
      encoding: 'utf8',
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(ran.stdout.trim().split('\n'), [
      '.npmrc:1',
      '.npmrc:2',
      '.npmrc:3',
      '.npmrc:6',
      '.npmrc:7',
    ]);
    assert.deepEqual(authLineNumbers(text), [1, 2, 3, 6, 7]);
  });

  it('returns numbers, never the line', () => {
    const found = authLineNumbers('//h/:_authToken=secret-value\n');
    assert.deepEqual(found, [1]);
    assert.equal(JSON.stringify(found).includes('secret'), false);
  });
});

describe('compareToken', () => {
  const COUNTS = 'history=0 inspect=0 config=0 layers=0 tars=20\n';

  it('passes when scan-image.sh found nothing', () => {
    assert.deepEqual(compareToken('api', { status: 0, stdout: COUNTS, stderr: '' }), []);
  });

  it('fails with the places scan-image.sh counted, and nothing else', () => {
    const found = 'history=4 inspect=2 config=6 layers=1 tars=20\n';
    assert.deepEqual(compareToken('api', { status: 1, stdout: found, stderr: '' }), [
      {
        key: 'api',
        check: 'token',
        what: 'the vendor token is in the image: history=4 inspect=2 config=6 layers=1 tars=20',
      },
    ]);
  });

  it('does not trust an exit 0 that sits beside a count', () => {
    const found = 'history=0 inspect=0 config=0 layers=1 tars=20\n';
    assert.equal(compareToken('api', { status: 0, stdout: found, stderr: '' }).length, 1);
  });

  for (const [name, result] of [
    ['exit 2', { status: 2, stdout: '', stderr: 'scan-image: cannot read the history of x\n' }],
    ['a signal', { status: null, stdout: '', stderr: '' }],
    ['exit 127', { status: 127, stdout: '', stderr: 'bash: x: command not found\n' }],
    ['exit 0 and no counts', { status: 0, stdout: '', stderr: '' }],
    ['exit 1 and no counts', { status: 1, stdout: 'garbage\n', stderr: '' }],
  ]) {
    it(`could not look on ${name}`, () => {
      assert.throws(() => compareToken('api', result), CouldNotLook);
    });
  }
});

describe('formatOffender', () => {
  it('prints OFFENDER, the image key, the check and what was found', () => {
    assert.equal(
      formatOffender({
        key: 'api',
        check: 'presence',
        what: 'registry module beta is in the image',
      }),
      'OFFENDER api presence registry module beta is in the image',
    );
  });

  it('keeps one offender on one line whatever the image put in a name', () => {
    const line = formatOffender({
      key: 'web',
      check: 'lists',
      what: 'a\nOFFENDER api token x\r\u001b[31my\u007f',
    });
    assert.equal(line.split('\n').length, 1);
    assert.equal(line, 'OFFENDER web lists a\\x0aOFFENDER api token x\\x0d\\x1b[31my\\x7f');
  });
});

describe('foldExit', () => {
  const OFFENDER = { key: 'api', check: 'token', what: 'x' };

  it('is 0 only when nothing was found and nothing was missed', () => {
    assert.equal(foldExit([], []), 0);
  });

  it('is 1 when a check found an offender', () => {
    assert.equal(foldExit([OFFENDER], []), 1);
    assert.equal(foldExit([OFFENDER, OFFENDER], []), 1);
  });

  it('is 2 when a check could not look, and that beats the offenders', () => {
    assert.equal(foldExit([], ['api layers: x']), 2);
    assert.equal(foldExit([OFFENDER], ['api layers: x']), 2);
  });
});

const TOKEN = 'd2a2tok-0123456789abcdef0123456789abcdef';

// Runs the gate with a stub docker first on PATH and a TMPDIR of its own, so the real daemon is never
// reached and what the gate leaves behind can be counted.
function runGate(t, { stub, files = {}, args, env = {}, script = gate } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'haive-channel-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const scratch = join(dir, 'tmp');
  mkdirSync(bin);
  mkdirSync(scratch);
  if (stub !== undefined) {
    writeFileSync(join(bin, 'docker'), stub);
    chmodSync(join(bin, 'docker'), 0o755);
  }
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const withFiles = args ?? [
    '--expect',
    join(dir, 'expect.json'),
    '--token-file',
    join(dir, 'token'),
  ];
  const result = spawnSync(process.execPath, [script, ...withFiles], {
    encoding: 'utf8',
    env: { ...process.env, ...env, PATH: [bin, process.env.PATH].join(delimiter), TMPDIR: scratch },
  });
  return { ...result, leftovers: readdirSync(scratch), dir };
}

const GOOD_FILES = {
  'expect.json': JSON.stringify(expectation({ images: { api: 'a-api:1', worker: 'a-worker:1' } })),
  token: `${TOKEN}\n`,
};

describe('the command line: a run that cannot look exits 2', () => {
  it('on arguments it does not understand', (t) => {
    for (const args of [
      [],
      ['--expect', 'x'],
      ['--token-file', 'x'],
      ['--expect', 'a', '--expect', 'b', '--token-file', 'x'],
      ['--nope'],
      ['x'],
    ]) {
      const result = runGate(t, { args });
      assert.equal(result.status, 2, args.join(' '));
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /usage: node scripts\/channel-gate\.mjs --expect/);
    }
  });

  it('on an expectation that is not there', (t) => {
    const result = runGate(t, { files: { token: TOKEN } });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
  });

  it('on a malformed expectation, before docker is asked anything', (t) => {
    const result = runGate(t, { files: { 'expect.json': '{"version": "1"}', token: TOKEN } });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /malformed expectation: images is not an object/);
  });

  it('on a registry module with no version, naming the package, before docker is asked anything', (t) => {
    const modules = [STATISTICS, { ...ALPHA, version: undefined }];
    const files = { 'expect.json': JSON.stringify(expectation({ modules })), token: TOKEN };
    const stub = '#!/bin/sh\necho "docker was asked: $*" >&2\nexit 1\n';
    const result = runGate(t, { files, stub });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /malformed expectation: .*@haive-module\/alpha/);
    assert.doesNotMatch(result.stderr, /docker was asked/);
  });

  for (const [name, text] of [
    ['empty', ''],
    ['two lines', 'abc\ndef\n'],
  ]) {
    it(`on a token file that is ${name}`, (t) => {
      const result = runGate(t, { files: { ...GOOD_FILES, token: text } });
      assert.equal(result.status, 2);
      assert.equal(result.stdout, '');
    });
  }

  it('on a token file that is not there', (t) => {
    const result = runGate(t, { files: { 'expect.json': GOOD_FILES['expect.json'] } });
    assert.equal(result.status, 2);
  });

  it('through a symlink to the script: never a silent 0', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'haive-channel-gate-link-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    symlinkSync(gate, join(dir, 'gate.mjs'));
    symlinkSync(dirname(gate), join(dir, 'scripts'));
    for (const script of [join(dir, 'gate.mjs'), join(dir, 'scripts', 'channel-gate.mjs')]) {
      const result = runGate(t, { files: GOOD_FILES, args: [], script });
      assert.equal(result.status, 2, script);
      assert.match(result.stderr, /usage: /);
    }
  });

  it('when docker cannot be reached', (t) => {
    const stub = '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n';
    const result = runGate(t, { files: GOOD_FILES, stub });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /could not look: api: a-api:1 cannot be inspected: Cannot connect/);
    assert.deepEqual(result.leftovers, []);
  });

  it('when one image does not exist, naming every image it checked first', (t) => {
    const stub = `#!/bin/sh
case "$*" in *a-worker*) echo "Error response from daemon: No such image: a-worker:1" >&2; exit 1 ;; esac
echo '[]'
`;
    const result = runGate(t, { files: GOOD_FILES, stub });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(
      result.stderr,
      /could not look: worker: a-worker:1 cannot be inspected: .*No such image/,
    );
    assert.doesNotMatch(result.stderr, /api: a-api/);
  });

  it('with offenders it found, which it still prints, and a check it could not make', (t) => {
    const stub = `#!/bin/sh
if [ "$1" = image ]; then echo '["HAIVE_VERSION=9.9.9"]'; exit 0; fi
echo "docker: cannot go on" >&2
exit 1
`;
    const result = runGate(t, { files: GOOD_FILES, stub });
    assert.equal(result.status, 2);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      'OFFENDER api stamp HAIVE_VERSION="9.9.9", the channel version is 0.9.0.1',
      'OFFENDER worker stamp HAIVE_VERSION="9.9.9", the channel version is 0.9.0.1',
    ]);
    assert.match(result.stderr, /could not look: api layers: docker save of a-api:1 failed/);
    assert.match(
      result.stderr,
      /could not look: api lists: the module list of a-api:1 cannot be read/,
    );
    assert.match(
      result.stderr,
      /could not look: api token: scan-image\.sh could not read the image/,
    );
    assert.equal(result.stdout.includes(TOKEN) || result.stderr.includes(TOKEN), false);
    assert.deepEqual(result.leftovers, []);
  });
});

// A docker whose `save` streams the tar in $STUB_SAVE, `run` answers with the reading in $STUB_READING
// (or $STUB_READING_WEB for the web image) and `image inspect` with $STUB_ENV.
const FAKE_DOCKER = `#!/bin/sh
case "$1" in
  image) echo "$STUB_ENV" ;;
  save) cat "$STUB_SAVE" ;;
  history) echo "IMAGE CREATED BY SIZE" ;;
  rm) ;;
  run)
    cat > /dev/null
    for arg in "$@"; do [ "$prev" = -w ] && dir=$arg; prev=$arg; done
    case "$dir" in */web) echo "$STUB_READING_WEB" ;; *) echo "$STUB_READING" ;; esac ;;
  *) exit 1 ;;
esac
`;

// A directory tree per layer, tarred; the whole as `docker save` lays it out (manifest.json and the layer tars).
function fakeSave(dir, layers) {
  const tree = join(dir, 'save');
  const names = [];
  layers.forEach((files, i) => {
    const staged = join(dir, `layer-${i}`);
    mkdirSync(staged, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(staged, name)), { recursive: true });
      if (typeof text === 'string') writeFileSync(join(staged, name), text);
      else symlinkSync(text.link, join(staged, name));
    }
    mkdirSync(join(tree, `l${i}`), { recursive: true });
    assert.equal(
      spawnSync('tar', ['-cf', join(tree, `l${i}`, 'layer.tar'), '-C', staged, '.']).status,
      0,
    );
    names.push(`l${i}/layer.tar`);
  });
  writeFileSync(
    join(tree, 'manifest.json'),
    JSON.stringify([{ Config: 'c.json', RepoTags: [], Layers: names }]),
  );
  writeFileSync(join(tree, 'c.json'), '{}');
  const archive = join(dir, 'image.tar');
  assert.equal(spawnSync('tar', ['-cf', archive, '-C', tree, '.']).status, 0);
  return archive;
}

const READING = {
  entries: [
    { packageName: '@haive-module/alpha', source: 'registry', problem: null },
    { packageName: '@haive/module-statistics', source: 'local', problem: null },
  ],
};
const CLEAN_LAYER = {
  'app/.npmrc': '@haive-module:registry=https://npm.pkg.github.com\n',
  'app/modules/.gitkeep': '',
  'app/modules/statistics/package.json': '{"name":"@haive/module-statistics"}',
  [`${ALPHA_DIR}/package.json`]: '{"name":"@haive-module/alpha"}',
};

function fakeImage(
  t,
  { layers = [CLEAN_LAYER], env = ['HAIVE_VERSION=0.9.0.1'], reading = READING } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'haive-channel-gate-fixture-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    stub: FAKE_DOCKER,
    env: {
      STUB_SAVE: fakeSave(dir, layers),
      STUB_ENV: JSON.stringify(env),
      STUB_READING: JSON.stringify(reading),
      STUB_READING_WEB: JSON.stringify({
        list: [
          { id: 'alpha', ...ALPHA, parts: ['web'] },
          { id: 'statistics', ...STATISTICS, parts: ['dashboard', 'web'] },
        ],
      }),
    },
  };
}

describe('the command line against a docker that answers', () => {
  it('exits 0 for the images the expectation describes, and prints no offender', (t) => {
    const result = runGate(t, { files: GOOD_FILES, ...fakeImage(t) });
    assert.equal(result.stderr.includes('every image passed every check'), true, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.status, 0);
    assert.deepEqual(result.leftovers, []);
  });

  it('checks a web image too when the expectation has one', (t) => {
    const expect = JSON.stringify(expectation());
    const result = runGate(t, { files: { ...GOOD_FILES, 'expect.json': expect }, ...fakeImage(t) });
    assert.equal(result.stdout, '');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /web a-web:1: 0 offender\(s\), 0 check\(s\) not looked at/);
  });

  for (const [name, listed, line] of [
    ['another version', { version: '0.2.0' }, 'is listed with version "0.2.0", expected 0.1.0'],
    ['no version', {}, 'is listed with no version, expected 0.1.0'],
  ]) {
    it(`exits 1 with one web lists line when the web list gives a registry module ${name}`, (t) => {
      const image = fakeImage(t);
      const { packageName, source } = ALPHA;
      image.env.STUB_READING_WEB = JSON.stringify({
        list: [
          { id: 'alpha', packageName, source, ...listed, parts: ['web'] },
          { id: 'statistics', ...STATISTICS, parts: ['dashboard', 'web'] },
        ],
      });
      const files = { ...GOOD_FILES, 'expect.json': JSON.stringify(expectation()) };
      const result = runGate(t, { files, ...image });
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(result.stdout.trim().split('\n'), [
        `OFFENDER web lists @haive-module/alpha (registry) web ${line}`,
      ]);
      assert.deepEqual(result.leftovers, []);
    });
  }

  it('exits 1 and prints one line per offender, from every check that found one', (t) => {
    const flawed = [
      CLEAN_LAYER,
      {
        'app/.npmrc': `//registry.invalid/:_authToken=${'planted-credential-7c1f'}\n`,
        'app/modules/beta/package.json': '{"name":"@haive-module/beta"}',
        'root/leak.txt': `leak=${TOKEN}\n`,
      },
    ];
    const image = fakeImage(t, { layers: flawed, env: ['HAIVE_VERSION=9.9.9'] });
    const result = runGate(t, { files: GOOD_FILES, ...image });
    assert.equal(result.status, 1, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.deepEqual(
      lines.filter((line) => line.startsWith('OFFENDER api ')),
      [
        'OFFENDER api presence module folder beta (app/modules/beta) is in the image but not expected',
        'OFFENDER api npmrc app/.npmrc (layer 1) line 1 sets a credential',
        'OFFENDER api stamp HAIVE_VERSION="9.9.9", the channel version is 0.9.0.1',
        'OFFENDER api token the vendor token is in the image: history=0 inspect=0 config=0 layers=1 tars=2',
      ],
    );
    assert.equal(lines.length, 8, result.stdout);
    for (const secret of [TOKEN, 'planted-credential-7c1f']) {
      assert.equal(result.stdout.includes(secret) || result.stderr.includes(secret), false, secret);
    }
    assert.deepEqual(result.leftovers, []);
  });

  it('exits 1 for a symlink or file named app/modules/<x>, which tar -t lists with no slash', (t) => {
    const layers = [
      CLEAN_LAYER,
      { 'app/modules/evil': { link: 'statistics' }, 'app/modules/x': '' },
    ];
    const result = runGate(t, { files: GOOD_FILES, ...fakeImage(t, { layers }) });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      'OFFENDER api presence app/modules/evil is not a directory',
      'OFFENDER api presence app/modules/x is not a directory',
      'OFFENDER worker presence app/modules/evil is not a directory',
      'OFFENDER worker presence app/modules/x is not a directory',
    ]);
  });

  it('prints the token nowhere even when the image carries it in a name the gate prints', (t) => {
    const image = fakeImage(t, { env: [`HAIVE_VERSION=${TOKEN}`] });
    const result = runGate(t, { files: GOOD_FILES, ...image });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /HAIVE_VERSION="\[token\]"/);
    assert.equal(result.stdout.includes(TOKEN) || result.stderr.includes(TOKEN), false);
  });

  it('exits 2, naming the layer, when a layer cannot be listed', (t) => {
    const image = fakeImage(t);
    writeFileSync(image.env.STUB_SAVE, 'this is not a tar');
    const result = runGate(t, { files: GOOD_FILES, ...image });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not look: api layers: docker save of a-api:1 failed/);
    assert.deepEqual(result.leftovers, []);
  });

  it('exits 2 when the in-image reader prints nothing it can read', (t) => {
    const image = fakeImage(t);
    image.env.STUB_READING = 'Error: Cannot find module';
    const result = runGate(t, { files: GOOD_FILES, ...image });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /could not look: api lists: the in-image reader printed no result/);
  });
});
