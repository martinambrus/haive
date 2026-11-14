import { createHash } from 'node:crypto';
import { safeErrorMessage, scrubErrorPaths } from '@haive/shared/logger';
import {
  decodeUtf8Strict,
  lstatNoFollow,
  isPathContainmentError,
  isResourceLimitError,
  openFileNoFollow,
  relUnder,
  toSafeRel,
} from '@haive/shared/fs-safe';
import type {
  ImplementationFileSet,
  ReviewDiff,
  ReviewDiffOptions,
  StepContext,
} from '@haive/shared/step';
import { taskSecretMaskPolicy } from '../queues/cli-exec/secret-mask.js';
import { compileSecretMaskPolicy } from '../queues/cli-exec/secret-mask-policy.js';
import { gitRun } from '../repo/git-exec.js';
import { loadPreviousStepOutput } from './steps/onboarding/_helpers.js';
import { collectImplementationFiles } from './steps/workflow/_impl-changes.js';
import { loadDependencyPolicy } from './steps/workflow/_dependency-policy.js';
import { resolveTaskReviewDimensions } from './review-dimension-context.js';
import { checkHostCancellation, hostCall } from './host-call.js';

interface ReviewFile {
  path: string;
  kind:
    | 'text'
    | 'binary'
    | 'deleted'
    | 'nested-repository'
    | 'withheld'
    | 'link'
    | 'gitlink'
    | 'directory'
    | 'missing'
    | 'invalid'
    | 'unreadable'
    | 'other';
  mode?: number;
  size?: number;
  hash?: string;
  content?: string;
  untracked?: boolean;
  contentOmission?: 'retained-content-limit' | 'maxBytes';
}
export interface ReviewSnapshot {
  forkPoint: string;
  partial?: boolean;
  /** Fingerprint all git-changed paths, including paths omitted by the scope cap. */
  changeHash: string;
  scope: ImplementationFileSet;
  dependencyPolicy: unknown;
  reviewDimensions: string[];
  diff: string;
  files: ReviewFile[];
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, v]) => [key, ordered(v)]),
    );
  return value;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function canonicalScope(scope: ImplementationFileSet): ImplementationFileSet {
  return { ...scope, files: [...scope.files].sort(compare) };
}
function fileIdentity({ content: _content, contentOmission: _omission, ...file }: ReviewFile) {
  return file;
}
function snapshotIdentity(snapshot: ReviewSnapshot) {
  return { ...snapshot, files: snapshot.files.map(fileIdentity) };
}
function unavailable(scope: ImplementationFileSet, reason: string): ReviewDiff {
  return {
    status: 'unavailable',
    partial: true,
    scope: {
      ...scope,
      scanError: scope.scanError
        ? scrubErrorPaths(safeErrorMessage(scope.scanError))
        : scope.scanError,
    },
    reason: scrubErrorPaths(safeErrorMessage(reason)),
  };
}

