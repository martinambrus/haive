import { and, asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import type { StatusSummaryItem } from '@haive/shared';
import { collapseToLine, isSingleLine, safeKey, survivesFence } from '../_untrusted-repo.js';
import { code } from './_plan-ops.js';

/** A place with the same code or defect that an implementing agent found and deliberately did
 *  NOT change, reported for the person at the review gate to decide on. */
export interface SimilarSite {
  path: string;
  lines?: string;
  reason: string;
}

/** A site as a gate shows it: which pass reported it. */
export interface GateSimilarSite extends SimilarSite {
  source: string;
  /** The first implementation round after the last one that reported this site to edit its file,
   *  so the site may have been fixed since. Absent when no later round touched the file. */
  editedInRound?: number;
}

export const SIMILAR_SITES_AT_GATE = 50;
const SIMILAR_SITE_REASON_CHARS = 200;
const LINES_PATTERN = /^\d+(-\d+)?(,\s*\d+(-\d+)?)*$/;

/** One spelling per path, so two passes naming one file key and compare as one. */
const canonicalPath = (path: string): string => path.trim().replace(/^(?:\.\/)+/, '');

/** Keep only well-formed entries from agent output. A path that could not be shown as itself or
 *  that leaves the repository drops the entry; malformed `lines` drops only the range. Nothing is
 *  capped here: the reply is already stored whole, and the gate is where the list is cut and the
 *  rest counted. */
export function sanitizeSimilarSites(raw: unknown): SimilarSite[] {
  if (!Array.isArray(raw)) return [];
  const out: SimilarSite[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { path, lines, reason } = item as Record<string, unknown>;
    if (typeof path !== 'string') continue;
    const p = canonicalPath(path);
    if (!p || !isSingleLine(p) || !survivesFence(p)) continue;
    if (p.startsWith('/') || p.split('/').includes('..')) continue;
    const site: SimilarSite = {
      path: p,
      reason:
        typeof reason === 'string'
          ? collapseToLine(reason).slice(0, SIMILAR_SITE_REASON_CHARS)
          : '',
    };
    const range =
      typeof lines === 'number' ? String(lines) : typeof lines === 'string' ? lines.trim() : '';
    if (LINES_PATTERN.test(range)) site.lines = range;
    out.push(site);
  }
  return out;
}

const siteKey = (s: SimilarSite): string => JSON.stringify([s.path, s.lines ?? '']);

/** Union two lists, first occurrence winning, so a later pass cannot erase what an earlier one
 *  reported. */
export function mergeSimilarSites<T extends SimilarSite>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const seen = new Set(existing.map(siteKey));
  const out = [...existing];
  for (const s of incoming) {
    if (seen.has(siteKey(s))) continue;
    seen.add(siteKey(s));
    out.push(s);
  }
  return out;
}

/** Every site this task's implementing passes reported, in the order the work ran: the DAG
 *  build's issues, then each round of 07. Re-sanitised on read, since a stored value is only as
 *  good as whatever wrote it. Only the merged list is capped, and what the cap cuts is counted in
 *  `omitted`. */
export async function loadTaskSimilarSites(
  db: Database,
  taskId: string,
): Promise<{ sites: GateSimilarSite[]; omitted: number }> {
  const issues = await db
    .select({ issueKey: schema.taskDagIssues.issueKey, sites: schema.taskDagIssues.similarSites })
    .from(schema.taskDagIssues)
    .where(eq(schema.taskDagIssues.taskId, taskId))
    .orderBy(asc(schema.taskDagIssues.level), asc(schema.taskDagIssues.issueKey));
  const rounds = await db
    .select({ round: schema.taskSteps.round, output: schema.taskSteps.output })
    .from(schema.taskSteps)
    .where(
      and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '07-phase-2-implement')),
    )
    .orderBy(asc(schema.taskSteps.round));
  let all: GateSimilarSite[] = [];
  // The last pass that reported each site; the DAG build (-1) runs before every round.
  const lastReport = new Map<string, number>();
  for (const issue of issues) {
    const source = `DAG issue ${safeKey(issue.issueKey)}`;
    const sites = sanitizeSimilarSites(issue.sites);
    for (const site of sites) lastReport.set(siteKey(site), lastReport.get(siteKey(site)) ?? -1);
    all = mergeSimilarSites(
      all,
      sites.map((s) => ({ ...s, source })),
    );
  }
  const touched: { round: number; files: Set<string> }[] = [];
  for (const row of rounds) {
    const source = `implementation round ${row.round}`;
    const output = row.output as { similarSites?: unknown; filesTouched?: unknown } | null;
    const sites = sanitizeSimilarSites(output?.similarSites);
    for (const site of sites) lastReport.set(siteKey(site), row.round);
    const files = Array.isArray(output?.filesTouched) ? output.filesTouched : [];
    touched.push({
      round: row.round,
      files: new Set(files.filter((f): f is string => typeof f === 'string').map(canonicalPath)),
    });
    all = mergeSimilarSites(
      all,
      sites.map((s) => ({ ...s, source })),
    );
  }
  // Shown beside the site rather than used to drop it: that round may have edited the file for
  // something else, and the site is then still unchanged.
  all = all.map((site) => {
    const after = lastReport.get(siteKey(site)) ?? -1;
    const edit = touched.find((t) => t.round > after && t.files.has(site.path));
    return edit ? { ...site, editedInRound: edit.round } : site;
  });
  return {
    sites: all.slice(0, SIMILAR_SITES_AT_GATE),
    omitted: Math.max(0, all.length - SIMILAR_SITES_AT_GATE),
  };
}

/** The gate row listing them, or null when there are none. `nextStep` says what this gate lets
 *  the person do about them. */
export function similarSitesRow(
  sites: readonly GateSimilarSite[],
  omitted: number,
  nextStep: string,
): StatusSummaryItem | null {
  if (sites.length === 0) return null;
  const total = sites.length + omitted;
  const where = total === 1 ? 'in this place and left it' : 'in these places and left them';
  const range = (lines: string): string => `${/^\d+$/.test(lines) ? 'line' : 'lines'} ${lines}`;
  const body = [
    `The implementing agent reported the same code or defect ${where} unchanged at that point. ${nextStep}`,
    '',
    ...sites.map(
      (s) =>
        `- ${code(s.path)}${s.lines ? ` (${range(s.lines)})` : ''}${s.reason ? ` — ${s.reason}` : ''} (from ${s.source}${s.editedInRound !== undefined ? `; its file was edited again in implementation round ${s.editedInRound}, so it may be addressed` : ''})`,
    ),
    ...(omitted > 0 ? ['', `${omitted} more not shown.`] : []),
  ].join('\n');
  return {
    label: 'Similar code elsewhere — not changed',
    status: 'info',
    statusLabel: `${total} FOUND`,
    detail: `${total} ${total === 1 ? 'place' : 'places'} left for you to decide on`,
    body,
    defaultOpen: false,
  };
}
