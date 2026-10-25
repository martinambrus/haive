import { safeErrorMessage } from '@haive/shared/logger';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { CHECKOUT_HOLDING_TASK_STATUSES, logger } from '@haive/shared';
import { rtkEnabledUpdate } from '@haive/shared/rtk-enabled';
import { markProjectStateDirty } from '@haive/shared/project-state-outbox';
import { isUtf8 } from 'node:buffer';
import {
  isPathContainmentError,
  readFileNoFollow,
  removeFileIfNoFollow,
  rewriteFileIfNoFollow,
  writeFileNoFollow,
} from '@haive/shared/fs-safe';
import {
  ENVIRONMENT_UNIT,
  PROJECT_STATE_DIR,
  ProjectStateError,
  RENDER_UNIT,
  isRtkQuestion,
  claimFileName,
  claimSchema,
  conflictBody,
  conflictSideValue,
  emptyProjectState,
  environmentColumnOf,
  environmentSchema,
  environmentUnitOf,
  isClaimUnit,
  isConflictUnit,
  isEnvironmentUnit,
  isPlanUnit,
  isSettingUnit,
  normalizeEnvironment,
  normalizeProjectState,
  normalizeSetting,
  portableSettingsOf,
  settingColumnUpdate,
  renderContextColumnSchema,
  renderProjectState,
  renderSchema,
  sameValue,
  type ProjectEnvironment,
  type ProjectRender,
  type ProjectStateClaim,
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
import { answerPlanQuestion } from '../plan/answer.js';
import { flushPlanMirrorForRepository, lockPlanMirror } from '../plan/mirror.js';
import { insertImportMarker, loadMarkerContext } from './import-marker.js';
import { loadPendingRenderConflicts, loadRecordClaims, lockProjectState } from './write.js';

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

interface PutBack {
  repoPath: string;
  rel: string;
  /** The bytes the file held before the answer; null where the answer created it. */
  raw: Buffer | null;
  wrote: Buffer;
}

interface After {
  resync: string | null;
  putBack: PutBack | null;
  flushPlan: boolean;
}

/** Answers one pending conflict of the render unit, so that the file, the sync base and the column
 *  agree on the answered key and the next sync finds nothing to ask. Idempotent: the same answer to
 *  a closed row returns it again. A failure after the file was rewritten puts its bytes back. */
export async function resolveProjectStateConflict(
  db: Database,
  payload: ProjectStateResolvePayload,
): Promise<ProjectStateResolveResult> {
  const after: After = { resync: null, putBack: null, flushPlan: false };
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
              `${safeErrorMessage(err)}; putting the render file's bytes back failed too: ${safeErrorMessage(putBackErr)}`,
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
  if (after.flushPlan && result.kind === 'resolved') {
    await flushPlanMirrorForRepository(db, payload.repositoryId).catch((err) =>
      logger.warn(
        { err, repositoryId: payload.repositoryId },
        'plan mirror not flushed after a plan answer; the sweep retries',
      ),
    );
  }
  return result;
}

/** Under the lock, so no sync reads in between; only an answer still pending is undone, since a
 *  commit whose acknowledgement was lost may have landed. */
async function putBackIfPending(db: Database, conflictId: string, putBack: PutBack): Promise<void> {
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
    const { repoPath, rel, raw, wrote } = putBack;
    if (raw === null) {
      await removeFileIfNoFollow(repoPath, rel, (data) => data.equals(wrote));
    } else {
      await rewriteFileIfNoFollow(repoPath, rel, (data) => (data.equals(wrote) ? raw : null));
    }
  });
}

/** Either answer is this install's own choice and stamps `rtk_choice_made_at`; keep mine leaves the
 *  column, take theirs switches RTK off as the tooling page does. No file is written here: the
 *  question names a setting, and the sweep brings the record file to the column. */
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
      .set({ ...rtkEnabledUpdate(incoming), rtkChoiceMadeAt: new Date() })
      .where(eq(schema.repositories.id, repositoryId));
  } else {
    await tx
      .update(schema.repositories)
      .set({ rtkChoiceMadeAt: new Date() })
      .where(eq(schema.repositories.id, repositoryId));
  }
  await markProjectStateDirty(tx, repositoryId);
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

