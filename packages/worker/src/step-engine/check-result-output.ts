import {
  CHECK_RESULT_ROLES,
  STEP_ROLE_REGISTRY,
  type CheckResultRole,
} from '@haive/shared/step-outputs';

const record = (v: unknown): Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {};
/** Host compatibility adapter for the three canonical producers only. Modules must
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
  if (value == null && role !== CHECK_RESULT_ROLES.testManagement) return null;
  const state = status === 'skipped' ? 'skipped' : status !== 'done' ? 'incomplete' : undefined;
  if (role === CHECK_RESULT_ROLES.validation) {
    const exhaustedBudget = iterations.some((v) => record(v).exhaustedBudget === true);
    const c = record(o.changedFilesCoverage);
    const incomplete =
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
  const names = ['test', 'lint', 'typecheck'];
  const offSlots = names.filter((n) => Array.isArray(d.offSlots) && d.offSlots.includes(n));
  const checks = [...names, 'phpLint'].map((n) => record(o[n]));
  const anyRan = checks.some((c) => c.ran === true);
  const failed = checks.some((c) => c.ran === true && c.passed === false);
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
      (failed ? 'failed' : !anyRan ? 'not-run' : o.passed === true ? 'passed' : 'incomplete'),
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
