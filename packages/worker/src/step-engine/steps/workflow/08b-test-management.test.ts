import { describe, it, expect } from 'vitest';
import {
  parseTesterOutput,
  buildSelectiveCommand,
  filterTestFiles,
  testManagementStep,
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

describe('testManagementStep.fixLoop', () => {
  const mkApply = (over: Record<string, unknown>) => ({
    action: 'manage',
    testsCreated: [],
    testsUpdated: [],
    testsDeleted: [],
    notes: '',
    testRun: null,
    testsPassed: null,
    fixPasses: 0,
    ...over,
  });

  it('does NOT route back when the related tests passed', () => {
    expect(
      testManagementStep.fixLoop!.evaluate(
        mkApply({
          testsPassed: true,
          testRun: { ran: true, passed: true, command: 'npx vitest run a', output: 'ok' },
        }) as never,
      ),
    ).toBeNull();
  });

  // testsPassed === null is "no verdict", not a failure: the user skipped, nothing
  // runnable was produced, the framework has no file-scoped subset, or the DDEV
  // runner was unavailable. None of those is a defect for the implementer to fix.
  it('does NOT route back on any no-verdict shape', () => {
    const noVerdict = [
      mkApply({ action: 'skip', notes: 'test management skipped by user' }),
      mkApply({
        testsCreated: ['docs/x.md'],
        testRun: {
          ran: false,
          passed: false,
          command: '',
          output: 'no runnable test files among the changes — selective run skipped',
        },
      }),
      mkApply({
        testRun: {
          ran: false,
          passed: false,
          command: '',
          output:
            'selective run unsupported for plain test scripts (would run the full suite) — skipped',
        },
      }),
      mkApply({
        testRun: {
          ran: false,
          passed: false,
          command: 'ddev exec npx vitest run a',
          output: 'DDEV runner unavailable for the selective test run — skipped',
        },
      }),
    ];
    for (const out of noVerdict) {
      expect(testManagementStep.fixLoop!.evaluate(out as never)).toBeNull();
    }
  });

  it('routes back with the command, failures, touched tests and the three-way framing', () => {
    const v = testManagementStep.fixLoop!.evaluate(
      mkApply({
        testsPassed: false,
        fixPasses: 5,
        testsCreated: ['tests/new.spec.ts'],
        testsUpdated: ['tests/old.spec.ts'],
        testRun: {
          ran: true,
          passed: false,
          command: 'npx vitest run tests/new.spec.ts',
          output: 'AssertionError: expected 1 to be 2',
        },
      }) as never,
    );
    expect(v).not.toBeNull();
    expect(v!.blocking).toBe(true);
    expect(v!.diagnosis).toContain('npx vitest run tests/new.spec.ts');
    expect(v!.diagnosis).toContain('AssertionError: expected 1 to be 2');
    expect(v!.diagnosis).toContain('tests/new.spec.ts');
    expect(v!.diagnosis).toContain('tests/old.spec.ts');
    expect(v!.diagnosis).toContain('5 fix pass');
    // The implementer must not treat the failing assertion as gospel.
    expect(v!.diagnosis).toMatch(/TEST is wrong/);
    expect(v!.diagnosis).toMatch(/CODE is wrong/);
    expect(v!.diagnosis).toMatch(/FLAKY/);
  });
});
