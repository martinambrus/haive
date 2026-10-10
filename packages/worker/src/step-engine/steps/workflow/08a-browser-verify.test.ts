import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

const m = vi.hoisted(() => ({
  resolveBrowserRuntime: vi.fn(),
  loadPreviousStepOutput: vi.fn(),
  resolveTaskDirectAccess: vi.fn(),
  isStepGuidanceEnabled: vi.fn(),
  resolveSpecView: vi.fn(),
  collectImplementationFiles: vi.fn(),
  loadPlanImpactContext: vi.fn(),
  ensureAppServing: vi.fn(),
  recordLedgerEntry: vi.fn(),
  resolveScreenshotRoot: vi.fn(),
  buildScreenshotManifest: vi.fn(),
  getTaskEnvTemplate: vi.fn(),
  resolveDdevWorkspace: vi.fn(),
  loadAppBootOutput: vi.fn(),
  runnerExec: vi.fn(),
}));

vi.mock('./_browser-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_browser-runtime.js')>()),
  resolveBrowserRuntime: m.resolveBrowserRuntime,
}));
vi.mock('../onboarding/_helpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../onboarding/_helpers.js')>()),
  loadPreviousStepOutput: m.loadPreviousStepOutput,
}));
vi.mock('../../../sandbox/_browser-access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/_browser-access.js')>()),
  resolveTaskDirectAccess: m.resolveTaskDirectAccess,
}));
vi.mock('../../guidance-context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../guidance-context.js')>()),
  isStepGuidanceEnabled: m.isStepGuidanceEnabled,
}));
vi.mock('./_spec-artifact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_spec-artifact.js')>()),
  resolveSpecView: m.resolveSpecView,
}));
vi.mock('./_impl-changes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_impl-changes.js')>()),
  collectImplementationFiles: m.collectImplementationFiles,
}));
vi.mock('./_plan-impact.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_plan-impact.js')>()),
  loadPlanImpactContext: m.loadPlanImpactContext,
}));
vi.mock('./_app-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_app-runtime.js')>()),
  ensureAppServing: m.ensureAppServing,
}));
vi.mock('../../../sandbox/ddev-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../sandbox/ddev-runner.js')>()),
  runnerExec: m.runnerExec,
}));
vi.mock('../../task-ledger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-ledger.js')>()),
  recordLedgerEntry: m.recordLedgerEntry,
}));
vi.mock('./_screenshots.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_screenshots.js')>()),
  resolveScreenshotRoot: m.resolveScreenshotRoot,
  buildScreenshotManifest: m.buildScreenshotManifest,
}));

vi.mock('../env-replicate/_shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env-replicate/_shared.js')>()),
  getTaskEnvTemplate: m.getTaskEnvTemplate,
}));
vi.mock('./_task-meta.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_task-meta.js')>()),
  resolveDdevWorkspace: m.resolveDdevWorkspace,
  loadAppBootOutput: m.loadAppBootOutput,
}));

import { TaskCancelledError } from '../../step-definition.js';
import {
  appHealthFailures,
  browserVerifyStep,
  parseBrowserTestOutput,
  parseFixerOutput,
} from './08a-browser-verify.js';

describe('parseBrowserTestOutput', () => {
  it('parses a fenced tester verdict', () => {
    const raw =
      'tested\n```json\n{"passed":false,"failures":[{"description":"button invisible","evidence":"a.tsx:10"}],"visual_verdict":"UNSTYLED","notes":"x"}\n```';
    const p = parseBrowserTestOutput(raw);
    expect(p).not.toBeNull();
    expect(p!.passed).toBe(false);
    expect(p!.failures).toHaveLength(1);
    expect(p!.failures[0]!.evidence).toBe('a.tsx:10');
    expect(p!.visualVerdict).toBe('UNSTYLED');
  });

  it('accepts an already-parsed object (bypass stub shape)', () => {
    const p = parseBrowserTestOutput({
      passed: true,
      failures: [],
      visual_verdict: 'SKIPPED',
      notes: 'bypass stub',
    });
    expect(p).not.toBeNull();
    expect(p!.passed).toBe(true);
    expect(p!.visualVerdict).toBe('SKIPPED');
  });

  it('defaults failures/notes when omitted', () => {
    const p = parseBrowserTestOutput('```json\n{"passed":true}\n```');
    expect(p!.failures).toEqual([]);
    expect(p!.visualVerdict).toBeNull();
  });

  it('returns null on garbled output or a missing verdict (treated as fail by caller)', () => {
    expect(parseBrowserTestOutput('no json here')).toBeNull();
    expect(parseBrowserTestOutput('```json\n{"failures":[]}\n```')).toBeNull(); // no passed
    expect(parseBrowserTestOutput(null)).toBeNull();
  });
});

