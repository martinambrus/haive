import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CHECKOUT_HOLDING_TASK_STATUSES, logger } from '@haive/shared';
import { rtkEnabledUpdate } from '@haive/shared/rtk-enabled';
import { isUtf8 } from 'node:buffer';
import {
  isPathContainmentError,
  readFileNoFollow,
  rewriteFileIfNoFollow,
} from '@haive/shared/fs-safe';
import {
  PROJECT_STATE_DIR,
  ProjectStateError,
  RENDER_UNIT,
  RTK_ENABLED_UNIT,
  conflictBody,
  conflictSideValue,
  emptyProjectState,
  isConflictUnit,
  normalizeProjectState,
  renderContextColumnSchema,
  renderProjectState,
  renderSchema,
  sameValue,
  type ProjectRender,
  type ProjectStateRecord,
  type ProjectStateAnswer,
  type ProjectStateResolvePayload,
  type ProjectStateResolveResult,
} from '@haive/shared/project-state';
import {
  CONFLICT_ERROR_PREFIX,
  keyOf,
  rebuildLocalRender,
  syncProjectStateFromCheckout,
  writeApplicableTemplateIds,
} from './sync.js';
import { lockPlanMerge } from '@haive/shared/plan';
import { loadPendingRenderConflicts, lockProjectState } from './write.js';

const RENDER_FILE = `${PROJECT_STATE_DIR}/project/render.json`;
const MAX_RENDER_BYTES = 1024 * 1024;

type Json = Record<string, unknown>;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The checkout's render file as parsed and as its bytes stand, or null when it is gone, links out of
 *  the repository or does not read as a render unit: whatever the question was asked against has moved. */
async function readRenderFile(
  repoPath: string,
): Promise<{ render: ProjectRender; raw: Buffer } | null> {
  try {
    const read = await readFileNoFollow(repoPath, RENDER_FILE, {
      strict: true,
      maxBytes: MAX_RENDER_BYTES,
    });
    if (read === null || read.truncated || !isUtf8(read.data)) return null;
    const parsed = renderSchema.safeParse(JSON.parse(read.data.toString('utf8')));
    return parsed.success ? { render: parsed.data, raw: read.data } : null;
  } catch (err) {
    if (err instanceof SyntaxError || isPathContainmentError(err)) return null;
    throw err;
  }
}

/** The render file changed on disk after it was read, so the answer was asked against bytes that
 *  are gone; the transaction rolls back and the question reads as moved. */
class RenderFileMovedError extends Error {
  constructor(readonly repoPath: string) {
    super('the render file changed while the answer was applied');
  }
}

interface After {
  resync: string | null;
  putBack: { repoPath: string; raw: Buffer; wrote: Buffer } | null;
}

/** Answers one pending conflict of the render unit, so that the file, the sync base and the column
 *  agree on the answered key and the next sync finds nothing to ask. Idempotent: the same answer to
 *  a closed row returns it again. A failure after the file was rewritten puts its bytes back. */
export async function resolveProjectStateConflict(
  db: Database,
  payload: ProjectStateResolvePayload,
): Promise<ProjectStateResolveResult> {
  const after: After = { resync: null, putBack: null };
  let result: ProjectStateResolveResult;
  try {
    result = await answerInTransaction(db, payload, after);
  } catch (err) {
    if (err instanceof RenderFileMovedError) {
      result = { kind: 'moved' };
      after.resync = err.repoPath;
    } else {
      if (after.putBack !== null) {
        await putBackIfPending(db, payload.conflictId, after.putBack).catch(
          (putBackErr: unknown) => {
            throw new AggregateError(
              [err, putBackErr],
              `${err}; putting the render file's bytes back failed too: ${putBackErr}`,
            );
          },
        );
      }
      throw err;
    }
  }
  if (after.resync !== null) {
    await syncProjectStateFromCheckout(db, {
      repositoryId: payload.repositoryId,
      repoPath: after.resync,
    }).catch((err) =>
      logger.warn(
        { err, repositoryId: payload.repositoryId },
        'project state not re-synced after a moved answer',
      ),
    );
  }
  return result;
}

/** Under the lock, so no sync reads in between; only an answer still pending is undone, since a
 *  commit whose acknowledgement was lost may have landed. */
