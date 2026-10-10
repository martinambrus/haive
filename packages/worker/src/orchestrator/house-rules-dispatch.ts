import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CONFIG_KEYS, configService, logger, parseHouseRulesSimilarityMode } from '@haive/shared';
import { readFileNoFollow } from '@haive/shared/fs-safe';
import type { GlobalKbErrorClass } from '@haive/shared/global-kb';
import { gitRun } from '../repo/git-exec.js';
import { resolveInvocationWorkerTree } from '../repo/worktree-git-boundary.js';
import { workspaceAnchor } from '../repo/worktree-paths.js';
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
  type HouseRulesRequest,
} from './house-rules.js';
import { namedFiles, resolveNamedFiles } from './named-files.js';

const log = logger.child({ module: 'house-rules-dispatch' });

/** Each git of the change read is killed at this bound, so a hung git costs a dispatch or a gate
 *  its answer (null) and not the whole wait. */
export const CHANGE_READ_GIT_TIMEOUT_MS = 30_000;

/** What git reports dirty or untracked (gate 3's argv, NUL separated so no path is quoted) plus what
 *  the branch holds against its fork point, which is all of a DAG task's work. A deleted path counts,
 *  and so does a rename's or copy's source: a rule can cover what a task removes or moves out. Null
 *  when a read fails: absent is not "unchanged". */
export async function readChangedFiles(
  tree: string,
  baseBranch: string | null,
  gitTimeoutMs = CHANGE_READ_GIT_TIMEOUT_MS,
): Promise<string[] | null> {
  const status = await gitRun(
    tree,
    ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'],
    undefined,
    { timeout: gitTimeoutMs },
  );
  if (status.code !== 0) return null;
  const committed = await readChangedPaths(tree, baseBranch, {
    includeDeleted: true,
    timeoutMs: gitTimeoutMs,
  });
  if (committed === null) return null;
  const dirty = parsePorcelainZ(status.stdout).flatMap((entry) =>
    entry.oldPath ? [entry.path, entry.oldPath] : [entry.path],
  );
  return [...new Set([...dirty, ...committed])];
}

// The worktree is written by sandboxed agents, so one file must never be able to exhaust the worker.
export const FINGERPRINT_READ_BYTES = 8 * 1024 * 1024;

/** sha256 over the paths `readChangedFiles` lists and the bytes of each regular file there; a link
 *  or a deleted path counts as not there. Null when the change cannot be read. */
export async function changeFingerprint(
  tree: string,
  baseBranch: string | null,
  gitTimeoutMs = CHANGE_READ_GIT_TIMEOUT_MS,
): Promise<string | null> {
  const files = await readChangedFiles(tree, baseBranch, gitTimeoutMs);
  if (files === null) return null;
  const { anchor, prefix } = workspaceAnchor(tree);
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const read = await readFileNoFollow(anchor, `${prefix}${file}`, {
      maxBytes: FINGERPRINT_READ_BYTES,
    });
    hash.update(JSON.stringify([file, read === null ? null : read.size]));
    if (read !== null) hash.update(read.data);
  }
  return hash.digest('hex');
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

const SPEC_STEP_04 = '04-phase-0b-pre-planning';
const SPEC_STEP_05 = '05-phase-0b5-spec-quality';
const SPEC_STEP_05A = '05a-resolve-spec-warnings';
// Task text has no length limit, so each part is read up to this; a name past it is not read.
const TASK_TEXT_READ_CHARS = 262_144;

