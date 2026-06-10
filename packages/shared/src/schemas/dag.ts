import { z } from 'zod';

/**
 * Phase 2c / Phase 3 DAG schemas. The sprint-planner and the coders emit
 * snake_case JSON (legacy contract); these parse that output. Step modules map
 * the parsed fields onto the camelCase task_dag_* columns.
 */

/** Per-issue guidance the sprint-planner attaches (legacy shape; all optional). */
export const dagIssueGuidanceSchema = z.object({
  needs_deeper_qa: z.boolean().optional(),
  estimated_scope: z.enum(['small', 'medium', 'large']).optional(),
  risk_rationale: z.string().optional(),
  testing_guidance: z.string().optional(),
  review_focus: z.string().optional(),
});
export type DagIssueGuidance = z.infer<typeof dagIssueGuidanceSchema>;

/** A single decomposed issue in a DAG sprint plan (legacy issue shape). */
export const dagIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(''),
  spec_sections: z.array(z.string()).default([]),
  acceptance_criteria: z.array(z.string()).default([]),
  depends_on: z.array(z.string()).default([]),
  level: z.number().int().min(0).default(0),
  estimated_files: z.array(z.string()).default([]),
  provides: z.string().default(''),
  guidance: dagIssueGuidanceSchema.optional(),
});
export type DagIssue = z.infer<typeof dagIssueSchema>;

/**
 * The sprint-planner's decision (Phase 2c). For mode=single the planner returns
 * empty issues/levels and max_parallel 1. `levels` is array-of-arrays of issue
 * ids per dependency wave. No upper cap on max_parallel — the executor bounds
 * the live fan-out by min(max_parallel, the admin MAX_PARALLEL_AGENTS cap).
 */
export const sprintPlanSchema = z.object({
  mode: z.enum(['single', 'dag']),
  rationale: z.string().default(''),
  max_parallel: z.number().int().min(1).default(1),
  issues: z.array(dagIssueSchema).default([]),
  levels: z.array(z.array(z.string())).default([]),
});
export type SprintPlan = z.infer<typeof sprintPlanSchema>;

/** A coder's ISSUE_RESULT_JSON emitted at the end of a Phase 3 implementation. */
export const dagIssueResultSchema = z.object({
  issue_id: z.string(),
  outcome: z.enum(['completed', 'completed_with_debt', 'failed_unrecoverable']),
  files_modified: z.array(z.string()).default([]),
  debt_items: z.array(z.unknown()).default([]),
  concerns: z.string().default(''),
});
export type DagIssueResult = z.infer<typeof dagIssueResultSchema>;
