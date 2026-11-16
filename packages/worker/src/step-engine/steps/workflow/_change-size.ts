import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import {
  readFileNoFollow,
  openDirNoFollow,
  relUnder,
  toSafeRel,
  errno,
  decodeUtf8Strict,
  isPathContainmentError,
} from '@haive/shared/fs-safe';
import type { ChangeSizeSet, FileTexts, ChangeSizeCounter } from '@haive/shared/change-size';
import { TaskCancelledError, type StepContext } from '../../step-definition.js';
import { gitExec } from '../../../repo/git-exec.js';
import { loadPreviousStepOutput } from '../onboarding/_helpers.js';
import { collectImplementationFiles, collectChangeSet } from './_impl-changes.js';

export const CHANGE_SIZE_HOST_LIMITS = {
  totalBytes: 16 * 1024 * 1024,
  gitTimeoutMs: 10_000,
} as const;
export type MeasurementOptions = Partial<{ [K in keyof typeof CHANGE_SIZE_HOST_LIMITS]: number }>;

export interface SizeMeasurement {
  state: 'measured' | 'unknown';
  reason?: string;
  result?: ChangeSizeSet;
  baseCommit?: string;
  /** Hash of the ordered path/base/head byte hashes; includes untracked working bytes. */
  diffHash?: string;
  eventId?: string;
  /** An environment fault is not evidence about the tree; do not freeze it in an attempt row. */
  retryable?: true;
}
export interface SimplifySizes {
  before: SizeMeasurement;
  afterSimplify: SizeMeasurement;
  afterFixup: SizeMeasurement;
}
export const unknownSize = (
  reason = 'Measurement unavailable.',
  retryable = false,
): SizeMeasurement => ({
  state: 'unknown',
  reason,
  ...(retryable ? { retryable: true } : {}),
});
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
let counter:
  | Promise<{
      module: typeof import('@haive/shared/change-size');
      count: ChangeSizeCounter;
    }>
  | undefined;
async function initialized() {
  counter ??= import('@haive/shared/change-size')
    .then(async (module) => ({
      module,
      count: await module.initializeChangeSize(),
    }))
    .catch((error) => {
      counter = undefined;
      throw error;
    });
  return counter;
}
async function availableCounter(ctx: StepContext) {
  try {
    ctx.throwIfCancelled();
    return await initialized();
  } catch (err) {
    if (err instanceof TaskCancelledError) throw err;
    ctx.throwIfCancelled();
    ctx.logger.warn({ err }, 'Change-size counter initialization failed');
    return undefined;
  }
}
const validOid = (value: string) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);

/** Host-only reader: hold the integration directory, resolve every working file from the
 * repository root, and read base blobs by object id through hardened Git, never checkout. */
export async function measureImplementationSize(
  ctx: StepContext,
  worktreePath: string,
  baseCommit?: string,
  options: MeasurementOptions = {},
): Promise<SizeMeasurement> {
  const limits = { ...CHANGE_SIZE_HOST_LIMITS, ...options };
  try {
    const ready = await availableCounter(ctx);
    if (!ready) return unknownSize('Change-size counter unavailable.', true);
    const { CHANGE_SIZE_LIMITS, excludedChangeSizePath, changeSizeLanguage } = ready.module;
    const prefix = relUnder(ctx.repoPath, worktreePath);
    if (!prefix) return unknownSize('Integration worktree is unavailable.');
    const dir = await openDirNoFollow(ctx.repoPath, prefix);
    try {
      const cwd = `/proc/self/fd/${dir.fd}`;
      const git = async (args: string[], maxBuffer = CHANGE_SIZE_LIMITS.maxBytes + 1) =>
        (await gitExec(args, { cwd, signal: ctx.signal, timeout: limits.gitTimeoutMs, maxBuffer }))
          .stdout;
      let set = await collectImplementationFiles(ctx, worktreePath, {
        signal: ctx.signal,
        gitCwd: cwd,
      });
      if (baseCommit && !set.scanError && !set.truncated) {
        set = await collectChangeSet(
          worktreePath,
          baseCommit,
          new Set(set.files),
          ctx.signal,
          undefined,
          false,
          cwd,
        );
      }
      ctx.throwIfCancelled();
      if (set.scanError || set.truncated)
        return unknownSize(
          'Implementation scope could not be measured completely.',
          !!set.scanError,
        );
      if (!baseCommit) {
        const setup = await loadPreviousStepOutput(ctx.db, ctx.taskId, '01-worktree-setup');
        const baseBranch = (setup?.output as { baseBranch?: string } | null)?.baseBranch;
        if (!baseBranch) return unknownSize('Task base is unavailable.');
        baseCommit = (await git(['merge-base', '--end-of-options', 'HEAD', baseBranch])).trim();
      }
      if (!validOid(baseCommit)) return unknownSize('Task base is unavailable.');
      const files: FileTexts[] = [];
      const identities: unknown[] = [];
      let bytes = 0;
      const paths = new Map<string, boolean>();
      for (const path of set.files) {
        try {
          paths.set(toSafeRel(path), true);
        } catch (err) {
          if (err instanceof TaskCancelledError) throw err;
          if (!isPathContainmentError(err)) throw err;
          paths.set(path, false);
        }
      }
      const nestedPaths = new Set(Object.keys(set.nestedRepositories ?? {}).map(toSafeRel));
      for (const [path, safe] of paths) {
        ctx.throwIfCancelled();
        if (!safe) {
          files.push({ path, base: null, head: null });
          continue;
        }
        if (excludedChangeSizePath(path)) {
          files.push({ path, base: '', head: '' });
          continue;
        }
        if (nestedPaths.has(path) || !changeSizeLanguage(path)) {
          files.push({ path, base: null, head: null });
          continue;
        }
        let base: string | null = null,
          head: Uint8Array | null = null;
        try {
          const entry = await git(
            ['ls-tree', '-l', '-z', baseCommit, '--', `:(literal)${path}`],
            64 * 1024,
          );
          if (!entry) base = '';
          else {
            const match = /^(100644|100755) blob ([a-f0-9]+)\s+(\d+)\t/.exec(entry);
            if (match && Number(match[3]) <= CHANGE_SIZE_LIMITS.maxBytes) {
              // gitExec returns strings; latin1 preserves each byte for strict UTF-8 validation.
              const data = await gitExec(['cat-file', 'blob', match[2]!], {
                cwd,
                signal: ctx.signal,
                timeout: limits.gitTimeoutMs,
                maxBuffer: CHANGE_SIZE_LIMITS.maxBytes + 1,
                encoding: 'latin1',
              });
              base = decodeUtf8Strict(Buffer.from(data.stdout, 'latin1'));
            }
          }
          const read = await readFileNoFollow(ctx.repoPath, `${prefix}/${path}`, {
            strict: true,
            maxBytes: CHANGE_SIZE_LIMITS.maxBytes,
          });
          head = read && !read.truncated ? read.data : null;
          // Strict reads return null only for confirmed missing entries, including deletions.
          if (read === null) head = new Uint8Array();
        } catch (error) {
          if (error instanceof TaskCancelledError) throw error;
          ctx.throwIfCancelled();
          // Only confirmed absence or a containment refusal is a file-level gap.
          if (errno(error) === 'ENOENT') head = new Uint8Array();
          else if (!isPathContainmentError(error)) throw error;
          else ctx.logger.warn({ err: error }, 'Change-size file read refused');
        }
        bytes += (base ? Buffer.byteLength(base) : 0) + (head?.length ?? 0);
        if (bytes > limits.totalBytes)
          return unknownSize('Change exceeds the measurement byte budget.');
        files.push({ path, base, head });
        identities.push([
          path,
          base === null ? null : hash(base),
          head === null ? null : hash(head),
        ]);
      }
      ctx.throwIfCancelled();
      // Invalid reported names are coverage holes, even if their raw spelling looks excluded.
      const result = ready.count(files.filter(({ path }) => paths.get(path)));
      result.touched = files.map(({ path }) => path);
      for (const { path } of files) {
        if (paths.get(path)) continue;
        result.files.push({ path, size: null });
        result.total.nullFiles++;
      }
      return {
        state: 'measured',
        baseCommit,
        diffHash: hash(JSON.stringify(identities)),
        result,
      };
    } finally {
      await dir.close();
    }
  } catch (err) {
    if (err instanceof TaskCancelledError) throw err;
    ctx.throwIfCancelled();
    ctx.logger.warn({ err }, 'Change-size measurement failed');
    return unknownSize(
      'Measurement unavailable.',
      errno(err) !== 'ENOENT' && !isPathContainmentError(err),
    );
  }
}

