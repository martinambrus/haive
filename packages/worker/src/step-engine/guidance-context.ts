import { and, desc, eq, or } from 'drizzle-orm';
import type { Database } from '@haive/database';
import { schema } from '@haive/database';
import { CONFIG_KEYS, configService, logger } from '@haive/shared';
import { resolveTaskFacets } from '@haive/shared/global-kb';
import { facetsMatchProject } from './steps/_global-kb-digest.js';

const log = logger.child({ module: 'guidance-context' });

/** Marker opening the appended block. A literal delimiter, not a parsed contract —
 *  nothing reads it back; it exists so a human reading a recorded prompt can tell
 *  learned guidance from the step's own text. */
const GUIDANCE_MARKER = '## Learned guidance for this step';

/** Items appended to one prompt. Deliberately small: this is a nudge list a model
 *  reads before starting, not a knowledge base — past a handful the marginal item
 *  dilutes the ones that matter and the block starts competing with the spec. */
const MAX_ITEMS = 5;

/** Hard ceiling on the block. Enforced on top of MAX_ITEMS because item LENGTH is
 *  user-approved free text: five 400-char items would otherwise be 2 KB of prompt
 *  on every dispatch of that step, forever. */
const MAX_CHARS = 1500;

/** Rows scanned before facet filtering. Global items are filtered in JS (see below),
 *  so the fetch has to be bounded by something; ordered as the block is, this
 *  repository's own first, so what an overflowing corpus drops is the least-observed. */
const SCAN_LIMIT = 100;

/** Haive's note ABOUT the block, appended as its last line.
 *
 *  No `- ` bullet, for the reason the ledger gives: every bullet in this block is one whole
 *  lesson, and wearing the entry marker would make that false. It names what SURVIVES rather
 *  than what went, because the order is the selection rule — repo-scoped first, then by
 *  occurrences and recency — so "the ones you are not seeing rank below these" is the useful
 *  half. `atLeast` is for a FETCH that filled `SCAN_LIMIT`: the count is then a floor on what this
 *  block dropped, not the size of the corpus. Keyed on the fetched rows and NOT on the eligible
 *  ones, because facet matching happens after the limit — 100 rows of which 6 survive it is still
 *  a saturated scan, and claiming an exact count there would be this function's own defect in
 *  miniature. A saturated scan speaks even when it dropped nothing it
 *  read, since the rows past the limit were never read; null means there is nothing to say. */
export function guidanceOmissionNotice(omitted: number, atLeast: boolean): string | null {
  if (omitted === 0 && !atLeast) return null;
  const count = omitted === 0 ? 'possibly' : atLeast ? `at least ${omitted}` : `${omitted}`;
  const plural = omitted === 1 ? '' : 's';
  return `(${count} more approved lesson${plural} not shown — the repository's own and the most-observed are kept)`;
}

/** The gate's answer plus the repository it resolved, so a caller that needs both does
 *  not repeat the task lookup. `repositoryId` is null for a task with no repository and
 *  is meaningless when `enabled` is false. */
interface GuidanceGate {
  enabled: boolean;
  repositoryId: string | null;
}

/** Is learned step guidance active for this task — globally AND for its repository?
 *
 *  One gate for all three halves of the feature (capture, triage, injection) so they
 *  cannot disagree: a repo that opted out must not be asked for defects it will never
 *  be shown, nor shown a triage form whose approvals would never be injected.
 *
 *  Best-effort like every other reader on the dispatch path: a config or DB failure
 *  answers false, which is the pre-feature behaviour. */
async function resolveGate(db: Database, taskId: string): Promise<GuidanceGate> {
  const off: GuidanceGate = { enabled: false, repositoryId: null };
  try {
    if (!(await configService.getBoolean(CONFIG_KEYS.STEP_GUIDANCE_ENABLED, false))) return off;
    const task = await db.query.tasks.findFirst({
      where: eq(schema.tasks.id, taskId),
      columns: { repositoryId: true },
    });
    // A task with no repository has nothing to scope guidance to and mounts no repo
    // tree; there is no per-repo switch to consult, so the global one decides.
    if (!task?.repositoryId) return { enabled: true, repositoryId: null };
    const repo = await db.query.repositories.findFirst({
      where: eq(schema.repositories.id, task.repositoryId),
      columns: { stepGuidanceEnabled: true },
    });
    return { enabled: repo?.stepGuidanceEnabled ?? false, repositoryId: task.repositoryId };
  } catch (err) {
    log.warn({ err, taskId }, 'step-guidance gate unreadable; treating as disabled');
    return off;
  }
}

export async function isStepGuidanceEnabled(db: Database, taskId: string): Promise<boolean> {
  return (await resolveGate(db, taskId)).enabled;
}

