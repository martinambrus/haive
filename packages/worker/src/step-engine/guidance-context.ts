import { and, desc, eq } from 'drizzle-orm';
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
 *  so the fetch has to be bounded by something; ordered by the same rank the block
 *  uses, so what an overflowing corpus drops is the least-observed and stalest. */
const SCAN_LIMIT = 100;

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

    const rows = await db
      .select({
        scope: schema.stepGuidance.scope,
        repositoryId: schema.stepGuidance.repositoryId,
        facets: schema.stepGuidance.facets,
        guidance: schema.stepGuidance.guidance,
      })
      .from(schema.stepGuidance)
      .where(and(eq(schema.stepGuidance.stepId, stepId), eq(schema.stepGuidance.status, 'active')))
      .orderBy(desc(schema.stepGuidance.occurrences), desc(schema.stepGuidance.updatedAt))
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
    const selected = [...repoRows, ...globalRows].slice(0, MAX_ITEMS);
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

    return (
      prompt +
      '\n\n' +
      GUIDANCE_MARKER +
      '\n' +
      'Lessons a human approved after earlier runs of this step went wrong. Follow them.\n' +
      lines.join('\n')
    );
  } catch (err) {
    log.warn({ err, taskId, stepId }, 'learned guidance lookup failed; prompt left unchanged');
    return prompt;
  }
}
