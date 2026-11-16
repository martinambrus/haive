import { expect, it } from 'vitest';
import {
  CHECK_RESULT_ROLES,
  STEP_ROLE_REGISTRY,
  safeParseStepOutput,
  type CheckResultRole,
} from '@haive/shared/step-outputs';
import { finalizeCanonicalCheckResult } from '../src/step-engine/check-result-output.js';

// Full return records reproduced from the apply paths, including storage-only fields.
// Keep these in step with 07b's fixer/validator/stub, 08's aggregate and 08b's
// skip/aggregate. Partial consumer fixtures cannot prove the throwing writer safe.
const validator = {
  validationSnapshot: { 'src/a.ts': 'file:sha256' },
  verdict: 'VALID',
  summary: 'All dimensions checked',
  issues: [],
  upstreamIssues: [],
  dimensions: [{ name: 'correctness', status: 'PASS', note: 'checked' }],
  excludedDimensions: ['performance'],
  ruleConflicts: [],
  validatorInvocationId: 'validator-run',
  changedFilesCoverage: { listed: 2, total: 2 },
  changeFingerprint: 'host-fingerprint',
  converged: true,
  churnFiles: [],
  fixesApplied: [],
  findingsSummary: 'No findings',
  report: 'Full validator report',
  reportChars: 21,
  validatorPasses: 1,
  source: 'validator',
};
const issue = { severity: 'high', file: 'src/a.ts', description: 'a defect', fix: 'repair it' };
// 07b apply: fixer carries the previous validator's metadata and adds its own writes.
const fixer = {
  runtimeChanged: true,
  verdict: 'ISSUES_FOUND',
  summary: 'Defect found',
  issues: [issue],
  upstreamIssues: [],
  dimensions: [{ name: 'correctness', status: 'FAIL', note: 'a defect' }],
  excludedDimensions: [],
  ruleConflicts: [],
  validatorInvocationId: 'validator-run',
  changedFilesCoverage: { listed: 2, total: 2 },
  changeFingerprint: 'host-fingerprint',
  implementationFiles: { files: ['src/a.ts'], total: 1, scanFailed: false },
  converged: true,
  churnFiles: [],
  fixesApplied: ['repaired a.ts'],
  findingsSummary: 'One fix',
  report: 'Defect report',
  reportChars: 13,
  validatorPasses: 1,
  validationSnapshot: { 'src/a.ts': 'file:sha256' },
  source: 'fixer',
};
// 07b apply: no parsed reply deliberately has neither invocation nor coverage.
const stub = {
  validationSnapshot: null,
  verdict: 'UNPARSEABLE',
  summary: 'Validator output could not be parsed; review the raw report at gate 2.',
  issues: [],
  dimensions: [],
  excludedDimensions: [],
  converged: true,
  churnFiles: [],
  fixesApplied: [],
  findingsSummary: 'Unparseable',
  report: 'raw reply',
  reportChars: 9,
  validatorPasses: 1,
  source: 'stub',
};
const skipped = { ran: false, passed: false, command: null, output: 'skipped' };
const ran = { ran: true, passed: true, command: 'pnpm test', output: 'tests passed' };
const unavailable = {
  ran: false,
  passed: false,
  command: 'pnpm test',
  output: 'runner unavailable',
  note: 'runner unavailable',
};
const command = {
  kind: 'host',
  bin: 'pnpm',
  args: ['test'],
  label: 'pnpm test',
  source: 'declared',
};
const noSmoke = {
  ran: false,
  passed: false,
  httpStatus: null,
  url: null,
  errorExcerpt: 'no runtime',
};
const verify = { test: ran, lint: ran, typecheck: ran, passed: true, runtimeSmoke: noSmoke };
const management = {
  action: 'manage',
  testsCreated: ['a.test.ts'],
  testsUpdated: ['b.test.ts'],
  testsDeleted: ['old.test.ts'],
  notes: 'Tests updated',
  testRun: null,
  testsPassed: null,
  fixPasses: 0,
};

