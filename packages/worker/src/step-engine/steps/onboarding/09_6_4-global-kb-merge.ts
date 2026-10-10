import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { globalKbEntries, resolveGlobalKbSettings, withGlobalKb } from '@haive/shared/global-kb';
import type { FormSchema } from '@haive/shared';
import type {
  AgentMiningDispatch,
  AgentMiningResult,
  StepContext,
  StepDefinition,
} from '../../step-definition.js';
import { miningLossNote, shouldRetryMiningTerminalFailure } from '../../mining-failure.js';

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
  /** Absent on a payload persisted before descriptions existed. */
  draftDescription?: string | null;
  existingDescription?: string | null;
}

interface MergeDetect {
  pairs: MergePair[];
}

interface MergeApply {
  merged: number;
  skipped: number;
  /** Set when a draft this step set out to merge was left unmerged. Lifted verbatim by
   *  computeDegradedNote. Optional: apply outputs are persisted. */
  degradedNote?: string;
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

/** A pair whose bodies already match has nothing to merge, so no agent is spent on it. */
function nothingToMerge(p: MergePair): boolean {
  return p.draftBody.trim() === p.existingBody.trim();
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
          description: globalKbEntries.description,
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
          .select({ body: globalKbEntries.body, description: globalKbEntries.description })
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
            draftDescription: d.description,
            existingDescription: existing.description,
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
    // Merges KB entries against each other; reaches nothing outside the knowledge base.
    toolProfile: 'rag_only',
    // An undeclared budget is not "no limit" — it falls through to the docker runner's
    // DEFAULT_RUN_TIMEOUT_MS, which is 2 MINUTES. Every merge agent here was being
    // SIGKILLed almost at spawn and its draft counted as "skipped". One hour, matching
    // the other agent-backed mining steps (09_5, 09_5b, 11d, 03).
    timeoutMs: 60 * 60 * 1000,
    // One agent per draft pair, and an unmerged pair costs the cross-repo KB the extra
    // knowledge the draft carries. Same budget and classifier as 08c/08d.
    retry: { maxAttempts: 2, retryOnInvocationFailure: shouldRetryMiningTerminalFailure },
    async selectAgents({ detected }): Promise<AgentMiningDispatch[]> {
      // Mining has no bypass stub; under test bypass return [] so the smoke pipeline
      // runs without a real CLI provider (the drafts stay linked, unmerged).
      if (process.env.HAIVE_TEST_BYPASS_LLM === '1') return [];
      const { pairs } = detected as MergeDetect;
      return pairs
        .filter((p) => !nothingToMerge(p))
        .map((p) => ({
          agentId: `merge:${p.draftId}`,
          agentTitle: `KB merge: ${p.draftTitle}`,
          prompt: buildMergePrompt(p),
        }));
    },
  },

  async apply(ctx, args): Promise<MergeApply> {
    const { pairs } = args.detected as MergeDetect;
    const results = (args.agentMiningResults ?? []) as AgentMiningResult[];
    const mergedDrafts = new Set<string>();
    const leftDraft = new Set<string>();
    const editedDraft = new Set<string>();
    const finishedDraft = new Set<string>();
    let writeFailed = false;
    let merged = 0;
    try {
      const settings = await resolveGlobalKbSettings();
      if (settings.enabled) {
        await withGlobalKb(ctx.db, async ({ db: gdb }) => {
          for (const p of pairs) {
            const r = results.find((x) => x.agentId === `merge:${p.draftId}`);
            const body = r?.status === 'done' ? extractMergedArticle(r.rawOutput) : '';
            // Guard against an empty / truncated merge clobbering real content.
            const usable = body.length >= 40;
            // Agents run up to an hour; a draft activated meanwhile is no longer ours to write.
            const stillDraft = and(
              eq(globalKbEntries.id, p.draftId),
              eq(globalKbEntries.status, 'draft'),
            );
            if (nothingToMerge(p)) {
              merged += 1;
            } else if (usable) {
              const [hit] = await gdb
                .update(globalKbEntries)
                .set({ body, embedStatus: 'pending', updatedAt: new Date() })
                .where(and(stillDraft, eq(globalKbEntries.body, p.draftBody)))
                .returning({ id: globalKbEntries.id });
              if (hit) {
                mergedDrafts.add(p.draftId);
                merged += 1;
              } else {
                const [row] = await gdb
                  .select({ status: globalKbEntries.status })
                  .from(globalKbEntries)
                  .where(eq(globalKbEntries.id, p.draftId))
                  .limit(1);
                (row?.status === 'draft' ? editedDraft : leftDraft).add(p.draftId);
              }
            }
            // Activation archives the superseded entry, so a description it carried would otherwise be
            // lost; the draft's own, when it has one, stays.
            const inherited = p.draftDescription ? null : (p.existingDescription ?? null);
            if (inherited) {
              await gdb
                .update(globalKbEntries)
                .set({ description: inherited, updatedAt: new Date() })
                .where(and(stillDraft, isNull(globalKbEntries.description)));
            }
            finishedDraft.add(p.draftId);
          }
        });
      }
    } catch (err) {
      writeFailed = true;
      ctx.logger.warn({ err }, 'global KB merge: applying merged bodies failed');
    }
    // Unmerged drafts stay linked for manual review/merge at 09_6_5.
    const skipped = pairs.length - merged;
    ctx.logger.info({ merged, skipped, pairs: pairs.length }, 'global KB merge complete');
    // Per-draft view for the loss note. A draft is lost whether its agent DIED, returned no
    // article, or returned one too short to trust — all three leave the pair unmerged, and
    // `skipped` is a bare count on an output nobody reads back.
    const attempted = pairs.filter((p) => !nothingToMerge(p));
    const degradedNote = miningLossNote(
      'knowledge-base merge',
      attempted.map((p) => {
        const r = results.find((x) => x.agentId === `merge:${p.draftId}`);
        if (mergedDrafts.has(p.draftId)) {
          return {
            agentId: p.draftTitle,
            agentTitle: null,
            status: 'done' as const,
            errorMessage: null,
          };
        }
        return {
          agentId: p.draftTitle,
          agentTitle: null,
          status: 'failed' as const,
          errorMessage: leftDraft.has(p.draftId)
            ? 'no longer a draft when the merge finished'
            : editedDraft.has(p.draftId)
              ? 'edited while the merge ran; the edit was kept'
              : writeFailed && !finishedDraft.has(p.draftId)
                ? 'the merged article was not written: the knowledge base write failed'
                : (r?.errorMessage ?? (r ? 'no usable merged article in the reply' : 'not merged')),
        };
      }),
    );
    return { merged, skipped, ...(degradedNote ? { degradedNote } : {}) };
  },
};