async function putBackIfPending(
  db: Database,
  conflictId: string,
  putBack: { repoPath: string; raw: Buffer; wrote: Buffer },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ repositoryId: schema.projectStateConflicts.repositoryId })
      .from(schema.projectStateConflicts)
      .where(eq(schema.projectStateConflicts.id, conflictId));
    if (!row) return;
    await lockPlanMerge(tx, row.repositoryId);
    await lockProjectState(tx, row.repositoryId);
    const [again] = await tx
      .select({ resolvedAt: schema.projectStateConflicts.resolvedAt })
      .from(schema.projectStateConflicts)
      .where(eq(schema.projectStateConflicts.id, conflictId));
    if (again?.resolvedAt !== null) return;
    // Only over the bytes the failed answer wrote: a file someone changed since is theirs.
    await rewriteFileIfNoFollow(putBack.repoPath, RENDER_FILE, (data) =>
      data.equals(putBack.wrote) ? putBack.raw : null,
    );
  });
}

/** Keep mine leaves the column; take theirs switches RTK off as the tooling page does. No file is
 *  written: the question names a setting, not a record file. */
async function answerRtkQuestion(
  tx: Tx,
  {
    repositoryId,
    userId,
    answer,
    row,
  }: {
    repositoryId: string;
    userId: string;
    answer: ProjectStateAnswer;
    row: typeof schema.projectStateConflicts.$inferSelect;
  },
): Promise<ProjectStateResolveResult> {
  if (answer === 'take_theirs') {
    const incoming = conflictSideValue(row.incoming);
    if (typeof incoming !== 'boolean') return { kind: 'invalid' };
    await tx
      .update(schema.repositories)
      .set(rtkEnabledUpdate(incoming))
      .where(eq(schema.repositories.id, repositoryId));
  }
  const now = new Date();
  const [closed] = await tx
    .update(schema.projectStateConflicts)
    .set({ resolution: answer, resolvedAt: now, resolvedBy: userId })
    .where(eq(schema.projectStateConflicts.id, row.id))
    .returning();
  return {
    kind: 'resolved',
    conflict: conflictBody(closed ?? { ...row, resolution: answer, resolvedAt: now }),
    written: [],
  };
}

