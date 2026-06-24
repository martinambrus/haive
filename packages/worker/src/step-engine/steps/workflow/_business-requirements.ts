import type { StepContext } from '../../step-definition.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';

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
  const humanized = await loadPreviousStepOutput(ctx.db, ctx.taskId, '03b2-humanize-requirements');
  const h = humanized?.output as { requirements?: string; summary?: string } | null;
  if (h && typeof h.requirements === 'string' && h.requirements.trim().length > 0) {
    return { requirements: h.requirements, summary: h.summary ?? '' };
  }
  const raw = await loadPreviousStepOutput(ctx.db, ctx.taskId, '03b-business-requirements');
  const r = raw?.output as { requirements?: string; summary?: string } | null;
  return { requirements: r?.requirements ?? '', summary: r?.summary ?? '' };
}