describe('parseFixerOutput', () => {
  it('parses a fenced fixer report', () => {
    const p = parseFixerOutput('```json\n{"fixes_made":["added aria-label"],"notes":"ok"}\n```');
    expect(p.fixesMade).toEqual(['added aria-label']);
    expect(p.notes).toBe('ok');
  });

  it('falls back to no-fixes on garbled output', () => {
    expect(parseFixerOutput('nope')).toEqual({ fixesMade: [], screenshots: [], notes: '' });
  });

  it('carries the screenshot captions the fixer reported', () => {
    const p = parseFixerOutput(
      '```json\n{"fixes_made":["fixed contrast"],"screenshots":[{"file":"01-fix-button.webp","caption":"Button after contrast fix","test_case":"T2","result":"pass"}],"notes":""}\n```',
    );
    expect(p.screenshots).toEqual([
      {
        file: '01-fix-button.webp',
        caption: 'Button after contrast fix',
        testCase: 'T2',
        result: 'pass',
      },
    ]);
  });
});

describe('browserVerifyStep.fixLoopOnError', () => {
  const route = (msg: string) => (browserVerifyStep.fixLoopOnError as (m: string) => boolean)(msg);

  it('routes an agent-authored .ddev defect back to implementation', () => {
    // The mcp `prepare` hook does not catch, so this is the difference between a fix
    // round and a dead task — reporting untested work as verified is the alternative.
    expect(
      route(
        'DDEV cannot start: DDEV config is not valid YAML: .ddev/config.yaml cannot be ' +
          'parsed — Nested mappings are not allowed in compact mappings at line 14, column 13.',
      ),
    ).toBe(true);
  });

  it('leaves a reaped runner on the hard-fail path', () => {
    expect(route('ddev restart failed: Error response from daemon: No such container')).toBe(false);
  });
});

describe('appHealthFailures', () => {
  const probe = (over: Record<string, unknown> = {}) =>
    ({
      pageTitle: 'Home',
      httpStatus: 200,
      consoleErrors: [],
      consoleWarnings: [],
      networkErrors: [],
      passed: true,
      ...over,
    }) as never;
  const URL = 'https://app.ddev.site/';
  const FATAL =
    '[23-Aug-2026 18:23:35] WARNING: [pool www] child 1793 said into stderr: "[23-Aug-2026 ' +
    '18:23:35 Etc/UTC] PHP Fatal error:  Allowed memory size of 1073741824 bytes exhausted ' +
    '(tried to allocate 77 bytes) in /var/www/html/error.php on line 54"';

  it('fails a 4xx at the app root and names the status', () => {
    // The measured case: three automated rounds called a 403 root a pre-install state and
    // passed, and the developer met it at the gate.
    const out = appHealthFailures(probe({ httpStatus: 403 }), '', URL);
    expect(out).toHaveLength(1);
    expect(out[0]!.description).toContain('403');
    expect(out[0]!.evidence).toContain('403');
  });

  it('fails a 5xx too', () => {
    expect(appHealthFailures(probe({ httpStatus: 503 }), '', URL)).toHaveLength(1);
  });

  it('fails a fatal in the log even when the page returned 200', () => {
    // The whole reason the log is read rather than the status: a PHP fatal renders inside a 200.
    const out = appHealthFailures(probe({ httpStatus: 200 }), FATAL, URL);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toContain('Allowed memory size');
  });

  it('reports both when the root is dead AND the log has a fatal', () => {
    expect(appHealthFailures(probe({ httpStatus: 500 }), FATAL, URL)).toHaveLength(2);
  });

  it('passes a healthy page with a clean log', () => {
    expect(appHealthFailures(probe(), 'GET / HTTP/1.1 200\nnothing wrong here', URL)).toEqual([]);
  });

  it('judges nothing when there is no probe', () => {
    // "Could not measure" is not "measured clean" — but it must not invent a failure either;
    // an app the probe cannot reach is already caught by the tester, which cannot test it.
    expect(appHealthFailures(null, '', URL)).toEqual([]);
  });

  it('does not fail on an empty log tail', () => {
    // ddevContainerFailureLogs returns '' on ANY failure, and app-runner mode passes '' by
    // design. Neither may read as a fatal.
    expect(appHealthFailures(probe(), '', URL)).toEqual([]);
  });

  it('does not fire on prose that merely mentions a fatal error', () => {
    // A CMS page or a changelog can legitimately contain the words; the pattern needs PHP's
    // own shape. This is why the check reads the error channel and not page text.
    const prose = 'INFO: docs/errors.md describes what to do about a fatal error in production';
    expect(appHealthFailures(probe(), prose, URL)).toEqual([]);
  });
});

