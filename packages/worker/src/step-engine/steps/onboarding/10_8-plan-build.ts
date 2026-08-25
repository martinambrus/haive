import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { findPlanRoot } from '@haive/shared/plan';
import { createPlanBuildStep } from '../plan/01-plan-build.js';

/**
 * Build the repository's plan during onboarding.
 *
 * Slotted after `10-rag-populate` (index 14) and before `11-final-review`
 * (index 15), which is where both of the builder's inputs first exist: the
 * knowledge base is written by `08` and its gaps closed by the `09` chain, and
 * RAG is populated, so the agents can both READ the KB and SEARCH the code. It
 * lands before `12-post-onboarding` (index 16), which writes and stages the
 * `.haive-data/` mirror, so the new plan travels with the first commit.
 *
 * A thin wrapper on purpose: `createPlanBuildStep` is the same code the
 * standalone `plan_build` task runs. Two triggers exist because
 * `onboarding_upgrade` reconciles template artifacts only — it never re-runs
 * onboarding steps — so a repo onboarded before this feature can only reach the
 * builder through the button.
 */
export const onboardingPlanBuildStep = createPlanBuildStep({
  id: '10_8-plan-build',
  workflowType: 'onboarding',
  index: 14.5,
  title: 'Project plan',
  description:
    'Derives a durable plan of what the project is meant to be from the knowledge base just written, so later tasks can be created from it and the spec writer knows what components exist.',
  // No form: onboarding is already a long sequence of them, and one more asking
  // for two numbers with good defaults is friction rather than control. The plan
  // is editable on the canvas afterwards.
  askForBudget: false,
  // Never rebuild over an existing plan. A repo re-onboarded (or resumed) must
  // not get a second decomposition merged into the one someone has been editing.
  extraShouldRun: async (ctx) => {
    const [task] = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    if (!task?.repositoryId) return false;
    return (await findPlanRoot(ctx.db, task.repositoryId)) === null;
  },
});
