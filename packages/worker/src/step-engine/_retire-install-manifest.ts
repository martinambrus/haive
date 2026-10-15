import { eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { lstatNoFollow, removeFileIfNoFollow } from '@haive/shared/fs-safe';
import {
  HAIVE_DATA_FILES,
  ONBOARDING_ENVIRONMENT_SCHEMA_VERSION,
  ONBOARDING_EXCLUSIONS_SCHEMA_VERSION,
  ONBOARDING_TOOLING_SCHEMA_VERSION,
} from '@haive/shared';
import {
  ENVIRONMENT_UNIT,
  PROJECT_STATE_DIR,
  TOOLING_UNIT_NAME,
  settingFileName,
  toolingUnitOf,
} from '@haive/shared/project-state';
import type { StepContext } from './step-definition.js';

export const INSTALL_MANIFEST_PATH = '.haive/install.json';

const RETIRE_READ_CAP = 8 * 1024 * 1024;

type Outcome = 'removed' | 'absent' | 'kept';
type RetireContext = Pick<StepContext, 'repoPath' | 'logger'>;
/** Awaited with the path of a Haive file just before it is unlinked; a throw keeps the file. */
type OnRetire = (path: string) => Promise<void>;

function jsonObject(data: Buffer): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

const isPlainObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isHaiveInstallManifest(data: Buffer): boolean {
  const doc = jsonObject(data);
  return (
    doc !== null &&
    doc.schemaVersion === 1 &&
    typeof doc.templateSetHash === 'string' &&
    Array.isArray(doc.templates)
  );
}

function isHaiveEnvironmentMirror(data: Buffer): boolean {
  const doc = jsonObject(data);
  return (
    doc !== null &&
    doc.schemaVersion === ONBOARDING_ENVIRONMENT_SCHEMA_VERSION &&
    isPlainObject(doc.envDetectData) &&
    isPlainObject(doc.confirmedValues)
  );
}

function isHaiveExclusionsMirror(data: Buffer): boolean {
  const doc = jsonObject(data);
  return (
    doc !== null &&
    doc.schemaVersion === ONBOARDING_EXCLUSIONS_SCHEMA_VERSION &&
    Array.isArray(doc.scopeExcludeGlobs) &&
    doc.scopeExcludeGlobs.every((glob) => typeof glob === 'string')
  );
}

function isHaiveToolingMirror(data: Buffer): boolean {
  const doc = jsonObject(data);
  return (
    doc !== null &&
    doc.schemaVersion === ONBOARDING_TOOLING_SCHEMA_VERSION &&
    isPlainObject(doc.tooling)
  );
}

/** Delete `path` while `accept` takes its bytes for Haive's own; the person's file at that name stays.
 *  `requires` is the record file that now carries the value: missing, nothing is deleted or reported.
 *  Never throws; a file it could not judge is reported as kept. */
async function retireHaiveFile(
  ctx: RetireContext,
  target: {
    path: string;
    label: string;
    accept: (data: Buffer) => boolean;
    requires?: string;
  },
  warnings: string[],
  onRetire?: OnRetire,
): Promise<Outcome> {
  let outcome: Outcome;
  let reason = `it is not a Haive ${target.label}`;
  try {
    if (target.requires && (await lstatNoFollow(ctx.repoPath, target.requires)) === null) {
      return 'kept';
    }
    outcome = await removeFileIfNoFollow(
      ctx.repoPath,
      target.path,
      async (data) => {
        if (!target.accept(data)) return false;
        try {
          await onRetire?.(target.path);
        } catch (err) {
          const cause = err instanceof Error ? err.message : String(err);
          reason = `its removal could not be recorded: ${cause}`;
          return false;
        }
        return true;
      },
      { maxBytes: RETIRE_READ_CAP },
    );
  } catch (err) {
    outcome = 'kept';
    reason = err instanceof Error ? err.message : String(err);
  }
  if (outcome === 'kept') {
    warnings.push(`${target.path} was left in place: ${reason}`);
    ctx.logger.warn({ path: target.path, reason }, `${target.label} kept`);
  }
  return outcome;
}

/** Delete `.haive/install.json` while it still has the shape Haive wrote it in: nothing reads it, and
 *  the project state record carries what it held. Any other file at that name is the person's. Never
 *  throws; a file it could not judge is reported as kept. */
export function retireInstallManifest(
  ctx: RetireContext,
  warnings: string[],
  onRetire?: OnRetire,
): Promise<Outcome> {
  return retireHaiveFile(
    ctx,
    { path: INSTALL_MANIFEST_PATH, label: 'install manifest', accept: isHaiveInstallManifest },
    warnings,
    onRetire,
  );
}

const unitPath = (rel: string): string => `${PROJECT_STATE_DIR}/${rel}`;

/** Whether the repository holds tooling the record cannot carry (another schema version, a unit past
 *  the file limit), so `tooling.json` stays the only copy. */
export async function toolingOutsideRecord(db: Database, repositoryId: string): Promise<boolean> {
  const [row] = await db
    .select({ onboardingTooling: schema.repositories.onboardingTooling })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  return row?.onboardingTooling != null && toolingUnitOf(row.onboardingTooling) === null;
}

/** Delete the legacy `.haive-data/environment.json`, `exclusions.json` and `tooling.json` mirrors, each
 *  once the record file carrying its value exists, except the paths in `keep`. Never throws. */
export async function retireLegacyMirrors(
  ctx: RetireContext,
  warnings: string[],
  keep: readonly string[] = [],
  onRetire?: OnRetire,
): Promise<Array<{ path: string; outcome: Outcome }>> {
  const targets = [
    {
      path: HAIVE_DATA_FILES.environment,
      label: 'environment mirror',
      accept: isHaiveEnvironmentMirror,
      requires: unitPath(ENVIRONMENT_UNIT),
    },
    {
      path: HAIVE_DATA_FILES.exclusions,
      label: 'exclusions mirror',
      accept: isHaiveExclusionsMirror,
      requires: unitPath(settingFileName('scope-exclude-globs')),
    },
    {
      path: HAIVE_DATA_FILES.tooling,
      label: 'tooling mirror',
      accept: isHaiveToolingMirror,
      requires: unitPath(settingFileName(TOOLING_UNIT_NAME)),
    },
  ];
  const results: Array<{ path: string; outcome: Outcome }> = [];
  for (const target of targets) {
    results.push({
      path: target.path,
      outcome: keep.includes(target.path)
        ? 'kept'
        : await retireHaiveFile(ctx, target, warnings, onRetire),
    });
  }
  return results;
}