describe('appHealthFailures: an error page at HTTP 200', () => {
  const URL = 'https://app.ddev.site/';
  const probe = (over: Record<string, unknown> = {}) =>
    ({
      pageTitle: 'Home',
      httpStatus: 200,
      consoleErrors: [],
      consoleWarnings: [],
      networkErrors: [],
      passed: true,
      ...over,
    }) as never;

  // Verbatim from the run that motivated this. HTTP 200, 1558 bytes, no PHP fatal in the log.
  const MEASURED_TITLE = 'An Error Has Occured';
  const MEASURED_BODY =
    'An Error Has Occured There has been a problem found while trying to connect to a database. ' +
    'Error location: File = /var/www/html/database.php Line = 235 Function = Db->Select ' +
    "Extra Message = Table 'db.rs_modules' doesn't exist File Sequence " +
    '/var/www/html/index.php (line 155) /var/www/html/init.php (line 582) ' +
    '/var/www/html/mods.php (line 97) /var/www/html/mods/class_counter.php (line 60)';

  it('fires on the title the app gave itself', () => {
    const out = appHealthFailures(probe({ pageTitle: MEASURED_TITLE }), '', URL);
    expect(out).toHaveLength(1);
    expect(out[0]!.description).toContain('ERROR PAGE');
    // The status is named so nobody re-derives "but it returned 200".
    expect(out[0]!.description).toContain('200');
  });

  it('fires on the rendered trace even when the title says nothing', () => {
    // Language-independent half: a localised app would not match the title vocabulary.
    const out = appHealthFailures(
      probe({ pageTitle: 'Vitajte', bodyText: MEASURED_BODY }),
      '',
      URL,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.description).toContain('stack trace');
  });

  it('reports ONE failure when both triggers fire', () => {
    // The developer has one problem, not two.
    const out = appHealthFailures(
      probe({ pageTitle: MEASURED_TITLE, bodyText: MEASURED_BODY }),
      '',
      URL,
    );
    expect(out).toHaveLength(1);
  });

  it('still fires on the title when the runner reports no bodyText', () => {
    // The DDEV image bakes the probe script, so an existing runner keeps sending the old shape
    // until it is rebuilt. Absence must disable the trace trigger and nothing else.
    const out = appHealthFailures(probe({ pageTitle: MEASURED_TITLE }), '', URL);
    expect(out).toHaveLength(1);
  });

  it('passes a healthy page', () => {
    expect(
      appHealthFailures(probe({ bodyText: 'Welcome to the site. Latest news.' }), '', URL),
    ).toEqual([]);
  });

  it('does not fire on a single incidental line reference', () => {
    // One "(line 12)" is something a page may legitimately say; a SEQUENCE is not.
    const body = 'See the config example at settings.php (line 12) for details.';
    expect(appHealthFailures(probe({ bodyText: body }), '', URL)).toEqual([]);
  });

  it('carries the page text as evidence so the fixer sees what the error said', () => {
    const out = appHealthFailures(
      probe({ pageTitle: MEASURED_TITLE, bodyText: MEASURED_BODY }),
      '',
      URL,
    );
    expect(out[0]!.evidence).toContain("Table 'db.rs_modules' doesn't exist");
  });

  it('adds to the other health failures rather than replacing them', () => {
    // Additive by construction: no path through this can clear a failure already raised.
    const out = appHealthFailures(
      probe({ httpStatus: 500, pageTitle: MEASURED_TITLE }),
      'PHP Fatal error: boom in /x.php on line 1',
      URL,
    );
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
});

const rejection = (run: () => Promise<unknown>) =>
  run().then(
    () => null,
    (e: unknown) => e,
  );

// detect's live browser bring-up is best-effort, but a Stop is no failure to degrade around: the step
// runner tells it apart only by `instanceof TaskCancelledError`.
describe('08a live browser bring-up in detect', () => {
  const warn = vi.fn();
  const ctx = {
    taskId: 'task-1',
    workspacePath: '/repos/u/r',
    db: {},
    emitProgress: vi.fn(async () => {}),
    logger: { info: vi.fn(), warn },
  } as never;
  const detect = () => browserVerifyStep.detect!(ctx);

  beforeEach(() => {
    m.resolveBrowserRuntime.mockReset().mockResolvedValue({
      browserTesting: true,
      available: true,
      skipReason: null,
      ddevMode: true,
      appRunnerMode: false,
      appUrl: 'https://app.ddev.site',
      appBooted: true,
      envImageTag: null,
      repoSubpath: 'u/r',
      workspace: '/repos/u/r',
    });
    m.loadPreviousStepOutput.mockReset().mockResolvedValue(null);
    m.resolveTaskDirectAccess.mockReset().mockResolvedValue(false);
    m.isStepGuidanceEnabled.mockReset().mockResolvedValue(false);
    m.resolveSpecView
      .mockReset()
      .mockResolvedValue({ text: 'the spec', spec: 'the spec', condensed: false });
    m.collectImplementationFiles
      .mockReset()
      .mockResolvedValue({ files: [], total: 0, truncated: false });
    m.loadPlanImpactContext.mockReset().mockResolvedValue(null);
    m.ensureAppServing.mockReset();
    warn.mockClear();
  });

  it('lets a cancel from the app ensure out as that same cancel, whatever its message', async () => {
    const cancel = new TaskCancelledError('stopped from the task page');
    m.ensureAppServing.mockRejectedValueOnce(cancel);

    const err = await rejection(detect);

    expect(m.ensureAppServing, 'the bring-up never reached the app ensure').toHaveBeenCalledTimes(
      1,
    );
    expect(err, 'the cancel was swallowed into liveBrowser.reason').not.toBeNull();
    expect(err, 'the cancel was replaced by another error').toBe(cancel);
  });

  it('still turns an ordinary error that only says the task was cancelled into liveBrowser.reason', async () => {
    const boom = new Error('task cancelled');
    m.ensureAppServing.mockRejectedValueOnce(boom);

    const detected = await detect();

    expect(m.ensureAppServing).toHaveBeenCalledTimes(1);
    expect(detected.liveBrowser).toEqual({
      available: false,
      appUrl: 'https://app.ddev.site',
      probe: null,
      reason: 'task cancelled',
    });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: boom }), expect.any(String));
  });
});

