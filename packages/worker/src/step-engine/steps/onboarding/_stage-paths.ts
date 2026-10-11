import path from 'node:path';
import { lstatNoFollow, relUnder, toSafeRel } from '@haive/shared/fs-safe';
import { KB_DIR, LEGACY_KNOWLEDGE_MIGRATIONS } from '@haive/shared/knowledge-paths';
import { LEGACY_IMPORT_SUBDIR } from './_kb-legacy.js';
import type { Database } from '@haive/database';
import { GIT_MAX_BUFFER, gitExec, gitRun } from '../../../repo/git-exec.js';
import { loadPreviousStepOutput } from './_helpers.js';
import { sanitizeKbRelPath } from './_kb-write.js';

const DEFAULT_SKILLS_DIR = '.claude/skills';
const GLOBAL_KB_FILE_PATH_PREFIX = 'global-kb:';

export interface StagePlan {
  /** Paths to add if they exist. */
  add: string[];
  /** Paths to take out of the index if they are gone from disk. */
  remove: string[];
}

type Json = Record<string, unknown> | null | undefined;

function field(obj: unknown, key: string): unknown {
  return (obj as Json)?.[key];
}

function list(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

/** A persisted step output is replayed, so every path in it is validated again. */
function repoRel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const rel = toSafeRel(raw);
    return rel === '' ? null : rel;
  } catch {
    return null;
  }
}

function rels(raw: unknown): string[] {
  return list(raw)
    .map(repoRel)
    .filter((p): p is string => p !== null);
}

function strings(raw: unknown): string[] {
  return list(raw).filter((s): s is string => typeof s === 'string');
}

async function inHead(repoPath: string, rel: string): Promise<boolean> {
  return (await gitRun(repoPath, ['cat-file', '-e', `HEAD:${rel}`])).code === 0;
}

/** The legacy knowledge move, read from git and the disk instead of a record, so an 08 Retry that
 *  found the move already done changes nothing. A legacy file tracked in HEAD and gone from disk
 *  was moved: its deletion is staged, and so is the file at the slot 08 gave it. An untracked one
 *  is the person's own, so its destination is left to them, as with 07's quarantine. */
