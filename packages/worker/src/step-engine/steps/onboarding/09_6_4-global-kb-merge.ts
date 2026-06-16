import { and, eq, isNotNull } from 'drizzle-orm';
import { globalKbEntries, resolveGlobalKbSettings, withGlobalKb } from '@haive/shared/global-kb';
import type { FormSchema } from '@haive/shared';
import type {
  AgentMiningDispatch,
  AgentMiningResult,
  StepContext,
  StepDefinition,
} from '../../step-definition.js';

// Onboarding merge step. Step 08 keeps a newly-promoted global-KB article whose topic
// already exists as a DRAFT linked (supersedes_entry_id) to that existing entry instead
// of discarding it (which would lose any extra knowledge it carries). This step
// LLM-merges each such pair into one enriched draft body — keeping every unique point
// and dropping duplication — so the cross-repo KB grows richer rather than duplicating.
// On activation the merged draft supersedes the existing entry (handled in the API).
// Best-effort: when no model runs (test bypass / dispatch skip) the linked drafts are
// left as-is for manual review at 09_6_5. Runs after skill verification (12) and before
// the global-KB review gate (12.5).

interface MergePair {
  draftId: string;
  draftTitle: string;
  draftBody: string;
  existingId: string;
  existingBody: string;
}

interface MergeDetect {
  pairs: MergePair[];
}

interface MergeApply {
  merged: number;
  skipped: number;
}

const MERGE_BEGIN = '<<<MERGED';
const MERGE_END = 'MERGED>>>';

/** Pull the merged article from the agent output: between the markers when present,
 *  else the whole trimmed text. Empty when nothing usable came back. */
export function extractMergedArticle(raw: string | null | undefined): string {
  if (!raw) return '';
  const b = raw.indexOf(MERGE_BEGIN);
  const e = raw.lastIndexOf(MERGE_END);
  if (b >= 0 && e > b) return raw.slice(b + MERGE_BEGIN.length, e).trim();
  return raw.trim();
}

function buildMergePrompt(p: MergePair): string {
  return [
    'You are merging two knowledge-base articles that cover the SAME topic: an EXISTING',
    'article and a NEW candidate. Produce ONE merged article that keeps every unique,',
    'correct point from BOTH and removes duplication. Preserve a clean structure with',
    'headings. Do NOT invent content — only combine what the two articles actually say.',
    'Keep it portable: no project-specific names or repo file lists.',
    '',
    `Output ONLY the merged markdown, wrapped exactly between ${MERGE_BEGIN} and ${MERGE_END}`,
    'on their own lines.',
    '',
    '=== EXISTING article ===',
    p.existingBody,
    '',
    '=== NEW candidate ===',
    p.draftBody,
  ].join('\n');
}

/** This task's promoted drafts that are linked to an existing entry, paired with that
 *  entry's body. Best-effort: a disabled/unreachable global KB yields no pairs. */
async function loadPairs(ctx: StepContext): Promise<MergePair[]> {
  try {
    const settings = await resolveGlobalKbSettings();
    if (!settings.enabled) return [];
    return await withGlobalKb(ctx.db, async ({ db: gdb }) => {
      const drafts = await gdb
        .select({
          id: globalKbEntries.id,
          title: globalKbEntries.title,
          body: globalKbEntries.body,
          supersedesEntryId: globalKbEntries.supersedesEntryId,
        })
        .from(globalKbEntries)
        .where(
          and(
            eq(globalKbEntries.sourceTaskId, ctx.taskId),
            eq(globalKbEntries.status, 'draft'),
            isNotNull(globalKbEntries.supersedesEntryId),
          ),
        );
      const pairs: MergePair[] = [];
      for (const d of drafts) {
        if (!d.supersedesEntryId) continue;
        const [existing] = await gdb
          .select({ body: globalKbEntries.body })
          .from(globalKbEntries)
          .where(eq(globalKbEntries.id, d.supersedesEntryId))
          .limit(1);
        if (existing) {
          pairs.push({
            draftId: d.id,
            draftTitle: d.title,
            draftBody: d.body,
            existingId: d.supersedesEntryId,
            existingBody: existing.body,
          });
        }
      }
      return pairs;
    });
  } catch (err) {
    ctx.logger.warn({ err }, 'global KB merge: pair lookup failed (treating as none)');
    return [];
  }
}

export const globalKbMergeStep: StepDefinition<MergeDetect, MergeApply> = {
  metadata: {
    id: '09_6_4-global-kb-merge',
    workflowType: 'onboarding',
    index: 12.4,
    title: 'Global KB merge',
    description:
      'Merges newly-promoted global KB articles into the existing same-topic entries (enrich + dedup) before review.',
    requiresCli: false,
  },

  async shouldRun(ctx): Promise<boolean> {
    return (await loadPairs(ctx)).length > 0;
  },

  async detect(ctx): Promise<MergeDetect> {
    return { pairs: await loadPairs(ctx) };
  },

  // No user form — runs hands-free; the merged drafts surface at 09_6_5 for review.
  form(): FormSchema | null {
    return null;
  },

  agentMining: {
    requiredCapabilities: ['tool_use'],
    async selectAgents({ detected }): Promise<AgentMiningDispatch[]> {
      // Mining has no bypass stub; under test bypass return [] so the smoke pipeline
      // runs without a real CLI provider (the drafts stay linked, unmerged).
      if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
      const { pairs } = detected as MergeDetect;
      return pairs.map((p) => ({
        agentId: `merge:${p.draftId}`,
        agentTitle: `KB merge: ${p.draftTitle}`,
        prompt: buildMergePrompt(p),
      }));
    },
  },

  async apply(ctx, args): Promise<MergeApply> {
    const { pairs } = args.detected as MergeDetect;
    const results = (args.agentMiningResults ?? []) as AgentMiningResult[];
    const byDraft = new Map<string, MergePair>(pairs.map((p) => [`merge:${p.draftId}`, p]));
    let merged = 0;
    try {
      const settings = await resolveGlobalKbSettings();
      if (settings.enabled) {
        await withGlobalKb(ctx.db, async ({ db: gdb }) => {
          for (const r of results) {
            const p = byDraft.get(r.agentId);
            if (!p) continue;
            const body = r.status === 'done' ? extractMergedArticle(r.rawOutput) : '';
            // Guard against an empty / truncated merge clobbering real content.
            if (body.length < 40) continue;
            await gdb
              .update(globalKbEntries)
              .set({ body, embedStatus: 'pending', updatedAt: new Date() })
              .where(eq(globalKbEntries.id, p.draftId));
            merged += 1;
          }
        });
      }
    } catch (err) {
      ctx.logger.warn({ err }, 'global KB merge: applying merged bodies failed');
    }
    // Unmerged drafts stay linked for manual review/merge at 09_6_5.
    const skipped = pairs.length - merged;
    ctx.logger.info({ merged, skipped, pairs: pairs.length }, 'global KB merge complete');
    return { merged, skipped };
  },
};
