import { describe, expect, it } from 'vitest';
import { excludedChangeSizePath } from '../src/change-size.js';

// Every alternative of the original policy has a positive and a near-miss control.
const directories = [
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  '__fixtures__',
  'fixture',
  'fixtures',
  '__snapshots__',
  'e2e',
  'cypress',
  'playwright',
  'doc',
  'docs',
  'generated',
  'vendor',
  'third_party',
  'third-party',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.git',
  '.haive',
  '.haive-data',
  'venv',
  '.venv',
  '__pycache__',
  '.cache',
  '.turbo',
  '.nuxt',
  '.svelte-kit',
];
const proseNames = ['readme', 'changelog', 'license', 'notice', 'authors', 'contributing'];
const cases: [string, boolean][] = directories.flatMap((name) => [
  [`src/${name}/a.py`, true],
  [name.toUpperCase(), true],
  [`src/${name}x/a.py`, false],
]);
for (const name of proseNames) {
  cases.push(
    [name, true],
    [`src/${name.toUpperCase()}.txt`, true],
    [`${name}.`, true],
    [`src/${name}x.txt`, false],
    [`src/${name}/a.py`, false],
  );
}
cases.push(
  ['types.d.ts', true],
  ['types.d.cts', true],
  ['types.d.mts', true],
  ['.d.ts', true],
  ['types.d.tsx', false],
  ['types.d.jts', false],
  ['test_a.py', true],
  ['test_.py', false],
  ['test_a.pyx', false],
  ['a_test.py', true],
  ['_test.py', false],
  ['a_tests.py', false],
  ['aTest.php', true],
  ['Test.php', false],
  ['aTests.php', false],
);
for (const kind of ['test', 'spec']) {
  for (const ext of [
    'js',
    'jsx',
    'ts',
    'tsx',
    'mjs',
    'mjsx',
    'mts',
    'mtsx',
    'cjs',
    'cjsx',
    'cts',
    'ctsx',
  ])
    cases.push([`a.${kind}.${ext}`, true]);
  cases.push([`.${kind}.ts`, false], [`a.${kind}.jss`, false], [`a.${kind}.zts`, false]);
}
for (const marker of ['generated', 'g', 'min']) {
  cases.push(
    [`a.${marker}.ts`, true],
    [`a.${marker}.more.ts`, true],
    [`.${marker}.ts`, false],
    [`a.${marker}.`, false],
    [`a.${marker}x.ts`, false],
  );
}
cases.push(
  ['a.lock', true],
  ['.lock', false],
  ['a.lockx', false],
  ['lock.yaml', true],
  ['pnpm-lock.yaml', true],
  ['lock.json', true],
  ['aLOCKb.JSON', true],
  ['locked.yml', false],
  ['clock.jsonx', false],
  ['locK.yaml', false],
);
for (const ext of ['md', 'mdx', 'rst', 'adoc', 'map'])
  cases.push([`a.${ext}`, true], [`.${ext}`, false], [`a.${ext}extra`, false]);
cases.push(
  ['src/main.py', false],
  ['', false],
  ['src/a.g.ts/keep.py', false],
  ['src/a.min.js/keep.py', false],
  ['src/a.test.ts/keep.py', false],
  ['src/a.g.ts\n', true],
  ['src/a.md\n', false],
  ['src/readme.\n', true],
);

describe('change-size path policy parity', () => {
  it.each(cases)('%s excludes=%s', (path, excluded) => {
    expect(excludedChangeSizePath(path)).toBe(excluded);
  });
});
