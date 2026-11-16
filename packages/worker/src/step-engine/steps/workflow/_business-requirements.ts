import type { StepContext } from '../../step-definition.js';
import { REQUIREMENTS_ROLES } from '@haive/shared/step-outputs';
import { EFFECTIVE_REQUIREMENTS_ROLES } from '@haive/shared/step-ports';
import { readRole, legacyRoleOutput } from '../../read-role.js';
export const EFFECTIVE_REQUIREMENTS_INPUTS = EFFECTIVE_REQUIREMENTS_ROLES;

// Shared accessor for the business-requirements doc. 03b drafts it; 03b2 humanizes
// it; 03c reviews it and 04 grounds the technical spec on it. Consumers must read
// the HUMANIZED version when it exists so the humanization pass is transparent —
// this is the single place that prefers 03b2 over 03b, so the preference can't
// drift between callers.

export interface BizReqDoc {
  requirements: string;
  summary: string;
}

/** The business-requirements doc downstream steps should consume: the humanized
 *  03b2 output when present and non-empty, else the raw 03b draft, else empty. */
export async function loadBusinessRequirements(ctx: StepContext): Promise<BizReqDoc> {
  return effectiveRequirements(await readRequirementsStages(ctx));
}

/** Host adapter: prefer a nonblank humanized body, preserving its exact bytes.
 * Unlike effective-spec, a blank humanized body falls back to the raw draft.
 * Canonical old rows remain tolerant; v3 reads suppress output from reset rows. */
export async function readRequirementsStages(ctx: StepContext) {
  const [humanized, draft] = await Promise.all([
    readRole(ctx, REQUIREMENTS_ROLES.humanized),
    readRole(ctx, REQUIREMENTS_ROLES.draft),
  ]);
  return { humanized, draft };
}
export function effectiveRequirements(
  stages: Awaited<ReturnType<typeof readRequirementsStages>>,
): BizReqDoc {
  const byRole = {
    [REQUIREMENTS_ROLES.humanized]: stages.humanized,
    [REQUIREMENTS_ROLES.draft]: stages.draft,
  };
  for (const role of EFFECTIVE_REQUIREMENTS_INPUTS) {
    const out = legacyRoleOutput(byRole[role]);
    if (
      role === REQUIREMENTS_ROLES.humanized &&
      !(typeof out.requirements === 'string' && out.requirements.trim().length > 0)
    )
      continue;
    return { requirements: out.requirements ?? '', summary: out.summary ?? '' };
  }
  return { requirements: '', summary: '' };
}
