import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
  type OnboardingEnvironmentMirror,
  type OnboardingToolingMirror,
} from '../types/index.js';
import { extractProjectFacets, type ConfirmedStackValues, type ProjectFacetSet } from './facets.js';

// The stack-describing step outputs a task retrieves against, resolved once so
// every consumer scopes the global KB identically. Both the query side (the
// api's rag_search) and the prompt side (the worker's global KB digest) read
// this: a digest that advertises titles a later rag_search cannot retrieve is
// worse than no digest, and that is exactly what two separate facet
// derivations drift into.

export interface TaskStackContext {
  repositoryId: string | null;
  /** `04-tooling-infrastructure`'s `tooling` OBJECT — never the `{ tooling }` wrapper.
   *  Normalised here on purpose: the step row and the repo mirror nest it differently,
   *  and handing callers the raw blob is what let those two shapes diverge. */
  tooling: Record<string, unknown> | null;
  /** `01-env-detect`'s detect `.data` — never the `{ data }` wrapper. Hand a caller the
   *  wrapper and `data.project.name` reads `undefined`, which resolves projectName to
   *  'default' and makes the api CREATE an empty `haive_rag_default`. */
  envDetectData: Record<string, unknown> | null;
  /** `02-detection-confirmation`'s confirmed overrides on the detected stack. */
  confirmed: ConfirmedStackValues | null;
}

/** envDetectData and confirmed always travel together: they are the DETECTED and
 *  CONFIRMED halves of one stack answer, and mixing tiers yields a stack that was
 *  never true (PHP 8 detected on a later round, PHP 7 confirmed on an earlier one). */
export interface StackTier {
  envDetectData: Record<string, unknown>;
  confirmed: ConfirmedStackValues | null;
}

export interface ResolvedTier {
  tooling: Record<string, unknown> | null;
  stack: StackTier | null;
}

/** The three stack-describing rows of one task. `orderBy desc(round)` matters: fix-loop
 *  and retried steps materialise a row per round, so an unordered findFirst returns an
 *  arbitrary one — the worker's `loadPreviousStepOutput` has always ordered this way. */
async function readStepTier(db: Database, taskId: string): Promise<ResolvedTier> {
  const [toolingRow, envRow, confirmedRow] = await Promise.all([
    db.query.taskSteps.findFirst({
      where: and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, '04-tooling-infrastructure'),
      ),
      orderBy: [desc(schema.taskSteps.round)],
      columns: { output: true },
    }),
    db.query.taskSteps.findFirst({
      where: and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '01-env-detect')),
      orderBy: [desc(schema.taskSteps.round)],
      columns: { detectOutput: true },
    }),
    db.query.taskSteps.findFirst({
      where: and(
        eq(schema.taskSteps.taskId, taskId),
        eq(schema.taskSteps.stepId, '02-detection-confirmation'),
      ),
      orderBy: [desc(schema.taskSteps.round)],
      columns: { output: true },
    }),
  ]);

  const tooling = (toolingRow?.output as { tooling?: Record<string, unknown> } | null)?.tooling;
  const envData = (envRow?.detectOutput as { data?: Record<string, unknown> } | null)?.data;

  return {
    tooling: tooling ?? null,
    stack: envData
      ? { envDetectData: envData, confirmed: confirmedStackValues(confirmedRow?.output) }
      : null,
  };
}

/** The same three answers as written onto the repository ROW at onboarding, and restored
 *  from a committed `.haive-data/` by `importHaiveDataMirror` on clone/upload.
 *
 *  This tier is why the function exists. A repo recovered from its mirror has the columns
 *  and NO onboarding task, so a task-steps-only resolution returned nothing and `ragMode`
 *  fell to 'none' — MEASURED, 17 of 17 rag_search calls returned zero hits against a
 *  9,272-chunk index, with no error and no warning anywhere. The worker's indexing side
 *  has always read these columns; the query side had not, which is the whole divergence.
 *
 *  Preferring the mirror over the onboarding task costs nothing: `04-tooling-infrastructure`
 *  rewrites the column on EVERY onboarding run from the same object it returns as its step
 *  output, so the two can never disagree — while the onboarding-task lookup picks the newest
 *  run with no status filter, which during a re-onboarding is one whose 04 has not produced
 *  output yet. */
async function readMirrorTier(db: Database, repositoryId: string): Promise<ResolvedTier> {
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { onboardingTooling: true, onboardingEnvironment: true },
  });

  return stackContextFromMirror(repo?.onboardingTooling, repo?.onboardingEnvironment);
}

/** The mirror tier as a PURE function of the two repository columns.
 *
 *  Split out because the repository-delete path reads those columns inside its own
 *  transaction and cannot call a `Database`-taking resolver there: `collectInternalRag
 *  ProjectNamesForRepo` receives a `PgTransaction`, which is not structurally assignable
 *  to `PostgresJsDatabase` (it has no `$client`). Handing that caller the two blobs it
 *  has already selected keeps one parser for both, which is the point — a second reading
 *  of these columns is how the retrieval bugs in 013af86e happened. */