/** The task's title and description, then its freshest spec: the highest round, then 05a, 05, 04. */
export async function readTaskText(db: Database, taskId: string): Promise<string> {
  const { tasks, taskSteps } = schema;
  const rows = (await db.execute(sql`
    select left(${tasks.title}, ${TASK_TEXT_READ_CHARS}::int) as title,
      left(${tasks.description}, ${TASK_TEXT_READ_CHARS}::int) as description,
      (select left(${taskSteps.output}->>'spec', ${TASK_TEXT_READ_CHARS}::int) from ${taskSteps}
        where ${taskSteps.taskId} = ${tasks.id}
          and ${taskSteps.stepId} in (${SPEC_STEP_04}, ${SPEC_STEP_05}, ${SPEC_STEP_05A})
          and coalesce(${taskSteps.output}->>'spec', '') <> ''
        order by ${taskSteps.round} desc,
          case ${taskSteps.stepId} when ${SPEC_STEP_05A} then 3 when ${SPEC_STEP_05} then 2 else 1 end desc
        limit 1) as spec
    from ${tasks}
    where ${tasks.id} = ${taskId}`)) as unknown as Array<{
    title: string;
    description: string | null;
    spec: string | null;
  }>;
  const row = rows[0];
  return row === undefined ? '' : [row.title, row.description ?? '', row.spec ?? ''].join('\n');
}

/** NUL separated so no path is quoted. Null when git fails or outlives `gitTimeoutMs`. */
export async function readTrackedFiles(
  tree: string,
  gitTimeoutMs = CHANGE_READ_GIT_TIMEOUT_MS,
): Promise<string[] | null> {
  const listed = await gitRun(tree, ['ls-files', '-z'], undefined, { timeout: gitTimeoutMs });
  if (listed.code !== 0) return null;
  return listed.stdout.split('\0').filter((file) => file !== '');
}

/** The paths a task names, resolved against the tracked files; none when they cannot be read. */
async function readNamedFiles(
  db: Database,
  taskId: string,
  worktreeRel: string | undefined,
): Promise<string[]> {
  try {
    const names = namedFiles(await readTaskText(db, taskId));
    if (names.length === 0) return [];
    const tree = await resolveInvocationWorkerTree(db, taskId, worktreeRel);
    const tracked = tree === null ? null : await readTrackedFiles(tree);
    if (tracked !== null) return resolveNamedFiles(names, tracked);
    log.warn({ taskId }, 'could not list the tracked files to resolve the paths a task names');
    return [];
  } catch (err) {
    log.warn({ err, taskId }, 'could not read the paths a task names to scope house rules');
    return [];
  }
}

/** Whether a write dispatch records how close the task is to its unmatched `files` rules; a setting
 *  that cannot be read means off, so a broken config does no extra IO. */
async function recordsSimilarity(): Promise<boolean> {
  try {
    const raw = await configService.get(CONFIG_KEYS.GLOBAL_KB_HOUSE_RULES_SIMILARITY);
    return parseHouseRulesSimilarityMode(raw) === 'record';
  } catch {
    return false;
  }
}

/** Reads the change only when a `files` rule is there to be scoped by it. */
export async function selectForDispatch(
  db: Database,
  taskId: string,
  request: HouseRulesRequest,
  worktreeRel: string | undefined,
  kb: Pick<GlobalKbContext, 'status' | 'errorClass' | 'rules' | 'refused'>,
): Promise<HouseRuleSelection> {
  if (kb.status === 'disabled') return disabledSelection();
  if (kb.status === 'unavailable') return unavailableSelection(kb.errorClass ?? 'other');
  const scoped = kb.rules.some((rule) => rule.spec.mode === 'files');
  const changedFiles = scoped ? await readDispatchChange(db, taskId, worktreeRel) : [];
  const named =
    scoped &&
    changedFiles !== null &&
    request.mode === 'write' &&
    request.estimatedFiles === undefined
      ? await readNamedFiles(db, taskId, worktreeRel)
      : [];
  return selectHouseRules({
    mode: request.mode,
    findings: request.findings,
    rules: kb.rules,
    refused: kb.refused,
    changedFiles,
    estimatedFiles: plannedFiles(request.estimatedFiles),
    namedFiles: named,
    similarity:
      scoped && changedFiles !== null && request.mode === 'write' && (await recordsSimilarity()),
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
