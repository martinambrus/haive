import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { extractProjectFacets, type ConfirmedStackValues, type ProjectFacetSet } from './facets.js';

// The stack-describing step outputs a task retrieves against, resolved once so
// every consumer scopes the global KB identically. Both the query side (the
// api's rag_search) and the prompt side (the worker's global KB digest) read
// this: a digest that advertises titles a later rag_search cannot retrieve is
// worse than no digest, and that is exactly what two separate facet
// derivations drift into.

export interface TaskStackContext {
  repositoryId: string | null;
  /** 04-tooling-infrastructure output (RAG mode / connection prefs). */
  toolingOutput: unknown;
  /** 01-env-detect detect column. */
  envDetect: unknown;
  /** 02-detection-confirmation output (user overrides on the detected stack). */
  confirmedOutput: unknown;
}

/** Resolve the stack-describing step outputs for a task. Workflow tasks have no
 *  04-tooling-infrastructure / 01-env-detect steps of their own, so fall back to
 *  the repo's most recent onboarding run (mirrors the 02-pre-rag-sync detect
 *  resolution). Without the fallback, ragMode resolves to 'none' and the facet
 *  set comes back empty for every workflow task. */
export async function resolveTaskStackContext(
  db: Database,
  taskId: string,
): Promise<TaskStackContext> {
  const taskRow = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  const repositoryId = taskRow?.repositoryId ?? null;

  let toolingOutput = (
    await db.query.taskSteps.findFirst({
      where: and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
      ),
      columns: { output: true },
    })
  )?.output;
  let envDetect = (
    await db.query.taskSteps.findFirst({
      where: and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '01-env-detect')),
      columns: { detectOutput: true },
    })
  )?.detectOutput;
  let confirmedOutput = (
    await db.query.taskSteps.findFirst({
      where: and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, '02-detection-confirmation'),
      ),
      columns: { output: true },
    })
  )?.output;

  if (!toolingOutput || !envDetect) {
    if (repositoryId) {
      const onboarding = await db.query.tasks.findFirst({
        where: and(
          eq(schema.tasks.repositoryId, repositoryId),
          eq(schema.tasks.type, 'onboarding'),
        ),
        orderBy: [desc(schema.tasks.createdAt)],
        columns: { id: true },
      });
      if (onboarding) {
        if (!toolingOutput) {
          toolingOutput = (
            await db.query.taskSteps.findFirst({
              where: and(
                eq(schema.taskSteps.taskId, onboarding.id),
                eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
              ),
              columns: { output: true },
            })
          )?.output;
        }
        if (!envDetect) {
          envDetect = (
            await db.query.taskSteps.findFirst({
              where: and(
                eq(schema.taskSteps.taskId, onboarding.id),
                eq(schema.taskSteps.stepId, '01-env-detect'),
              ),
              columns: { detectOutput: true },
            })
          )?.detectOutput;
        }
        if (!confirmedOutput) {
          confirmedOutput = (
            await db.query.taskSteps.findFirst({
              where: and(
                eq(schema.taskSteps.taskId, onboarding.id),
                eq(schema.taskSteps.stepId, '02-detection-confirmation'),
              ),
              columns: { output: true },
            })
          )?.output;
        }
      }
    }
  }

  return { repositoryId, toolingOutput, envDetect, confirmedOutput };
}

/** The confirmed stack overrides carried on a 02-detection-confirmation output. */
export function confirmedStackValues(confirmedOutput: unknown): ConfirmedStackValues | null {
  return (confirmedOutput as { values?: ConfirmedStackValues } | null)?.values ?? null;
}

/** The project facet set for a task, from its own steps or the repo's newest
 *  onboarding run. Empty facet set when nothing is resolvable — which the search
 *  filter reads as "no dimension constrained", not as "match nothing". */
export async function resolveTaskFacets(db: Database, taskId: string): Promise<ProjectFacetSet> {
  const ctx = await resolveTaskStackContext(db, taskId);
  return extractProjectFacets(ctx.envDetect, confirmedStackValues(ctx.confirmedOutput));
}
