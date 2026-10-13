import { HAIVE_DATA_FILES, type PlanMirror, type PlanMirrorPayload } from '@haive/shared';
import { planMirrorPayloadSchema, planMirrorV2Schema } from '@haive/shared/schemas';
import { renderPlanMarkdownFromMirror, serializePlanMirror } from '@haive/shared/plan';
import { mergePlanMirror } from '@haive/shared/plan-mirror-merge';
import { gitRun } from '../repo/git-exec.js';
import { unmergedPaths } from '../step-engine/git-merge.js';

export interface ProjectionResolution {
  resolved: string[];
  warnings: string[];
}

type Stage = 1 | 2 | 3;

const BYTES = { encoding: 'latin1' as const };

async function readBlob(worktreePath: string, sha: string): Promise<Buffer | null> {
  const res = await gitRun(worktreePath, ['cat-file', 'blob', sha], undefined, BYTES);
  return res.code === 0 ? Buffer.from(res.stdout, 'latin1') : null;
}

/** The bytes of each stage git holds for `path`: 1 base, 2 ours, 3 theirs. */
async function readStages(worktreePath: string, path: string): Promise<Map<Stage, Buffer>> {
  const listing = await gitRun(
    worktreePath,
    ['ls-files', '-u', '-z', '--', path],
    undefined,
    BYTES,
  );
  const stages = new Map<Stage, Buffer>();
  if (listing.code !== 0) return stages;
  for (const entry of listing.stdout.split('\0')) {
    const m = /^\d+ ([0-9a-f]+) ([123])\t/.exec(entry);
    if (!m) continue;
    const bytes = await readBlob(worktreePath, m[1]!);
    if (bytes) stages.set(Number(m[2]) as Stage, bytes);
  }
  return stages;
}

function parsePayload(bytes: Buffer): PlanMirrorPayload | null {
  try {
    const parsed = planMirrorPayloadSchema.safeParse(JSON.parse(bytes.toString('utf8')) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const rootsOf = (p: PlanMirrorPayload): string[] =>
  p.nodes.filter((n) => n.parentId === null).map((n) => n.id);

function wellFormed(p: PlanMirror): boolean {
  const ids = new Set(p.nodes.map((n) => n.id));
  return (
    ids.size === p.nodes.length &&
    rootsOf(p).length === 1 &&
    p.nodes.every((n) => n.parentId === null || ids.has(n.parentId))
  );
}

/** plan.json's three-way merge, or the reason there is none. A contested field keeps THEIRS. */
function mergeStages(stages: Map<Stage, Buffer>): PlanMirror | string {
  const ours = parsePayload(stages.get(2)!);
  const theirs = parsePayload(stages.get(3)!);
  const baseBytes = stages.get(1);
  const base = baseBytes ? parsePayload(baseBytes) : null;
  if (!ours || !theirs || (baseBytes && !base)) return 'a side of plan.json does not parse';
  const [ourRoot] = rootsOf(ours);
  if (
    rootsOf(ours).length !== 1 ||
    rootsOf(theirs).length !== 1 ||
    ourRoot !== rootsOf(theirs)[0]
  ) {
    return 'the two plan.json files have different roots';
  }
  try {
    const merged = planMirrorV2Schema.parse(
      mergePlanMirror({ base, local: ours, incoming: theirs }).merged,
    );
    return wellFormed(merged) ? merged : 'the merged plan is not a single tree';
  } catch (err) {
    return `the plans could not be merged (${err instanceof Error ? err.message : String(err)})`;
  }
}

async function writeResolved(worktreePath: string, path: string, bytes: Buffer): Promise<boolean> {
  const hashed = await gitRun(worktreePath, ['hash-object', '-w', '--stdin'], undefined, {
    input: bytes,
  });
  if (hashed.code !== 0) return false;
  const staged = await gitRun(worktreePath, [
    'update-index',
    '--add',
    '--cacheinfo',
    `100644,${hashed.stdout.trim()},${path}`,
  ]);
  if (staged.code !== 0) return false;
  return (await gitRun(worktreePath, ['checkout-index', '-f', '--', path])).code === 0;
}

async function takeTheirs(worktreePath: string, path: string): Promise<boolean> {
  const take = await gitRun(worktreePath, ['checkout', '--theirs', '--', path]);
  return take.code === 0 && (await gitRun(worktreePath, ['add', '--', path])).code === 0;
}

/**
 * Resolve a merge's conflicts in the plan mirror's own two files.
 *
 * plan.json merges three-way through `mergePlanMirror` over the merge base, ours and theirs, so the
 * merge commit carries both sides' changes; a field both sides changed differently takes theirs, as
 * the flush does for a pending question. plan.md is re-rendered from the merged plan.json. A side
 * that does not parse, another root, or a failed merge falls back to theirs for that path. Where one
 * side deleted plan.json and the other kept it, the kept side stays: dropping a plan is not a merge.
 */
export async function resolveHaiveProjectionConflicts(
  worktreePath: string,
): Promise<ProjectionResolution> {
  const out: ProjectionResolution = { resolved: [], warnings: [] };
  const conflicted = new Set((await unmergedPaths(worktreePath)) ?? []);
  const jsonPath = HAIVE_DATA_FILES.plan;
  const mdPath = HAIVE_DATA_FILES.planMarkdown;
  let plan: PlanMirrorPayload | null = null;

  const fallBack = async (path: string, why: string): Promise<void> => {
    if (await takeTheirs(worktreePath, path)) {
      out.resolved.push(path);
      out.warnings.push(`${path}: ${why}; took the incoming side`);
    }
  };

  if (conflicted.has(jsonPath)) {
    const stages = await readStages(worktreePath, jsonPath);
    const kept = stages.get(2) ?? stages.get(3);
    if (stages.has(2) && stages.has(3)) {
      const merged = mergeStages(stages);
      if (typeof merged === 'string') {
        await fallBack(jsonPath, merged);
        plan = parsePayload(stages.get(3)!);
      } else if (
        await writeResolved(worktreePath, jsonPath, Buffer.from(serializePlanMirror(merged)))
      ) {
        out.resolved.push(jsonPath);
        plan = merged;
      }
    } else if (kept && (await writeResolved(worktreePath, jsonPath, kept))) {
      out.resolved.push(jsonPath);
      out.warnings.push(`${jsonPath}: one side deleted it; kept the other side's`);
      plan = parsePayload(kept);
    }
  } else if (conflicted.has(mdPath)) {
    const res = await gitRun(worktreePath, ['cat-file', 'blob', `:${jsonPath}`], undefined, BYTES);
    plan = res.code === 0 ? parsePayload(Buffer.from(res.stdout, 'latin1')) : null;
  }

  // plan.md follows a resolved plan.json even where git merged it cleanly: it renders that file.
  if (conflicted.has(mdPath) || (plan !== null && out.resolved.includes(jsonPath))) {
    if (
      plan &&
      (await writeResolved(worktreePath, mdPath, Buffer.from(renderPlanMarkdownFromMirror(plan))))
    ) {
      out.resolved.push(mdPath);
    } else {
      await fallBack(mdPath, 'plan.json gave nothing to render it from');
    }
  }
  return out;
}
