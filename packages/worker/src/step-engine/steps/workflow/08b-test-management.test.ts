import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import {
  actionInstructions,
  parseTesterOutput,
  buildCollectCommand,
  buildSelectiveCommand,
  filterTestFiles,
  primaryFrameworkRoot,
  priorPassNotes,
  repairInvocation,
  scanTestInfra,
  scopeToRoot,
  testManagementStep,
} from './08b-test-management.js';
import { classifyTestEnvFailure } from './_test-env-guard.js';

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

describe('actionInstructions', () => {
  const text = actionInstructions().join('\n');

  it('asks for the coverage audit the blast-radius block exists to enable', () => {
    // The gap this step could not see before: a form test that asserts everything
    // except the checkbox the change added still PASSES, so the full suite that runs
    // after this step reports nothing.
    expect(text).toContain('AUDIT the tests covering the components');
    expect(text).toContain('still asserts the WHOLE of what its component does now');
  });

  it('says a missing assertion is the fix, not a rewrite', () => {
    // Widening a test-writer's remit is how a small change grows a large diff.
    expect(text).toContain('not by rewriting a test that is still correct');
  });

  it('does not let an empty list be read as "this component has no tests"', () => {
    // Links accrue one task at a time through 11f, so most components carry none
    // for a long while.
    expect(text).toContain('has none RECORDED in the plan');
  });

  it('keeps the numbering contiguous', () => {
    const numbered = actionInstructions().filter((l) => /^\d+\./.test(l));
    expect(numbered.map((l) => l.split('.')[0])).toEqual(['1', '2', '3', '4', '5', '6']);
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
    expect(cmd).toEqual({ kind: 'ddev', args: ['playwright', 'test', 'tests/a.spec.ts'], cwd: '' });
  });

  it('falls back to ddev exec npx playwright without the addon', () => {
    const cmd = buildSelectiveCommand('playwright', files, {
      ddev: true,
      ddevPlaywrightAddon: false,
    });
    expect(cmd).toEqual({
      kind: 'ddev',
      args: ['exec', 'npx', 'playwright', 'test', 'tests/a.spec.ts'],
      cwd: '',
    });
  });

  it('runs playwright host-side for non-ddev repos', () => {
    const cmd = buildSelectiveCommand('playwright', files, {
      ddev: false,
      ddevPlaywrightAddon: false,
    });
    expect(cmd).toEqual({
      kind: 'host',
      args: ['npx', 'playwright', 'test', 'tests/a.spec.ts'],
      cwd: '',
    });
  });

  it('builds phpunit + pytest + vitest variants', () => {
    expect(
      buildSelectiveCommand('phpunit', ['tests/FooTest.php'], {
        ddev: true,
        ddevPlaywrightAddon: false,
      }),
    ).toEqual({ kind: 'ddev', args: ['exec', 'vendor/bin/phpunit', 'tests/FooTest.php'], cwd: '' });
    expect(
      buildSelectiveCommand('pytest', ['tests/test_x.py'], {
        ddev: false,
        ddevPlaywrightAddon: false,
      }),
    ).toEqual({ kind: 'host', args: ['pytest', 'tests/test_x.py'], cwd: '' });
    expect(
      buildSelectiveCommand('vitest', files, { ddev: false, ddevPlaywrightAddon: false }),
    ).toEqual({ kind: 'host', args: ['npx', 'vitest', 'run', 'tests/a.spec.ts'], cwd: '' });
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

  // The bug this scoping exists for. Config and node_modules under test-playwright/, nothing at
  // the repo root: measured on a live runner, the un-scoped command lists 0 tests and exits 1
  // while this one lists 48 and exits 0.
  it('runs from the framework project root with root-relative paths (ddev)', () => {
    expect(
      buildSelectiveCommand('playwright', ['test-playwright/tests/a.spec.ts'], {
        ddev: true,
        ddevPlaywrightAddon: false,
        root: 'test-playwright',
      }),
    ).toEqual({
      kind: 'ddev',
      // Absolute --dir: a relative one exits 128.
      args: [
        'exec',
        '-d',
        '/var/www/html/test-playwright',
        'npx',
        'playwright',
        'test',
        'tests/a.spec.ts',
      ],
      cwd: 'test-playwright',
    });
  });

  it('carries the root as a cwd on the host path instead of a --dir', () => {
    expect(
      buildSelectiveCommand('vitest', ['packages/web/src/a.test.ts'], {
        ddev: false,
        ddevPlaywrightAddon: false,
        root: 'packages/web',
      }),
    ).toEqual({
      kind: 'host',
      args: ['npx', 'vitest', 'run', 'src/a.test.ts'],
      cwd: 'packages/web',
    });
  });

  // A detect payload written before frameworkRoots existed replays with root undefined and must
  // build exactly the command it originally built — no --dir, workspace-relative paths.
  it('is byte-identical to the pre-root command when the root is absent or empty', () => {
    const legacy = buildSelectiveCommand('playwright', files, {
      ddev: true,
      ddevPlaywrightAddon: false,
    });
    expect(
      buildSelectiveCommand('playwright', files, {
        ddev: true,
        ddevPlaywrightAddon: false,
        root: '',
      }),
    ).toEqual(legacy);
    expect(legacy!.args).toEqual(['exec', 'npx', 'playwright', 'test', 'tests/a.spec.ts']);
  });

  it('refuses to run when no config file was found for the framework', () => {
    expect(
      buildSelectiveCommand('playwright', files, {
        ddev: true,
        ddevPlaywrightAddon: false,
        root: null,
      }),
    ).toBeNull();
  });

  // The addon owns its own working directory, so it keeps the workspace-relative paths it has
  // always been handed — a null root must not take that path away from it either.
  it('leaves the ddev playwright addon path untouched by the root', () => {
    expect(
      buildSelectiveCommand('playwright', files, {
        ddev: true,
        ddevPlaywrightAddon: true,
        root: null,
      }),
    ).toEqual({ kind: 'ddev', args: ['playwright', 'test', 'tests/a.spec.ts'], cwd: '' });
  });

  it('drops files outside the project root, and refuses when none is left', () => {
    expect(
      buildSelectiveCommand('playwright', ['test-playwright/tests/a.spec.ts', 'other/b.spec.ts'], {
        ddev: false,
        ddevPlaywrightAddon: false,
        root: 'test-playwright',
      })!.args,
    ).toEqual(['npx', 'playwright', 'test', 'tests/a.spec.ts']);
    expect(
      buildSelectiveCommand('playwright', ['other/b.spec.ts'], {
        ddev: false,
        ddevPlaywrightAddon: false,
        root: 'test-playwright',
      }),
    ).toBeNull();
  });
});

describe('scopeToRoot', () => {
  it('passes files through untouched at the workspace root', () => {
    expect(scopeToRoot(['tests/a.spec.ts'], '')).toEqual(['tests/a.spec.ts']);
  });

  // A `../` path is the "Total: 0 tests in 0 files" failure this exists to prevent, so it is
  // dropped rather than handed to a runner that will reject it and exit non-zero with nothing run.
  it('drops anything that escapes the root, including the root itself', () => {
    expect(scopeToRoot(['sub/a.spec.ts', 'b.spec.ts', '../c.spec.ts', 'sub'], 'sub')).toEqual([
      'a.spec.ts',
    ]);
  });
});

describe('scanTestInfra', () => {
  const made: string[] = [];
  const tree = async (files: Record<string, string>): Promise<string> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'haive-08b-'));
    made.push(dir);
    for (const [rel, body] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), body);
    }
    return dir;
  };
  afterAll(async () => {
    await Promise.all(made.map((d) => rm(d, { recursive: true, force: true })));
  });

  // The layout that produced the bug: a Drupal root with the whole playwright project one level
  // down. Detection fired off the directory alone and the root was never resolved, so the runner
  // was invoked where neither the config nor node_modules lives.
  it('roots a framework at the subdirectory holding its config', async () => {
    const dir = await tree({
      'test-playwright/playwright.config.ts': '',
      'test-playwright/tests/a.spec.ts': '',
      'index.php': '',
    });
    const infra = await scanTestInfra(dir);
    expect(infra.frameworks).toEqual(['playwright']);
    expect(infra.roots).toEqual({ playwright: 'test-playwright' });
  });

  it('roots a framework at the workspace when its config is there', async () => {
    const dir = await tree({ 'playwright.config.ts': '', 'vitest.config.ts': '' });
    const infra = await scanTestInfra(dir);
    expect(infra.roots).toEqual({ playwright: '', vitest: '' });
  });

  // Detection is deliberately unchanged — the marker directory still detects playwright on its
  // own — but with no config anywhere the root is null and apply declines to claim a run.
  it('reports a null root when the marker directory carries no config', async () => {
    const dir = await tree({ 'test-playwright/tests/a.spec.ts': '' });
    const infra = await scanTestInfra(dir);
    expect(infra.frameworks).toEqual(['playwright']);
    expect(infra.roots).toEqual({ playwright: null });
  });

  it('does not root a framework inside installed dependencies', async () => {
    const dir = await tree({
      cypress: '',
      'node_modules/some-dep/cypress.config.js': '',
      'vendor/other/phpunit.xml': '',
    });
    const infra = await scanTestInfra(dir);
    expect(infra.roots.cypress).toBeNull();
    expect(infra.frameworks).not.toContain('phpunit');
  });

  // The script pseudo-frameworks are the repo's own manifests, rooted at the workspace by
  // construction — never searched for.
  it('roots the script pseudo-frameworks at the workspace', async () => {
    const dir = await tree({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }),
    });
    const infra = await scanTestInfra(dir);
    expect(infra.roots).toEqual({ 'pkg-script': '', 'composer-script': '' });
  });
});

