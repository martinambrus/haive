import {
  STEP_ROLE_REGISTRY,
  projectRoleOutput,
  safeParseStepOutput,
  type SpecRoleId,
  type RoleOutput,
} from '@haive/shared/step-outputs';
import type { StepContext } from './step-definition.js';
import { loadPreviousStepOutput } from './steps/onboarding/_helpers.js';

type Producer<R extends SpecRoleId> = {
  role: R;
  contract: (typeof STEP_ROLE_REGISTRY)[R]['contract'];
  producer: { rowId: string | null; stepId: string; round: number | null; status: string | null };
  iterations: unknown[];
  /** Declared fields from the SAME row, even for a reset or malformed historical output.
   * Only explicit host compatibility adapters use this; new consumers must require ready. */
  legacyOutput: Partial<RoleOutput<R>> | null;
};
export type RoleRead<R extends SpecRoleId> =
  | {
      state: 'absent';
      role: R;
      contract: (typeof STEP_ROLE_REGISTRY)[R]['contract'];
      producer: null;
    }
  | (Producer<R> & { state: 'not-ready' })
  | (Producer<R> & { state: 'invalid'; issuePaths: readonly string[] })
  | (Producer<R> & { state: 'ready'; data: RoleOutput<R> });

/** Canonical resolution ONLY. Preserve L selection: newest round, no status predicate,
 * no implicit round ceiling. A passed ceiling is forwarded exactly. PR3's v3 per-input
 * pins will change selection for NEW tasks only; v1/v2 tasks keep this compatibility path. */
export async function readRole<R extends SpecRoleId>(
  ctx: Pick<StepContext, 'db' | 'taskId'>,
  role: R,
  maxRound?: number,
): Promise<RoleRead<R>> {
  const entry = STEP_ROLE_REGISTRY[role];
  if (!entry || 'hostPolicy' in entry)
    throw new Error('readRole cannot resolve host-policy roles without per-input pins');
  const row = await loadPreviousStepOutput(ctx.db, ctx.taskId, entry.legacyStepId, maxRound);
  const contract = entry.contract;
  if (!row) return { state: 'absent', role, contract, producer: null };
  const common = {
    role,
    contract,
    producer: { rowId: row.id, stepId: row.stepId, round: row.round, status: row.status },
    iterations: row.iterations,
    legacyOutput: projectRoleOutput(role, row.output),
  };
  if (row.status !== 'done') return { ...common, state: 'not-ready' };
  const result = safeParseStepOutput(contract, row.output);
  if (!result.success) return { ...common, state: 'invalid', issuePaths: result.issuePaths };
  return { ...common, state: 'ready', data: projectRoleOutput(role, result.data) as RoleOutput<R> };
}

/** PR1 host adapters preserve tolerant old-row reads, including absent spec fields and
 * non-done rows with retained output. Validation is diagnostic, never a new routing gate. */
export function legacyRoleOutput<R extends SpecRoleId>(read: RoleRead<R>): Partial<RoleOutput<R>> {
  return read.state === 'absent' ? {} : (read.legacyOutput ?? {});
}
