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
import { checkHostCancellation, hostCall } from './step-host-services.js';

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
}
export interface ReviewSnapshot {
  forkPoint: string;
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
function unavailable(scope: ImplementationFileSet, reason: string): ReviewDiff {
  return { status: 'unavailable', scope, reason };
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
  const omittedContents = includeFileContents
    ? files.map((file) => ({
        path: file.path,
        reason: file.kind === 'text' ? 'maxBytes' : file.kind,
      }))
    : [];
  const payload = {
    version: 1,
    includeFileContents,
    forkPoint: snapshot.forkPoint,
    changeHash: snapshot.changeHash,
    scope: ordered(scope),
    coverage: {
      partial:
        scope.truncated || files.some((f) => !['text', 'binary', 'deleted'].includes(f.kind)),
      listed: scope.files.length,
      total: scope.total,
    },
    dependencyPolicy: ordered(snapshot.dependencyPolicy),
    reviewDimensions: [...snapshot.reviewDimensions].sort(compare),
    files: files.map(({ content: _content, ...file }) => file),
    diff: snapshot.diff,
    // Untracked files are absent from git diff. Their full text is mandatory evidence.
    untrackedContents: files
      .filter((f) => f.untracked && f.kind === 'text')
      .map((f) => ({ path: f.path, content: f.content })),
    fileContents,
    omittedContents,
  };
  const encode = () => JSON.stringify(payload) + '\n';
  if (Buffer.byteLength(encode()) > options.maxBytes)
    return {
      status: 'too-large',
      reason: 'The complete diff and mandatory coverage evidence exceed maxBytes.',
      scope,
    };
  if (includeFileContents) {
    for (const file of files) {
      if (file.kind !== 'text' || file.content === undefined) continue;
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
    content,
    bytes: Buffer.byteLength(content),
    diffHash: createHash('sha256').update(content).digest('hex'),
    scope,
  };
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
): Promise<ReviewDiff> {
  let scope = EMPTY_SCOPE;
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0)
    return unavailable(scope, 'maxBytes must be a positive safe integer.');
  const limits = { maxRound: ctx.round, signal: ctx.signal };
  const run = async (args: string[], budget = options.maxBytes) => {
    checkHostCancellation(ctx);
    const result = await gitRun(worktree, args, undefined, {
      signal: ctx.signal,
      maxBuffer: budget,
    });
    checkHostCancellation(ctx);
    if (result.noExit === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new DiffTooLarge();
    if (result.code !== 0) throw new Error('Git could not read the review change.');
    return result.stdout;
  };
  try {
    const policy = await hostCall(ctx, () => taskSecretMaskPolicy(ctx.db, ctx.taskId));
    if (!policy) return unavailable(scope, 'The task secret policy is unavailable.');
    // At-rest capture covers tracked files too, unlike the sandbox mount policy.
    const denied = compileSecretMaskPolicy({ ...policy, tracked: null });
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
    const capture = async (): Promise<ReviewSnapshot> => {
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
      const gitlinks = new Set(
        (await run(['ls-files', '--stage', '-z'])).split('\0').flatMap((record) => {
          const match = /^160000 [a-f0-9]{40,64} [0-3]\t(.*)$/s.exec(record);
          return match ? [match[1]!] : [];
        }),
      );
      const files: ReviewFile[] = [];
      // The cap limits delivered review evidence, not retry identity. Hash omitted changes
      // too, so a partial payload cannot reuse an earlier identity after those files change.
      const allPaths = [...new Set([...paths, ...changed, ...untracked])].sort(compare);
      // A move is delete + add. Once a denied endpoint participates, the allowed
      // endpoint cannot be identified safely, so withhold the whole capture's contents.
      const withhold = allPaths.some(denied);
      for (const p of allPaths) {
        checkHostCancellation(ctx);
        if (scope.nestedRepositories?.[p] || (untracked.has(p) && p.endsWith('/'))) {
          files.push({ path: p, kind: 'nested-repository' });
          continue;
        }
        let safe: string;
        try {
          safe = toSafeRel(p);
        } catch (error) {
          if (!isPathContainmentError(error, 'invalid-path')) throw error;
          files.push({ path: p, kind: 'invalid' });
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
        if (withhold) {
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
            kind:
              entry?.kind === 'symlink'
                ? 'link'
                : (entry?.kind ?? (deleted.has(p) ? 'deleted' : 'missing')),
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
            if (delivered && size <= options.maxBytes) chunks.push(Buffer.from(bytes));
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
            delivered && size <= options.maxBytes
              ? decodeUtf8Strict(Buffer.concat(chunks))
              : undefined;
          binary ||= content === null;
          if (delivered && untracked.has(p) && !binary && content === undefined)
            throw new DiffTooLarge();
          files.push({
            path: p,
            kind: binary ? 'binary' : 'text',
            mode: before.mode & 0o7777,
            size,
            hash: hash.digest('hex'),
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
        .map((file) => ':(literal)' + toSafeRel(file.path));
      const diff = pathspecs.length
        ? await run([
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
          ])
        : '';
      const changeHash = createHash('sha256')
        .update(JSON.stringify(ordered(files.map(({ content: _content, ...file }) => file))))
        .digest('hex');
      return {
        forkPoint,
        changeHash,
        scope,
        dependencyPolicy,
        reviewDimensions: dimensions.enabled.map((d) => d.id),
        diff,
        files: files.filter((file) => paths.includes(file.path)),
      };
    };
    const first = await capture();
    const again = await collectImplementationFiles(ctx, worktree, limits);
    if (
      JSON.stringify(ordered(canonicalScope(scope))) !==
      JSON.stringify(ordered(canonicalScope(again)))
    )
      return unavailable(scope, 'The implementation scope changed during collection.');
    const second = await capture();
    if (JSON.stringify(ordered(first)) !== JSON.stringify(ordered(second)))
      return unavailable(scope, 'The review content changed during collection.');
    return serializeReviewPayload(first, options);
  } catch (error) {
    checkHostCancellation(ctx);
    if (isResourceLimitError(error)) throw error;
    if (error instanceof DiffTooLarge)
      return { status: 'too-large', scope, reason: 'The complete diff exceeds maxBytes.' };
    return unavailable(scope, scrubErrorPaths(safeErrorMessage(error)));
  }
}
