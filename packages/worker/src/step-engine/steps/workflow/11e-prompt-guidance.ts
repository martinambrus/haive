import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema } from '@haive/database';
import type { StepGuidanceCause } from '@haive/database';
import type { FormSchema } from '@haive/shared';
import type { StepContext, StepDefinition } from '../../step-definition.js';
import { isStepGuidanceEnabled } from '../../guidance-context.js';
import { loadRepoStackAnchors } from '../_repo-stack.js';
import { sanitizeGlobalArticle } from '../_global-kb-promote.js';
import { guidanceTargetStep, parsePromptDefects, type PromptDefect } from './_prompt-defect.js';

// Prompt-defect triage (plan lexical-jingling-dawn.md §2). Structurally a copy of
// 08e-insights-triage: scan this run's raw agent outputs for a markdown block the
// agents were invited to append, and let the user decide what to do with it. No CLI
// call of its own — everything it needs was already said during the run.
//
// The APPROVER IS THE HUMAN AT THIS FORM. There is deliberately no auto-generated
// "improved prompt" and no synthetic validation scenario: judging a rewritten prompt
// against a scenario the same model invented is intrinsic self-correction on a
// training set of size one, which degrades accuracy and costs more than the task it
// aims to improve. Nothing reaches a prompt without an explicit selection here.

/** Longest guidance string stored. Also applied at parse time; re-applied here
 *  because the global path rewrites the text (name scrubbing) after parsing. */
const MAX_GUIDANCE_CHARS = 400;

/** What this run can do with a candidate.
 *
 *  `new` is the only one the user decides: nothing is on record for it (or the only
 *  record is an archived item they turned off, which a fresh recurrence is worth
 *  re-asking about).
 *
 *  `active` is a defect that is ALREADY steering this step's prompt. It is not put to
 *  the user, and that is deliberate rather than a simplification: a multi-select whose
 *  UNCHECKED state deactivates existing guidance would wipe an approved set the moment
 *  anyone skipped the form -- and an auto-continued run submits exactly that empty
 *  default. The off-switch for an active item is the explicit Deactivate action on the
 *  repo tooling page, where it says what it does. Here the recurrence only bumps
 *  `occurrences`.
 *
 *  `display_only` is `task_description_defect`: it blames the USER's task text, which
 *  03b-business-requirements / 05-phase-0b5-spec-quality own. Shown so the signal is
 *  not lost, never stored -- appending a complaint about one task's wording to every
 *  later task's prompt is not a lesson about the step. */
export type GuidanceDisposition = 'new' | 'active' | 'display_only';

export interface GuidanceCandidate extends PromptDefect {
  /** The step whose prompt this would be appended to. */
  targetStep: string;
  /** Independent observations already on record for this fingerprint (0 = new).
   *  Repeated observation, NOT evidence that any guidance helped. */
  seen: number;
  disposition: GuidanceDisposition;
}

interface GuidanceDetect {
  candidates: GuidanceCandidate[];
  /** Source repo's project name, used to genericize a global item. */
  projectName: string | null;
  /** Stack facets stamped on a global item so it only reaches compatible repos. */
  stackFacets: Record<string, string[]>;
}

interface GuidanceApply {
  found: number;
  kept: number;
  globalKept: number;
  rejected: number;
  /** Already-active items this run observed again (occurrences bumped, not re-decided). */
  recurred: number;
  /** Fingerprints written as `active`, for the step summary. */
  activated: string[];
}

/** Parse every CLI invocation this task made, from the four capture steps.
 *  Same query shape as 08e's collectInsights — the block rides on output that was
 *  already produced and stored, so this costs one SELECT and no tokens. */
async function collectDefects(ctx: StepContext): Promise<PromptDefect[]> {
  const rows = await ctx.db
    .select({ stepId: schema.taskSteps.stepId, raw: schema.cliInvocations.rawOutput })
    .from(schema.cliInvocations)
    .innerJoin(schema.taskSteps, eq(schema.cliInvocations.taskStepId, schema.taskSteps.id))
    .where(eq(schema.cliInvocations.taskId, ctx.taskId));
  return parsePromptDefects(rows.map((r) => ({ stepId: r.stepId, raw: r.raw ?? '' })));
}