async function loadSyncRow(tx: Tx, repositoryId: string) {
  const [sync] = await tx
    .select({
      baseSnapshot: schema.projectStateSync.baseSnapshot,
      lastError: schema.projectStateSync.lastError,
    })
    .from(schema.projectStateSync)
    .where(eq(schema.projectStateSync.repositoryId, repositoryId))
    .limit(1);
  return sync;
}

type ClaimFile =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'file'; claim: ProjectStateClaim; raw: Buffer };

async function readClaimFile(repoPath: string, rel: string): Promise<ClaimFile> {
  try {
    const read = await readFileNoFollow(repoPath, rel, {
      strict: true,
      maxBytes: MAX_RENDER_BYTES,
    });
    if (read === null) return { kind: 'absent' };
    if (read.truncated || !isUtf8(read.data)) return { kind: 'unreadable' };
    const parsed = claimSchema.safeParse(JSON.parse(read.data.toString('utf8')));
    return parsed.success
      ? { kind: 'file', claim: parsed.data, raw: read.data }
      : { kind: 'unreadable' };
  } catch (err) {
    if (err instanceof SyntaxError || isPathContainmentError(err)) return { kind: 'unreadable' };
    throw err;
  }
}

/** A claim side as the row holds it: the claim, `undefined` where the side has none, `null` where
 *  what it holds is not a claim. */
