import { and, desc, eq } from 'drizzle-orm';
import { globalKbEntries, resolveGlobalKbSettings, withGlobalKb } from '@haive/shared/global-kb';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';

// Onboarding-only review gate for global KB drafts. Step 08 promotes any
// global-scoped knowledge (framework / library / plugin house standards) to the
// cross-repo KB as DRAFTS. Drafts hold no vectors and are not retrievable until
// the user approves them, so this step surfaces them once — listing what was
// drafted and linking to Settings -> Global KB (drafts filter) for manual
// review — BEFORE the RAG source-selection step. It auto-skips (shouldRun=false)
// when this run promoted nothing, so a normal run with no global findings goes
// straight to RAG. The workflow learning phase (step 11) has its own inline
// draft-approval form, so this gate is onboarding-specific.

interface GlobalKbDraftRow {
  id: string;
  title: string;
  category: string;
}

interface GlobalKbReviewDetect {
  drafts: GlobalKbDraftRow[];
}

/** Draft rows the current task promoted to the global KB. Best-effort: if the
 *  global KB is disabled or unreachable, treat it as "no drafts" (the step
 *  simply skips) rather than failing the run. */
async function fetchTaskDrafts(ctx: StepContext): Promise<GlobalKbDraftRow[]> {
  try {
    // Gate on the cheap config read first: when the global KB is off this never
    // opens (or, in internal mode, creates) the dedicated DB.
    const settings = await resolveGlobalKbSettings();
    if (!settings.enabled) return [];
    return await withGlobalKb(ctx.db, async ({ db: gdb }) => {
      const rows = await gdb
        .select({
          id: globalKbEntries.id,
          title: globalKbEntries.title,
          category: globalKbEntries.category,
        })
        .from(globalKbEntries)
        .where(
          and(eq(globalKbEntries.sourceTaskId, ctx.taskId), eq(globalKbEntries.status, 'draft')),
        )
        .orderBy(desc(globalKbEntries.createdAt));
      return rows.map((r) => ({ id: r.id, title: r.title, category: r.category }));
    });
  } catch (err) {
    ctx.logger.warn({ err }, 'global KB draft lookup failed (treating as no drafts)');
    return [];
  }
}

export const globalKbReviewStep: StepDefinition<GlobalKbReviewDetect, { acknowledged: boolean }> = {
  metadata: {
    id: '09_6_5-global-kb-review',
    workflowType: 'onboarding',
    index: 12.5,
    title: 'Global KB drafts review',
    description: 'Review house-standard entries promoted to the shared Global KB as drafts.',
    requiresCli: false,
  },

  // Only gate the user when this run actually promoted at least one draft.
  async shouldRun(ctx): Promise<boolean> {
    const drafts = await fetchTaskDrafts(ctx);
    return drafts.length > 0;
  },

  async detect(ctx): Promise<GlobalKbReviewDetect> {
    return { drafts: await fetchTaskDrafts(ctx) };
  },

  form(_ctx, detected): FormSchema {
    const n = detected.drafts.length;
    const list = detected.drafts.map((d) => `- **${d.title}** _(${d.category})_`).join('\n');
    return {
      title: 'Review global knowledge base drafts',
      description: `Onboarding identified ${n} reusable house-standard ${
        n === 1 ? 'entry' : 'entries'
      } that apply beyond this project and added ${
        n === 1 ? 'it' : 'them'
      } to the shared Global KB as DRAFTS. Drafts are not used for retrieval until you approve them.`,
      infoSections: [
        {
          title: `${n} draft${n === 1 ? '' : 's'} awaiting your review`,
          body: `${list}\n\n[Open the Global KB drafts to review and activate them →](/settings/global-kb?status=draft)`,
          defaultOpen: true,
        },
      ],
      fields: [
        {
          type: 'checkbox',
          id: 'acknowledged',
          label: 'Got it — I will review and activate these in Global KB',
          default: true,
        },
      ],
      submitLabel: 'Continue',
    };
  },

  async apply() {
    return { acknowledged: true };
  },
};
