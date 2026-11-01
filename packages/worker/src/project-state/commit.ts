import { HAIVE_DATA_FILES, logger } from '@haive/shared';
import { lstatNoFollow } from '@haive/shared/fs-safe';
import type { HaiveDataRefusal } from '@haive/shared/haive-data';
import { parseProjectState, PROJECT_STATE_DIR } from '@haive/shared/project-state';
import { readStateTree } from '../plan/projection-merge.js';
import { gitRun } from '../repo/git-exec.js';
import { commitRecorded, type StagePlan } from '../step-engine/steps/onboarding/_stage-paths.js';
import { readStateFiles } from './sync.js';

export class HaiveProjectionRefusal extends Error {
  constructor(readonly refusal: HaiveDataRefusal) {
    super(refusal.code);
    this.name = 'HaiveProjectionRefusal';
  }
}

export interface HaiveProjectionCommit {
  indexSynced: boolean;
  committed: boolean;
  commitSha: string | null;
  files: string[];
  skipped: string[];
}

/** Names from valid records only. Never mutate the index through a directory pathspec: unknown
 * files beside Haive's belong to their owner, including their staged blobs and tracked deletions. */
export async function commitHaiveProjections(args: {
  repositoryId: string;
  repoPath: string;
  identity: Record<string, string>;
  message?: string;
  waitForIndexRetry?: (ms: number) => Promise<void>;
}): Promise<HaiveProjectionCommit> {
  const { repoPath, repositoryId } = args;
  const unreadable = (err: unknown): never => {
    logger.warn({ err, repositoryId }, 'Haive data projection read failed');
    throw new HaiveProjectionRefusal({ code: 'record_unreadable' });
  };
  const current = await readStateFiles(repoPath, { boundedDirectoryReads: true }).catch(unreadable);
  if (!current?.size) throw new HaiveProjectionRefusal({ code: 'record_absent' });
  const parsed = parseProjectState(current);
  if (!parsed.ok) throw new HaiveProjectionRefusal({ code: 'record_refused' });
  const ignored = new Set(parsed.ignored);
  const skipped = new Set(parsed.ignored.map((rel) => `${PROJECT_STATE_DIR}/${rel}`));
  const plan: StagePlan = {
    add: [...current.keys()]
      .filter((rel) => !ignored.has(rel))
      .map((rel) => `${PROJECT_STATE_DIR}/${rel}`),
    remove: [],
  };
  const head = await gitRun(repoPath, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']).catch(
    unreadable,
  );
  if (head.code !== 0 && head.code !== 1)
    unreadable(new Error(`git HEAD read failed: ${head.stderr || head.stdout}`));
  const parent = head.code === 0 ? head.stdout.trim() : null;
  if (parent) {
    const previous = await readStateTree(repoPath, parent).catch(unreadable);
    if (previous.size) {
      const old = parseProjectState(previous);
      // An invalid old record proves no ownership of its deleted names.
      const names = new Map([...previous.keys()].map((rel) => [rel, '']));
      names.set('format.json', current.get('format.json')!);
      const strayOnly = !previous.has('format.json') ? parseProjectState(names) : null;
      if (!old.ok && !(strayOnly?.ok && strayOnly.ignored.length === previous.size))
        throw new HaiveProjectionRefusal({ code: 'record_refused' });
      const unknown = new Set(old.ok ? old.ignored : previous.keys());
      for (const rel of previous.keys()) {
        if (current.has(rel)) continue;
        if (unknown.has(rel)) skipped.add(`${PROJECT_STATE_DIR}/${rel}`);
        else plan.remove.push(`${PROJECT_STATE_DIR}/${rel}`);
      }
    }
    // A deletion committed while the real index was locked leaves an addition there. Neither
    // HEAD nor the current record remembers that name on a repeat Save, so recover it from the
    // real index. The directory pathspec is read-only; repairs still name individual projections.
    const additions = await gitRun(repoPath, [
      'diff-index',
      '--cached',
      '--diff-filter=A',
      '--no-renames',
      '--name-only',
      '-z',
      parent,
      '--',
      `:(literal)${PROJECT_STATE_DIR}/`,
    ]).catch(unreadable);
    if (additions.code !== 0)
      unreadable(new Error(`git index read failed: ${additions.stderr || additions.stdout}`));
    for (const name of additions.stdout.split('\0').filter(Boolean)) {
      const rel = name.slice(PROJECT_STATE_DIR.length + 1);
      if (current.has(rel)) continue;
      // Probe the codec with empty bytes: a known name is parsed (and may be invalid),
      // while an unknown name is ignored. Never read or claim the person's staged blob.
      const classified = parseProjectState(
        new Map([
          ['format.json', current.get('format.json')!],
          [rel, ''],
        ]),
      );
      if (classified.ok && classified.ignored.includes(rel)) continue;
      plan.remove.push(name);
    }
  }
  for (const rel of [HAIVE_DATA_FILES.plan, HAIVE_DATA_FILES.planMarkdown]) {
    const entry = await lstatNoFollow(repoPath, rel, { strict: true }).catch(unreadable);
    if (entry && entry.kind !== 'file') unreadable(new Error(`${rel} is not a regular file`));
    if (entry) plan.add.push(rel);
    else if (parent) {
      const tree = await gitRun(repoPath, [
        'ls-tree',
        '-z',
        parent,
        '--',
        `:(literal)${rel}`,
      ]).catch(unreadable);
      if (tree.code !== 0)
        unreadable(new Error(`git plan entry read failed: ${tree.stderr || tree.stdout}`));
      if (tree.stdout) plan.remove.push(rel);
    }
  }
  const warnings: string[] = [];
  let commitSha: string | null = null;
  const files = await commitRecorded(
    repoPath,
    plan,
    args.message?.trim() || 'chore(haive): save Haive data',
    args.identity,
    warnings,
    (sha) => {
      commitSha = sha;
    },
    { repairUnchangedIndex: true, waitForIndexRetry: args.waitForIndexRetry },
  );
  for (const warning of warnings)
    logger.warn({ repoPath, warning }, 'Haive data commit index sync');
  return {
    indexSynced: warnings.length === 0,
    committed: files.length > 0,
    commitSha,
    files: files.sort(),
    skipped: [...skipped].sort(),
  };
}
