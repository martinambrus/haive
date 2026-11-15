import { createHash } from 'node:crypto';
import { and, asc, eq, ilike } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { reviewerOutputSchema } from '@haive/shared';
import type {
  Insight,
  LoadedInsight,
  InsightSourceRef,
  InsightLoadOptions,
  InsightLoadResult,
} from '@haive/shared/step';
import { collapseToLine } from '../_untrusted-repo.js';

interface InsightOutput {
  stepId: string;
  raw: string;
  sourceRefs?: InsightSourceRef[];
  /** A withheld finding already covered by written text contributes provenance, not a new record. */
  aliases?: { title: string; location: string }[];
}

// Keep the legacy selection/count key: full fields, case-insensitive, with line numbers intact.
const insightKey = (i: { title: string; location: string }): string =>
  `${i.title}::${i.location}`.toLowerCase();

type SourcedInsight = Insight & Pick<LoadedInsight, 'sourceRefs'>;

function addSourceRefs(
  insight: SourcedInsight,
  refs: readonly InsightSourceRef[] | undefined,
): void {
  if (!refs?.length) return;
  const target = (insight.sourceRefs ??= []);
  for (const ref of refs) {
    if (!target.some((existing) => JSON.stringify(existing) === JSON.stringify(ref)))
      target.push(ref);
  }
}

/** The one parser for `## INSIGHTS` blocks. The legacy form keeps positional ids and its default
 *  cap; loadUnactedInsights projects stable occurrence ids over the uncapped records instead. */