// The health probe after a tester pass is best-effort, but a Stop is no probe failure: the step runner
// tells it apart only by `instanceof TaskCancelledError`.
describe('08a app-health probe after a tester pass', () => {
  const warn = vi.fn();
  const ctx = {
    taskId: 'task-1',
    taskStepId: 'step-1',
    round: 0,
    repoPath: '/repos/u/r',
    workspacePath: '/repos/u/r',
    db: {},
    logger: { info: vi.fn(), warn },
  } as never;
  const TESTER_PASS =
    '```json\n' +
    JSON.stringify({ passed: true, failures: [], visual_verdict: 'SKIPPED', notes: '' }) +
    '\n```';
  const apply = () =>
    browserVerifyStep.apply(ctx, {
      detected: { available: true, mode: 'mcp', appUrl: 'https://app.ddev.site' },
      formValues: {},
      iteration: 0,
      previousIterations: [],
      llmOutput: TESTER_PASS,
    } as never);

  beforeEach(() => {
    m.ensureAppServing.mockReset();
    m.recordLedgerEntry.mockReset().mockResolvedValue(undefined);
    m.resolveScreenshotRoot.mockReset().mockResolvedValue('/repos/u/r');
    m.buildScreenshotManifest
      .mockReset()
      .mockResolvedValue({ artifactPath: '/repos/u/r/.haive/screenshots.json', count: 1 });
    warn.mockClear();
  });

  it('lets a cancel from the app ensure out as that same cancel, whatever its message', async () => {
    const cancel = new TaskCancelledError('stopped from the task page');
    m.ensureAppServing.mockRejectedValueOnce(cancel);

    const err = await rejection(apply);

    expect(
      m.ensureAppServing,
      'the health probe never reached the app ensure',
    ).toHaveBeenCalledTimes(1);
    expect(err, 'the cancel was swallowed as a health probe that could not run').not.toBeNull();
    expect(err, 'the cancel was replaced by another error').toBe(cancel);
  });

  it('still leaves the tester verdict alone when an ordinary error only says the task was cancelled', async () => {
    const boom = new Error('task cancelled');
    m.ensureAppServing.mockRejectedValueOnce(boom);

    const out = await apply();

    expect(m.ensureAppServing).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ method: 'mcp', source: 'tester', passed: true, failures: [] });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: boom }), expect.any(String));
  });
});

