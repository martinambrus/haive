import {
  CHECK_RESULT_ROLES,
  STEP_ROLE_REGISTRY,
  type CheckResultRole,
} from '@haive/shared/step-outputs';

/** Canonical verify's host stub for a command that was not selected. */
export const VERIFY_SKIPPED_OUTPUT = 'skipped';

const record = (v: unknown): Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
/** Host compatibility adapter for the canonical producers only. Modules must
 * supply the exact contract themselves; never complete an alternate producer's data. */
export function canonicalCheckResult(
  role: CheckResultRole,
  value: unknown,
  detect: unknown,
  iterations: unknown[] = [],
  status = 'done',
): Record<string, unknown> | null {
  const o = record(value);
  const d = record(detect);
  const state = status === 'skipped' ? 'skipped' : status !== 'done' ? 'incomplete' : undefined;
  if (role === CHECK_RESULT_ROLES.validation) {
    const exhaustedBudget = iterations.some((v) => record(v).exhaustedBudget === true);
    const c = record(o.changedFilesCoverage);
    // A model can pair VALID with advisory issues or a failed dimension. Keep
    // its stored verdict/routing, but never claim an unqualified role pass.
    const contradictory =
      o.verdict === 'VALID' &&
      ((Array.isArray(o.issues) && o.issues.length > 0) ||
        (Array.isArray(o.dimensions) && o.dimensions.some((d) => record(d).status === 'FAIL')));
    const incomplete =
      contradictory ||
      exhaustedBudget ||
      o.verdict === 'UNPARSEABLE' ||
      o.converged === false ||
      c.scanFailed === true ||
      (typeof c.total === 'number' && c.listed < c.total);
    return {
      ...o,
      exhaustedBudget,
      resultStatus:
        state ??
        (incomplete
          ? 'incomplete'
          : o.verdict === 'VALID'
            ? 'passed'
            : o.verdict === 'ISSUES_FOUND'
              ? 'failed'
              : 'not-run'),
    };
  }
  if (role === CHECK_RESULT_ROLES.testManagement)
    return {
      ...o,
      primary: d.primary ?? null,
      resultStatus:
        state ??
        (o.action === 'skip'
          ? 'skipped'
          : o.testsPassed === true
            ? 'passed'
            : o.testsPassed === false
              ? 'failed'
              : 'not-run'),
    };
  if (role === CHECK_RESULT_ROLES.browser) {
    const tested =
      o.ran === true &&
      o.skipped !== true &&
      ['mcp', 'interactive', 'headless', 'direct'].includes(o.method);
    const contradictory =
      o.passed === true &&
      ((Array.isArray(o.failures) && o.failures.length > 0) || o.visualVerdict === 'UNSTYLED');
    return {
      ...o,
      resultStatus:
        state ??
        (o.verificationIncomplete === true || contradictory
          ? 'incomplete'
          : o.skipped === true || o.method === 'skip'
            ? 'skipped'
            : o.ran !== true
              ? 'not-run'
              : o.method === 'manual'
                ? o.checklistMarkdown
                  ? 'manual'
                  : 'incomplete'
                : tested && o.passed === true
                  ? 'passed'
                  : tested && o.passed === false
                    ? 'failed'
                    : 'incomplete'),
    };
  }
  if (role === CHECK_RESULT_ROLES.adversarialQa) {
    const c = record(o.coverage);
    const incomplete =
      o.qaIncomplete === true ||
      c.scanFailed === true ||
      c.truncated === true ||
      (typeof c.total === 'number' && c.listed < c.total);
    return {
      ...o,
      resultStatus:
        state ??
        (incomplete
          ? 'incomplete'
          : o.ran !== true
            ? 'not-run'
            : Array.isArray(o.findings)
              ? o.findings.length > 0
                ? 'findings'
                : 'clean'
              : 'incomplete'),
    };
  }
  const names = ['test', 'lint', 'typecheck'];
  const offSlots = names.filter((n) => Array.isArray(d.offSlots) && d.offSlots.includes(n));
  const checks = [...names, 'phpLint'].map((n) => record(o[n]));
  const anyRan = checks.some((c) => c.ran === true);
  const failed = checks.some((c) => c.ran === true && c.passed === false);
  // The canonical apply writes this host stub only when a detected command was
  // not selected. Runner/environment failures carry their own output and note.
  const declined = names.some((n) => d[n] != null && record(o[n]).output === VERIFY_SKIPPED_OUTPUT);
  return {
    ...o,
    declinedConfigs: Array.isArray(d.declinedConfigs)
      ? d.declinedConfigs.filter((v) => typeof v === 'string')
      : [],
    declaredSlots: names.filter((n) => record(d[n]).source === 'declared'),
    offSlots,
    slotWithoutRunner: names.some((n) => d[n] === null && !offSlots.includes(n)),
    resultStatus:
      state ??
      (failed
        ? 'failed'
        : !anyRan
          ? declined
            ? 'declined'
            : 'not-run'
          : o.passed === true
            ? 'passed'
            : 'incomplete'),
  };
}
/** Called by the runner on successful returns and after its loop budget decision. */
export function finalizeCanonicalCheckResult(
  stepId: string,
  value: unknown,
  detect: unknown,
  iterations: unknown[] = [],
): unknown {
  const role = Object.values(CHECK_RESULT_ROLES).find(
    (r) => STEP_ROLE_REGISTRY[r].legacyStepId === stepId,
  );
  return role ? canonicalCheckResult(role, value, detect, iterations) : value;
}