type Case = {
  name: string;
  role: CheckResultRole;
  output: unknown;
  detect?: unknown;
  iterations?: unknown[];
  status: string;
};
const cases: Case[] = [];
function add(
  role: CheckResultRole,
  name: string,
  output: unknown,
  status: string,
  detect: unknown = {},
  iterations: unknown[] = [],
) {
  cases.push({ role, name, output, status, detect, iterations });
}
const { validation, verify: verification, testManagement } = CHECK_RESULT_ROLES;
add(validation, 'validator pass', validator, 'passed');
add(
  validation,
  'validator issues',
  { ...validator, verdict: 'ISSUES_FOUND', issues: [issue] },
  'failed',
);
add(
  validation,
  'validator contradictory advisory report',
  { ...validator, issues: [{ ...issue, severity: 'low' }] },
  'incomplete',
);
add(
  validation,
  'validator contradictory dimension',
  { ...validator, dimensions: [{ name: 'correctness', status: 'FAIL' }] },
  'incomplete',
);
add(
  validation,
  'validator capped coverage',
  { ...validator, changedFilesCoverage: { listed: 1, total: 2 } },
  'incomplete',
);
add(
  validation,
  'validator failed scan',
  { ...validator, changedFilesCoverage: { listed: 2, total: 2, scanFailed: true } },
  'incomplete',
);
add(
  validation,
  'validator churn',
  { ...validator, converged: false, churnFiles: ['src/a.ts'] },
  'incomplete',
);
add(validation, 'fixer carry-forward', fixer, 'failed');
add(
  validation,
  'fixer without prior pass',
  {
    verdict: 'ISSUES_FOUND',
    summary: '',
    issues: [],
    upstreamIssues: [],
    dimensions: [],
    excludedDimensions: [],
    ruleConflicts: [],
    validatorInvocationId: null,
    implementationFiles: null,
    converged: true,
    churnFiles: [],
    fixesApplied: [],
    findingsSummary: '',
    report: '',
    validatorPasses: 0,
    source: 'fixer',
    runtimeChanged: true,
  },
  'failed',
);
add(validation, 'parse-miss stub', stub, 'incomplete');
add(validation, 'exhausted validator', validator, 'incomplete', {}, [{ exhaustedBudget: true }]);
add(validation, 'exhausted fixer', fixer, 'incomplete', {}, [{ exhaustedBudget: true }]);
add(verification, 'all executed', verify, 'passed', {
  test: command,
  lint: command,
  typecheck: command,
});
add(
  verification,
  'executed failure',
  { ...verify, test: { ...ran, passed: false, output: 'failed' }, passed: false },
  'failed',
);
add(
  verification,
  'skipped slots without runners',
  { ...verify, test: skipped, lint: skipped, typecheck: skipped },
  'not-run',
  { test: null, lint: null, typecheck: null },
);
add(
  verification,
  'declined detected commands',
  {
    ...verify,
    test: skipped,
    lint: skipped,
    typecheck: skipped,
    degradedNote: 'No checks selected',
  },
  'declined',
  { test: command, lint: null, typecheck: null, declinedConfigs: ['nested/vitest.config.ts'] },
);
add(
  verification,
  'off slots and missing runner',
  {
    ...verify,
    test: unavailable,
    lint: skipped,
    typecheck: skipped,
    degradedNote: 'runner unavailable',
  },
  'not-run',
  { test: command, lint: null, typecheck: null, offSlots: ['lint'] },
);
add(
  verification,
  'mixed executed and declined',
  { ...verify, lint: skipped, typecheck: skipped },
  'passed',
  { test: command, lint: command, typecheck: null },
);
add(
  verification,
  'scoped PHP lint',
  { ...verify, phpLint: { ...ran, command: 'phpcs', scope: { blocking: 0, preExisting: 3 } } },
  'passed',
);
add(
  verification,
  'PHP lint failure',
  {
    ...verify,
    phpLint: { ...ran, passed: false, scope: { blocking: 1, preExisting: 3 } },
    passed: false,
  },
  'failed',
);
add(verification, 'declined PHP lint', { ...verify, phpLint: skipped }, 'passed');
add(
  verification,
  'environment prevented tests',
  {
    ...verify,
    test: { ...unavailable, note: 'test run stopped by its environment, not a test failure' },
    lint: skipped,
    typecheck: skipped,
    degradedNote: 'missing browser',
  },
  'not-run',
  { test: command },
);
for (const [name, runtimeSmoke] of [
  [
    'passed',
    { ran: true, passed: true, httpStatus: 200, url: 'http://localhost', errorExcerpt: 'OK' },
  ],
  [
    'failed',
    {
      ran: true,
      passed: false,
      httpStatus: 500,
      url: 'http://localhost',
      errorExcerpt: 'Fatal error',
    },
  ],
  [
    'ambiguous',
    {
      ran: true,
      passed: null,
      httpStatus: 404,
      url: 'http://localhost',
      errorExcerpt: 'Not found',
    },
  ],
  ['unavailable', noSmoke],
] as const)
  add(
    verification,
    `runtime smoke ${name} (separate from check verdict)`,
    { ...verify, runtimeSmoke },
    'passed',
  );
