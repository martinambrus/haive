import type { StepDefinition } from '@haive/shared/step';
import steps from './steps.js';

export const wrongMetadata = {
  ...steps[0],
  // @ts-expect-error Step metadata requires a numeric index.
  metadata: { ...steps[0].metadata, index: 'first' },
} satisfies StepDefinition<{ path: string }, { report: string }>;

export const wrongApply = {
  ...steps[0],
  // @ts-expect-error The declared apply output requires a string report.
  async apply() {
    return { report: 42 };
  },
} satisfies StepDefinition<{ path: string }, { report: string }>;

import type { CodeAuditOutput, StepOutputContractRef } from '@haive/shared/step';
// @ts-expect-error Modules receive no mutable host validator.
import { codeAuditOutputSchema } from '@haive/shared/step-outputs';
// @ts-expect-error Only the registered version is an SDK reference.
const badVersion: StepOutputContractRef = { id: 'haive.code-audit', version: 2 };
const auditStep = {
  ...steps[0],
  outputContract: { id: 'haive.code-audit', version: 1 },
  // @ts-expect-error The declared contract output cannot be an arbitrary report.
  async apply() {
    return { report: 'wrong' };
  },
} satisfies StepDefinition<{ path: string }, CodeAuditOutput>;
void [codeAuditOutputSchema, badVersion, auditStep];

export function invalidInsightOverrides(host: import('@haive/shared/step').StepHostServices) {
  // @ts-expect-error The insight capability is task-bound.
  void host.loadUnactedInsights({ taskId: 'foreign' });
  // @ts-expect-error The insight capability is owner-bound.
  void host.loadUnactedInsights({ userId: 'foreign' });
  // @ts-expect-error Insight reads do not accept filesystem paths.
  void host.loadUnactedInsights({ worktreePath: '/foreign' });
}

export function provenanceIsInventoryOnly(insight: import('@haive/shared/step').Insight) {
  // @ts-expect-error Legacy triage/gate snapshots have no provenance field.
  void insight.sourceRefs;
}
