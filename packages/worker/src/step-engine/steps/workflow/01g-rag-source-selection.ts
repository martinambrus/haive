import type { StepDefinition } from '../../step-definition.js';
import {
  ragSourceSelectionStep,
  type RagSourceSelectionDetect,
  type RagSourceSelectionApply,
} from '../onboarding/09_7-rag-source-selection.js';
import { resolveRagSyncPrefs } from './_rag-index.js';
import { detectWorkflowRagSourceSelection } from './11b1-rag-source-selection.js';

/** Every pre-sync scans the main checkout, including changes made outside the
 * task worktree. Review its current tree before indexing, even with saved scope. */
export const preRagSourceSelectionStep: StepDefinition<
  RagSourceSelectionDetect,
  RagSourceSelectionApply
> = {
  metadata: {
    id: '01g-rag-source-selection',
    workflowType: 'workflow',
    index: 1.95,
    title: 'Select RAG scope before pre-sync',
    description:
      'Review the repository folders before pre-workflow RAG ingestion. Saved exclusions are preselected, including folders changed outside this task.',
    requiresCli: false,
  },
  shouldRun: async (ctx) => (await resolveRagSyncPrefs(ctx)).ragConfigured,
  detect: (ctx) => detectWorkflowRagSourceSelection(ctx, ctx.repoPath),
  form: (ctx, detected) => ragSourceSelectionStep.form!(ctx, detected),
  apply: (ctx, args) => ragSourceSelectionStep.apply(ctx, args),
};
