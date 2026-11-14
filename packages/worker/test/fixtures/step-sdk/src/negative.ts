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
