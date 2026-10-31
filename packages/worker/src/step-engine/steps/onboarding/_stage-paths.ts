import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { lstatNoFollow, relUnder, toSafeRel } from '@haive/shared/fs-safe';
import { KB_DIR, LEGACY_KNOWLEDGE_MIGRATIONS } from '@haive/shared/knowledge-paths';
import { namesGitData } from '@haive/shared/project-state';
import { LEGACY_IMPORT_SUBDIR } from './_kb-legacy.js';
import type { Database } from '@haive/database';
import { GIT_MAX_BUFFER, gitExec, gitGaveNoAnswer, gitRun } from '../../../repo/git-exec.js';
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

/** A persisted step output is replayed, so every path in it is validated again. One naming git
 *  data is refused: a record from before the writers refused it may hold one, and git fails the
 *  whole `add` on an alias spelling such as `.GIT./x`. */
function repoRel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const rel = toSafeRel(raw);
    return rel === '' || namesGitData(rel) ? null : rel;
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
  const res = await gitRun(repoPath, ['cat-file', '-e', `HEAD:${rel}`]);
  if (gitGaveNoAnswer(res)) {
    throw new Error(`could not tell whether ${rel} is in HEAD: git gave no answer`);
  }
  return res.code === 0;
}

/** The legacy knowledge move, read from git and the disk instead of a record, so an 08 Retry that
 *  found the move already done changes nothing. A legacy file tracked in HEAD and gone from disk
 *  was moved: its deletion is staged, and so is the file at the slot 08 gave it. An untracked one
 *  is the person's own, so its destination is left to them, as with 07's quarantine. */
