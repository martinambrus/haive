import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Database } from '@haive/database';
import { readFileNoFollow, removeFileIfNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import {
  PROJECT_STATE_DIR,
  RENDER_UNIT,
  ENVIRONMENT_UNIT,
  bundleDescriptors,
  bundleFileName,
  claimFileName,
  conflictSide,
  conflictSideValue,
  emptyProjectState,
  environmentUnitOf,
  isCanonicalRepoPath,
  isClaimablePath,
  isClaimUnit,
  isEnvironmentUnit,
  isRenderUnit,
  isRtkQuestion,
  isSettingUnit,
  sameValue,
  normalizeProjectState,
  isRecordName,
  portableBundleSource,
  portableRender,
  portableSettingsOf,
  settingFileName,
  toolingUnitOf,
  TOOLING_UNIT_NAME,
  withoutUnchosenRtk,
  portableTemplateId,
  recordReadable,
  renderContextColumnSchema,
  renderProjectState,
  type NamedLocalBundle,
  type ProjectEnvironment,
  type ProjectRender,
  type ProjectStateBundle,
  type ProjectStateClaim,
} from '@haive/shared/project-state';
import { CHECKOUT_HOLDING_TASK_STATUSES } from '@haive/shared';
import { gitOperationInProgress } from '../repo/git-operation.js';
import type { TemplateRenderContext } from '../step-engine/template-manifest.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** First in every transaction that writes a repository's render context or its sync row. */
export async function lockProjectState(tx: Tx, repositoryId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`project-state:${repositoryId}`}, 0))`,
  );
}

type RenderContextColumn = ReturnType<typeof renderContextColumnFor>;

interface ProjectStateColumnInput {
  repositoryId: string;
  repoPath: string;
  /** The columns the writer planned against; a column found holding anything else (null aside)
   *  refuses the write before a file changes. Omitted: written whatever the column holds. */
  expectedColumns?: unknown[];
  /** The task writing the record. Its write is refused once the task no longer holds the checkout,
   *  since a refresh may then have fast-forwarded the record files under it. */
  holdingTaskId?: string;
}

export interface ProjectStateRecordInput extends ProjectStateColumnInput {
  context: TemplateRenderContext;
  /** Whether `context.rtkEnabled` is a choice somebody made, rather than a default. */
  rtkChoiceRecorded: boolean;
}

interface Look {
  pending: PendingRenderConflict[];
  pendingClaims: PendingClaimConflict[];
  pendingSettings: PendingRenderConflict[];
  claims: ProjectStateClaim[];
  bundles: ProjectStateBundle[];
  settings: Record<string, unknown>;
  environment: ProjectEnvironment | null;
  baseFiles: string[];
}

const RTK_SETTING_FILE = `${PROJECT_STATE_DIR}/${settingFileName('rtk-enabled')}`;
const ENVIRONMENT_FILE = `${PROJECT_STATE_DIR}/project/environment.json`;
const OWNED_FILE_PREFIXES = [
  `${PROJECT_STATE_DIR}/artifacts/`,
  `${PROJECT_STATE_DIR}/bundles/`,
  `${PROJECT_STATE_DIR}/settings/`,
];
const isOwnedFile = (path: string): boolean =>
  path === ENVIRONMENT_FILE || OWNED_FILE_PREFIXES.some((p) => path.startsWith(p));

/** The column moved past what the writer planned against, so its record would undo a newer one. */
export class ProjectStateMovedError extends Error {
  constructor() {
    super("The repository's project settings changed while this write was pending");
    this.name = 'ProjectStateMovedError';
  }
}

/** The record's files are more than a reader of the directory accepts, so none is written. */
export class ProjectStateUnreadableError extends Error {
  constructor(reason: string) {
    super(`the project state record would not be read back: ${reason}`);
    this.name = 'ProjectStateUnreadableError';
  }
}

/** What a record write left behind, as repository-relative paths: the files it wrote and the claim
 *  files it removed, for whoever commits the repository to stage. */
export interface ProjectStateWriteResult {
  written: string[];
  removed: string[];
}

/** A write that failed once it had begun. `written` and `removed` name the repository-relative record
 *  files standing on disk, and the claim and descriptor files gone from it, by then, whatever the
 *  database kept, so that whoever commits the repository commits them. */
export class ProjectStateWriteError extends Error {
  readonly written: string[];
  readonly removed: string[];
  /** The column could not be cleared either, so it still outranks the rows its writer wrote. */
  readonly columnStale: boolean;

  constructor(cause: unknown, written: string[], columnStale = false, removed: string[] = []) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ProjectStateWriteError';
    this.written = written;
    this.removed = removed;
    this.columnStale = columnStale;
  }
}

/** A writer reports a failed record write as a warning, unless the column it leaves would outrank the
 *  rows it wrote: that one fails the step, which a retry runs again. */
export function failIfColumnStale(err: unknown): void {
  if (err instanceof ProjectStateWriteError && err.columnStale) throw err;
}

/** The render context column a record write stores for this context. Throws when it would not read back. */
export function renderContextColumnFor(context: TemplateRenderContext, rtkChoiceRecorded: boolean) {
  return renderContextColumnSchema.parse({ ...context, rtkChoiceRecorded });
}

/** A pending conflict of the render unit, its sides as values (`undefined` where a side has none). */
export interface PendingRenderConflict {
  unit: string;
  base: unknown;
  local: unknown;
  incoming: unknown;
}

async function loadPendingRows(db: Database | Tx, repositoryId: string) {
  return db
    .select({
      unit: schema.projectStateConflicts.unit,
      base: schema.projectStateConflicts.base,
      local: schema.projectStateConflicts.local,
      incoming: schema.projectStateConflicts.incoming,
    })
    .from(schema.projectStateConflicts)
    .where(
      and(
        eq(schema.projectStateConflicts.repositoryId, repositoryId),
        isNull(schema.projectStateConflicts.resolvedAt),
      ),
    )
    .orderBy(asc(schema.projectStateConflicts.unit));
}

const sidesOf = (row: Awaited<ReturnType<typeof loadPendingRows>>[number]) => ({
  unit: row.unit,
  base: conflictSideValue(row.base),
  local: conflictSideValue(row.local),
  incoming: conflictSideValue(row.incoming),
});

export async function loadPendingRenderConflicts(
  db: Database | Tx,
  repositoryId: string,
): Promise<PendingRenderConflict[]> {
  return (await loadPendingRows(db, repositoryId))
    .filter((row) => isRenderUnit(row.unit))
    .map(sidesOf);
}

/** A pending conflict of one artifact claim: its sides are the claim, `undefined` where a side
 *  holds none. */
export interface PendingClaimConflict {
  unit: string;
  base: unknown;
  local: unknown;
  incoming: unknown;
}

export async function loadPendingClaimConflicts(
  db: Database | Tx,
  repositoryId: string,
): Promise<PendingClaimConflict[]> {
  return (await loadPendingRows(db, repositoryId))
    .filter((row) => isClaimUnit(row.unit))
    .map(sidesOf);
}

/** Pending conflicts of a portable setting or of the environment, not the RTK question, which names a
 *  setting no merge contested and so has no value of the other install's to write. */
export async function loadPendingSettingConflicts(
  db: Database | Tx,
  repositoryId: string,
): Promise<PendingRenderConflict[]> {
  return (await loadPendingRows(db, repositoryId))
    .filter(
      (row) => (isSettingUnit(row.unit) || isEnvironmentUnit(row.unit)) && !isRtkQuestion(row),
    )
    .map(sidesOf);
}

/** The settings with every contested one at `side`'s value; a side that holds none leaves it out. */
export function overlaySettings(
  settings: Record<string, unknown>,
  pending: readonly PendingRenderConflict[],
  side: 'base' | 'local' | 'incoming',
): Record<string, unknown> {
  const out = { ...settings };
  for (const row of pending.filter((r) => isSettingUnit(r.unit))) {
    const name = row.unit.slice('settings/'.length, -'.json'.length);
    if (row[side] === undefined) delete out[name];
    else out[name] = row[side];
  }
  return out;
}

/** The environment with every contested key (or the whole of it) at `side`'s value. A result missing
 *  a key is no environment. */
export function overlayEnvironment(
  environment: ProjectEnvironment | null,
  pending: readonly PendingRenderConflict[],
  side: 'base' | 'local' | 'incoming',
): ProjectEnvironment | null {
  let out: Record<string, unknown> | null = environment;
  for (const row of pending.filter((r) => isEnvironmentUnit(r.unit))) {
    if (row.unit === ENVIRONMENT_UNIT) {
      out = (row[side] ?? null) as Record<string, unknown> | null;
      continue;
    }
    out = { ...out, [row.unit.slice(ENVIRONMENT_UNIT.length + 1)]: row[side] };
  }
  const whole = out as Partial<ProjectEnvironment> | null;
  return whole?.envDetectData && whole.confirmedValues ? (whole as ProjectEnvironment) : null;
}

/** The render unit with every contested key at `side`'s value, the whole unit first. A writer renders
 *  the file with `incoming` and the sync base with `base`, so the next sync meets the same conflict
 *  rather than the writer settling it for the column's side. */
export function overlayRender(
  render: ProjectRender | null,
  pending: readonly PendingRenderConflict[],
  side: 'base' | 'local' | 'incoming',
): ProjectRender | null {
  let out: Record<string, unknown> | null = render;
  for (const row of pending) {
    const value = row[side];
    if (row.unit === RENDER_UNIT) {
      out = (value ?? null) as Record<string, unknown> | null;
      continue;
    }
    const key = row.unit.slice(RENDER_UNIT.length + 1);
    out = { ...out, [key]: value };
  }
  return out as ProjectRender | null;
}

/** The claims with every contested one at `side`'s value: a side that holds none leaves the claim out.
 *  The writer's record takes `incoming` and its sync base `base`, as for the render unit. */
export function overlayClaims(
  claims: readonly ProjectStateClaim[],
  pending: readonly PendingClaimConflict[],
  side: 'base' | 'local' | 'incoming',
): ProjectStateClaim[] {
  const contested = new Set(pending.map((row) => row.unit));
  const out = claims.filter((claim) => !contested.has(claimFileName(claim.path)));
  for (const row of pending) {
    if (row[side] !== undefined) out.push(row[side] as ProjectStateClaim);
  }
  return out;
}

export async function loadLocalBundles(
  db: Database | Tx,
  repositoryId: string,
): Promise<NamedLocalBundle[]> {
  const bundles = await db
    .select({
      id: schema.customBundles.id,
      name: schema.customBundles.name,
      sourceType: schema.customBundles.sourceType,
      gitUrl: schema.customBundles.gitUrl,
      gitBranch: schema.customBundles.gitBranch,
    })
    .from(schema.customBundles)
    .where(eq(schema.customBundles.repositoryId, repositoryId));
  if (bundles.length === 0) return [];
  const items = await db
    .select({
      id: schema.customBundleItems.id,
      bundleId: schema.customBundleItems.bundleId,
      sourcePath: schema.customBundleItems.sourcePath,
    })
    .from(schema.customBundleItems)
    .where(
      inArray(
        schema.customBundleItems.bundleId,
        bundles.map((b) => b.id),
      ),
    );
  return bundles.map((b) => ({
    bundleId: b.id,
    name: b.name,
    source: portableBundleSource(b),
    items: new Map(items.filter((i) => i.bundleId === b.id).map((i) => [i.id, i.sourcePath])),
  }));
}

/** One claim per live ledger row of the repository a record can name: a path a claim may hold,
 *  and a template another install can map back. Import markers are live rows like any other. */
export async function loadRecordClaims(
  db: Database | Tx,
  repositoryId: string,
): Promise<ProjectStateClaim[]> {
  const rows = await db
    .select({
      diskPath: schema.onboardingArtifacts.diskPath,
      templateId: schema.onboardingArtifacts.templateId,
      templateKind: schema.onboardingArtifacts.templateKind,
      templateSchemaVersion: schema.onboardingArtifacts.templateSchemaVersion,
      templateContentHash: schema.onboardingArtifacts.templateContentHash,
      writtenHash: schema.onboardingArtifacts.writtenHash,
      haiveVersion: schema.onboardingArtifacts.haiveVersion,
    })
    .from(schema.onboardingArtifacts)
    .where(
      and(
        eq(schema.onboardingArtifacts.repositoryId, repositoryId),
        isNull(schema.onboardingArtifacts.supersededAt),
      ),
    )
    .orderBy(asc(schema.onboardingArtifacts.diskPath));
  const bundles = rows.some((r) => r.templateId.startsWith('custom.'))
    ? await loadLocalBundles(db, repositoryId)
    : [];
  const claims: ProjectStateClaim[] = [];
  for (const row of rows) {
    if (!isClaimablePath(row.diskPath)) continue;
    const templateId = portableTemplateId(row.templateId, bundles);
    if (templateId === null || templateId === '') continue;
    claims.push({
      path: row.diskPath,
      templateId,
      kind: row.templateKind,
      schemaVersion: row.templateSchemaVersion,
      templateHash: row.templateContentHash,
      writtenHash: row.writtenHash,
      haiveVersion: row.haiveVersion ?? '',
    });
  }
  return claims;
}

/** The files the sync base names, claims, bundle descriptors, settings and the environment: the
 *  ones this install holds, whoever wrote them. */
async function loadBase(
  db: Database | Tx,
  repositoryId: string,
): Promise<{ files: string[]; bundles: ProjectStateBundle[] }> {
  const [row] = await db
    .select({ baseSnapshot: schema.projectStateSync.baseSnapshot })
    .from(schema.projectStateSync)
    .where(eq(schema.projectStateSync.repositoryId, repositoryId))
    .limit(1);
  const snapshot = row?.baseSnapshot as
    | { claims?: unknown; bundles?: unknown; settings?: unknown; environment?: unknown }
    | null
    | undefined;
  const files: string[] = [];
  const settings = snapshot?.settings;
  if (settings !== null && typeof settings === 'object' && !Array.isArray(settings)) {
    for (const name of Object.keys(settings)) {
      if (isRecordName(name)) files.push(`${PROJECT_STATE_DIR}/${settingFileName(name)}`);
    }
  }
  if (snapshot?.environment !== null && typeof snapshot?.environment === 'object') {
    files.push(ENVIRONMENT_FILE);
  }
  if (Array.isArray(snapshot?.claims)) {
    for (const claim of snapshot.claims) {
      const path = (claim as { path?: unknown } | null)?.path;
      // Canonical, not claimable: a git-data claim an earlier release wrote is still removed.
      if (typeof path === 'string' && isCanonicalRepoPath(path)) {
        files.push(`${PROJECT_STATE_DIR}/${claimFileName(path)}`);
      }
    }
  }
  const bundles: ProjectStateBundle[] = [];
  if (Array.isArray(snapshot?.bundles)) {
    for (const bundle of snapshot.bundles) {
      const { source, name } = (bundle ?? {}) as { source?: unknown; name?: unknown };
      if (typeof source === 'string' && source !== '' && typeof name === 'string') {
        bundles.push({ source, name });
        files.push(`${PROJECT_STATE_DIR}/${bundleFileName(source)}`);
      }
    }
  }
  return { files, bundles };
}

/** Writes the record holding the context's render unit, one claim per live ledger row and one
 *  descriptor per bundle source, then moves the repository's render context and the sync base to it in
 *  one transaction. A claim or descriptor file the previous base named and the record no longer holds
 *  is removed; one it never named is not touched. A file already holding the bytes is not rewritten
 *  but is still listed, since whoever commits the repository may not have staged it yet.
 *  Returns the repository-relative paths written and removed. */
export async function writeProjectStateRecord(
  db: Database,
  { context, rtkChoiceRecorded, ...rest }: ProjectStateRecordInput,
): Promise<ProjectStateWriteResult> {
  let column: RenderContextColumn;
  try {
    // Refused before anything is written, so the column only ever holds what reads back.
    column = renderContextColumnFor(context, rtkChoiceRecorded);
  } catch (err) {
    const cleared = await clearRenderContext(db, rest.repositoryId, rest.expectedColumns, null);
    throw new ProjectStateWriteError(err, [], !cleared, []);
  }
  return writeProjectStateColumn(db, { ...rest, column });
}

/** The record for a render context column that already reads back: what the sweep writes from the
 *  column a sync or a writer left. */
export async function writeProjectStateColumn(
  db: Database,
  {
    repositoryId,
    repoPath,
    column,
    expectedColumns,
    holdingTaskId,
    keepColumnOnFailure,
    refuseDuringGitOperation,
  }: ProjectStateColumnInput & {
    column: RenderContextColumn;
    /** The column is what it was before the write, so a failure leaves it rather than clearing it. */
    keepColumnOnFailure?: boolean;
    /** A merge or rebase open in the checkout refuses the write, as the sweep refuses to start one. */
    refuseDuringGitOperation?: boolean;
  },
): Promise<ProjectStateWriteResult> {
  const written: string[] = [];
  const removed: string[] = [];
  let attempted: ProjectRender | null = null;
  try {
    const portable = portableRender(column);
    attempted = portable;
    const planFor = (look: Look) => ({
      record: {
        ...emptyProjectState(),
        render: overlayRender(portable, look.pending, 'incoming'),
        claims: overlayClaims(look.claims, look.pendingClaims, 'incoming'),
        bundles: look.bundles,
        settings: overlaySettings(look.settings, look.pendingSettings, 'incoming'),
        environment: overlayEnvironment(look.environment, look.pendingSettings, 'incoming'),
      },
      baseSnapshot: normalizeProjectState({
        ...emptyProjectState(),
        render: overlayRender(portable, look.pending, 'base'),
        claims: overlayClaims(look.claims, look.pendingClaims, 'base'),
        bundles: look.bundles,
        settings: overlaySettings(look.settings, look.pendingSettings, 'base'),
        environment: overlayEnvironment(look.environment, look.pendingSettings, 'base'),
      }),
    });
    const lookAt = async (reader: Database | Tx): Promise<Look> => {
      const pendingClaims = await loadPendingClaimConflicts(reader, repositoryId);
      const claims = await loadRecordClaims(reader, repositoryId);
      const base = await loadBase(reader, repositoryId);
      const [repo] = await reader
        .select({
          scopeExcludeGlobs: schema.repositories.scopeExcludeGlobs,
          rtkEnabled: schema.repositories.rtkEnabled,
          rtkVersion: schema.repositories.rtkVersion,
          lspServers: schema.repositories.lspServers,
          lspServerVersions: schema.repositories.lspServerVersions,
          chromeDevtoolsMcpVersion: schema.repositories.chromeDevtoolsMcpVersion,
          reviewDimensions: schema.repositories.reviewDimensions,
          onboardingEnvironment: schema.repositories.onboardingEnvironment,
          onboardingTooling: schema.repositories.onboardingTooling,
        })
        .from(schema.repositories)
        .where(eq(schema.repositories.id, repositoryId))
        .limit(1);
      const settings = repo
        ? withoutUnchosenRtk(portableSettingsOf(repo), column.rtkChoiceRecorded)
        : emptyProjectState().settings;
      const tooling = repo ? toolingUnitOf(repo.onboardingTooling) : null;
      if (tooling !== null) settings[TOOLING_UNIT_NAME] = tooling;
      return {
        settings,
        environment: repo ? environmentUnitOf(repo.onboardingEnvironment) : null,
        pending: await loadPendingRenderConflicts(reader, repositoryId),
        pendingClaims,
        pendingSettings: await loadPendingSettingConflicts(reader, repositoryId),
        claims,
        bundles: bundleDescriptors(
          await loadLocalBundles(reader, repositoryId),
          base.bundles,
          overlayClaims(claims, pendingClaims, 'incoming'),
        ),
        baseFiles: column.rtkChoiceRecorded
          ? base.files
          : base.files.filter((f) => f !== RTK_SETTING_FILE),
      };
    };
    // A first look only, so its failure must not clear the column: the files then wait for the locked read.
    let seen: Look | null = expectedColumns ? null : await lookAt(db).catch(() => null);
    let plan = planFor(
      seen ?? {
        pending: [],
        pendingClaims: [],
        pendingSettings: [],
        claims: [],
        bundles: [],
        settings: emptyProjectState().settings,
        environment: null,
        baseFiles: [],
      },
    );
    const writeFiles = async (baseFiles: readonly string[]): Promise<void> => {
      const files = renderProjectState(plan.record);
      const readable = recordReadable(files);
      if (!readable.readable) throw new ProjectStateUnreadableError(readable.reason);
      const produced = new Set<string>();
      for (const [rel, text] of files) {
        const path = `${PROJECT_STATE_DIR}/${rel}`;
        produced.add(path);
        if (!(await holdsBytes(repoPath, path, text))) {
          await writeFileNoFollow(repoPath, path, text, { createParents: true });
        }
        if (!written.includes(path)) written.push(path);
        const back = removed.indexOf(path);
        if (back >= 0) removed.splice(back, 1);
      }
      const owned = new Set([...baseFiles, ...written.filter(isOwnedFile)]);
      for (const path of owned) {
        if (produced.has(path)) continue;
        const gone = await removeFileIfNoFollow(repoPath, path, () => true);
        const was = written.indexOf(path);
        if (was >= 0) written.splice(was, 1);
        if (gone !== 'kept' && !removed.includes(path)) removed.push(path);
      }
    };
    // A fenced write keeps the lock from its check to its last write, files included, so no sync
    // lands between them; an unfenced one writes its files first, before any database write.
    if (!expectedColumns && seen !== null) await writeFiles(seen.baseFiles);
    await db.transaction(async (tx) => {
      await lockProjectState(tx, repositoryId);
      if (refuseDuringGitOperation && (await gitOperationInProgress(repoPath))) {
        throw new ProjectStateMovedError();
      }
      if (expectedColumns) {
        await refuseMovedColumn(tx, repositoryId, expectedColumns);
        if (holdingTaskId) await refuseReleasedCheckout(tx, holdingTaskId);
      }
      // Read before the look: a mutation after this read stays above `written_revision`.
      const revision = await readOutboxRevision(tx, repositoryId);
      const now = await lookAt(tx);
      if (expectedColumns || seen === null || !sameValue(now, seen)) {
        seen = now;
        plan = planFor(now);
        await writeFiles(now.baseFiles);
      }
      const synced = { baseSnapshot: plan.baseSnapshot, lastError: null, updatedAt: new Date() };
      await tx
        .update(schema.repositories)
        .set({ renderContext: column })
        .where(eq(schema.repositories.id, repositoryId));
      await recordLocalSide(tx, repositoryId, portable, now.claims, {
        settings: now.settings,
        environment: now.environment,
      });
      await tx
        .insert(schema.projectStateSync)
        .values({ repositoryId, ...synced })
        .onConflictDoUpdate({ target: schema.projectStateSync.repositoryId, set: synced });
      if (revision !== null) await stampOutbox(tx, repositoryId, revision);
    });
  } catch (err) {
    if (err instanceof ProjectStateMovedError) throw err;
    const cleared =
      keepColumnOnFailure === true ||
      (await clearRenderContext(
        db,
        repositoryId,
        expectedColumns,
        written.includes(`${PROJECT_STATE_DIR}/${RENDER_UNIT}`) ? attempted : null,
      ));
    throw new ProjectStateWriteError(err, written, !cleared, removed);
  }
  return { written, removed };
}

async function holdsBytes(repoPath: string, path: string, text: string): Promise<boolean> {
  const bytes = Buffer.from(text, 'utf8');
  const held = await readFileNoFollow(repoPath, path, { maxBytes: bytes.length + 1 });
  return held !== null && !held.truncated && held.data.equals(bytes);
}

async function readOutboxRevision(tx: Tx, repositoryId: string): Promise<number | null> {
  const [row] = await tx
    .select({ revision: schema.projectStateOutbox.revision })
    .from(schema.projectStateOutbox)
    .where(eq(schema.projectStateOutbox.repositoryId, repositoryId))
    .limit(1);
  return row?.revision ?? null;
}

async function stampOutbox(tx: Tx, repositoryId: string, revision: number): Promise<void> {
  await tx
    .update(schema.projectStateOutbox)
    .set({
      writtenRevision: sql`LEAST(${schema.projectStateOutbox.revision}, GREATEST(${schema.projectStateOutbox.writtenRevision}, ${revision}))`,
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.projectStateOutbox.repositoryId, repositoryId));
}

async function refuseReleasedCheckout(tx: Tx, taskId: string): Promise<void> {
  const [task] = await tx
    .select({ status: schema.tasks.status, deadAt: schema.tasks.deadAt })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1);
  if (
    !task ||
    task.deadAt !== null ||
    !(CHECKOUT_HOLDING_TASK_STATUSES as readonly string[]).includes(task.status)
  ) {
    throw new ProjectStateMovedError();
  }
}

/** Throws ProjectStateMovedError when the column holds a context none of `expected` is. Call it
 *  under `lockProjectState`, in the transaction whose write it fences. */
export async function refuseMovedColumn(
  tx: Tx,
  repositoryId: string,
  expected: unknown[],
): Promise<void> {
  const [repo] = await tx
    .select({ renderContext: schema.repositories.renderContext })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  const now = repo?.renderContext ?? null;
  if (now !== null && !expected.some((c) => sameValue(now, c))) throw new ProjectStateMovedError();
}

/** A column this write could not move would read as newer than the rows its writer just wrote, so it
 *  is cleared and every reader falls back to those rows' snapshot. One a sync moved past `expected`
 *  meanwhile is newer than both and stays. */
/** The value this install now holds for each pending key becomes the row's local side; a key that
 *  now holds what the other side has is no longer contested. `claims` are the live claims, when the
 *  caller has read them: without them a pending claim is left as it was. */
async function recordLocalSide(
  tx: Tx,
  repositoryId: string,
  rendered: ProjectRender | null,
  claims?: readonly ProjectStateClaim[],
  portable?: { settings: Record<string, unknown>; environment: ProjectEnvironment | null },
): Promise<void> {
  const settle = async (row: PendingRenderConflict, local: unknown): Promise<void> => {
    if (sameValue(local, row.local)) return;
    const agreed = sameValue(local, row.incoming);
    await tx
      .update(schema.projectStateConflicts)
      .set(
        agreed
          ? { local: conflictSide(local), resolution: 'converged', resolvedAt: new Date() }
          : { local: conflictSide(local) },
      )
      .where(
        and(
          eq(schema.projectStateConflicts.repositoryId, repositoryId),
          eq(schema.projectStateConflicts.unit, row.unit),
          isNull(schema.projectStateConflicts.resolvedAt),
        ),
      );
  };
  for (const row of await loadPendingRenderConflicts(tx, repositoryId)) {
    await settle(
      row,
      row.unit === RENDER_UNIT
        ? rendered
        : (rendered as Record<string, unknown> | null)?.[row.unit.slice(RENDER_UNIT.length + 1)],
    );
  }
  if (portable !== undefined) {
    for (const row of await loadPendingSettingConflicts(tx, repositoryId)) {
      const { settings, environment } = portable;
      await settle(
        row,
        isSettingUnit(row.unit)
          ? settings[row.unit.slice('settings/'.length, -'.json'.length)]
          : row.unit === ENVIRONMENT_UNIT
            ? environment
            : (environment as Record<string, unknown> | null)?.[
                row.unit.slice(ENVIRONMENT_UNIT.length + 1)
              ],
      );
    }
  }
  if (claims === undefined) return;
  for (const row of await loadPendingClaimConflicts(tx, repositoryId)) {
    await settle(
      row,
      claims.find((claim) => claimFileName(claim.path) === row.unit),
    );
  }
}

async function clearRenderContext(
  db: Database,
  repositoryId: string,
  expected: unknown[] | undefined,
  attempted: ProjectRender | null,
): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      await lockProjectState(tx, repositoryId);
      if (expected) {
        try {
          await refuseMovedColumn(tx, repositoryId, expected);
        } catch (err) {
          if (err instanceof ProjectStateMovedError) return;
          throw err;
        }
      }
      await tx
        .update(schema.repositories)
        .set({ renderContext: null })
        .where(eq(schema.repositories.id, repositoryId));
      // The column was this install's side of each pending key; the next sync rebuilds it from the rows.
      if (attempted) {
        await recordLocalSide(tx, repositoryId, attempted);
      }
    });
    return true;
  } catch {
    return false;
  }
}