/** Append this task's approved guidance for `stepId` to a built prompt.
 *
 *  APPEND ONLY, by design. A DB row must never replace buildPrompt output:
 *  `adaptPromptForCliCapabilities` (dispatcher.ts) runs over the built prompt doing
 *  exact-string swaps on canonical retrieval fragments and resolving
 *  `[[HAIVE_AGENT_DEFINITION:...]]` markers, so an overridden prompt would silently
 *  hand codex/gemini LSP-referencing text and agent-file paths they cannot use.
 *  Appending also makes the rollback exact — with the switch off, every prompt is
 *  byte-identical to a pre-feature run.
 *
 *  Shaped like terseness-context.ts, and best-effort for the same reason: guidance
 *  is an optional nudge, so a config blip, an unmigrated database, or a transient
 *  query failure returns the input string UNCHANGED rather than failing the step.
 *
 *  COVERAGE: called from the step-runner's `llm` dispatch only, so it reaches
 *  07-phase-2-implement (the sole guidance target today) on a normal run and on every
 *  fix round. It does NOT reach the DAG coder prompts (`dagExecute` builds those in
 *  dag-executor.ts) nor the agent-mining fan-outs — both build their prompts on paths
 *  of their own. A DAG-mode run therefore gets the guidance only once the fix loop
 *  routes back to 07. Widening this means calling it at those builders too, not
 *  moving it. */
export async function augmentPromptWithLearnedGuidance(
  db: Database,
  taskId: string,
  stepId: string,
  prompt: string,
): Promise<string> {
  try {
    const gate = await resolveGate(db, taskId);
    if (!gate.enabled) return prompt;

    // Scoped and ordered here rather than after the limit, or another repository's lessons and
    // higher-ranked global ones could fill the scan and leave this repository's own unread.
    const scopes = gate.repositoryId
      ? or(
          eq(schema.stepGuidance.scope, 'global'),
          and(
            eq(schema.stepGuidance.scope, 'repo'),
            eq(schema.stepGuidance.repositoryId, gate.repositoryId),
          ),
        )
      : eq(schema.stepGuidance.scope, 'global');
    const rows = await db
      .select({
        scope: schema.stepGuidance.scope,
        repositoryId: schema.stepGuidance.repositoryId,
        facets: schema.stepGuidance.facets,
        guidance: schema.stepGuidance.guidance,
      })
      .from(schema.stepGuidance)
      .where(
        and(
          eq(schema.stepGuidance.stepId, stepId),
          eq(schema.stepGuidance.status, 'active'),
          scopes,
        ),
      )
      .orderBy(
        desc(eq(schema.stepGuidance.scope, 'repo')),
        desc(schema.stepGuidance.occurrences),
        desc(schema.stepGuidance.updatedAt),
      )
      .limit(SCAN_LIMIT);
    if (rows.length === 0) return prompt;

    const repoRows = rows.filter(
      (r) => r.scope === 'repo' && !!gate.repositoryId && r.repositoryId === gate.repositoryId,
    );
    const globalCandidates = rows.filter((r) => r.scope === 'global');

    // Facet matching is an in-JS filter over the bounded fetch above, exactly as the
    // global-KB digest does it — and via the SAME predicate, so guidance scoping
    // cannot drift from what retrieval scopes on. facetsMatchProject treats a
    // dimension an item does not constrain as universal, so an item stored with no
    // facets applies to every stack; that is the global KB's rule, not an accident.
    let globalRows: typeof globalCandidates = [];
    if (globalCandidates.length > 0) {
      const projectFacets = await resolveTaskFacets(db, taskId);
      globalRows = globalCandidates.filter((r) => facetsMatchProject(r.facets, projectFacets));
    }

    // Repo-scoped first: it was approved about THIS codebase, so when the char cap
    // truncates, the item that survives is the more specific one.
    const eligible = [...repoRows, ...globalRows];
    const selected = eligible.slice(0, MAX_ITEMS);
    if (selected.length === 0) return prompt;

    const lines: string[] = [];
    let used = 0;
    for (const r of selected) {
      const line = `- ${r.guidance}`;
      if (used + line.length + 1 > MAX_CHARS) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length === 0) return prompt;

    // Both caps used to drop in silence, so a sixth approved lesson — or one that pushed the
    // block past MAX_CHARS — was simply absent and the list read as complete. That is the one
    // thing AGENTS.md forbids of a bounded block: a truncated fact reads as a whole one. Stated
    // the way the task ledger and `loadPriorFixContext` state theirs, and LOGGED as well, so a
    // corpus that keeps overflowing is visible without reading a prompt.
    const omitted = eligible.length - lines.length;
    const scanSaturated = rows.length >= SCAN_LIMIT;
    const notice = guidanceOmissionNotice(omitted, scanSaturated);
    if (notice) {
      log.info(
        { taskId, stepId, omitted, shown: lines.length, scanSaturated },
        'learned guidance incomplete; items not shown',
      );
    }

    return (
      prompt +
      '\n\n' +
      GUIDANCE_MARKER +
      '\n' +
      'Lessons a human approved after earlier runs of this step went wrong. Follow them.\n' +
      lines.join('\n') +
      (notice ? `\n${notice}` : '')
    );
  } catch (err) {
    log.warn({ err, taskId, stepId }, 'learned guidance lookup failed; prompt left unchanged');
    return prompt;
  }
}