/** Existing rows for these fingerprints, restricted to the scopes this repo can see:
 *  its own repo-scoped rows and every global row. A row from ANOTHER repo must not
 *  suppress or inflate this repo's candidate. */
async function loadExisting(ctx: StepContext, repositoryId: string | null, fingerprints: string[]) {
  if (fingerprints.length === 0) return [];
  return ctx.db
    .select({
      fingerprint: schema.stepGuidance.fingerprint,
      status: schema.stepGuidance.status,
      occurrences: schema.stepGuidance.occurrences,
      repositoryId: schema.stepGuidance.repositoryId,
    })
    .from(schema.stepGuidance)
    .where(
      and(
        inArray(schema.stepGuidance.fingerprint, fingerprints),
        repositoryId
          ? sql`(${schema.stepGuidance.repositoryId} = ${repositoryId} OR ${schema.stepGuidance.repositoryId} IS NULL)`
          : sql`${schema.stepGuidance.repositoryId} IS NULL`,
      ),
    );
}

async function loadRepositoryId(ctx: StepContext): Promise<string | null> {
  const task = await ctx.db.query.tasks.findFirst({
    where: eq(schema.tasks.id, ctx.taskId),
    columns: { repositoryId: true },
  });
  return task?.repositoryId ?? null;
}

/** One stored row as the candidate filter needs to see it. */
export interface ExistingGuidanceRow {
  fingerprint: string;
  status: string;
  occurrences: number;
}

/** Turn parsed defects into triage candidates: drop anything already declined, place
 *  each on its target step, and annotate how often it has been seen. Pure, so the
 *  tombstone rule is testable without a database.
 *
 *  A tombstone is FINAL. The user saw this exact complaint and declined it; re-offering
 *  it would make every later run on this repo re-litigate a settled decision, which is
 *  the failure mode that makes a triage form get ignored. */
export function filterCandidates(
  defects: PromptDefect[],
  existing: ExistingGuidanceRow[],
): GuidanceCandidate[] {
  const out: GuidanceCandidate[] = [];
  for (const d of defects) {
    const rows = existing.filter((r) => r.fingerprint === d.fingerprint);
    if (rows.some((r) => r.status === 'rejected')) continue;
    const targetStep = guidanceTargetStep(d.sourceStep);
    if (!targetStep) continue;
    const disposition: GuidanceDisposition =
      d.cause === 'task_description_defect'
        ? 'display_only'
        : rows.some((r) => r.status === 'active')
          ? 'active'
          : 'new';
    out.push({
      ...d,
      targetStep,
      seen: Math.max(0, ...rows.map((r) => r.occurrences)),
      disposition,
    });
  }
  return out;
}

/** Candidates for this task: parsed, tombstone-filtered, occurrence-annotated. */
async function buildCandidates(ctx: StepContext): Promise<GuidanceCandidate[]> {
  const defects = await collectDefects(ctx);
  if (defects.length === 0) return [];
  const repositoryId = await loadRepositoryId(ctx);
  const existing = await loadExisting(
    ctx,
    repositoryId,
    defects.map((d) => d.fingerprint),
  );
  return filterCandidates(defects, existing);
}

const CAUSE_LABEL: Record<StepGuidanceCause, string> = {
  prompt_ambiguity: 'ambiguous instruction',
  missing_context: 'missing context',
  task_description_defect: 'task description (not offered)',
};