/** All mandatory evidence is measured before optional full-file contents are packed. */
export function serializeReviewPayload(
  snapshot: ReviewSnapshot,
  options: Pick<ReviewDiffOptions, 'maxBytes' | 'includeFileContents'>,
): ReviewDiff {
  const scope = canonicalScope(snapshot.scope);
  if (!scope.files.length) return unavailable(scope, 'The review scope is empty.');
  if (scope.scanError) return unavailable(scope, 'The implementation scan failed.');
  const files = [...snapshot.files].sort((a, b) => compare(a.path, b.path));
  const includeFileContents = options.includeFileContents === true;
  const fileContents: { path: string; content: string }[] = [];
  const omittedContents = files.flatMap((file) => {
    if (file.untracked && file.kind === 'text' && file.content !== undefined) return [];
    if (!includeFileContents && !(file.untracked && file.kind === 'text')) return [];
    return [
      {
        path: file.path,
        reason: file.kind === 'text' ? (file.contentOmission ?? 'maxBytes') : file.kind,
      },
    ];
  });
  const payload = {
    version: 1,
    includeFileContents,
    forkPoint: snapshot.forkPoint,
    changeHash: snapshot.changeHash,
    scope: ordered(scope),
    coverage: {
      partial:
        snapshot.partial === true ||
        scope.truncated ||
        files.some(
          (f) => !['text', 'binary', 'deleted'].includes(f.kind) || f.contentOmission !== undefined,
        ),
      listed: scope.files.length,
      total: scope.total,
    },
    dependencyPolicy: ordered(snapshot.dependencyPolicy),
    reviewDimensions: [...snapshot.reviewDimensions].sort(compare),
    files: files.map(fileIdentity),
    diff: snapshot.diff,
    // Untracked text has one home; retained-content omissions are explicit coverage gaps.
    untrackedContents: files
      .filter((f) => f.untracked && f.kind === 'text' && f.content !== undefined)
      .map((f) => ({ path: f.path, content: f.content })),
    fileContents,
    omittedContents,
  };
  const encode = () => JSON.stringify(payload) + '\n';
  if (Buffer.byteLength(encode()) > options.maxBytes)
    return {
      status: 'too-large',
      partial: true,
      reason: 'The complete diff and mandatory coverage evidence exceed maxBytes.',
      scope,
    };
  if (includeFileContents) {
    for (const file of files) {
      if (file.kind !== 'text' || file.untracked || file.content === undefined) continue;
      const index = omittedContents.findIndex((f) => f.path === file.path);
      const [omission] = omittedContents.splice(index, 1);
      fileContents.push({ path: file.path, content: file.content });
      if (Buffer.byteLength(encode()) > options.maxBytes) {
        fileContents.pop();
        omittedContents.splice(index, 0, omission!);
      }
    }
  }
  const content = encode();
  return {
    status: 'ready',
    partial: payload.coverage.partial,
    content,
    bytes: Buffer.byteLength(content),
    diffHash: createHash('sha256').update(content).digest('hex'),
    scope,
  };
}

export const REVIEW_GITLINK_PATHSPEC_BYTES = 32 * 1024;
export const REVIEW_METADATA_BYTES = 16 * 1024 * 1024;
export const REVIEW_RETAINED_CONTENT_BYTES = 16 * 1024 * 1024;
interface CaptureLimits {
  retainedContentBytes?: number;
  gitlinkPathspecBytes?: number;
}
class DiffTooLarge extends Error {}
const EMPTY_SCOPE: ImplementationFileSet = {
  files: [],
  total: 0,
  truncated: false,
  scanError: null,
};