async function collectLegacyMoves(repoPath: string, plan: StagePlan): Promise<void> {
  for (const { from, to } of LEGACY_KNOWLEDGE_MIGRATIONS) {
    const tree = await gitRun(repoPath, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', from]);
    if (gitGaveNoAnswer(tree)) {
      throw new Error(`could not list ${from} in HEAD: git gave no answer`);
    }
    if (tree.code !== 0) continue;
    for (const srcRel of tree.stdout.split('\0')) {
      const src = repoRel(srcRel);
      if (src === null || !src.startsWith(`${from}/`)) continue;
      if ((await lstatNoFollow(repoPath, src)) !== null) continue;
      plan.remove.push(src);
      const rel = src.slice(from.length + 1);
      for (const dest of [`${to}/${LEGACY_IMPORT_SUBDIR}/${rel}`, `${to}/${rel}`]) {
        if ((await lstatNoFollow(repoPath, dest))?.kind === 'file') plan.add.push(dest);
      }
    }
  }
}

/** The repair clears a skill's whole directory, so every file HEAD tracks under it that is gone
 *  from the disk was dropped by it, whichever step wrote it. */
async function collectRepairRemovals(
  repoPath: string,
  dirs: readonly string[],
  ids: readonly string[],
  plan: StagePlan,
): Promise<void> {
  for (const dir of dirs) {
    for (const id of ids) {
      const tree = await gitRun(repoPath, [
        'ls-tree',
        '-r',
        '-z',
        '--name-only',
        'HEAD',
        '--',
        ...literal([`${dir}/${id}/`]),
      ]);
      if (gitGaveNoAnswer(tree)) {
        throw new Error(`could not list ${dir}/${id} in HEAD: git gave no answer`);
      }
      if (tree.code !== 0) continue;
      for (const srcRel of tree.stdout.split('\0')) {
        const src = repoRel(srcRel);
        if (src === null || !src.startsWith(`${dir}/${id}/`)) continue;
        if ((await lstatNoFollow(repoPath, src)) === null) plan.remove.push(src);
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

  const skills = await stepOutput('09_5-skill-generation');
  const skillDirs = new Set<string>();
  for (const w of list(field(skills, 'written'))) {
    const id = field(w, 'id');
    if (typeof id !== 'string') continue;
    const slugs = strings(field(w, 'subSkillSlugs'));
    for (const dir of rels(field(w, 'mirroredDirs'))) {
      skillDirs.add(dir);
      add.add(`${dir}/${id}/SKILL.md`);
      for (const slug of slugs) add.add(`${dir}/${id}/sub-skills/${slug}.md`);
    }
  }
  for (const dir of skillDirs) add.add(`${dir}/README.md`);

  const repair = await loadPreviousStepOutput(db, taskId, '09_5b-skill-repair');
  const repaired = strings(field(repair?.output, 'repaired'));
  let repairDirs: string[] = [];
  if (repaired.length > 0) {
    const targets = rels(field(repair?.detect, 'skillTargetDirs'));
    repairDirs = Array.isArray(field(repair?.detect, 'skillTargetDirs'))
      ? targets
      : [DEFAULT_SKILLS_DIR];
    for (const dir of repairDirs) {
      add.add(`${dir}/README.md`);
      for (const id of repaired) {
        const slugs = strings(field(field(repair?.output, 'repairedSubSkillSlugs'), id));
        add.add(`${dir}/${id}/SKILL.md`);
        for (const s of slugs) add.add(`${dir}/${id}/sub-skills/${s}.md`);
      }
    }
  }

  // Ids and slugs above are interpolated into paths, so the finished ones are checked once more.
  const clean = (paths: Set<string>): string[] => [...paths].filter((p) => repoRel(p) === p);
  const plan = { add: clean(add), remove: clean(remove) };
  if (knowledge) await collectLegacyMoves(repoPath, plan);
  await collectRepairRemovals(repoPath, repairDirs, repaired, plan);
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
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  // Only a file or a link is named: a directory standing at a recorded path would be added whole.
  const files: string[] = [];
  for (const rel of add) {
    const entry = await lstatNoFollow(repoPath, rel);
    if (entry && (entry.kind === 'file' || entry.kind === 'symlink')) files.push(rel);
  }
  if (files.length > 0) {
    await gitExec(['add', '-f', '--', ...literal(files)], {
      cwd: repoPath,
      env,
      maxBuffer: GIT_MAX_BUFFER,
    });
  }
  if (remove.length > 0) {
    await gitExec(['rm', '--cached', '--ignore-unmatch', '-q', '--', ...literal(remove)], {
      cwd: repoPath,
      env,
      maxBuffer: GIT_MAX_BUFFER,
    });
  }
}

/** The paths the index changes against HEAD: those among `only`, or every one without it. */
export async function stagedChanges(
  repoPath: string,
  only?: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string[]> {
  const { stdout } = await gitExec(
    [
      'diff',
      '--cached',
      '--no-renames',
      '--name-only',
      '-z',
      ...(only ? ['--', ...literal(only)] : []),
    ],
    { cwd: repoPath, env, maxBuffer: GIT_MAX_BUFFER },
  );
  const changed = stdout.split('\0').filter((s) => s.length > 0);
  if (!only) return changed;
  // A pathspec reaches into a directory standing at a named path; only the names themselves count.
  const named = new Set(only);
  return changed.filter((p) => named.has(p));
}

/** Stage `add` and `remove` into a private index built from HEAD and commit what that changes among
 *  those names. The real index is never read for them, so a blob another writer stages there in the
 *  meantime cannot enter the commit; afterwards the real index agrees with HEAD for the committed
 *  names only, and keeps whatever else the person staged. Returns the committed names. */
/** Set exactly the real-index entries of `paths` to the commit's, never a pathspec that would reach
 *  what the person staged under a name that is now a directory. */
async function syncRealIndex(
  run: (args: string[]) => Promise<{ stdout: string }>,
  commit: string,
  paths: readonly string[],
): Promise<void> {
  // Another writer may have committed on top since; sync to the HEAD that is current, never behind it.
  const readHead = async () =>
    (await run(['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
  const head = await readHead();
  if (head !== commit) {
    const descends = await run(['merge-base', '--is-ancestor', commit, head]).then(
      () => true,
      () => false,
    );
    if (!descends) return;
  }
  const listed = await run(['ls-tree', '-z', head, '--', ...literal(paths)]);
  const entries = new Map<string, string>();
  for (const line of listed.stdout.split('\0')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const [mode, , oid] = line.slice(0, tab).split(' ');
    entries.set(line.slice(tab + 1), `${mode},${oid}`);
  }
  const kept = paths.filter((p) => entries.has(p));
  const gone = paths.filter((p) => !entries.has(p));
  if (kept.length > 0) {
    await run([
      'update-index',
      '--add',
      ...kept.flatMap((p) => ['--cacheinfo', `${entries.get(p)},${p}`]),
    ]);
  }
  if (gone.length > 0) await run(['update-index', '--force-remove', '--', ...gone]);
  if ((await readHead()) !== head) throw new Error('HEAD moved while the index was synced');
}

export async function commitRecorded(
  repoPath: string,
  plan: StagePlan,
  message: string,
  env: NodeJS.ProcessEnv,
  warnings?: string[],
  onCommitted?: (sha: string) => void,
): Promise<string[]> {
  const run = (args: string[], extra?: NodeJS.ProcessEnv) =>
    gitExec(args, { cwd: repoPath, env: { ...env, ...extra }, maxBuffer: GIT_MAX_BUFFER });
  for (const mark of ['MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
    const open = await gitRun(repoPath, ['rev-parse', '-q', '--verify', mark]);
    const name = mark.split('_')[0]!.toLowerCase();
    if (open.code === 0) throw new Error(`cannot do a partial commit during a ${name}`);
    if (open.code !== 1) throw new Error(`could not check for a ${name}: git exited ${open.code}`);
  }
  const head = await gitRun(repoPath, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  const parent = head.code === 0 ? head.stdout.trim() : '';
  const indexFile = path.join(tmpdir(), `${randomUUID()}.index`);
  const temp = { GIT_INDEX_FILE: indexFile };
  try {
    if (parent !== '') await run(['read-tree', parent], temp);
    await stageNamed(repoPath, plan.add, plan.remove, { ...env, ...temp });
    // A name that became a directory after its check is added whole; put whatever lies under it back.
    const named = new Set([...plan.add, ...plan.remove]);
    const listed = await run(['ls-files', '-z', '--', ...literal([...named])], temp);
    const children = listed.stdout.split('\0').filter((p) => p.length > 0 && !named.has(p));
    const turned = [...named].filter((n) => children.some((c) => c.startsWith(`${n}/`)));
    // A removal recreated after its check would be committed as a deletion; keep HEAD's entry instead.
    const recreated: string[] = [];
    for (const rel of plan.remove) {
      if ((await lstatNoFollow(repoPath, rel)) !== null) recreated.push(rel);
    }
    const strays = [...children, ...turned, ...recreated];
    if (strays.length > 0) {
      await run(
        parent !== ''
          ? ['reset', '-q', parent, '--', ...literal(strays)]
          : ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...literal(strays)],
        temp,
      );
    }
    const changed = await stagedChanges(repoPath, [...named], {
      ...env,
      ...temp,
    });
    if (changed.length === 0) {
      // A prior commit may have landed while the real index was locked. Repair its named
      // entries on a repeat too, without creating a commit or touching unrelated staged work.
      if (parent !== '') {
        let synced = false;
        for (let attempt = 0; attempt < 6 && !synced; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
          synced = await syncRealIndex(run, parent, [...named]).then(
            () => true,
            () => false,
          );
        }
        if (!synced)
          warnings?.push(`the git index could not be synced for: ${[...named].join(', ')}`);
      }
      return [];
    }
    const tree = (await run(['write-tree'], temp)).stdout.trim();
    const commit = (
      await run(['commit-tree', tree, ...(parent !== '' ? ['-p', parent] : []), '-m', message])
    ).stdout.trim();
    const subject = message.split('\n')[0]!;
    await run(['update-ref', '-m', `commit: ${subject}`, 'HEAD', commit, parent]);
    onCommitted?.(commit);
    // The commit has landed; a real index another writer holds locked is retried, then reported.
    let synced = false;
    for (let attempt = 0; attempt < 6 && !synced; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
      synced = await syncRealIndex(run, commit, changed).then(
        () => true,
        () => false,
      );
    }
    if (!synced) {
      warnings?.push(
        `committed, but the git index could not be synced (locked, or HEAD kept moving), so these files may show as staged changes until you run \`git reset -- <file>\`: ${changed.join(', ')}`,
      );
    }
    return changed;
  } finally {
    await rm(indexFile, { force: true });
  }
}