async function collectLegacyMoves(repoPath: string, plan: StagePlan): Promise<void> {
  for (const { from, to } of LEGACY_KNOWLEDGE_MIGRATIONS) {
    const tree = await gitRun(repoPath, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', from]);
    if (tree.code !== 0) continue;
    for (const srcRel of tree.stdout.split('\0')) {
      const src = repoRel(srcRel);
      if (src === null || !src.startsWith(`${from}/`)) continue;
      if ((await lstatNoFollow(repoPath, src)) !== null) continue;
      plan.remove.push(src);
      const rel = src.slice(from.length + 1);
      for (const dest of [`${to}/${LEGACY_IMPORT_SUBDIR}/${rel}`, `${to}/${rel}`]) {
        if ((await lstatNoFollow(repoPath, dest))?.kind !== 'file') continue;
        plan.add.push(dest);
        break;
      }
    }
  }
}

/** The paths this task's own onboarding steps recorded writing or removing. A directory is never
 *  named: a person's untracked or ignored file beside Haive's is not in any record. */
export async function collectOnboardingStagePaths(
  repoPath: string,
  db: Database,
  taskId: string,
): Promise<StagePlan> {
  const add = new Set<string>();
  const remove = new Set<string>();
  const stepOutput = async (stepId: string) =>
    (await loadPreviousStepOutput(db, taskId, stepId))?.output ?? null;

  const generated = await stepOutput('07-generate-files');
  const quarantineReadmes = new Set<string>();
  const movedReadmes = new Set<string>();
  for (const q of list(field(generated, 'quarantinedAgentFiles'))) {
    const from = repoRel(field(q, 'from'));
    const to = repoRel(field(q, 'to'));
    if (from === null || to === null) continue;
    const readme = `${path.posix.dirname(to)}/README.md`;
    quarantineReadmes.add(readme);
    // A definition git never tracked is the person's file, so its move is theirs to commit.
    if (!(await inHead(repoPath, from))) continue;
    add.add(to);
    remove.add(from);
    movedReadmes.add(readme);
  }
  for (const rel of rels(field(generated, 'wroteFiles'))) {
    if (!quarantineReadmes.has(rel) || movedReadmes.has(rel)) add.add(rel);
  }

  const knowledge = await stepOutput('08-knowledge-acquisition');
  if (knowledge) {
    add.add(`${KB_DIR}/INDEX.md`);
    for (const w of list(field(knowledge, 'written'))) {
      const filePath = field(w, 'filePath');
      if (typeof filePath !== 'string' || filePath.startsWith(GLOBAL_KB_FILE_PATH_PREFIX)) continue;
      try {
        add.add(relUnder(repoPath, filePath));
      } catch {
        continue;
      }
    }
    for (const rel of rels(field(knowledge, 'removedPaths'))) remove.add(rel);
    for (const merged of strings(field(knowledge, 'mergedRemoved'))) {
      const safe = sanitizeKbRelPath(merged);
      if (safe.ok) remove.add(`${KB_DIR}/${safe.normalized}`);
    }
  }

  const review = await stepOutput('09_3-qa-review');
  for (const w of list(field(review, 'kbWritten'))) {
    const rel = field(w, 'relPath');
    const safe = typeof rel === 'string' ? sanitizeKbRelPath(rel) : null;
    if (safe?.ok) add.add(`${KB_DIR}/${safe.normalized}`);
  }

  const skillSlugs = new Map<string, string[]>();
  const skills = await stepOutput('09_5-skill-generation');
  const skillDirs = new Set<string>();
  for (const w of list(field(skills, 'written'))) {
    const id = field(w, 'id');
    if (typeof id !== 'string') continue;
    const slugs = strings(field(w, 'subSkillSlugs'));
    skillSlugs.set(id, slugs);
    for (const dir of rels(field(w, 'mirroredDirs'))) {
      skillDirs.add(dir);
      add.add(`${dir}/${id}/SKILL.md`);
      for (const slug of slugs) add.add(`${dir}/${id}/sub-skills/${slug}.md`);
    }
  }
  for (const dir of skillDirs) add.add(`${dir}/README.md`);

  const repair = await loadPreviousStepOutput(db, taskId, '09_5b-skill-repair');
  const repaired = strings(field(repair?.output, 'repaired'));
  if (repaired.length > 0) {
    const targets = rels(field(repair?.detect, 'skillTargetDirs'));
    for (const dir of targets.length > 0 ? targets : [DEFAULT_SKILLS_DIR]) {
      add.add(`${dir}/README.md`);
      for (const id of repaired) {
        const slugs = strings(field(field(repair?.output, 'repairedSubSkillSlugs'), id));
        add.add(`${dir}/${id}/SKILL.md`);
        for (const s of slugs) add.add(`${dir}/${id}/sub-skills/${s}.md`);
        // The repair clears the skill's directory, so a sub-skill 09_5 wrote and it did not is gone.
        for (const s of skillSlugs.get(id) ?? []) {
          if (!slugs.includes(s)) remove.add(`${dir}/${id}/sub-skills/${s}.md`);
        }
      }
    }
  }

  // Ids and slugs above are interpolated into paths, so the finished ones are checked once more.
  const clean = (paths: Set<string>): string[] => [...paths].filter((p) => repoRel(p) === p);
  const plan = { add: clean(add), remove: clean(remove) };
  if (knowledge) await collectLegacyMoves(repoPath, plan);
  return plan;
}

/** Pathspecs that match the names given and nothing wider. */
export function literal(paths: readonly string[]): string[] {
  return paths.map((p) => `:(literal)${p}`);
}

/** Add `add` (forced: a curated deliverable may sit under an excluded or ignored path) and drop
 *  `remove` from the index. A path git never tracked is skipped. */
export async function stageNamed(
  repoPath: string,
  add: readonly string[],
  remove: readonly string[],
): Promise<void> {
  if (add.length > 0) {
    await gitExec(['add', '-f', '--', ...literal(add)], {
      cwd: repoPath,
      maxBuffer: GIT_MAX_BUFFER,
    });
  }
  if (remove.length > 0) {
    await gitExec(['rm', '--cached', '--ignore-unmatch', '-q', '--', ...literal(remove)], {
      cwd: repoPath,
      maxBuffer: GIT_MAX_BUFFER,
    });
  }
}

/** The paths the index changes against HEAD: those among `only`, or every one without it. */
export async function stagedChanges(repoPath: string, only?: readonly string[]): Promise<string[]> {
  const { stdout } = await gitExec(
    [
      'diff',
      '--cached',
      '--no-renames',
      '--name-only',
      '-z',
      ...(only ? ['--', ...literal(only)] : []),
    ],
    { cwd: repoPath, maxBuffer: GIT_MAX_BUFFER },
  );
  return stdout.split('\0').filter((s) => s.length > 0);
}

/** Commit exactly `paths`, so anything else the person had staged stays staged and uncommitted. */
export async function commitOnly(
  repoPath: string,
  paths: readonly string[],
  message: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await gitExec(['commit', '--only', '-m', message, '--', ...literal(paths)], {
    cwd: repoPath,
    env,
    maxBuffer: GIT_MAX_BUFFER,
  });
}
