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
} from '@haive/shared/fs-safe';
import {
  initializeChangeSize,
  CHANGE_SIZE_LIMITS,
  excludedChangeSizePath,
  type ChangeSizeSet,
  type FileTexts,
  type ChangeSizeCounter,
} from '@haive/shared/change-size';
import type { StepContext } from '../../step-definition.js';
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
}
export interface SimplifySizes {
  before: SizeMeasurement;
  afterSimplify: SizeMeasurement;
  afterFixup: SizeMeasurement;
}
export const unknownSize = (reason = 'Measurement unavailable.'): SizeMeasurement => ({
  state: 'unknown',
  reason,
});
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
let counter: Promise<ChangeSizeCounter> | undefined;
async function initialized() {
  counter ??= initializeChangeSize().catch((error) => {
    counter = undefined;
    throw error;
  });
  return counter;
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
      if (set.scanError || set.truncated)
        return unknownSize('Implementation scope could not be measured completely.');
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
      for (const path of set.files) {
        if (excludedChangeSizePath(path)) {
          files.push({ path, base: '', head: '' });
          continue;
        }
        if (set.nestedRepositories?.[path]) {
          files.push({ path, base: null, head: null });
          continue;
        }
        let base: string | null = null,
          head: Uint8Array | null = null;
        try {
          const safe = toSafeRel(path);
          const entry = await git(
            ['ls-tree', '-l', '-z', baseCommit, '--', `:(literal)${safe}`],
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
          const read = await readFileNoFollow(ctx.repoPath, prefix ? `${prefix}/${safe}` : safe, {
            strict: true,
            maxBytes: CHANGE_SIZE_LIMITS.maxBytes,
          });
          head = read && !read.truncated ? read.data : null;
          // Strict reads return null only for confirmed missing entries, including deletions.
          if (read === null) head = new Uint8Array();
        } catch (error) {
          // ENOENT on a strict fs-safe read is confirmed absence; other refusal stays null.
          if (errno(error) === 'ENOENT') head = new Uint8Array();
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
      return {
        state: 'measured',
        baseCommit,
        diffHash: hash(JSON.stringify(identities)),
        result: (await initialized())(files),
      };
    } finally {
      await dir.close();
    }
  } catch {
    return unknownSize();
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
  const digest = hash(
    JSON.stringify([
      'change-size',
      1,
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
  try {
    const stored = await ctx.db.query.taskEvents.findFirst({ where: eq(schema.taskEvents.id, id) });
    if (stored) return (stored.payload as unknown as { measurement: SizeMeasurement }).measurement;
    const measurement = {
      ...(await measureImplementationSize(ctx, worktreePath, before?.baseCommit)),
      eventId: id,
    };
    const rows = await ctx.db
      .insert(schema.taskEvents)
      .values({
        id,
        taskId: ctx.taskId,
        taskStepId: ctx.taskStepId,
        eventType: 'change_size.measured',
        payload: {
          version: 1,
          counterVersion: 1,
          runtimeVersion: '0.25.10',
          grammarPackageVersion: '0.3.1',
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
  } catch {
    ctx.logger.warn('Change-size measurement could not be retained; continuing with unknown size');
    return unknownSize('Measurement could not be retained.');
  }
}