export function parseInsights(outputs: InsightOutput[], limit?: number): Insight[];
export function parseInsights(
  outputs: InsightOutput[],
  limit: number,
  options: { includeSourceRefs: true },
): SourcedInsight[];
export function parseInsights(
  outputs: InsightOutput[],
  limit = 30,
  options = { includeSourceRefs: false },
): SourcedInsight[] {
  const seen = new Map<string, SourcedInsight>();
  const out: SourcedInsight[] = [];
  for (const { stepId, raw, sourceRefs } of outputs) {
    if (!raw) continue;
    const sections = [...raw.matchAll(/##\s*INSIGHTS\b([\s\S]*?)(?=\n##\s|\n```|$)/gi)];
    for (const line of sections.flatMap((m) => m[1]!.split('\n'))) {
      const im = /^\s*[-*]\s*INSIGHT:\s*(.+)$/i.exec(line);
      if (!im) continue;
      const parts = im[1]!.split('|').map((p) => p.trim());
      const title = parts[0] ?? '';
      if (!title) continue;
      const location = parts[1] ?? '';
      const description = parts.slice(2).join(' | ') || parts[1] || '';
      const key = insightKey({ title, location });
      const existing = seen.get(key);
      if (existing) {
        if (options.includeSourceRefs) addSourceRefs(existing, sourceRefs);
        continue;
      }
      if (out.length >= limit) continue;
      const insight: SourcedInsight = {
        id: `i-${out.length + 1}`,
        sourceStep: stepId,
        title,
        location,
        description,
      };
      if (options.includeSourceRefs) addSourceRefs(insight, sourceRefs);
      seen.set(key, insight);
      out.push(insight);
    }
  }
  // Aliases carry host-owned references only; no withheld value is interpreted as Markdown here.
  for (const output of outputs) {
    for (const alias of output.aliases ?? []) {
      const insight = seen.get(insightKey(alias));
      if (insight && options.includeSourceRefs) addSourceRefs(insight, output.sourceRefs);
    }
  }
  return out;
}

const normalizeFinding = (text: string): string => collapseToLine(text).toLowerCase();

type WithheldFinding = { file?: string | null; description: string; suggestion?: string | null };

/** What names a finding: its description, else its suggestion, else its file. */
const findingText = (f: WithheldFinding): string =>
  collapseToLine(f.description) ||
  collapseToLine(f.suggestion ?? '') ||
  collapseToLine(f.file ? `out-of-scope finding at ${f.file}` : 'out-of-scope finding');

/** The identity of a finding: its file (without a trailing line number) and its normalized name. */
export const findingIdentity = (f: WithheldFinding): string =>
  `${normalizeFinding((f.file ?? '').replace(/:\d+(-\d+)?$/, ''))}::${normalizeFinding(findingText(f))}`;

/** Historical invocation sources, including superseded runs, then DAG-withheld findings. */
export async function loadInsightOutputs(db: Database, taskId: string): Promise<InsightOutput[]> {
  const rows = await db
    .select({
      stepId: schema.taskSteps.stepId,
      raw: schema.cliInvocations.rawOutput,
      invocationId: schema.cliInvocations.id,
      taskStepId: schema.taskSteps.id,
      round: schema.taskSteps.round,
      supersededAt: schema.cliInvocations.supersededAt,
    })
    .from(schema.cliInvocations)
    .innerJoin(schema.taskSteps, eq(schema.cliInvocations.taskStepId, schema.taskSteps.id))
    .where(
      and(
        eq(schema.cliInvocations.taskId, taskId),
        ilike(schema.cliInvocations.rawOutput, '%INSIGHTS%'),
      ),
    )
    .orderBy(asc(schema.cliInvocations.createdAt), asc(schema.cliInvocations.id));
  const outputs: InsightOutput[] = rows.map((r) => ({
    stepId: r.stepId,
    raw: r.raw ?? '',
    sourceRefs: [
      {
        kind: 'invocation',
        invocationId: r.invocationId,
        taskStepId: r.taskStepId,
        stepId: r.stepId,
        round: r.round,
        superseded: r.supersededAt != null,
      },
    ],
  }));
  const written = parseInsights(outputs, Number.POSITIVE_INFINITY);
  const verdicts = await db
    .select({
      issueId: schema.taskDagIssues.id,
      reviewerVerdict: schema.taskDagIssues.reviewerVerdict,
    })
    .from(schema.taskDagIssues)
    .where(eq(schema.taskDagIssues.taskId, taskId))
    .orderBy(asc(schema.taskDagIssues.createdAt), asc(schema.taskDagIssues.id));
  for (const { issueId, reviewerVerdict } of verdicts) {
    const parsed = reviewerOutputSchema.safeParse(reviewerVerdict);
    for (const f of parsed.success ? (parsed.data.withheld ?? []) : []) {
      const id = findingIdentity(f);
      const covered =
        normalizeFinding(f.description) !== ''
          ? written.filter((i) =>
              [i.title, i.description].some(
                (w) =>
                  normalizeFinding(w) === normalizeFinding(f.description) &&
                  (!f.file || findingIdentity({ file: i.location, description: w }) === id),
              ),
            )
          : [];
      const sourceRefs: InsightSourceRef[] = [
        { kind: 'dag_withheld', issueId, stepId: '06c-dag-execute', severity: f.severity ?? null },
      ];
      if (covered.length > 0) {
        outputs.push({ stepId: '06c-dag-execute', raw: '', sourceRefs, aliases: covered });
      } else {
        // Preserve the legacy synthetic fields and containment: a newline or pipe cannot forge
        // another record. Provenance travels separately, never through agent-authored syntax.
        const field = (text: string) => collapseToLine(text).replaceAll('|', '/');
        const title = field(findingText(f));
        const suggestion = collapseToLine(f.description) ? field(f.suggestion ?? '') : '';
        outputs.push({
          stepId: '06c-dag-execute',
          sourceRefs,
          raw: `## INSIGHTS\n- INSIGHT: ${title} | ${field(f.file ?? '')} | ${f.severity ?? 'unrated'} severity, outside the lines this issue wrote${suggestion ? ` — suggested: ${suggestion}` : ''}\n`,
        });
      }
    }
  }
  return outputs;
}

/** Shared by the inventory and its host adapter; invalid options must fail before any reads. */
export function validateInsightLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    throw new RangeError('Insight limit must be a finite, safe, non-negative integer.');
}

/** Complete inventory, with selection projected from every legacy 08e snapshot before limiting. */
export async function loadUnactedInsights(
  db: Database,
  taskId: string,
  options: InsightLoadOptions = {},
): Promise<InsightLoadResult> {
  const { limit, includePicked = false } = options;
  validateInsightLimit(limit);
  const all = parseInsights(await loadInsightOutputs(db, taskId), Number.POSITIVE_INFINITY, {
    includeSourceRefs: true,
  });
  const triage = await db
    .select({ output: schema.taskSteps.output })
    .from(schema.taskSteps)
    .where(
      and(eq(schema.taskSteps.taskId, taskId), eq(schema.taskSteps.stepId, '08e-insights-triage')),
    );
  const picked = new Set<string>();
  for (const row of triage) {
    const selected = (row.output as { selected?: unknown } | null)?.selected;
    if (!Array.isArray(selected)) continue;
    for (const value of selected) {
      if (!value || typeof value !== 'object') continue;
      const s = value as Partial<Insight>;
      // Missing/ill-typed locations must not select a title-only record or become wildcards.
      if (typeof s.title !== 'string' || typeof s.location !== 'string') continue;
      picked.add(insightKey({ title: s.title, location: s.location }));
    }
  }
  const eligible = all
    .map((i) => {
      const key = insightKey(i);
      return {
        ...i,
        legacyId: i.id,
        id: `insight-v1-${createHash('sha256')
          .update(JSON.stringify([i.title.toLowerCase(), i.location.toLowerCase()]))
          .digest('hex')}`,
        identity: findingIdentity({ file: i.location, description: i.title }),
        picked: picked.has(key),
      };
    })
    .filter((i) => includePicked || !i.picked);
  const insights = limit === undefined ? eligible : eligible.slice(0, limit);
  return { insights, omitted: eligible.length - insights.length };
}
