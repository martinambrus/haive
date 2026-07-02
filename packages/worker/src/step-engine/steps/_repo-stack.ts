import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { ONBOARDING_ENVIRONMENT_SCHEMA_VERSION } from '@haive/shared';
import type { DetectResult, OnboardingEnvironmentMirror } from '@haive/shared';
import {
  resolveStackVersions,
  type ConfirmedStackValues,
  type GlobalKbFacets,
} from '@haive/shared/global-kb';
import { loadPreviousStepOutput } from './onboarding/_helpers.js';

/** The detected-stack fields techAnchorFacets reads to version-anchor a promoted
 *  global article. A subset of onboarding's KnowledgeDetect (which satisfies this
 *  structurally), so both the onboarding step and the workflow learning step can
 *  feed it. */
export interface StackAnchors {
  framework: string | null;
  frameworkMajor: string | null;
  phpMajor: string | null;
  database: string | null;
  dbMajor: string | null;
  packages: string[];
}

/** Derive version-anchor facets for a deterministically-promoted tech-bucket entry
 *  from its `tech` slug + the detected stack, anchoring to what is actually
 *  installed: PHP -> language+phpMajor; a datastore -> database+dbMajor (installed
 *  engine + major); a detected dependency -> packages; the framework ->
 *  framework+frameworkMajor. When nothing anchors (e.g. jquery/fckeditor with no
 *  detectable version), no anchor is added and the caller keeps the entry local.
 *
 *  Lives here (not in step 08) so the workflow learning step reuses the SAME
 *  deterministic anchoring — the LLM's free-form tech/facets drift (php<->php5)
 *  and broke dedup, which is why this is detection-derived. */
export function techAnchorFacets(
  techRaw: string | undefined,
  base: GlobalKbFacets,
  anchors: StackAnchors,
): GlobalKbFacets {
  const f: GlobalKbFacets = { ...base };
  if (f.packages?.length) return f; // already module-scoped
  const tech = (techRaw ?? '').trim().toLowerCase();
  if (!tech) return f;

  // PHP language knowledge.
  if (tech === 'php' && anchors.phpMajor) {
    f.language = ['php'];
    f.phpMajor = [anchors.phpMajor];
    return f;
  }
  // Datastore knowledge — anchor to the INSTALLED engine + major.
  const isDbTech = ['mysql', 'mariadb', 'maria', 'sql'].includes(tech) || tech === anchors.database;
  if (isDbTech && anchors.database && anchors.dbMajor) {
    const engines = new Set<string>([anchors.database]);
    if (tech === 'mysql' || tech === 'mariadb') engines.add(tech);
    f.database = [...engines];
    f.dbMajor = [anchors.dbMajor];
    return f;
  }
  // A detected dependency whose package name matches the tech slug.
  const pkg = anchors.packages.find((p) => {
    const name = (p.split('@')[0] ?? '').toLowerCase();
    return name === tech || name.split('/').pop() === tech;
  });
  if (pkg) {
    f.packages = [pkg];
    return f;
  }
  // The framework itself.
  if (anchors.framework && tech === anchors.framework.toLowerCase() && anchors.frameworkMajor) {
    f.framework = [anchors.framework];
    f.frameworkMajor = [anchors.frameworkMajor];
    return f;
  }
  return f; // no anchor derivable → caller keeps it local
}

/** The detect-column data shape we read from a persisted 01-env-detect step.
 *  Superset of the shared EnvDetectDataish (adds project.name), so it is still
 *  assignable to resolveStackVersions. */
interface EnvDetectShape {
  project?: {
    framework?: string;
    frameworkMajor?: string | null;
    primaryLanguage?: string;
    name?: string;
    packages?: string[];
  };
  stack?: {
    language?: string | null;
    runtimeVersions?: Record<string, string>;
    database?: { type?: string | null; version?: string | null } | null;
  };
}

/** Load a repository's installed-stack anchors from its most recent COMPLETED
 *  onboarding task (01-env-detect + 02-detection-confirmation), so a workflow step
 *  that lives in a different task can version-anchor a promoted global article the
 *  same way onboarding does. null when the repo has never completed onboarding. */
export async function loadRepoStackAnchors(
  db: Database,
  repositoryId: string,
): Promise<{ anchors: StackAnchors; language: string | null; projectName: string | null } | null> {
  // Prefer the repo-level onboarding mirror — it survives a clone to another
  // machine, where the onboarding task's rows/step outputs don't exist. Fall
  // back to the onboarding task's outputs for repos onboarded before the mirror
  // column existed (no backfill).
  const [repo] = await db
    .select({ onboardingEnvironment: schema.repositories.onboardingEnvironment })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  const mirror = repo?.onboardingEnvironment as OnboardingEnvironmentMirror | null | undefined;

  let data: EnvDetectShape;
  let confirmed: ConfirmedStackValues | null;
  if (mirror && mirror.schemaVersion === ONBOARDING_ENVIRONMENT_SCHEMA_VERSION) {
    data = (mirror.envDetectData ?? {}) as EnvDetectShape;
    confirmed = (mirror.confirmedValues as ConfirmedStackValues | undefined) ?? null;
  } else {
    const [task] = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.repositoryId, repositoryId),
          eq(schema.tasks.type, 'onboarding'),
          eq(schema.tasks.status, 'completed'),
        ),
      )
      .orderBy(desc(schema.tasks.completedAt))
      .limit(1);
    if (!task) return null;

    const envPrev = await loadPreviousStepOutput(db, task.id, '01-env-detect');
    data = ((envPrev?.detect as DetectResult | null)?.data ?? {}) as EnvDetectShape;
    const confirmedPrev = await loadPreviousStepOutput(db, task.id, '02-detection-confirmation');
    confirmed = (confirmedPrev?.output as { values?: ConfirmedStackValues } | null)?.values ?? null;
  }

  const { phpMajor, database, dbMajor } = resolveStackVersions(data, confirmed);
  const project = data.project ?? {};
  return {
    anchors: {
      framework: project.framework ?? null,
      frameworkMajor: project.frameworkMajor ?? null,
      phpMajor,
      database,
      dbMajor,
      packages: project.packages ?? [],
    },
    language: project.primaryLanguage ?? data.stack?.language ?? null,
    projectName: project.name ?? null,
  };
}