describe('primaryFrameworkRoot', () => {
  it('reads the primary framework root', () => {
    expect(
      primaryFrameworkRoot({
        primary: 'playwright',
        frameworkRoots: { playwright: 'test-playwright', vitest: '' },
      }),
    ).toBe('test-playwright');
  });

  it('distinguishes "no config found" (null) from "at the workspace root" ("")', () => {
    expect(
      primaryFrameworkRoot({ primary: 'playwright', frameworkRoots: { playwright: null } }),
    ).toBeNull();
    expect(
      primaryFrameworkRoot({ primary: 'playwright', frameworkRoots: { playwright: '' } }),
    ).toBe('');
  });

  // detect_output is persisted and replayed. A payload from before the field existed means the
  // workspace root, which is the command it originally built — NOT "no config found".
  it('replays a pre-field payload as the workspace root', () => {
    expect(primaryFrameworkRoot({ primary: 'playwright' })).toBe('');
    expect(primaryFrameworkRoot({ primary: 'playwright', frameworkRoots: {} })).toBe('');
  });

  it('has no root without a primary framework', () => {
    expect(primaryFrameworkRoot({ primary: null, frameworkRoots: {} })).toBeNull();
  });
});

describe('buildCollectCommand', () => {
  const files = ['test-playwright/tests/a.spec.ts'];

  it('splices --list after the playwright subcommand, keeping the root scoping', () => {
    expect(
      buildCollectCommand('playwright', files, {
        ddev: true,
        ddevPlaywrightAddon: false,
        root: 'test-playwright',
      }),
    ).toEqual({
      kind: 'ddev',
      args: [
        'exec',
        '-d',
        '/var/www/html/test-playwright',
        'npx',
        'playwright',
        'test',
        '--list',
        'tests/a.spec.ts',
      ],
      cwd: 'test-playwright',
    });
  });

  // Playwright only: its --list exit code was measured against a live runner. Every other
  // framework keeps the previous behaviour verbatim until its list mode is measured too, and the
  // addon's flag pass-through is unmeasured.
  it('offers nothing for unmeasured frameworks or the addon', () => {
    for (const framework of ['vitest', 'jest', 'phpunit', 'pytest', 'cypress'] as const) {
      expect(
        buildCollectCommand(framework, ['tests/a.spec.ts'], {
          ddev: false,
          ddevPlaywrightAddon: false,
        }),
      ).toBeNull();
    }
    expect(
      buildCollectCommand('playwright', files, { ddev: true, ddevPlaywrightAddon: true }),
    ).toBeNull();
  });

  it('offers nothing when the selective run itself is impossible', () => {
    expect(
      buildCollectCommand('playwright', files, {
        ddev: true,
        ddevPlaywrightAddon: false,
        root: null,
      }),
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
      // The runner could enumerate none of the tests, so nothing ran and there is no failing
      // assertion for an implementer to act on. This is the shape that used to arrive as
      // testsPassed:false and buy 5 fix passes plus a whole round back through implementation.
      mkApply({
        testsUpdated: ['test-playwright/tests/a.spec.ts'],
        testRun: {
          ran: false,
          passed: false,
          command: 'ddev exec npx playwright test test-playwright/tests/a.spec.ts',
          output: 'Total: 0 tests in 0 files',
        },
        degradedNote: 'The playwright runner could not enumerate any of the tests…',
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

// Verbatim fragments of the three failure outputs task 681f0f99 actually stored. Rounds 1-2
// are a LOAD failure (the enumerate guard's class); round 3 is the environment failure that
// guard cannot see, because `--list` skips globalSetup and exited 0 on the same container.
const ROUND12_LOAD_FAILURE = [
  'Error: Playwright Test did not expect test.describe() to be called here.',
  'Most common reasons include:',
  '- You are calling test.describe() in a configuration file.',
  'Error: No tests found.',
].join('\n');

const ROUND3_BROWSER_MISSING = [
  '[global-setup] Running global setup',
  "Error: browserType.launch: Executable doesn't exist at /home/ddev/.cache/ms-playwright/chromium_headless_shell-1181/chrome-linux/headless_shell",
  '║ Looks like Playwright Test or Playwright was just installed or updated. ║',
  '    at performCleanup (/var/www/html/test-playwright/global-teardown.ts:352:34)',
].join('\n');

describe('classifyTestEnvFailure', () => {
  it('names the environment failure the enumerate guard cannot see', () => {
    const b = classifyTestEnvFailure('playwright', ROUND3_BROWSER_MISSING);
    expect(b).not.toBeNull();
    expect(b!.reason).toContain('browser binaries are not installed');
    expect(b!.repair).toBe('npx playwright install --with-deps');
  });

  it('classifies a missing shared library as its own blocker', () => {
    const b = classifyTestEnvFailure(
      'playwright',
      'Host system is missing dependencies to run browsers.',
    );
    expect(b!.repair).toBe('npx playwright install-deps');
  });

  it('reports the missing binary when both errors appear, since --with-deps covers both', () => {
    const b = classifyTestEnvFailure(
      'playwright',
      `${ROUND3_BROWSER_MISSING}\nHost system is missing dependencies to run browsers.`,
    );
    expect(b!.repair).toBe('npx playwright install --with-deps');
  });

  it('leaves a load failure to the enumerate guard', () => {
    expect(classifyTestEnvFailure('playwright', ROUND12_LOAD_FAILURE)).toBeNull();
  });

  it('claims nothing for a framework whose output has not been measured', () => {
    expect(classifyTestEnvFailure('vitest', ROUND3_BROWSER_MISSING)).toBeNull();
    expect(classifyTestEnvFailure(null, ROUND3_BROWSER_MISSING)).toBeNull();
  });
});

describe('repairInvocation', () => {
  const d = (over: Record<string, unknown>) =>
    ({
      ddev: true,
      primary: 'playwright',
      frameworkRoots: { playwright: 'test-playwright' },
      ...over,
    }) as never;

  it('reuses the failing run’s own ddev invocation shape', () => {
    expect(repairInvocation(d({}), 'npx playwright install --with-deps')).toBe(
      'ddev exec -d /var/www/html/test-playwright npx playwright install --with-deps',
    );
  });

  it('carries the root as a cd on the host path', () => {
    expect(repairInvocation(d({ ddev: false }), 'npx playwright install')).toBe(
      'cd test-playwright && npx playwright install',
    );
  });

  it('drops the root when the framework is rooted at the workspace', () => {
    const at_root = d({ ddev: false, frameworkRoots: { playwright: '' } });
    expect(repairInvocation(at_root, 'npx playwright install')).toBe('npx playwright install');
  });
});

describe('priorPassNotes', () => {
  const pass = (notes: string) => ({ applyOutput: { notes } }) as never;

  it('carries what earlier passes concluded, numbered by pass', () => {
    const block = priorPassNotes([pass('browser binaries missing'), pass('config root is wrong')]);
    expect(block).toContain('- pass 0: browser binaries missing');
    expect(block).toContain('- pass 1: config root is wrong');
  });

  it('collapses a verbatim repeat, ignoring case and the paths and numbers in it', () => {
    const block = priorPassNotes([
      pass('Browser missing at /home/ddev/.cache/ms-playwright/chromium-1181'),
      pass('browser missing at /root/.cache/ms-playwright/chromium-1204'),
    ]);
    expect(block.match(/- pass /g)).toHaveLength(1);
  });

  // The honest limit: contentFingerprint hashes the prose, so two passes that describe one
  // finding in different sentences are two entries. That is the same effect review_findings
  // measured (0.05% fingerprint match across rounds); the block cap is what bounds it.
  it('does not collapse two rewordings of one finding', () => {
    const block = priorPassNotes([
      pass('The Playwright browser binaries are not installed.'),
      pass('Playwright has no browser binaries in this container.'),
    ]);
    expect(block.match(/- pass /g)).toHaveLength(2);
  });

  it('is empty on the tester’s own pass and when no pass said anything', () => {
    expect(priorPassNotes([])).toBe('');
    expect(priorPassNotes([pass(''), pass('   ')])).toBe('');
  });

  it('caps the block so it cannot crowd out the failure output', () => {
    const many = Array.from({ length: 40 }, (_, i) => pass(`finding ${i} `.repeat(60)));
    expect(priorPassNotes(many).length).toBeLessThanOrEqual(4000);
  });
});
