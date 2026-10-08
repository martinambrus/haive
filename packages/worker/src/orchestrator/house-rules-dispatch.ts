import { sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { logger, type HouseRuleMode } from '@haive/shared';
import type { GlobalKbErrorClass } from '@haive/shared/global-kb';
import { gitRun } from '../repo/git-exec.js';
import { resolveInvocationWorkerTree } from '../repo/worktree-git-boundary.js';
import { SANDBOX_WORKDIR } from '../sandbox/sandbox-runner.js';
import { loadPreviousStepOutput } from '../step-engine/steps/onboarding/_helpers.js';
import { parsePorcelainZ } from '../step-engine/steps/workflow/_commit-diff.js';
import { readChangedPaths } from '../step-engine/steps/workflow/_impl-changes.js';
import type { GlobalKbContext } from './global-kb-context.js';
import {
  disabledSelection,
  selectHouseRules,
  unavailableSelection,
  type HouseRuleSelection,
} from './house-rules.js';

const log = logger.child({ module: 'house-rules-dispatch' });

/** What git reports dirty or untracked (gate 3's argv, NUL separated so no path is quoted) plus what
 *  the branch holds against its fork point, which is all of a DAG task's work. A deleted path counts,
 *  and so does a rename's or copy's source: a rule can cover what a task removes or moves out. Null
 *  when a read fails: absent is not "unchanged". */
export async function readChangedFiles(
  tree: string,
  baseBranch: string | null,
): Promise<string[] | null> {
  const status = await gitRun(tree, [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
  ]);
  if (status.code !== 0) return null;
  const committed = await readChangedPaths(tree, baseBranch, { includeDeleted: true });
  if (committed === null) return null;
  const dirty = parsePorcelainZ(status.stdout).flatMap((entry) =>
    entry.oldPath ? [entry.path, entry.oldPath] : [entry.path],
  );
  return [...new Set([...dirty, ...committed])];
}

/** The change of the tree the dispatch mounts; null when it cannot be read, including no repository. */
export async function readDispatchChange(
  db: Database,
  taskId: string,
  worktreeRel: string | undefined,
): Promise<string[] | null> {
  try {
    const tree = await resolveInvocationWorkerTree(db, taskId, worktreeRel);
    if (tree === null) return null;
    const setup = await loadPreviousStepOutput(db, taskId, '01-worktree-setup');
    const baseBranch = (setup?.output as { baseBranch?: string } | null)?.baseBranch ?? null;
    return await readChangedFiles(tree, baseBranch);
  } catch (err) {
    log.warn({ err, taskId }, 'could not read the change to scope house rules');
    return null;
  }
}

/** Planned files as repository-relative paths, matched and never shown: a bad one is dropped. */
export function plannedFiles(files: readonly string[] | undefined): string[] {
  const prefix = `${SANDBOX_WORKDIR}/`;
  const out: string[] = [];
  for (const raw of files ?? []) {
    let file = raw.trim();
    if (file.startsWith(prefix)) file = file.slice(prefix.length);
    while (file.startsWith('./')) file = file.slice(2);
    if (file === '' || file.startsWith('/') || file.split('/').includes('..')) continue;
    out.push(file);
  }
  return out;
}

/** Reads the change only when a `files` rule is there to be scoped by it. */
export async function selectForDispatch(
  db: Database,
  taskId: string,
  request: { mode: HouseRuleMode; estimatedFiles?: readonly string[] },
  worktreeRel: string | undefined,
  kb: Pick<GlobalKbContext, 'status' | 'errorClass' | 'rules' | 'refused'>,
): Promise<HouseRuleSelection> {
  if (kb.status === 'disabled') return disabledSelection();
  if (kb.status === 'unavailable') return unavailableSelection(kb.errorClass ?? 'other');
  const scoped = kb.rules.some((rule) => rule.spec.mode === 'files');
  return selectHouseRules({
    mode: request.mode,
    rules: kb.rules,
    refused: kb.refused,
    changedFiles: scoped ? await readDispatchChange(db, taskId, worktreeRel) : [],
    estimatedFiles: plannedFiles(request.estimatedFiles),
  });
}

export const HOUSE_RULES_UNAVAILABLE_EVENT = 'house_rules.unavailable';

/** One event per task, the error class only (the message names the store's host). A DAG level
 *  dispatches concurrently, so the check and the insert share the task's advisory lock. Best-effort. */
export async function recordHouseRulesUnavailable(
  db: Database,
  taskId: string,
  errorClass: GlobalKbErrorClass,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${HOUSE_RULES_UNAVAILABLE_EVENT}:${taskId}`}, 0))`,
      );
      await tx.execute(sql`
        insert into ${schema.taskEvents} (task_id, event_type, payload)
        select ${taskId}::uuid, ${HOUSE_RULES_UNAVAILABLE_EVENT}, ${JSON.stringify({ errorClass })}::jsonb
        where not exists (
          select 1 from ${schema.taskEvents}
          where ${schema.taskEvents.taskId} = ${taskId}::uuid
            and ${schema.taskEvents.eventType} = ${HOUSE_RULES_UNAVAILABLE_EVENT}
        )`);
    });
  } catch (err) {
    log.warn({ err, taskId }, 'could not record that house rules were unavailable');
  }
}
