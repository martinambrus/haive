import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import {
  CLI_PROVIDER_CATALOG,
  getCliProviderMetadata,
  type CliProviderMetadata,
  type CliProviderName,
} from '@haive/shared';

export async function loadCliProviderMetadata(
  db: Database,
  cliProviderId: string | null,
): Promise<CliProviderMetadata | null> {
  if (!cliProviderId) return null;
  const rows = await db
    .select({ name: schema.cliProviders.name })
    .from(schema.cliProviders)
    .where(eq(schema.cliProviders.id, cliProviderId))
    .limit(1);
  const name = rows[0]?.name;
  if (!name) return null;
  return CLI_PROVIDER_CATALOG[name] ?? null;
}

/** Repo-relative skills directories to write to and verify, one per unique
 *  projectSkillsDir across all ENABLED CLI providers for this user (claude/zai/amp
 *  collapse to .claude/skills; gemini -> .gemini/skills; codex -> .agents/skills).
 *  Returns `fallback` (default []) when no enabled provider declares a skills dir.
 *  Bundle-expansion callers take the empty default so expansion no-ops rather than
 *  writing to a dir no CLI asked for; the write/verify steps (09_5/09_6) pass
 *  ['.claude/skills'] so they always have somewhere to target. */
export async function resolveSkillTargetDirs(
  db: Database,
  userId: string,
  fallback: string[] = [],
): Promise<string[]> {
  const rows = await db.query.cliProviders.findMany({
    where: eq(schema.cliProviders.userId, userId),
    columns: { name: true, enabled: true },
  });
  const targets = new Set<string>();
  for (const row of rows) {
    if (!row.enabled) continue;
    const dir = getCliProviderMetadata(row.name as CliProviderName).projectSkillsDir;
    if (dir) targets.add(dir);
  }
  return targets.size > 0 ? Array.from(targets) : fallback;
}

export async function loadPreviousStepOutput(
  db: Database,
  taskId: string,
  stepId: string,
): Promise<{ detect: unknown; output: unknown; iterations: unknown[] } | null> {
  const rows = await db
    .select()
    .from(schema.taskSteps)
    .where(and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, stepId)))
    // Latest round wins: during forward execution the current round is the highest
    // that exists, so this returns the current round's row for repeating steps and
    // round 0 for steps that never recur. (Fix-loop rounds.)
    .orderBy(desc(schema.taskSteps.round))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    detect: row.detectOutput,
    output: row.output,
    iterations: (row.iterations ?? []) as unknown[],
  };
}

/** Which value wins for one confirmable project field.
 *
 *  Only a non-empty confirmed value wins: the form submits every field, so an untouched
 *  one arrives as '' and must not erase what the scan found. */
function pickConfirmed(
  confirmed: Record<string, unknown> | undefined,
  detected: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const c = confirmed?.[key];
  if (typeof c === 'string' && c.trim().length > 0) return c;
  const d = detected?.[key];
  return typeof d === 'string' && d.length > 0 ? d : null;
}

/** The precedence rule, separated from the two DB reads so it can be tested without
 *  standing up a query builder. */
export function mergeConfirmedProject(
  detectedProject: Record<string, unknown> | undefined,
  confirmedValues: Record<string, unknown> | undefined,
): { framework: string | null; primaryLanguage: string | null } {
  return {
    framework: pickConfirmed(confirmedValues, detectedProject, 'framework'),
    primaryLanguage: pickConfirmed(confirmedValues, detectedProject, 'primaryLanguage'),
  };
}

/** What this run is actually working with: 01-env-detect's scan, overlaid with the
 *  values the user confirmed at 02.
 *
 *  Reading the detect payload alone makes a correction at that gate do nothing, which is
 *  the opposite of what a confirmation step is for. It also split the run in two:
 *  `07-generate-files` already overlays the confirmed values (`extractProjectInfo`), so a
 *  corrected framework decided WHICH agent templates got written while the raw one still
 *  decided which agents were offered (06_5), what the scope pickers excluded (06_7, 09_7)
 *  and how the global KB was scoped. One answer per run. */
export async function resolveConfirmedProject(
  db: Database,
  taskId: string,
): Promise<{ framework: string | null; primaryLanguage: string | null }> {
  const [envPrev, confirmPrev] = await Promise.all([
    loadPreviousStepOutput(db, taskId, '01-env-detect'),
    loadPreviousStepOutput(db, taskId, '02-detection-confirmation'),
  ]);
  return mergeConfirmedProject(
    (envPrev?.detect as { data?: { project?: Record<string, unknown> } } | null)?.data?.project,
    (confirmPrev?.output as { values?: Record<string, unknown> } | null)?.values,
  );
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function countFilesMatching(
  root: string,
  predicate: (relPath: string, isDir: boolean) => boolean,
  maxDepth = 3,
): Promise<number> {
  let total = 0;
  await walk(root, '', 0, maxDepth, (rel, isDir) => {
    if (predicate(rel, isDir)) total += 1;
  });
  return total;
}

export async function listFilesMatching(
  root: string,
  predicate: (relPath: string, isDir: boolean) => boolean,
  maxDepth = 3,
): Promise<string[]> {
  const out: string[] = [];
  await walk(root, '', 0, maxDepth, (rel, isDir) => {
    if (predicate(rel, isDir)) out.push(rel);
  });
  return out;
}

type Visitor = (relPath: string, isDir: boolean) => void;

async function walk(
  root: string,
  rel: string,
  depth: number,
  maxDepth: number,
  visit: Visitor,
): Promise<void> {
  if (depth > maxDepth) return;
  const dir = path.join(root, rel);
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      visit(childRel, true);
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'vendor') {
        continue;
      }
      await walk(root, childRel, depth + 1, maxDepth, visit);
    } else if (entry.isFile()) {
      visit(childRel, false);
    }
  }
}