export const promptGuidanceStep: StepDefinition<GuidanceDetect, GuidanceApply> = {
  metadata: {
    id: '11e-prompt-guidance',
    workflowType: 'workflow',
    // 11.5 (the plan's number) belongs to 11b-kb-commit; 11.4/11.7 are 11d/11c. 11.8
    // puts triage at the end of the learning phase, before the 11a push gate (12).
    index: 11.8,
    title: 'Prompt guidance triage',
    description:
      'Instruction defects agents named during this run; you pick which become permanent step guidance.',
    requiresCli: false,
    cliRoles: undefined,
  },

  async shouldRun(ctx: StepContext): Promise<boolean> {
    // The switch first: a disabled install must not pay for the scan, and a repo that
    // opted out must never be shown a form whose approvals would never be injected.
    if (!(await isStepGuidanceEnabled(ctx.db, ctx.taskId))) return false;
    // At least one candidate the USER decides. A run whose only candidates are already
    // active, or are task-description complaints, has nothing to ask -- parking it for
    // an informational form the user can only dismiss is a click that buys nothing.
    // The cost is that such a run's recurrences are not counted; `occurrences` is a
    // rough repeat count for ranking, never a metric, so under-counting is acceptable.
    return (await buildCandidates(ctx)).some((c) => c.disposition === 'new');
  },

  async detect(ctx: StepContext): Promise<GuidanceDetect> {
    const repositoryId = await loadRepositoryId(ctx);
    const stack = repositoryId ? await loadRepoStackAnchors(ctx.db, repositoryId) : null;
    // Stack IDENTITY only (framework + major + language). Deliberately not the full
    // project facet set: `packages` lists every detected dependency and would pin a
    // wording lesson to a dependency list it has nothing to do with, and a datastore
    // major has no bearing on how an instruction reads. An unconstrained dimension is
    // universal under facetsMatchProject, which is the intended default here.
    const stackFacets: Record<string, string[]> = {};
    if (stack?.anchors.framework) stackFacets.framework = [stack.anchors.framework];
    if (stack?.anchors.frameworkMajor) {
      stackFacets.frameworkMajor = [stack.anchors.frameworkMajor];
    }
    if (stack?.language) stackFacets.language = [stack.language];
    return {
      candidates: await buildCandidates(ctx),
      projectName: stack?.projectName ?? null,
      stackFacets,
    };
  },

  form(_ctx, detected): FormSchema {
    const offerable = detected.candidates.filter((c) => c.disposition === 'new');
    const active = detected.candidates.filter((c) => c.disposition === 'active');
    const display = detected.candidates.filter((c) => c.disposition === 'display_only');
    const option = (c: GuidanceCandidate) => ({
      value: c.id,
      label: `${c.guidance}${c.seen > 0 ? ` (seen ${c.seen}x before)` : ''}`,
      description: [`${CAUSE_LABEL[c.cause]} — reported by ${c.sourceStep}`, c.evidence]
        .filter(Boolean)
        .join(' · '),
      group: c.targetStep,
    });
    return {
      title: 'Prompt guidance triage',
      description: [
        `Agents named ${offerable.length} instruction defect(s) during this run — cases where the`,
        'wording they were given, not the code, caused a round to be sent back.',
        'Anything you keep is APPENDED to that step’s prompt on future runs; anything you leave',
        'unchecked is remembered as declined and never offered again.',
        'Nothing here has been shown to improve results — a repeat count means the problem',
        'recurred, not that the guidance works.',
        active.length > 0
          ? `\n${active.length} item(s) recurred that are ALREADY applied to this step; nothing to ` +
            'decide, and their repeat count has been recorded. Turn one off on the repository ' +
            'tooling page:\n' +
            active.map((c) => `  - ${c.guidance}`).join('\n')
          : '',
        display.length > 0
          ? `\n${display.length} further item(s) blame the task description rather than Haive’s prompt; ` +
            'they are listed below for information only and are not stored:\n' +
            display.map((c) => `  - ${c.guidance}`).join('\n')
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      fields: [
        {
          type: 'multi-select',
          id: 'keep',
          label: 'Keep as guidance for this repository',
          options: offerable.map(option),
          defaults: [],
        },
        {
          type: 'multi-select',
          id: 'global',
          label: 'Also apply to every repository on this stack',
          description:
            'A subset of the above. The project name is scrubbed from the text, but a global item ' +
            'still carries wording authored about this repo — pick only what is genuinely general.',
          options: offerable.map(option),
          defaults: [],
        },
      ],
      submitLabel: 'Save guidance',
    };
  },

  async apply(ctx, args): Promise<GuidanceApply> {
    const d = args.detected;
    const values = args.formValues as { keep?: string[]; global?: string[] };
    const keep = new Set(Array.isArray(values.keep) ? values.keep : []);
    const globalIds = new Set(Array.isArray(values.global) ? values.global : []);
    const repositoryId = await loadRepositoryId(ctx);

    const activated: string[] = [];
    let kept = 0;
    let globalKept = 0;
    let rejected = 0;
    let recurred = 0;

    for (const c of d.candidates) {
      // Display-only class: the task text is 03b/05's business, not this table's.
      if (c.disposition === 'display_only') continue;

      // Already steering this step. Record the recurrence and move on -- the user was
      // not asked about it, so neither a keep nor a tombstone can be read from the form.
      if (c.disposition === 'active') {
        await ctx.db
          .update(schema.stepGuidance)
          .set({
            occurrences: sql`${schema.stepGuidance.occurrences} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.stepGuidance.fingerprint, c.fingerprint),
              eq(schema.stepGuidance.status, 'active'),
              repositoryId
                ? sql`(${schema.stepGuidance.repositoryId} = ${repositoryId} OR ${schema.stepGuidance.repositoryId} IS NULL)`
                : sql`${schema.stepGuidance.repositoryId} IS NULL`,
            ),
          );
        recurred += 1;
        continue;
      }

      // A `global` tick implies keeping the item — the second multi-select is a
      // subset of the first, and a user who ticked only the global box plainly meant
      // to keep it. Treating that as "declined" would write a tombstone for something
      // they just asked for.
      const wantGlobal = globalIds.has(c.id);
      const wantKeep = keep.has(c.id) || wantGlobal;

      if (!wantKeep) {
        // Tombstone. Recorded at repo scope (or global when the task has no repo) so a
        // later run on THIS repo never re-offers it; another repo may still be asked.
        await ctx.db
          .insert(schema.stepGuidance)
          .values({
            stepId: c.targetStep,
            scope: repositoryId ? 'repo' : 'global',
            repositoryId,
            facets: {},
            cause: c.cause,
            guidance: c.guidance,
            status: 'rejected',
            fingerprint: c.fingerprint,
            occurrences: 1,
            sourceTaskId: ctx.taskId,
            sourceStepId: c.sourceStep,
          })
          .onConflictDoNothing();
        rejected += 1;
        continue;
      }

      const scope = wantGlobal ? ('global' as const) : ('repo' as const);
      // Global text is genericized with the same pure scrubber promoted KB articles
      // use — it drops the project name and its package scope for an obvious
      // rename-me placeholder. Mitigation, not elimination: the real control is that
      // a human ticked this box for this line.
      const guidance = wantGlobal
        ? sanitizeGlobalArticle({ title: 'guidance', body: c.guidance, projectName: d.projectName })
            .body.trim()
            .slice(0, MAX_GUIDANCE_CHARS)
        : c.guidance;
      if (!guidance) continue;

      await ctx.db
        .insert(schema.stepGuidance)
        .values({
          stepId: c.targetStep,
          scope,
          repositoryId: wantGlobal ? null : repositoryId,
          facets: wantGlobal ? d.stackFacets : {},
          cause: c.cause,
          guidance,
          status: 'active',
          fingerprint: c.fingerprint,
          occurrences: 1,
          sourceTaskId: ctx.taskId,
          sourceStepId: c.sourceStep,
        })
        .onConflictDoUpdate({
          target: wantGlobal
            ? [schema.stepGuidance.stepId, schema.stepGuidance.fingerprint]
            : [
                schema.stepGuidance.stepId,
                schema.stepGuidance.repositoryId,
                schema.stepGuidance.fingerprint,
              ],
          // Both unique indexes are PARTIAL, so the conflict target has to name the same
          // predicate or Postgres cannot pick the index (42P10).
          targetWhere: wantGlobal
            ? sql`${schema.stepGuidance.repositoryId} IS NULL`
            : sql`${schema.stepGuidance.repositoryId} IS NOT NULL`,
          set: {
            occurrences: sql`${schema.stepGuidance.occurrences} + 1`,
            // An item the user archived by hand and then re-approved here is active
            // again — the second approval is the newer statement.
            status: 'active',
            updatedAt: new Date(),
          },
        });
      activated.push(c.fingerprint);
      kept += 1;
      if (wantGlobal) globalKept += 1;
    }

    ctx.logger.info(
      { found: d.candidates.length, kept, globalKept, rejected, recurred },
      'prompt guidance triage complete',
    );
    return { found: d.candidates.length, kept, globalKept, rejected, recurred, activated };
  },
};
