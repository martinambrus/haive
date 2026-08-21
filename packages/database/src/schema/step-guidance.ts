import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { repositories } from './repos.js';
import { tasks } from './tasks.js';

/** Scope of a learned guidance item. `repo` applies to one repository; `global`
 *  applies to every repository whose stack facets are compatible. */
export type StepGuidanceScope = 'repo' | 'global';

/** Why the instruction failed the agent, as classified by the agent that hit it.
 *  `task_description_defect` points at the USER's task text rather than at
 *  Haive's own prompt, so it is displayed at triage but never offered for
 *  guidance — 03b-business-requirements / 05-phase-0b5-spec-quality own that. */
export type StepGuidanceCause = 'prompt_ambiguity' | 'missing_context' | 'task_description_defect';

/** `active` is injected into the step's prompt. `rejected` is a TOMBSTONE: the
 *  user saw this candidate and declined it, and it must never be offered again.
 *  `archived` was active once and was turned off by hand. */
export type StepGuidanceStatus = 'active' | 'rejected' | 'archived';

/** Learned per-step prompt guidance: lessons about how HAIVE ASKED for the work,
 *  captured from validator/reviewer agents mid-run and approved by a human at
 *  11e-prompt-guidance.
 *
 *  Guidance is only ever APPENDED to a step's built prompt, never substituted for
 *  it. An override would bypass `adaptPromptForCliCapabilities` (dispatcher.ts),
 *  which rewrites canonical retrieval fragments and resolves
 *  `[[HAIVE_AGENT_DEFINITION:...]]` markers per CLI family — so codex/gemini would
 *  silently receive LSP-referencing text and agent-file paths they cannot use.
 *  Append also makes the rollback exact: flipping the feature switch off returns
 *  every prompt to byte-identical.
 *
 *  NO STATISTICAL VALIDATION. Sample counts per (step, repo) are far too low to
 *  show that a given item helped. `occurrences` is the honest substitute —
 *  repeated INDEPENDENT observation of the same defect, surfaced to the human who
 *  decides. Nothing here claims a measured improvement.
 *
 *  `provider_family` is recorded but NOT filtered on in v1: a lesson learned under
 *  one CLI family is applied to all of them. It is displayed in the UI so a
 *  wrong-family item can be archived by hand.
 *
 *  Global items are stack-scoped, not model-scoped, and DO NOT EXPIRE. A model
 *  upgrade can make one stale and there is no reaper; archive it by hand. */
export const stepGuidance = pgTable(
  'step_guidance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The step whose prompt this is appended to (e.g. `07-phase-2-implement`). */
    stepId: text('step_id').notNull(),
    scope: text('scope').$type<StepGuidanceScope>().notNull(),
    /** NULL for `global`. Cascade: a repo's own lessons die with the repo. */
    repositoryId: uuid('repository_id').references(() => repositories.id, { onDelete: 'cascade' }),
    /** Stack facets a `global` item applies to, in the SAME shape and matched by
     *  the SAME predicate (`facetsMatchProject`) as global-KB retrieval. An empty
     *  object therefore means "applies to every stack", exactly as it does there.
     *  Always `{}` for a `repo` item, which is scoped by repository_id instead. */
    facets: jsonb('facets').$type<Record<string, string[]>>().notNull().default({}),
    /** CLI family the defect was observed under (provenance/display only in v1). */
    providerFamily: text('provider_family'),
    cause: text('cause').$type<StepGuidanceCause>().notNull(),
    /** The line appended to the prompt: what the instruction SHOULD have said. */
    guidance: text('guidance').notNull(),
    status: text('status').$type<StepGuidanceStatus>().notNull().default('active'),
    /** Stable signature over (step, cause, guidance) with ids/paths/digits stripped,
     *  so the same complaint reported by a later run hashes equal — that is what
     *  increments `occurrences` instead of inserting a near-duplicate, and what lets
     *  a `rejected` tombstone suppress the candidate for good. */
    fingerprint: text('fingerprint').notNull(),
    /** Independent observations of this defect. NOT evidence that the guidance
     *  works — only that the problem recurred. Ranks the injection order. */
    occurrences: integer('occurrences').notNull().default(1),
    /** Provenance. Set null (not cascade) so an item outlives the task that
     *  produced it — the lesson is the point, the task is the receipt. */
    sourceTaskId: uuid('source_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    /** The step that REPORTED the defect (a validator/reviewer), which is not the
     *  step the guidance is attached to. */
    sourceStepId: text('source_step_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    // One row per (step, fingerprint) within a scope. Two PARTIAL uniques rather
    // than one coalesce() expression index over a sentinel uuid: repository_id is
    // genuinely NULL for a global item, and a partial index says so without
    // inventing a magic value that a future join could accidentally match.
    uniqueIndex('step_guidance_repo_fp_idx')
      .on(table.stepId, table.repositoryId, table.fingerprint)
      .where(sql`${table.repositoryId} IS NOT NULL`),
    uniqueIndex('step_guidance_global_fp_idx')
      .on(table.stepId, table.fingerprint)
      .where(sql`${table.repositoryId} IS NULL`),
    // The injection query: active rows for one step, then split by scope in JS.
    index('step_guidance_step_status_idx').on(table.stepId, table.status),
  ],
);

export const stepGuidanceRelations = relations(stepGuidance, ({ one }) => ({
  repository: one(repositories, {
    fields: [stepGuidance.repositoryId],
    references: [repositories.id],
  }),
  sourceTask: one(tasks, { fields: [stepGuidance.sourceTaskId], references: [tasks.id] }),
}));
