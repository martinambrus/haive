import { isUtf8 } from 'node:buffer';
import { HAIVE_DATA_FILES, type PlanMirror, type PlanMirrorPayload } from '@haive/shared';
import { planMirrorPayloadSchema, planMirrorV2Schema } from '@haive/shared/schemas';
import { renderPlanMarkdownFromMirror, serializePlanMirror } from '@haive/shared/plan';
import { mergePlanMirror } from '@haive/shared/plan-mirror-merge';
import {
  PROJECT_STATE_DIR,
  PROJECT_STATE_LIMITS,
  claimFileName,
  bundleFileName,
  emptyProjectState,
  isClaimUnit,
  isEnvironmentUnit,
  isRenderUnit,
  mergeProjectState,
  parseProjectState,
  renderProjectState,
  settingNameOfFile,
  type ProjectStateRecord,
} from '@haive/shared/project-state';
import { gitRun } from '../repo/git-exec.js';
import { unmergedPaths } from '../step-engine/git-merge.js';

export interface ProjectionResolution {
  resolved: string[];
  warnings: string[];
}

type Stage = 1 | 2 | 3;

const BYTES = { encoding: 'latin1' as const };

export async function readBlob(worktreePath: string, sha: string): Promise<Buffer | null> {
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
    const blob = await gitRun(worktreePath, ['cat-file', 'blob', m[1]!], undefined, BYTES);
    if (blob.code !== 0) return new Map();
    stages.set(Number(m[2]) as Stage, Buffer.from(blob.stdout, 'latin1'));
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

const STATE_PREFIX = `${PROJECT_STATE_DIR}/`;
const literal = (p: string): string => `:(literal)${p}`;
const utf8Path = (raw: string): string => Buffer.from(raw, 'latin1').toString('utf8');

/** The record's files in `rev`'s tree, relative to the state directory; empty where it has none.
 *  Bounded as the checkout reader is, by the sizes git lists, before any blob is read. */
export async function readStateTree(
  worktreePath: string,
  rev: string,
): Promise<Map<string, string>> {
  const listing = await gitRun(
    worktreePath,
    ['ls-tree', '-r', '-l', '-z', rev, '--', PROJECT_STATE_DIR],
    undefined,
    BYTES,
  );
  if (listing.code !== 0) throw new Error(`the state directory of ${rev} could not be listed`);
  const { maxEntries, maxFileBytes, maxTotalBytes } = PROJECT_STATE_LIMITS;
  const blobs: { sha: string; rel: string }[] = [];
  const dirs = new Set<string>();
  let total = 0;
  for (const entry of listing.stdout.split('\0')) {
    if (entry === '') continue;
    const m = /^100(?:644|755) blob ([0-9a-f]+) +(\d+)\t([\s\S]*)$/.exec(entry);
    const file = m ? utf8Path(m[3]!) : '';
    if (!m || !file.startsWith(STATE_PREFIX))
      throw new Error(`${rev} holds a state entry git reads as no file`);
    const rel = file.slice(STATE_PREFIX.length);
    const size = Number(m[2]);
    if (size > maxFileBytes) throw new Error(`${file} of ${rev} is larger than the record allows`);
    total += size;
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    if (total > maxTotalBytes || blobs.length + 1 + dirs.size > maxEntries) {
      throw new Error(`the state directory of ${rev} is larger than the record allows`);
    }
    blobs.push({ sha: m[1]!, rel });
  }
  const files = new Map<string, string>();
  for (const { sha, rel } of blobs) {
    const bytes = await readBlob(worktreePath, sha);
    if (!bytes) throw new Error(`${STATE_PREFIX}${rel} of ${rev} could not be read`);
    if (!isUtf8(bytes)) throw new Error(`${STATE_PREFIX}${rel} of ${rev} is not valid UTF-8`);
    files.set(rel, bytes.toString('utf8'));
  }
  return files;
}

function readRecord(
  files: Map<string, string>,
  side: string,
): { record: ProjectStateRecord | null; ignored: string[] } {
  if (files.size === 0) return { record: null, ignored: [] };
  const parsed = parseProjectState(files);
  if (!parsed.ok) throw new Error(`the ${side} state record is not valid: ${parsed.problems[0]}`);
  return { record: parsed.record, ignored: parsed.ignored };
}

/** `merged` with each unit both sides changed set to the incoming side's value, absent included. */
function takeIncomingUnits(
  merged: ProjectStateRecord,
  incoming: ProjectStateRecord,
  units: string[],
): ProjectStateRecord {
  const out: ProjectStateRecord = {
    ...merged,
    settings: Object.assign(Object.create(null) as Record<string, unknown>, merged.settings),
  };
  for (const unit of units) {
    const hash = unit.indexOf('#');
    const file = hash === -1 ? unit : unit.slice(0, hash);
    const setting = settingNameOfFile(unit);
    if (isEnvironmentUnit(unit) || isRenderUnit(unit)) {
      const field = file === 'project/environment.json' ? 'environment' : 'render';
      if (hash === -1) {
        (out as unknown as Record<string, unknown>)[field] = incoming[field];
      } else {
        const key = unit.slice(hash + 1);
        const value = (incoming[field] as Record<string, unknown> | null)?.[key];
        const copy = { ...(out[field] as Record<string, unknown>) };
        if (value === undefined) delete copy[key];
        else copy[key] = value;
        (out as unknown as Record<string, unknown>)[field] = copy;
      }
    } else if (setting !== null) {
      const value = incoming.settings[setting];
      if (value === undefined) delete out.settings[setting];
      else out.settings[setting] = value;
    } else if (isClaimUnit(unit)) {
      out.claims = [
        ...out.claims.filter((c) => claimFileName(c.path) !== unit),
        ...incoming.claims.filter((c) => claimFileName(c.path) === unit),
      ];
    } else if (/^bundles\/[^/]+\.json$/.test(unit)) {
      out.bundles = [
        ...out.bundles.filter((b) => bundleFileName(b.source) !== unit),
        ...incoming.bundles.filter((b) => bundleFileName(b.source) === unit),
      ];
    } else {
      throw new Error(`${unit} is a unit this merge does not know`);
    }
  }
  return out;
}

/** Take the incoming side of a path, its deletion included. */
async function takeIncoming(worktreePath: string, path: string): Promise<boolean> {
  const stages = await readStageNumbers(worktreePath, path);
  if (stages.size === 0) return false;
  if (!stages.has(3)) {
    return (await gitRun(worktreePath, ['rm', '-f', '-q', '--', literal(path)])).code === 0;
  }
  const take = await gitRun(worktreePath, ['checkout', '--theirs', '--', literal(path)]);
  return take.code === 0 && (await gitRun(worktreePath, ['add', '--', literal(path)])).code === 0;
}

async function readStageNumbers(worktreePath: string, path: string): Promise<Set<number>> {
  const listing = await gitRun(
    worktreePath,
    ['ls-files', '-u', '-z', '--', literal(path)],
    undefined,
    BYTES,
  );
  const stages = new Set<number>();
  for (const entry of listing.code === 0 ? listing.stdout.split('\0') : []) {
    const m = /^\d+ [0-9a-f]+ ([123])\t/.exec(entry);
    if (m) stages.add(Number(m[1]));
  }
  return stages;
}

async function unmergedInState(worktreePath: string): Promise<string[] | null> {
  const all = await unmergedPaths(worktreePath);
  return all === null ? null : all.filter((p) => p.startsWith(STATE_PREFIX));
}

async function indexedInState(worktreePath: string): Promise<string[]> {
  const listing = await gitRun(
    worktreePath,
    ['ls-files', '-z', '--', PROJECT_STATE_DIR],
    undefined,
    BYTES,
  );
  if (listing.code !== 0) throw new Error('the index could not be listed');
  return [
    ...new Set(
      listing.stdout
        .split('\0')
        .filter((p) => p !== '')
        .map(utf8Path),
    ),
  ];
}

/** Merge the whole record three-way and stage the result; a unit both sides changed takes theirs. */
async function mergeStateRecord(worktreePath: string): Promise<void> {
  const baseSha = await gitRun(worktreePath, ['merge-base', 'HEAD', 'MERGE_HEAD']);
  if (baseSha.code !== 0 && baseSha.code !== 1) {
    throw new Error(
      `the merge base could not be found: ${(baseSha.stderr || baseSha.stdout).trim()}`,
    );
  }
  const base =
    baseSha.code === 0
      ? readRecord(await readStateTree(worktreePath, baseSha.stdout.trim()), 'base')
      : null;
  const ours = readRecord(await readStateTree(worktreePath, 'HEAD'), 'local');
  const theirs = readRecord(await readStateTree(worktreePath, 'MERGE_HEAD'), 'incoming');
  const local = ours.record ?? emptyProjectState();
  const incoming = theirs.record ?? emptyProjectState();
  const merge = mergeProjectState({ base: base?.record ?? null, local, incoming });
  const files = renderProjectState(
    takeIncomingUnits(
      merge.merged,
      incoming,
      merge.conflicts.map((c) => c.unit),
    ),
  );
  for (const [rel, text] of files) {
    if (!(await writeResolved(worktreePath, `${STATE_PREFIX}${rel}`, Buffer.from(text)))) {
      throw new Error(`${rel} could not be staged`);
    }
  }
  const kept = new Set(
    [...files.keys(), ...ours.ignored, ...theirs.ignored].map((r) => `${STATE_PREFIX}${r}`),
  );
  for (const indexed of await indexedInState(worktreePath)) {
    if (kept.has(indexed)) continue;
    const removed = await gitRun(worktreePath, ['rm', '-f', '-q', '--', literal(indexed)]);
    if (removed.code !== 0) throw new Error(`${indexed} could not be removed`);
  }
}

/**
 * Resolve a merge's conflicts in the plan mirror's own two files.
 *
 * plan.json merges three-way through `mergePlanMirror` over the merge base, ours and theirs, so the
 * merge commit carries both sides' changes; a field both sides changed differently takes theirs, as
 * the flush does for a pending question. plan.md is re-rendered from the merged plan.json. A side
 * that does not parse, another root, or a failed merge falls back to theirs for that path. Where one
 * side deleted plan.json and the other kept it, the kept side stays: dropping a plan is not a merge.
 *
 * A conflict anywhere in the project state directory merges the whole record three-way instead
 * (`mergeProjectState`), a unit both sides changed taking theirs in the file; a record that does not
 * parse or merge falls back to theirs for every path still unmerged under it.
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
    if (await takeIncoming(worktreePath, path)) {
      out.resolved.push(path);
      out.warnings.push(`${path}: ${why}; took the incoming side`);
    }
  };

  if ([...conflicted].some((p) => p.startsWith(STATE_PREFIX))) {
    const inState = [...conflicted].filter((p) => p.startsWith(STATE_PREFIX));
    let why: string | null = null;
    try {
      await mergeStateRecord(worktreePath);
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    for (const left of (await unmergedInState(worktreePath)) ?? []) {
      why ??= 'the record was left unmerged';
      if (!(await takeIncoming(worktreePath, left))) {
        out.warnings.push(`${left}: could not be resolved`);
      }
    }
    if (why !== null) {
      out.warnings.push(`${PROJECT_STATE_DIR}: ${why}; took the incoming side`);
    }
    const left = await unmergedInState(worktreePath);
    if (left !== null && left.length === 0) out.resolved.push(...inState);
  }

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