function claimSide(side: unknown): ProjectStateClaim | undefined | null {
  const value = conflictSideValue(side);
  if (value === undefined) return undefined;
  const parsed = claimSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Answers a question about one artifact claim: keep mine writes the claim file and the base at the
 *  local row, take theirs retires that row and records their claim as an import marker. */
async function answerClaimQuestion(
  tx: Tx,
  {
    repositoryId,
    userId,
    answer,
    row,
    repo,
    repoPath,
    after,
    moved,
  }: {
    repositoryId: string;
    userId: string;
    answer: ProjectStateAnswer;
    row: typeof schema.projectStateConflicts.$inferSelect;
    repo: { userId: string; renderContext: unknown; rtkChoiceMadeAt: Date | null };
    repoPath: string;
    after: After;
    moved: () => ProjectStateResolveResult;
  },
): Promise<ProjectStateResolveResult> {
  const rel = `${PROJECT_STATE_DIR}/${row.unit}`;
  const base = claimSide(row.base);
  const incoming = claimSide(row.incoming);
  const named = incoming ?? base ?? claimSide(row.local);
  if (base === null || incoming === null || named === null || named === undefined) {
    return { kind: 'invalid' };
  }
  const path = named.path;
  if (claimFileName(path) !== row.unit) return { kind: 'invalid' };

  const file = await readClaimFile(repoPath, rel);
  if (file.kind === 'unreadable') return moved();
  if (incoming === undefined ? file.kind !== 'absent' : file.kind !== 'file') return moved();
  if (incoming !== undefined && file.kind === 'file' && !sameValue(file.claim, incoming)) {
    return moved();
  }

  const mine = (await loadRecordClaims(tx, repositoryId)).find((claim) => claim.path === path);
  if (answer === 'keep_mine' && mine === undefined) return { kind: 'no_local' };
  let chosen = answer === 'keep_mine' ? mine : incoming;

  let fileText: string | null = null;
  if (answer === 'keep_mine' && !(file.kind === 'file' && sameValue(file.claim, mine))) {
    try {
      fileText = renderProjectState({ ...emptyProjectState(), claims: [mine!] }).get(row.unit)!;
    } catch (err) {
      if (err instanceof ProjectStateError) return { kind: 'invalid' };
      throw err;
    }
  }

  const sync = await loadSyncRow(tx, repositoryId);
  const snapshot = (sync?.baseSnapshot ?? {}) as Partial<ProjectStateRecord>;
  const baseClaims = Array.isArray(snapshot.claims) ? snapshot.claims : [];
  const now = new Date();

  if (answer === 'take_theirs') {
    const [live] = await tx
      .select({ id: schema.onboardingArtifacts.id })
      .from(schema.onboardingArtifacts)
      .where(
        and(
          eq(schema.onboardingArtifacts.repositoryId, repositoryId),
          eq(schema.onboardingArtifacts.diskPath, path),
          isNull(schema.onboardingArtifacts.supersededAt),
        ),
      )
      .limit(1);
    if (live) {
      await tx
        .update(schema.onboardingArtifacts)
        .set({ supersededAt: now, importedAt: now })
        .where(eq(schema.onboardingArtifacts.id, live.id));
    }
    if (incoming !== undefined) {
      await insertImportMarker(tx, {
        repositoryId,
        repoPath,
        claim: incoming,
        now,
        context: await loadMarkerContext(tx, repositoryId, repo),
      });
    }
    await writeApplicableTemplateIds(tx, {
      repositoryId,
      userId: repo.userId,
      requireResolved: repo.renderContext !== null,
    });
  }

  const [closed] = await tx
    .update(schema.projectStateConflicts)
    .set({ resolution: answer, resolvedAt: now, resolvedBy: userId })
    .where(eq(schema.projectStateConflicts.id, row.id))
    .returning();

  const synced = {
    baseSnapshot: normalizeProjectState({
      ...emptyProjectState(),
      ...snapshot,
      claims: [
        ...baseClaims.filter((claim) => claim.path !== path),
        ...(chosen === undefined ? [] : [chosen]),
      ],
    }),
    lastError: sync?.lastError ?? null,
    updatedAt: now,
  };
  await tx
    .insert(schema.projectStateSync)
    .values({ repositoryId, ...synced })
    .onConflictDoUpdate({ target: schema.projectStateSync.repositoryId, set: synced });

  const written: string[] = [];
  if (fileText !== null) {
    const bytes = Buffer.from(fileText, 'utf8');
    if (file.kind === 'file') {
      const outcome = await rewriteFileIfNoFollow(repoPath, rel, (data) =>
        data.equals(file.raw) ? bytes : null,
      );
      if (outcome !== 'rewritten') throw new RenderFileMovedError(repoPath);
    } else {
      try {
        await writeFileNoFollow(repoPath, rel, bytes, {
          mode: 'create-exclusive',
          createParents: true,
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST')
          throw new RenderFileMovedError(repoPath);
        throw err;
      }
    }
    after.putBack = {
      repoPath,
      rel,
      raw: file.kind === 'file' ? file.raw : null,
      wrote: bytes,
    };
    written.push(rel);
  } else {
    const again = await readClaimFile(repoPath, rel);
    const unchanged =
      again.kind === file.kind &&
      (again.kind !== 'file' || (file.kind === 'file' && again.raw.equals(file.raw)));
    if (!unchanged) throw new RenderFileMovedError(repoPath);
  }

  return {
    kind: 'resolved',
    conflict: conflictBody(closed ?? { ...row, resolution: answer, resolvedAt: now }),
    written,
  };
}

type RecordFile =
  { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'file'; value: unknown; raw: Buffer };

async function readRecordFile(repoPath: string, rel: string): Promise<RecordFile> {
  try {
    const read = await readFileNoFollow(repoPath, rel, {
      strict: true,
      maxBytes: MAX_RENDER_BYTES,
    });
    if (read === null) return { kind: 'absent' };
    if (read.truncated || !isUtf8(read.data)) return { kind: 'unreadable' };
    return { kind: 'file', value: JSON.parse(read.data.toString('utf8')), raw: read.data };
  } catch (err) {
    if (err instanceof SyntaxError || isPathContainmentError(err)) return { kind: 'unreadable' };
    throw err;
  }
}

const settingNameOf = (unit: string): string => unit.slice('settings/'.length, -'.json'.length);

/** What the checkout's file holds for the unit, as the sync reads it: normalised, `undefined` where
 *  the file or the key is not there, `null` where the file is no valid value of the unit. */
function fileValueOf(unit: string, file: RecordFile): unknown {
  if (file.kind === 'absent') return undefined;
  if (file.kind === 'unreadable') return null;
  if (isSettingUnit(unit)) {
    const checked = normalizeSetting(settingNameOf(unit), file.value);
    return checked.ok ? checked.value : null;
  }
  const parsed = environmentSchema.safeParse(file.value);
  if (!parsed.success) return null;
  const environment = normalizeEnvironment(parsed.data);
  return unit === ENVIRONMENT_UNIT
    ? environment
    : (environment as Record<string, unknown>)[unit.slice(ENVIRONMENT_UNIT.length + 1)];
}

/** Answers a question about a portable setting or the environment: keep mine writes the column's
 *  value into the unit's file and the base at it, take theirs applies the other install's value to
 *  the column, as the routes would, and the base takes it; the file already holds it. */
async function answerSettingsQuestion(
  tx: Tx,
  {
    repositoryId,
    userId,
    answer,
    row,
    repoPath,
    after,
    moved,
  }: {
    repositoryId: string;
    userId: string;
    answer: ProjectStateAnswer;
    row: typeof schema.projectStateConflicts.$inferSelect;
    repoPath: string;
    after: After;
    moved: () => ProjectStateResolveResult;
  },
): Promise<ProjectStateResolveResult> {
  const environmental = isEnvironmentUnit(row.unit);
  const rel = `${PROJECT_STATE_DIR}/${row.unit.split('#')[0]}`;
  const incoming = conflictSideValue(row.incoming);
  const file = await readRecordFile(repoPath, rel);
  const held = fileValueOf(row.unit, file);
  if (held === null || !sameValue(held, incoming)) return moved();

  const [columns] = await tx
    .select({
      scopeExcludeGlobs: schema.repositories.scopeExcludeGlobs,
      rtkEnabled: schema.repositories.rtkEnabled,
      rtkVersion: schema.repositories.rtkVersion,
      lspServers: schema.repositories.lspServers,
      lspServerVersions: schema.repositories.lspServerVersions,
      chromeDevtoolsMcpVersion: schema.repositories.chromeDevtoolsMcpVersion,
      reviewDimensions: schema.repositories.reviewDimensions,
      onboardingEnvironment: schema.repositories.onboardingEnvironment,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  if (!columns) return { kind: 'not_found' };
  const environment = environmentUnitOf(columns.onboardingEnvironment);
  const key = row.unit.includes('#') ? row.unit.slice(ENVIRONMENT_UNIT.length + 1) : null;
  const mine = environmental
    ? key === null
      ? environment
      : (environment as Record<string, unknown> | null)?.[key]
    : portableSettingsOf(columns)[settingNameOf(row.unit)];
  if (answer === 'keep_mine' && (mine === undefined || mine === null)) return { kind: 'no_local' };

  const sync = await loadSyncRow(tx, repositoryId);
  const snapshot = (sync?.baseSnapshot ?? {}) as Partial<ProjectStateRecord>;
  let chosen = answer === 'keep_mine' ? mine : incoming;

  let update: Record<string, unknown> | null = null;
  let plannedEnvironment: ProjectEnvironment | null = null;
  if (environmental) {
    const onDisk = file.kind === 'file' ? environmentSchema.parse(file.value) : null;
    plannedEnvironment =
      key === null
        ? ((chosen ?? null) as ProjectEnvironment | null)
        : ((onDisk && { ...onDisk, [key]: chosen }) as ProjectEnvironment | null);
    if (answer === 'take_theirs') {
      const next =
        key === null
          ? (chosen as ProjectEnvironment | undefined)
          : environment && ({ ...environment, [key]: chosen } as ProjectEnvironment);
      if (!next) return { kind: 'invalid' };
      update = { onboardingEnvironment: environmentColumnOf(normalizeEnvironment(next)) };
    }
  } else if (answer === 'take_theirs') {
    const checked = chosen === undefined ? null : normalizeSetting(settingNameOf(row.unit), chosen);
    if (checked !== null && !checked.ok) return { kind: 'invalid' };
    chosen = checked?.value;
    update = settingColumnUpdate(settingNameOf(row.unit), chosen);
    if (update === null) return { kind: 'invalid' };
  }

  let fileText: string | null = null;
  if (answer === 'keep_mine') {
    try {
      const planned = environmental
        ? { ...emptyProjectState(), environment: plannedEnvironment }
        : { ...emptyProjectState(), settings: { [settingNameOf(row.unit)]: chosen } };
      fileText = renderProjectState(planned).get(rel.slice(PROJECT_STATE_DIR.length + 1)) ?? null;
    } catch (err) {
      if (err instanceof ProjectStateError) return { kind: 'invalid' };
      throw err;
    }
    if (fileText === null) return { kind: 'invalid' };
    if (file.kind === 'file' && file.raw.equals(Buffer.from(fileText, 'utf8'))) fileText = null;
  }

  const now = new Date();
  if (update !== null) {
    await tx
      .update(schema.repositories)
      .set({ ...update, updatedAt: now })
      .where(eq(schema.repositories.id, repositoryId));
  }

  const [closed] = await tx
    .update(schema.projectStateConflicts)
    .set({ resolution: answer, resolvedAt: now, resolvedBy: userId })
    .where(eq(schema.projectStateConflicts.id, row.id))
    .returning();

  const baseEnvironment = (snapshot.environment ?? plannedEnvironment) as ProjectEnvironment | null;
  const base = environmental
    ? {
        ...snapshot,
        environment: (key === null
          ? (chosen ?? null)
          : baseEnvironment && { ...baseEnvironment, [key]: chosen }) as ProjectEnvironment | null,
      }
    : {
        ...snapshot,
        settings: Object.fromEntries(
          Object.entries({
            ...(snapshot.settings ?? {}),
            [settingNameOf(row.unit)]: chosen,
          }).filter(([, value]) => value !== undefined),
        ),
      };
  const synced = {
    baseSnapshot: normalizeProjectState({ ...emptyProjectState(), ...base }),
    lastError: sync?.lastError ?? null,
    updatedAt: now,
  };
  await tx
    .insert(schema.projectStateSync)
    .values({ repositoryId, ...synced })
    .onConflictDoUpdate({ target: schema.projectStateSync.repositoryId, set: synced });

  const written: string[] = [];
  if (fileText !== null) {
    const bytes = Buffer.from(fileText, 'utf8');
    if (file.kind === 'file') {
      const outcome = await rewriteFileIfNoFollow(repoPath, rel, (data) =>
        data.equals(file.raw) ? bytes : null,
      );
      if (outcome !== 'rewritten') throw new RenderFileMovedError(repoPath);
    } else {
      try {
        await writeFileNoFollow(repoPath, rel, bytes, {
          mode: 'create-exclusive',
          createParents: true,
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST')
          throw new RenderFileMovedError(repoPath);
        throw err;
      }
    }
    after.putBack = {
      repoPath,
      rel,
      raw: file.kind === 'file' ? file.raw : null,
      wrote: bytes,
    };
    written.push(rel);
  } else {
    const again = await readRecordFile(repoPath, rel);
    const unchanged =
      again.kind === file.kind &&
      (again.kind !== 'file' || (file.kind === 'file' && again.raw.equals(file.raw)));
    if (!unchanged) throw new RenderFileMovedError(repoPath);
  }

  return {
    kind: 'resolved',
    conflict: conflictBody(closed ?? { ...row, resolution: answer, resolvedAt: now }),
    written,
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
    const [peek] = await tx
      .select({ unit: schema.projectStateConflicts.unit })
      .from(schema.projectStateConflicts)
      .where(
        and(
          eq(schema.projectStateConflicts.id, conflictId),
          eq(schema.projectStateConflicts.repositoryId, repositoryId),
        ),
      );
    if (peek && isPlanUnit(peek.unit)) {
      // Lock order: plan merge, project state, plan mirror, then repository, conflict and node rows.
      await lockPlanMirror(tx, repositoryId);
      const planResult = await answerPlanQuestion(tx, { repositoryId, userId, conflictId, answer });
      after.flushPlan = true;
      return planResult;
    }
    const [repo] = await tx
      .select({
        userId: schema.repositories.userId,
        renderContext: schema.repositories.renderContext,
        storagePath: schema.repositories.storagePath,
        localPath: schema.repositories.localPath,
        rtkChoiceMadeAt: schema.repositories.rtkChoiceMadeAt,
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
          isNull(schema.tasks.deadAt),
        ),
      )
      .limit(1);
    if (live.length > 0) return { kind: 'busy' };

    if (isRtkQuestion(row)) {
      return answerRtkQuestion(tx, { repositoryId, userId, answer, row });
    }

    const repoPath = repo.storagePath ?? repo.localPath;
    if (!repoPath) return { kind: 'moved' };
    const moved = (): ProjectStateResolveResult => {
      after.resync = repoPath;
      return { kind: 'moved' };
    };

    if (isClaimUnit(row.unit)) {
      return answerClaimQuestion(tx, {
        repositoryId,
        userId,
        answer,
        row,
        repo,
        repoPath,
        after,
        moved,
      });
    }

    if (isSettingUnit(row.unit) || isEnvironmentUnit(row.unit)) {
      return answerSettingsQuestion(tx, {
        repositoryId,
        userId,
        answer,
        row,
        repoPath,
        after,
        moved,
      });
    }

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
      column = { ...rebuilt, rtkChoiceRecorded: false };
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
            rtkChoiceRecorded: column === null ? false : column.rtkChoiceRecorded,
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

    const sync = await loadSyncRow(tx, repositoryId);
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
      after.putBack = {
        repoPath,
        rel: RENDER_FILE,
        raw: read.raw,
        wrote: Buffer.from(fileText, 'utf8'),
      };
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