export async function readReviewDiff(
  ctx: StepContext,
  worktree: string,
  options: ReviewDiffOptions,
  captureLimits: CaptureLimits = {},
): Promise<ReviewDiff> {
  let scope = EMPTY_SCOPE;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
    return unavailable(scope, 'maxBytes must be a positive safe integer.');
  const limits = { maxRound: ctx.round, signal: ctx.signal };
  const run = async (args: string[], budget = REVIEW_METADATA_BYTES, change = false) => {
    checkHostCancellation(ctx);
    const result = await gitRun(worktree, ['--no-optional-locks', ...args], undefined, {
      signal: ctx.signal,
      maxBuffer: budget,
    });
    checkHostCancellation(ctx);
    if (isResourceLimitError({ code: result.noExit }))
      throw Object.assign(new Error('Git could not start due to a resource limit.'), {
        code: result.noExit,
      });
    if (result.noExit === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      if (change) throw new DiffTooLarge();
      throw new Error('Review metadata exceeds the internal limit.');
    }
    if (result.code !== 0) throw new Error('Git could not read the review change.');
    return result.stdout;
  };
  try {
    const policy = await hostCall(ctx, () => taskSecretMaskPolicy(ctx.db, ctx.taskId));
    if (!policy) return unavailable(scope, 'The task secret policy is unavailable.');
    // At-rest capture covers tracked files too, unlike the sandbox mount policy.
    const atRestPolicy = { ...policy, tracked: null };
    const exactDeny = compileSecretMaskPolicy(atRestPolicy);
    const foldedDeny = compileSecretMaskPolicy(atRestPolicy, { nocase: true });
    // A case-insensitive mount can resolve another spelling of a denied name. Either
    // policy verdict withholds it; folding must never override an exact deny with an allow.
    const denied = (canonical: string) => exactDeny(canonical) || foldedDeny(canonical);
    scope = await collectImplementationFiles(ctx, worktree, limits);
    if (scope.scanError) return unavailable(scope, 'The implementation scan failed.');
    if (!scope.files.length) return unavailable(scope, 'The review scope is empty.');
    const previous = await loadPreviousStepOutput(
      ctx.db,
      ctx.taskId,
      '01-worktree-setup',
      ctx.round,
    );
    const baseBranch = (previous?.output as { baseBranch?: string } | null)?.baseBranch;
    if (!baseBranch) return unavailable(scope, 'The task fork point is not recorded.');
    const forkPoint = (await run(['merge-base', 'HEAD', baseBranch])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(forkPoint))
      return unavailable(scope, 'The task fork point is unreadable.');
    const dependencyPolicy = await hostCall(ctx, () => loadDependencyPolicy(ctx, worktree, limits));
    const dimensions = await hostCall(ctx, () => resolveTaskReviewDimensions(ctx.db, ctx.taskId));
    const prefix = relUnder(ctx.repoPath, worktree);
    const capture = async (retainContents: boolean): Promise<ReviewSnapshot> => {
      let remainingContentBytes = Math.min(
        captureLimits.retainedContentBytes ?? REVIEW_RETAINED_CONTENT_BYTES,
        REVIEW_RETAINED_CONTENT_BYTES,
      );
      const currentBase = (await run(['merge-base', 'HEAD', baseBranch])).trim();
      if (currentBase !== forkPoint)
        throw new Error('The task fork point changed during collection.');
      const paths = [...scope.files].sort(compare);
      const named = await run(['diff', '--name-status', '-z', '--no-renames', forkPoint, '--']);
      const deleted = new Set<string>();
      const changed: string[] = [];
      const fields = named.split('\0');
      for (let i = 0; i + 1 < fields.length; i += 2) {
        changed.push(fields[i + 1]!);
        if (fields[i] === 'D') deleted.add(fields[i + 1]!);
      }
      const untracked = new Set(
        (await run(['ls-files', '--others', '--exclude-standard', '-z']))
          .split('\0')
          .filter(Boolean),
      );
      if (
        !scope.truncated &&
        [...changed, ...untracked].some(
          (p) => !paths.includes(p) && !scope.nestedRepositories?.[p + '/'],
        )
      )
        throw new Error('The implementation scope is inconsistent with git.');
      const files: ReviewFile[] = [];
      // The cap limits delivered review evidence, not retry identity. Hash omitted changes
      // too, so a partial payload cannot reuse an earlier identity after those files change.
      const allPaths = [...new Set([...paths, ...changed, ...untracked])].sort(compare);
      // Validate once before policy, filesystem access or pathspec construction. Reported
      // names are evidence, not instructions to repair a path into another file's name.
      const safePaths = new Map<string, string>();
      for (const p of allPaths) {
        try {
          const safe = toSafeRel(p);
          if (safe && safe === p) safePaths.set(p, safe);
        } catch (error) {
          if (!isPathContainmentError(error, 'invalid-path')) throw error;
        }
      }
      const deniedPaths = new Set([...safePaths.values()].filter(denied));
      // A git-reported denied deletion could have moved to any allowed destination.
      // Existing denied paths withhold only their own bytes, hashes and hunks.
      const withholdAll = [...deniedPaths].some((p) => deleted.has(p));
      const withheld = new Map<string, ReviewFile>();
      for (const p of deniedPaths) {
        let metadata = {};
        try {
          const rel = (prefix ? prefix + '/' : '') + p;
          const entry = await lstatNoFollow(ctx.repoPath, rel, { strict: true });
          if (entry) metadata = { size: entry.stats.size, mode: entry.stats.mode & 0o7777 };
        } catch (error) {
          if (isResourceLimitError(error)) throw error;
        }
        withheld.set(p, { path: p, kind: 'withheld', ...metadata });
      }
      const indexPaths = withholdAll
        ? []
        : [...safePaths.values()].filter((p) => !deniedPaths.has(p));
      // A name over the argument budget cannot be a real path (PATH_MAX is far smaller), so it is
      // disclosed as invalid instead of voiding the capture.
      const oversized = new Set<string>();
      // Bound argv bytes, not just count: git paths can have very different lengths.
      const pathspecBudget = Math.min(
        captureLimits.gitlinkPathspecBytes ?? REVIEW_GITLINK_PATHSPEC_BYTES,
        REVIEW_GITLINK_PATHSPEC_BYTES,
      );
      if (!Number.isSafeInteger(pathspecBudget) || pathspecBudget <= 0)
        throw new Error('The gitlink pathspec budget must be a positive safe integer.');
      const gitlinks = new Set<string>();
      const readGitlinks = async (batch: string[]) => {
        for (const record of (await run(['ls-files', '--stage', '-z', '--', ...batch])).split(
          '\0',
        )) {
          const match = /^160000 [a-f0-9]{40,64} [0-3]\t(.*)$/s.exec(record);
          if (match) gitlinks.add(match[1]!);
        }
      };
      let batch: string[] = [];
      let batchBytes = 0;
      for (const indexPath of indexPaths) {
        const pathspec = ':(literal)' + indexPath;
        const bytes = Buffer.byteLength(pathspec) + 1;
        if (bytes > pathspecBudget) {
          oversized.add(indexPath);
          continue;
        }
        if (batchBytes + bytes > pathspecBudget) {
          await readGitlinks(batch);
          batch = [];
          batchBytes = 0;
        }
        batch.push(pathspec);
        batchBytes += bytes;
      }
      if (batch.length) await readGitlinks(batch);
      for (const p of allPaths) {
        checkHostCancellation(ctx);
        if (scope.nestedRepositories?.[p] || (untracked.has(p) && p.endsWith('/'))) {
          files.push({ path: p, kind: 'nested-repository' });
          continue;
        }
        const safe = safePaths.get(p);
        if (safe === undefined || oversized.has(safe)) {
          files.push({ path: p, kind: 'invalid' });
          continue;
        }
        const deniedFile = withheld.get(safe);
        if (deniedFile) {
          files.push(deniedFile);
          continue;
        }
        const rel = (prefix ? prefix + '/' : '') + safe;
        let entry;
        try {
          entry = await lstatNoFollow(ctx.repoPath, rel, { strict: true });
        } catch (error) {
          if (isResourceLimitError(error)) throw error;
          files.push({
            path: p,
            kind: isPathContainmentError(error, 'link') ? 'link' : 'unreadable',
          });
          continue;
        }
        const metadata = entry ? { size: entry.stats.size, mode: entry.stats.mode & 0o7777 } : {};
        if (withholdAll) {
          files.push({ path: p, kind: 'withheld', ...metadata });
          continue;
        }
        if (gitlinks.has(safe)) {
          files.push({ path: p, kind: 'gitlink', ...metadata });
          continue;
        }
        if (!entry || entry.kind !== 'file') {
          files.push({
            path: p,
            kind: !entry
              ? deleted.has(p)
                ? 'deleted'
                : 'missing'
              : entry.kind === 'symlink'
                ? 'link'
                : entry.kind === 'directory'
                  ? 'directory'
                  : 'other',
            ...metadata,
          });
          continue;
        }
        let fh;
        try {
          fh = await openFileNoFollow(ctx.repoPath, rel, 'read', { strict: true });
        } catch (error) {
          if (isResourceLimitError(error)) throw error;
          files.push({
            path: p,
            kind: isPathContainmentError(error, 'link') ? 'link' : 'unreadable',
          });
          continue;
        }
        if (!fh) {
          files.push({ path: p, kind: deleted.has(p) ? 'deleted' : 'missing' });
          continue;
        }
        try {
          checkHostCancellation(ctx);
          const before = await fh.stat();
          const hash = createHash('sha256');
          const chunks: Buffer[] = [];
          const delivered = paths.includes(p);
          const requested = delivered && (options.includeFileContents === true || untracked.has(p));
          const retain =
            retainContents &&
            requested &&
            before.size <= options.maxBytes &&
            before.size <= remainingContentBytes;
          const chunk = Buffer.alloc(64 * 1024);
          let size = 0,
            binary = false;
          const decoder = new TextDecoder('utf-8', { fatal: true });
          for (;;) {
            const read = await hostCall(ctx, () => fh.read(chunk, 0, chunk.length, size));
            if (!read.bytesRead) break;
            const bytes = chunk.subarray(0, read.bytesRead);
            hash.update(bytes);
            binary ||= bytes.includes(0);
            if (!binary) {
              try {
                decoder.decode(bytes, { stream: true });
              } catch {
                binary = true;
              }
            }
            size += read.bytesRead;
            if (retain && !binary && size <= options.maxBytes && size <= remainingContentBytes)
              chunks.push(Buffer.from(bytes));
            checkHostCancellation(ctx);
          }
          if (!binary) {
            try {
              decoder.decode();
            } catch {
              binary = true;
            }
          }
          const after = await fh.stat();
          if (
            size !== before.size ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            before.mode !== after.mode
          )
            throw new Error('A changed file changed during its read.');
          const content =
            retain && size <= options.maxBytes && size <= remainingContentBytes
              ? decodeUtf8Strict(Buffer.concat(chunks))
              : undefined;
          binary ||= content === null;
          if (!binary && content !== undefined) remainingContentBytes -= size;
          files.push({
            path: p,
            kind: binary ? 'binary' : 'text',
            mode: before.mode & 0o7777,
            size,
            hash: hash.digest('hex'),
            ...(!binary && retainContents && requested && content === undefined
              ? {
                  contentOmission:
                    before.size > options.maxBytes
                      ? ('maxBytes' as const)
                      : ('retained-content-limit' as const),
                }
              : {}),
            ...(untracked.has(p) ? { untracked: true } : {}),
            ...(!binary && content !== undefined && content !== null ? { content } : {}),
          });
        } finally {
          await fh.close();
        }
      }
      const pathspecs = files
        .filter(
          (file) => paths.includes(file.path) && ['text', 'binary', 'deleted'].includes(file.kind),
        )
        .map((file) => ':(literal)' + safePaths.get(file.path)!);
      const diff = pathspecs.length
        ? await run(
            [
              '-c',
              'core.quotePath=false',
              'diff',
              '--no-color',
              '--no-renames',
              '--no-relative',
              '--src-prefix=a/',
              '--dst-prefix=b/',
              '--full-index',
              '--diff-algorithm=myers',
              '--no-indent-heuristic',
              '--unified=3',
              '--submodule=short',
              forkPoint,
              '--',
              ...pathspecs,
            ],
            options.maxBytes,
            true,
          )
        : '';
      const changeHash = createHash('sha256')
        .update(JSON.stringify(ordered(files.map(fileIdentity))))
        .digest('hex');
      return {
        forkPoint,
        partial: withheld.size > 0,
        changeHash,
        scope,
        dependencyPolicy,
        reviewDimensions: dimensions.enabled.map((d) => d.id),
        diff,
        files: files.filter((file) => paths.includes(file.path)),
      };
    };
    const first = await capture(true);
    const again = await collectImplementationFiles(ctx, worktree, limits);
    if (
      JSON.stringify(ordered(canonicalScope(scope))) !==
      JSON.stringify(ordered(canonicalScope(again)))
    )
      return unavailable(scope, 'The implementation scope changed during collection.');
    const second = await capture(false);
    if (
      JSON.stringify(ordered(snapshotIdentity(first))) !==
      JSON.stringify(ordered(snapshotIdentity(second)))
    )
      return unavailable(scope, 'The review content changed during collection.');
    return serializeReviewPayload(first, options);
  } catch (error) {
    checkHostCancellation(ctx);
    if (isResourceLimitError(error)) throw error;
    if (error instanceof DiffTooLarge)
      return {
        status: 'too-large',
        partial: true,
        scope,
        reason: 'The complete diff exceeds maxBytes.',
      };
    return unavailable(scope, scrubErrorPaths(safeErrorMessage(error)));
  }
}
