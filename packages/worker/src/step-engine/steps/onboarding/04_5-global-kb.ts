import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepDefinition } from '../../step-definition.js';

// Dedicated, instance-level Global KB step (split out of 04-tooling-infrastructure
// so per-repo tooling stays focused). The form renders the `global-kb-status`
// field, which live-validates enabled/DB/Ollama in the browser and offers an
// Add/Fix action button into Settings → Global KB. Info-only otherwise: the single
// status field keeps the form non-empty so auto-continue pauses to show it.

interface GlobalKbStepDetect {
  repositoryId: string | null;
  cliProviderId: string | null;
}

export const globalKbStep: StepDefinition<GlobalKbStepDetect, { acknowledged: boolean }> = {
  metadata: {
    id: '04_5-global-kb',
    workflowType: 'onboarding',
    index: 4.5,
    title: 'Global knowledge base',
    description: 'Review the shared global knowledge base (optional, set up once).',
    requiresCli: false,
  },

  async detect(ctx): Promise<GlobalKbStepDetect> {
    // repo + CLI only pre-fill the "Add a house rule" link on the settings page.
    const rows = await ctx.db
      .select({ repositoryId: schema.tasks.repositoryId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, ctx.taskId))
      .limit(1);
    return {
      repositoryId: rows[0]?.repositoryId ?? null,
      cliProviderId: ctx.cliProviderId ?? null,
    };
  },

  form(_ctx, detected): FormSchema {
    return {
      title: 'Global knowledge base',
      description:
        'Haive keeps one instance-wide knowledge base of reusable house standards that every project retrieves from (version-scoped to its stack) — separate from the per-repository RAG in the previous step. It is where your hard-won, cross-project know-how lives: e.g. "never use the Panels module", "lazy-load images via the Lazy module", preferred boilerplate versions, or your house PHP / coding conventions. It is optional, but feeding it the findings and experience you have gained makes every future project start smarter — well worth a minute when you have something to share.',
      fields: [
        {
          type: 'global-kb-status',
          id: 'globalKb',
          label: 'Global KB status',
          repositoryId: detected.repositoryId,
          cliProviderId: detected.cliProviderId,
        },
      ],
      submitLabel: 'Continue',
    };
  },

  async apply() {
    return { acknowledged: true };
  },
};