// A row an older install parked in a mode `shouldRun` now refuses resumes at apply without being
// asked again; gate 2 verifies it hands-on, so it is skipped rather than probed into a pass.
describe('08a rows parked by older code in a non-mcp mode', () => {
  const ctx = {
    taskId: 'task-1',
    taskStepId: 'step-1',
    round: 0,
    repoPath: '/repos/u/r',
    workspacePath: '/repos/u/r',
    db: {},
    emitProgress: vi.fn(async () => {}),
    logger: { info: vi.fn(), warn: vi.fn() },
  } as never;
  const CLEAN_PROBE = JSON.stringify({
    pageTitle: 'Home',
    httpStatus: 200,
    consoleErrors: [],
    consoleWarnings: [],
    networkErrors: [],
    passed: true,
  });

  beforeEach(() => {
    m.ensureAppServing
      .mockReset()
      .mockResolvedValue({ mode: 'ddev', handle: {}, url: 'https://app.ddev.site' });
    m.runnerExec.mockReset().mockResolvedValue({ output: CLEAN_PROBE });
  });

  it.each(['interactive', 'headless', 'manual'])(
    'skips a %s row instead of probing it into a pass',
    async (mode) => {
      const out = await browserVerifyStep.apply(ctx, {
        detected: { available: true, mode, appUrl: 'https://app.ddev.site' },
        formValues: { decision: 'reject', feedback: 'the logout button does nothing' },
        iteration: 0,
        previousIterations: [],
        llmOutput: null,
      } as never);

      expect(out).toMatchObject({ skipped: true, ran: false, passed: false });
      expect(m.ensureAppServing).not.toHaveBeenCalled();
      expect(m.runnerExec).not.toHaveBeenCalled();
      expect(browserVerifyStep.fixLoop!.evaluate(out as never)).toBeNull();
    },
  );
});