add(
  testManagement,
  'user skip',
  {
    action: 'skip',
    testsCreated: [],
    testsUpdated: [],
    testsDeleted: [],
    notes: 'test management skipped by user',
    testRun: null,
    testsPassed: null,
    fixPasses: 0,
  },
  'skipped',
  { primary: 'playwright' },
);
for (const testsPassed of [true, false])
  add(
    testManagement,
    `selective run ${testsPassed ? 'passed' : 'failed'}`,
    {
      ...management,
      testRun: {
        ran: true,
        passed: testsPassed,
        command: 'pnpm vitest run a.test.ts b.test.ts',
        output: 'test output',
      },
      testsPassed,
      fixPasses: 1,
    },
    testsPassed ? 'passed' : 'failed',
    { primary: 'vitest' },
  );
add(testManagement, 'runTests false', management, 'not-run', { primary: 'vitest' });
add(
  testManagement,
  'no changed tests',
  { ...management, testsCreated: [], testsUpdated: [], testsDeleted: [] },
  'not-run',
  { primary: null },
);
for (const [name, command, output, degradedNote] of [
  [
    'no runnable files',
    '',
    'no runnable test files among the changes — selective run skipped',
    undefined,
  ],
  [
    'plain script',
    '',
    'selective run unsupported for plain test scripts (would run the full suite) — skipped',
    undefined,
  ],
  [
    'no framework config',
    '',
    'no vitest configuration file was found in the workspace, so the related tests could not be run — they were written but never executed',
    'missing config',
  ],
  [
    'outside framework root',
    '',
    'none of the changed test files are inside the vitest project root (web/), so the related tests could not be run — they were written but never executed',
    'outside root',
  ],
  [
    'no DDEV runner',
    'ddev exec --raw -- pnpm test',
    'DDEV runner unavailable for the selective test run, so the related tests could not be run — they were written but never executed',
    'DDEV unavailable',
  ],
  [
    'enumerate failed',
    'pnpm playwright test a.test.ts',
    'test collection failed',
    'The related tests could not be run (collection failed). They were written but never executed, and the suite is NOT known to be green.',
  ],
  [
    'environment failed',
    'pnpm playwright test a.test.ts',
    "Executable doesn't exist at /browsers/chromium",
    'missing browser',
  ],
] as const)
  add(
    testManagement,
    name,
    {
      ...management,
      testRun: { ran: false, passed: false, command, output },
      ...(degradedNote ? { degradedNote } : {}),
    },
    'not-run',
    { primary: name === 'plain script' ? 'pkg-script' : 'playwright' },
  );

it.each(cases)(
  '$role: $name survives successful-output finalization and strict parsing',
  ({ role, output, detect, iterations, status }) => {
    const entry = STEP_ROLE_REGISTRY[role];
    const finalized = finalizeCanonicalCheckResult(entry.legacyStepId, output, detect, iterations);
    expect(finalized).toMatchObject({ resultStatus: status });
    const parsed = safeParseStepOutput(entry.contract, finalized);
    expect(parsed).toMatchObject({ success: true });
  },
);
