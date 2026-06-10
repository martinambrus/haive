import { describe, it, expect } from 'vitest';
import {
  parseTesterOutput,
  buildSelectiveCommand,
  filterTestFiles,
} from './08b-test-management.js';

describe('parseTesterOutput', () => {
  it('parses a fenced tester report', () => {
    const raw =
      'searched tests\n```json\n{"tests_created":["tests/a.spec.ts"],"tests_updated":["tests/b.spec.ts"],"tests_deleted":[],"notes":"done"}\n```';
    const p = parseTesterOutput(raw);
    expect(p.testsCreated).toEqual(['tests/a.spec.ts']);
    expect(p.testsUpdated).toEqual(['tests/b.spec.ts']);
    expect(p.notes).toBe('done');
  });

  it('accepts an already-parsed object (bypass stub shape)', () => {
    const p = parseTesterOutput({
      tests_created: [],
      tests_updated: [],
      tests_deleted: [],
      notes: 'bypass',
    });
    expect(p.testsCreated).toEqual([]);
    expect(p.notes).toBe('bypass');
  });

  it('falls back to no-changes on garbled output', () => {
    expect(parseTesterOutput('not json')).toEqual({
      testsCreated: [],
      testsUpdated: [],
      testsDeleted: [],
      notes: '',
    });
    expect(parseTesterOutput(null).testsCreated).toEqual([]);
  });
});

describe('filterTestFiles', () => {
  it('keeps recognizable test files only', () => {
    const files = [
      'tests/feature.spec.ts',
      'src/feature.ts',
      'tests/unit/FeatureTest.php',
      'tests/test_feature.py',
      'docs/readme.md',
      'e2e/flow.test.js',
    ];
    expect(filterTestFiles(files)).toEqual([
      'tests/feature.spec.ts',
      'tests/unit/FeatureTest.php',
      'tests/test_feature.py',
      'e2e/flow.test.js',
    ]);
  });
});

describe('buildSelectiveCommand', () => {
  const files = ['tests/a.spec.ts'];

  it('uses the ddev playwright addon command when present', () => {
    const cmd = buildSelectiveCommand('playwright', files, {
      ddev: true,
      ddevPlaywrightAddon: true,
    });
    expect(cmd).toEqual({ kind: 'ddev', args: ['playwright', 'test', 'tests/a.spec.ts'] });
  });

  it('falls back to ddev exec npx playwright without the addon', () => {
    const cmd = buildSelectiveCommand('playwright', files, {
      ddev: true,
      ddevPlaywrightAddon: false,
    });
    expect(cmd).toEqual({
      kind: 'ddev',
      args: ['exec', 'npx', 'playwright', 'test', 'tests/a.spec.ts'],
    });
  });

  it('runs playwright host-side for non-ddev repos', () => {
    const cmd = buildSelectiveCommand('playwright', files, {
      ddev: false,
      ddevPlaywrightAddon: false,
    });
    expect(cmd).toEqual({ kind: 'host', args: ['npx', 'playwright', 'test', 'tests/a.spec.ts'] });
  });

  it('builds phpunit + pytest + vitest variants', () => {
    expect(
      buildSelectiveCommand('phpunit', ['tests/FooTest.php'], {
        ddev: true,
        ddevPlaywrightAddon: false,
      }),
    ).toEqual({ kind: 'ddev', args: ['exec', 'vendor/bin/phpunit', 'tests/FooTest.php'] });
    expect(
      buildSelectiveCommand('pytest', ['tests/test_x.py'], {
        ddev: false,
        ddevPlaywrightAddon: false,
      }),
    ).toEqual({ kind: 'host', args: ['pytest', 'tests/test_x.py'] });
    expect(
      buildSelectiveCommand('vitest', files, { ddev: false, ddevPlaywrightAddon: false }),
    ).toEqual({ kind: 'host', args: ['npx', 'vitest', 'run', 'tests/a.spec.ts'] });
  });

  it('refuses plain test scripts (would run the full suite) and empty file lists', () => {
    expect(
      buildSelectiveCommand('pkg-script', files, { ddev: false, ddevPlaywrightAddon: false }),
    ).toBeNull();
    expect(
      buildSelectiveCommand('composer-script', files, { ddev: false, ddevPlaywrightAddon: false }),
    ).toBeNull();
    expect(
      buildSelectiveCommand('playwright', [], { ddev: false, ddevPlaywrightAddon: false }),
    ).toBeNull();
    expect(
      buildSelectiveCommand(null, files, { ddev: false, ddevPlaywrightAddon: false }),
    ).toBeNull();
  });
});