describe('browserVerifyStep.shouldRun', () => {
  const ctx = { taskId: 'task-1', repoPath: '/repos/u/r', db: {} } as never;

  beforeEach(() => {
    m.getTaskEnvTemplate
      .mockReset()
      .mockResolvedValue({ status: 'ready', declaredDeps: { browserTesting: true } });
    m.resolveDdevWorkspace.mockReset().mockResolvedValue(null);
    m.loadAppBootOutput.mockReset().mockResolvedValue({ booted: true, skipped: false });
  });

  it.each([
    ['mcp', true],
    ['headless', false],
    ['interactive', false],
    ['direct', false],
    ['manual', false],
    ['skip', false],
  ])('for a setup row with mode %s returns %s', async (mode, expected) => {
    m.loadPreviousStepOutput.mockReset().mockResolvedValue({ output: { mode } });
    expect(await browserVerifyStep.shouldRun!(ctx)).toBe(expected);
  });

  it('treats a missing setup row as mcp', async () => {
    m.loadPreviousStepOutput.mockReset().mockResolvedValue(null);
    expect(await browserVerifyStep.shouldRun!(ctx)).toBe(true);
  });
});

describe('08a fixer prompt', () => {
  const ROOT_CAUSE = [
    'Before you edit anything, state the root cause of what is reported below (why it happens,',
    'not only where it shows), then fix that cause.',
  ].join('\n');
  const testerRecord = {
    iteration: 0,
    llmOutput: '',
    continueRequested: true,
    applyOutput: {
      source: 'tester',
      failures: [{ description: 'The admin page is blank.', evidence: '03-admin.png' }],
      fixesApplied: [],
      screenshots: [],
    },
  };
  const fixerPrompt = (previousIterations: unknown[]) =>
    browserVerifyStep.loop!.buildIterationPrompt!({
      detected: { spec: 'the spec', appUrl: 'http://app.test' } as never,
      formValues: {},
      iteration: 1,
      previousIterations: previousIterations as never,
    });

  it.each([
    ['with a failure list', [testerRecord], 'Failures to fix'],
    ['without one', [], '(the tester reported a failure without a list'],
  ])('asks for the root cause once, above the failures: %s', (_name, previous, failureBlock) => {
    const p = fixerPrompt(previous);
    expect(p.split(ROOT_CAUSE)).toHaveLength(2);
    expect(p.indexOf(failureBlock)).toBeGreaterThan(-1);
    expect(p.indexOf(ROOT_CAUSE)).toBeLessThan(p.indexOf(failureBlock));
  });

  it('keeps the root-cause request out of the tester re-pass', () => {
    const p = browserVerifyStep.loop!.buildIterationPrompt!({
      detected: { spec: 'the spec', appUrl: 'http://app.test' } as never,
      formValues: {},
      iteration: 2,
      previousIterations: [testerRecord] as never,
    });
    expect(p).not.toContain('state the root cause');
  });
});