async function answerInTransaction(
  db: Database,
  { repositoryId, userId, conflictId, answer }: ProjectStateResolvePayload,
  after: After,
): Promise<ProjectStateResolveResult> {
  return db.transaction(async (tx): Promise<ProjectStateResolveResult> => {
    // A pull lands the checkout under this lock, so no pull rewrites render.json between the last
    // check and the commit.
    await lockPlanMerge(tx, repositoryId);
    await lockProjectState(tx, repositoryId);
    const [repo] = await tx
      .select({
        userId: schema.repositories.userId,
        renderContext: schema.repositories.renderContext,
        storagePath: schema.repositories.storagePath,
        localPath: schema.repositories.localPath,
      })
      .from(schema.repositories)
      .where(eq(schema.repositories.id, repositoryId))
      .for('update');
    if (!repo || repo.userId !== userId) return { kind: 'not_found' };
    const [row] = await tx
      .select()
      .from(schema.projectStateConflicts)
      .where(
        and(
          eq(schema.projectStateConflicts.id, conflictId),
          eq(schema.projectStateConflicts.repositoryId, repositoryId),
        ),
      )
      .for('update');
    if (!row || !isConflictUnit(row.unit)) return { kind: 'not_found' };
    if (row.resolvedAt !== null) {
      return row.resolution === answer
        ? { kind: 'resolved', conflict: conflictBody(row), written: [] }
        : { kind: 'settled', resolution: row.resolution ?? '' };
    }

    const live = await tx
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.repositoryId, repositoryId),
          inArray(schema.tasks.type, ['onboarding', 'onboarding_upgrade']),
          inArray(schema.tasks.status, [...CHECKOUT_HOLDING_TASK_STATUSES]),
        ),
      )
      .limit(1);
    if (live.length > 0) return { kind: 'busy' };

    if (row.unit === RTK_ENABLED_UNIT) {
      return answerRtkQuestion(tx, { repositoryId, userId, answer, row });
    }

    const repoPath = repo.storagePath ?? repo.localPath;
    if (!repoPath) return { kind: 'moved' };
    const moved = (): ProjectStateResolveResult => {
      after.resync = repoPath;
      return { kind: 'moved' };
    };

    const whole = row.unit === RENDER_UNIT;
    const key = keyOf(row.unit);
    const incoming = conflictSideValue(row.incoming);
    const read = await readRenderFile(repoPath);
    if (read === null) return moved();
    const onDisk = read.render;
    const onDiskValue = whole ? onDisk : (onDisk as Json)[key];
    if (incoming === undefined || !sameValue(onDiskValue, incoming)) return moved();

    let column = (repo.renderContext ?? null) as Json | null;
    if (column === null && !whole) {
      const rebuilt = await rebuildLocalRender(tx, repositoryId, onDisk);
      if (rebuilt === null) return moved();
      column = { ...rebuilt, rtkChoiceRecorded: true };
    }
    const mine = whole
      ? undefined
      : (column as Json)[key] !== undefined
        ? (column as Json)[key]
        : conflictSideValue(row.local);
    if (answer === 'keep_mine' && mine === undefined) return { kind: 'no_local' };
    const chosen = answer === 'take_theirs' ? incoming : mine;

    const next = renderContextColumnSchema.safeParse(
      whole
        ? {
            ...column,
            ...(chosen as Json),
            rtkChoiceRecorded: column === null ? true : column.rtkChoiceRecorded,
          }
        : { ...column, [key]: chosen },
    );
    if (!next.success) return { kind: 'invalid' };

    const planned = whole
      ? (chosen as ProjectRender)
      : ({ ...onDisk, [key]: chosen } as ProjectRender);
    let fileText: string | null = null;
    if (!sameValue(planned, onDisk)) {
      try {
        fileText = renderProjectState({ ...emptyProjectState(), render: planned }).get(
          'project/render.json',
        )!;
      } catch (err) {
        if (err instanceof ProjectStateError) return { kind: 'invalid' };
        throw err;
      }
    }

    const [sync] = await tx
      .select({
        baseSnapshot: schema.projectStateSync.baseSnapshot,
        lastError: schema.projectStateSync.lastError,
      })
      .from(schema.projectStateSync)
      .where(eq(schema.projectStateSync.repositoryId, repositoryId))
      .limit(1);
    const snapshot = (sync?.baseSnapshot ?? {}) as Partial<ProjectStateRecord>;
    const baseRender = (snapshot.render ?? null) as Json | null;
    const baseNext = whole
      ? (chosen as ProjectRender)
      : ({ ...baseRender, [key]: chosen } as ProjectRender);

    const now = new Date();
    if (!sameValue(next.data, repo.renderContext ?? null)) {
      await tx
        .update(schema.repositories)
        .set({ renderContext: next.data })
        .where(eq(schema.repositories.id, repositoryId));
      await writeApplicableTemplateIds(tx, { repositoryId, userId: repo.userId });
    }

    const [closed] = await tx
      .update(schema.projectStateConflicts)
      .set({ resolution: answer, resolvedAt: now, resolvedBy: userId })
      .where(eq(schema.projectStateConflicts.id, row.id))
      .returning();

    const remaining = await loadPendingRenderConflicts(tx, repositoryId);
    const stillConflict =
      remaining.length === 0
        ? null
        : `${CONFLICT_ERROR_PREFIX}${remaining.map((r) => keyOf(r.unit)).join(', ')}`;
    const lastError =
      sync === undefined ||
      sync.lastError === null ||
      sync.lastError.startsWith(CONFLICT_ERROR_PREFIX)
        ? stillConflict
        : sync.lastError;
    const synced = {
      baseSnapshot: normalizeProjectState({
        ...emptyProjectState(),
        ...snapshot,
        render: baseNext,
      }),
      lastError,
      updatedAt: now,
    };
    await tx
      .insert(schema.projectStateSync)
      .values({ repositoryId, ...synced })
      .onConflictDoUpdate({ target: schema.projectStateSync.repositoryId, set: synced });

    // Last, so only the commit follows it; a failure from here on puts the previous bytes back.
    const written: string[] = [];
    if (fileText !== null) {
      const outcome = await rewriteFileIfNoFollow(repoPath, RENDER_FILE, (data) =>
        data.equals(read.raw) ? Buffer.from(fileText, 'utf8') : null,
      );
      if (outcome !== 'rewritten') throw new RenderFileMovedError(repoPath);
      after.putBack = { repoPath, raw: read.raw, wrote: Buffer.from(fileText, 'utf8') };
      written.push(RENDER_FILE);
    } else {
      const now = await readRenderFile(repoPath);
      if (now === null || !now.raw.equals(read.raw)) throw new RenderFileMovedError(repoPath);
    }

    return {
      kind: 'resolved',
      conflict: conflictBody(closed ?? { ...row, resolution: answer, resolvedAt: now }),
      written,
    };
  });
}