/** Deterministic primary keys make first-write-wins atomic without a schema change.
 * A replay reads the original record before touching the repository again. */
export async function recordChangeSize(
  ctx: StepContext,
  worktreePath: string,
  phase: 'before' | 'afterSimplify' | 'afterFixup',
  invocationId: string | null,
  pass: number,
  before?: SizeMeasurement,
): Promise<SizeMeasurement> {
  try {
    const ready = await availableCounter(ctx);
    // An environment fault says nothing about this tree and must remain retryable.
    if (!ready) return unknownSize('Change-size counter unavailable.', true);
    const { CHANGE_SIZE_VERSION, CHANGE_SIZE_DEPENDENCIES } = ready.module;
    const digest = hash(
      JSON.stringify([
        'change-size',
        CHANGE_SIZE_VERSION,
        ctx.taskId,
        ctx.taskStepId,
        ctx.round,
        ctx.rerunGeneration ?? 0,
        invocationId,
        pass,
        phase,
      ]),
    );
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const stored = await ctx.db.query.taskEvents.findFirst({ where: eq(schema.taskEvents.id, id) });
    if (stored) return (stored.payload as unknown as { measurement: SizeMeasurement }).measurement;
    const captured = await measureImplementationSize(ctx, worktreePath, before?.baseCommit);
    ctx.throwIfCancelled();
    if (captured.retryable) return captured;
    const measurement = { ...captured, eventId: id };
    const rows = await ctx.db
      .insert(schema.taskEvents)
      .values({
        id,
        taskId: ctx.taskId,
        taskStepId: ctx.taskStepId,
        eventType: 'change_size.measured',
        payload: {
          version: CHANGE_SIZE_VERSION,
          counterVersion: CHANGE_SIZE_VERSION,
          ...CHANGE_SIZE_DEPENDENCIES,
          stepId: '07a-code-simplify',
          invocationId,
          round: ctx.round,
          pass,
          phase,
          rerunGeneration: ctx.rerunGeneration ?? 0,
          beforeEventId: before?.eventId ?? null,
          before: before ?? null,
          measurement,
        },
      })
      .onConflictDoNothing()
      .returning();
    if (rows.length) return measurement;
    const winner = await ctx.db.query.taskEvents.findFirst({ where: eq(schema.taskEvents.id, id) });
    return (
      (winner?.payload as unknown as { measurement?: SizeMeasurement } | undefined)?.measurement ??
      unknownSize()
    );
  } catch (err) {
    if (err instanceof TaskCancelledError) throw err;
    ctx.throwIfCancelled();
    ctx.logger.warn(
      { err },
      'Change-size measurement could not be retained; continuing with unknown size',
    );
    return unknownSize('Measurement could not be retained.');
  }
}