// A fix pass can add to the change detect listed, so the re-tester is given the change it left.
describe('08a re-test after a fix pass', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

  /** A task branch on which the agent edited a.js and b.js, the two files 07 reported. */
  async function checkout(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'haive-browser-retest-'));
    dirs.push(dir);
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@test.local');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'config', 'gc.auto', '0');
    await writeFile(path.join(dir, 'a.js'), 'a\n');
    await writeFile(path.join(dir, 'b.js'), 'b\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    git(dir, 'checkout', '-q', '-b', 'task');
    await writeFile(path.join(dir, 'a.js'), 'a changed\n');
    await writeFile(path.join(dir, 'b.js'), 'b changed\n');
    return dir;
  }

  const FIXER_REPLY = '```json\n{"fixes_made":["added the icon"],"notes":""}\n```';
  const record = (iteration: number, applyOutput: unknown) => ({
    iteration,
    llmOutput: '',
    continueRequested: true,
    applyOutput,
  });
  const testerOut = {
    source: 'tester',
    failures: [{ description: 'The icon is missing.' }],
    fixesApplied: [],
    screenshots: [],
  };
  const firstPrompt = (detected: unknown) =>
    browserVerifyStep.llm!.buildPrompt({ detected, formValues: {} } as never);
  const retestPrompt = (detected: unknown, previousIterations: unknown[]) =>
    browserVerifyStep.loop!.buildIterationPrompt!({
      detected: detected as never,
      formValues: {},
      iteration: previousIterations.length,
      previousIterations: previousIterations as never,
    });

  beforeEach(async () => {
    const real = await vi.importActual<typeof import('./_impl-changes.js')>('./_impl-changes.js');
    m.collectImplementationFiles.mockReset().mockImplementation(real.collectImplementationFiles);
    m.loadPreviousStepOutput
      .mockReset()
      .mockImplementation(async (_db: unknown, _taskId: string, stepId: string) => {
        if (stepId === '08a-browser-setup') return { output: { mode: 'mcp' } };
        if (stepId === '07-phase-2-implement') {
          return { output: { filesTouched: ['a.js', 'b.js'] } };
        }
        if (stepId === '01-worktree-setup') return { output: { baseBranch: 'main' } };
        return null;
      });
    m.resolveBrowserRuntime.mockReset();
    m.resolveTaskDirectAccess.mockReset().mockResolvedValue(false);
    m.isStepGuidanceEnabled.mockReset().mockResolvedValue(false);
    m.resolveSpecView
      .mockReset()
      .mockResolvedValue({ text: 'the spec', spec: 'the spec', condensed: false });
    m.loadPlanImpactContext.mockReset().mockResolvedValue(null);
    m.ensureAppServing.mockReset().mockResolvedValue({ mode: 'none', url: null });
    m.recordLedgerEntry.mockReset().mockResolvedValue(undefined);
    m.resolveScreenshotRoot.mockReset().mockResolvedValue('/repos/u/r');
    m.buildScreenshotManifest.mockReset().mockResolvedValue({ artifactPath: null, count: 0 });
  });

  /** detect over that branch, from the DDEV workspace or, for an app on the host, the step's own. */
  async function detectOn(dir: string, runtime: 'ddev' | 'host') {
    m.resolveBrowserRuntime.mockResolvedValue({
      browserTesting: true,
      available: true,
      skipReason: null,
      ddevMode: runtime === 'ddev',
      appRunnerMode: false,
      appUrl: 'https://app.ddev.site',
      appBooted: true,
      envImageTag: null,
      repoSubpath: 'u/r',
      workspace: runtime === 'ddev' ? dir : null,
    });
    const ctx = {
      taskId: 'task-1',
      taskStepId: 'step-1',
      round: 0,
      repoPath: '/repos/u/r',
      workspacePath: runtime === 'ddev' ? '/repos/u/r' : dir,
      db: {},
      emitProgress: vi.fn(async () => {}),
      logger: { info: vi.fn(), warn: vi.fn() },
    } as never;
    return { ctx, detected: await browserVerifyStep.detect!(ctx) };
  }

  const fixPass = (
    ctx: never,
    detected: unknown,
    iteration: number,
    previousIterations: unknown[],
  ) =>
    browserVerifyStep.apply(ctx, {
      detected,
      formValues: {},
      iteration,
      previousIterations,
      llmOutput: FIXER_REPLY,
    } as never);

  it.each([
    ['a DDEV workspace', 'ddev'],
    ['the workspace the step was given', 'host'],
  ] as const)(
    'lists a file the fix pass created in the re-test prompt, beside the files detect took, in %s',
    async (_name, runtime) => {
      const dir = await checkout();
      const { ctx, detected } = await detectOn(dir, runtime);
      await mkdir(path.join(dir, 'images'));
      await writeFile(path.join(dir, 'images', 'icon-check.svg'), '<svg/>\n');

      const fixer = await fixPass(ctx, detected, 1, [record(0, testerOut)]);
      const prompt = retestPrompt(detected, [record(0, testerOut), record(1, fixer)]);

      expect(prompt).toContain('- images/icon-check.svg — new file');
      expect(prompt).toContain('- a.js');
      expect(prompt).toContain('- b.js');
    },
  );

  it('has the fix pass carry the change on its own output and leave detect output as it was', async () => {
    const dir = await checkout();
    const { ctx, detected } = await detectOn(dir, 'ddev');
    await writeFile(path.join(dir, 'c.js'), 'c\n');

    const fixer = await fixPass(ctx, detected, 1, [record(0, testerOut)]);

    expect(fixer.source).toBe('fixer');
    expect(fixer.implementationFiles?.files).toEqual(['a.js', 'b.js', 'c.js']);
    expect(detected.implementationFiles.files).toEqual(['a.js', 'b.js']);
  });

  it('lists the change the latest fix pass left, not the first one', async () => {
    const dir = await checkout();
    const { ctx, detected } = await detectOn(dir, 'ddev');
    await writeFile(path.join(dir, 'c.js'), 'c\n');
    const first = await fixPass(ctx, detected, 1, [record(0, testerOut)]);
    await writeFile(path.join(dir, 'd.js'), 'd\n');
    const earlier = [record(0, testerOut), record(1, first), record(2, testerOut)];
    const second = await fixPass(ctx, detected, 3, earlier);

    const prompt = retestPrompt(detected, [...earlier, record(3, second)]);

    expect(prompt).toContain('- c.js');
    expect(prompt).toContain('- d.js');
  });

  const UNREAD = /\nThe change could not be re-read after the last fix[\s\S]*?what a list names\./;

  it("gives the re-tester detect's list and the unread notice after a fix pass stored before it collected the change", async () => {
    const dir = await checkout();
    const { detected } = await detectOn(dir, 'ddev');
    const fixer = { source: 'fixer', failures: [], fixesApplied: [], screenshots: [] };

    const prompt = retestPrompt(detected, [record(0, testerOut), record(1, fixer)]);

    expect(prompt).toMatch(UNREAD);
    expect(prompt.replace(UNREAD, '')).toBe(firstPrompt(detected));
  });

  it.each([
    ['whose scan failed', ['a.js']],
    ['whose scan failed and found no file', []],
  ])(
    "gives the re-tester detect's list and says the change could not be re-read after a fix pass %s",
    async (_name, files) => {
      const dir = await checkout();
      const { detected } = await detectOn(dir, 'ddev');
      const implementationFiles = {
        files,
        total: files.length,
        truncated: false,
        scanError: 'git failed',
      };
      const fixer = {
        source: 'fixer',
        failures: [],
        fixesApplied: [],
        screenshots: [],
        implementationFiles,
      };

      const prompt = retestPrompt(detected, [record(0, testerOut), record(1, fixer)]);

      expect(prompt).toMatch(UNREAD);
      expect(prompt.replace(UNREAD, '')).toBe(firstPrompt(detected));
    },
  );

  it('says nothing of an unread change in the first tester prompt or after a fix pass that read it', async () => {
    const dir = await checkout();
    const { ctx, detected } = await detectOn(dir, 'ddev');
    await writeFile(path.join(dir, 'c.js'), 'c\n');
    const fixer = await fixPass(ctx, detected, 1, [record(0, testerOut)]);

    expect(firstPrompt(detected)).not.toMatch(UNREAD);
    expect(retestPrompt(detected, [record(0, testerOut), record(1, fixer)])).not.toMatch(UNREAD);
  });

  it('tells the first tester pass the list may lack files of the change when the scan of it failed', async () => {
    const dir = await checkout();
    const { detected } = await detectOn(dir, 'ddev');
    const failed = { files: ['a.js'], total: 1, truncated: false, scanError: 'git failed' };

    const prompt = firstPrompt({ ...detected, implementationFiles: failed });

    expect(prompt).toContain('COVERAGE: the change could not be read in full');
    expect(prompt).toContain('do NOT report a clean result');
    expect(firstPrompt(detected)).not.toContain('could not be read in full');
  });

  it('collects nothing in a fix pass when the detect output predates the workspace it records', async () => {
    const dir = await checkout();
    const { ctx, detected } = await detectOn(dir, 'ddev');
    await writeFile(path.join(dir, 'c.js'), 'c\n');
    m.collectImplementationFiles.mockClear();

    const fixer = await fixPass(ctx, { ...detected, workspace: undefined }, 1, [
      record(0, testerOut),
    ]);

    expect(m.collectImplementationFiles).not.toHaveBeenCalled();
    expect(fixer).not.toHaveProperty('implementationFiles');
    const prompt = retestPrompt(detected, [record(0, testerOut), record(1, fixer)]);
    expect(prompt).toMatch(UNREAD);
    expect(prompt.replace(UNREAD, '')).toBe(firstPrompt(detected));
  });
});
