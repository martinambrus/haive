import { expect, it } from 'vitest';
import {
  CHECK_RESULT_ROLES,
  STEP_ROLE_REGISTRY,
  safeParseStepOutput,
  type CheckResultRole,
} from '@haive/shared/step-outputs';
import { finalizeCanonicalCheckResult } from '../src/step-engine/check-result-output.js';
import type { browserVerifyStep } from '../src/step-engine/steps/workflow/08a-browser-verify.js';
import type { adversarialQaStep } from '../src/step-engine/steps/workflow/08d-adversarial-qa.js';
type Browser = Awaited<ReturnType<NonNullable<typeof browserVerifyStep.apply>>>;
type Qa = Awaited<ReturnType<NonNullable<typeof adversarialQaStep.apply>>>;
// Full records from every successful apply return: skip, retired-mode resume,
// fixer (with/without tester), parse miss, tester health/visual/evidence variants,
// and QA's single aggregate return with each execution/coverage outcome.
const browser: Browser = {
  ran: true,
  skipped: false,
  method: 'mcp',
  appUrl: 'http://app',
  consoleErrors: [],
  consoleWarnings: [],
  networkErrors: [],
  pageTitle: null,
  passed: true,
  output: 'tested',
  failures: [],
  visualVerdict: 'STYLED',
  checklistMarkdown: null,
  fixesApplied: [],
  fixScope: null,
  screenshots: [{ file: 'home.png', caption: 'Home' }],
  screenshotsArtifactPath: '/repo/screenshots.json',
  appLogin: { attempted: true, ok: true, reason: '' },
  source: 'tester',
};
const skipped: Browser = {
  ...browser,
  ran: false,
  skipped: true,
  appUrl: null,
  passed: false,
  output: 'unavailable',
  screenshots: [],
  screenshotsArtifactPath: null,
  visualVerdict: null,
  source: 'skip',
};
const qa: Qa = {
  ran: true,
  level: 'poc',
  findings: [],
  counts: { critical: 0, high: 0, total: 0 },
  blocking: false,
  qaIncomplete: false,
  coverage: { listed: 2, total: 2, truncated: false },
};
const cases: { role: CheckResultRole; name: string; output: Browser | Qa; status: string }[] = [];
const addBrowser = (name: string, output: Browser, status: string) =>
  cases.push({ role: CHECK_RESULT_ROLES.browser, name, output, status });
const addQa = (name: string, output: Qa, status: string) =>
  cases.push({ role: CHECK_RESULT_ROLES.adversarialQa, name, output, status });
addBrowser('runtime unavailable', skipped, 'skipped');
addBrowser(
  'user skip',
  { ...skipped, ran: true, method: 'skip', passed: true, output: 'skipped by user' },
  'skipped',
);
for (const method of ['interactive', 'direct', 'headless', 'manual'] as const)
  addBrowser(
    `retired ${method} resumes as skip`,
    { ...skipped, method, output: 'verified hands-on at gate 2' },
    'skipped',
  );
addBrowser('tester pass', browser, 'passed');
addBrowser(
  'tester failure',
  {
    ...browser,
    passed: false,
    failures: [{ description: 'bad', evidence: 'capture' }],
    fixScope: 'implementation',
  },
  'failed',
);
addBrowser('visual failure', { ...browser, passed: false, visualVerdict: 'UNSTYLED' }, 'failed');
addBrowser(
  'health failure',
  { ...browser, passed: false, failures: [{ description: 'HTTP 500', evidence: 'probe' }] },
  'failed',
);
addBrowser(
  'no screenshot evidence',
  { ...browser, verificationIncomplete: true, screenshots: [], screenshotsArtifactPath: null },
  'incomplete',
);
addBrowser(
  'parse miss',
  {
    ...browser,
    passed: false,
    visualVerdict: null,
    failures: [{ description: 'Tester output could not be parsed; review the raw report.' }],
    fixScope: 'implementation',
    output: 'raw',
  },
  'failed',
);
addBrowser(
  'fixer carries tester failure',
  {
    ...browser,
    passed: false,
    source: 'fixer',
    fixesApplied: ['repair'],
    failures: [{ description: 'bad' }],
    output: '',
    implementationFiles: { files: ['new.ts'], total: 1, truncated: false, scanError: null },
  },
  'failed',
);
addBrowser(
  'fixer without prior tester',
  { ...browser, passed: false, source: 'fixer', failures: [], visualVerdict: null, output: '' },
  'failed',
);
// Historical manual/probe outputs remain distinct and satisfy the declared result contract.
addBrowser(
  'historical manual checklist',
  { ...browser, method: 'manual', checklistMarkdown: '- [ ] Test', source: 'skip' },
  'manual',
);
addBrowser('not run', { ...browser, ran: false, passed: false }, 'not-run');
addBrowser(
  'contradictory tester pass',
  { ...browser, failures: [{ description: 'bad' }] },
  'incomplete',
);
for (const level of ['poc', 'standard', 'enterprise'] as const)
  addQa(`clean ${level}`, { ...qa, level }, 'clean');
for (const severity of ['critical', 'high', 'medium', 'low'] as const)
  for (const verification of ['reproduced', 'not_reproduced', 'unverified', 'untestable'] as const)
    addQa(
      `${severity} ${verification}`,
      {
        ...qa,
        findings: [
          {
            severity,
            category: 'auth',
            location: 'a.ts:1',
            impact: 'bypass',
            fix: 'guard',
            verification,
            fingerprints: ['fp'],
          },
        ],
        counts: { critical: +(severity === 'critical'), high: +(severity === 'high'), total: 1 },
        blocking: ['critical', 'high'].includes(severity) && verification !== 'not_reproduced',
      },
      'findings',
    );
addQa('no dispatch', { ...qa, ran: false, level: null }, 'not-run');
addQa(
  'killed/unreadable roster gap',
  {
    ...qa,
    qaIncomplete: true,
    findings: [
      { severity: 'medium', category: 'qa-gap', impact: 'agent unreadable', fingerprints: [] },
    ],
    counts: { critical: 0, high: 0, total: 1 },
  },
  'incomplete',
);
addQa('pre-coverage detect', { ...qa, coverage: null }, 'clean');
addQa('capped files', { ...qa, coverage: { listed: 1, total: 2, truncated: true } }, 'incomplete');
addQa(
  'scan failure',
  { ...qa, coverage: { listed: 2, total: 2, truncated: false, scanFailed: true } },
  'incomplete',
);
it.each(cases)(
  '$role $name survives runner finalization and strict parsing',
  ({ role, output, status }) => {
    const entry = STEP_ROLE_REGISTRY[role];
    const result = finalizeCanonicalCheckResult(entry.legacyStepId, output, {});
    expect(result).toMatchObject({ resultStatus: status });
    expect(safeParseStepOutput(entry.contract, result)).toMatchObject({ success: true });
  },
);
