import { describe, it, expect } from 'vitest';
import {
  appHealthFailures,
  browserVerifyStep,
  parseBrowserTestOutput,
  parseFixerOutput,
  parseChecklistOutput,
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

describe('parseChecklistOutput', () => {
  it('extracts checklist_markdown from fenced JSON', () => {
    const p = parseChecklistOutput(
      '```json\n{"checklist_markdown":"# Checklist\\n- [ ] step"}\n```',
    );
    expect(p).toContain('# Checklist');
    expect(p).toContain('- [ ] step');
  });

  it('falls back to raw markdown when not fenced JSON', () => {
    const md = '# Manual checklist\n- [ ] open the page';
    expect(parseChecklistOutput(md)).toBe(md);
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