export function stackContextFromMirror(
  onboardingTooling: unknown,
  onboardingEnvironment: unknown,
): ResolvedTier {
  const toolingMirror = onboardingTooling as OnboardingToolingMirror | null | undefined;
  const envMirror = onboardingEnvironment as OnboardingEnvironmentMirror | null | undefined;

  const tooling =
    toolingMirror?.schemaVersion === ONBOARDING_TOOLING_SCHEMA_VERSION && toolingMirror.tooling
      ? toolingMirror.tooling
      : null;

  // `envDetectData` IS the raw `.data`, unlike a step row's `{ data }` wrapper.
  const stack =
    envMirror?.schemaVersion === ONBOARDING_ENVIRONMENT_SCHEMA_VERSION && envMirror.envDetectData
      ? {
          envDetectData: envMirror.envDetectData,
          confirmed: (envMirror.confirmedValues as ConfirmedStackValues | undefined) ?? null,
        }
      : null;

  return { tooling, stack };
}

/** The project name a repository's RAG store is keyed on, from its mirror columns alone,
 *  plus the ragMode that decides whether Haive owns that store at all. Returns null when
 *  the mirror says nothing — never 'default', because a caller enumerating databases to
 *  clean must not be handed a name the repo never used. */
export function repoRagIdentityFromMirror(
  onboardingTooling: unknown,
  onboardingEnvironment: unknown,
): { projectName: string; ragMode: string } | null {
  const tier = stackContextFromMirror(onboardingTooling, onboardingEnvironment);
  const ragMode = (tier.tooling as { ragMode?: string } | null)?.ragMode;
  const projectName = (tier.stack?.envDetectData as { project?: { name?: string } } | undefined)
    ?.project?.name;
  if (!ragMode || !projectName || !projectName.trim()) return null;
  return { projectName: projectName.trim(), ragMode };
}

/** Resolve the stack-describing answers for a task, in three tiers: the task's own steps,
 *  then the repository mirror, then the repo's most recent onboarding run. Workflow tasks
 *  have no 04-tooling-infrastructure / 01-env-detect steps of their own, so in practice
 *  every workflow task is answered by tier 2 or 3 — without them ragMode resolves to
 *  'none' and the facet set comes back empty.
 *
 *  Resolved per TIER, never per field, for the stack half: see `StackTier`. */
export async function resolveTaskStackContext(
  db: Database,
  taskId: string,
): Promise<TaskStackContext> {
  const taskRow = await db.query.tasks.findFirst({
    where: eq(schema.tasks.id, taskId),
    columns: { repositoryId: true },
  });
  const repositoryId = taskRow?.repositoryId ?? null;

  const own = await readStepTier(db, taskId);
  let tooling = own.tooling;
  let stack = own.stack;

  if ((!tooling || !stack) && repositoryId) {
    const mirror = await readMirrorTier(db, repositoryId);
    tooling ??= mirror.tooling;
    stack ??= mirror.stack;

    if (!tooling || !stack) {
      const onboarding = await db.query.tasks.findFirst({
        where: and(
          eq(schema.tasks.repositoryId, repositoryId),
          eq(schema.tasks.type, 'onboarding'),
        ),
        orderBy: [desc(schema.tasks.createdAt)],
        columns: { id: true },
      });
      if (onboarding) {
        const prev = await readStepTier(db, onboarding.id);
        tooling ??= prev.tooling;
        stack ??= prev.stack;
      }
    }
  }

  return {
    repositoryId,
    tooling,
    envDetectData: stack?.envDetectData ?? null,
    confirmed: stack?.confirmed ?? null,
  };
}

/** The confirmed stack overrides carried on a 02-detection-confirmation output. */
export function confirmedStackValues(confirmedOutput: unknown): ConfirmedStackValues | null {
  return (confirmedOutput as { values?: ConfirmedStackValues } | null)?.values ?? null;
}

/** The project name the per-project RAG database is keyed on. 'default' is a real
 *  fallback, not a placeholder — it names a database, so reaching it by accident
 *  creates an empty store and reports "index not built yet". */
export function stackProjectName(ctx: TaskStackContext): string {
  return (
    ((ctx.envDetectData as { project?: { name?: string } } | null)?.project?.name ?? 'default') ||
    'default'
  );
}

/** The project facet set for a task, from its own steps, the repo mirror, or the repo's
 *  newest onboarding run. An EMPTY facet set is not "no dimension constrained" — for a
 *  global KB entry that constrains any dimension, `facetsMatchProject` returns false when
 *  the project has no values for it, so an empty set matches only entries with no facets
 *  at all. That is why resolving the mirror tier WIDENS what a restored repo can retrieve. */
export async function resolveTaskFacets(db: Database, taskId: string): Promise<ProjectFacetSet> {
  const ctx = await resolveTaskStackContext(db, taskId);
  return extractProjectFacets(ctx.envDetectData, ctx.confirmed);
}
