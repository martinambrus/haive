import { constants, type Dirent, type Stats } from 'node:fs';
import { lstat, open, readdir, readlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

/**
 * Link-refusing filesystem primitives for repository paths.
 *
 * Every function takes `(anchor, rel)`. The anchor is a trusted directory that may itself be
 * reached through links (a repository root under the storage volume, or a repository's
 * `localPath`); `rel` is a POSIX path below it in which NO component is ever followed. The worker
 * and the api run as root over trees that repositories and sandboxed agents write, so a path
 * resolved by name is a path they can redirect — a `realpath` check before the call is one more
 * resolution with one more window after it. These primitives resolve one component at a time
 * against a directory descriptor they hold, and check the result against the descriptor itself.
 *
 * Linux-only by construction. Node exposes no `*at` calls, so `openat(dirfd, name)` is spelled
 * `/proc/self/fd/<dirfd>/<name>`: the kernel resolves that magic link to the inode the descriptor
 * holds and looks `name` up inside it under the syscall's own no-follow rule (glibc emulates
 * `lchmod` the same way). `readlink('/proc/self/fd/<fd>')` then proves the held inode sits at
 * `<anchor>/<rel>`. A `/proc` read that fails is a refusal, never a check to skip.
 *
 * Anchors are `<storage>/<userId>/<repoId>` or a repository's `localPath` — never `.haive`, a
 * worktree or an uploads dir, because the sandbox mounts the whole repository root read-write.
 */

export type ContainmentReason =
  'invalid-path' | 'link' | 'not-directory' | 'not-regular-file' | 'out-of-tree' | 'unverifiable';

const REASON_TEXT: Record<ContainmentReason, string> = {
  'invalid-path': 'not a plain relative path',
  link: 'a symlink in the path',
  'not-directory': 'a path component is not a directory',
  'not-regular-file': 'not a regular file',
  'out-of-tree': 'resolved outside the anchor',
  unverifiable: 'could not be verified through /proc/self/fd',
};

/** A refused path. `at` is the rel of the component that was refused (`''` for the anchor), so a
 *  step can name the link in its own message; file contents never travel on it. Matched by `code`
 *  rather than `instanceof`, so a second copy of the module (two workspace builds) still matches. */
export class PathContainmentError extends Error {
  readonly code = 'EPATHCONTAINMENT' as const;

  constructor(
    readonly reason: ContainmentReason,
    readonly anchor: string,
    readonly rel: string,
    readonly at: string,
  ) {
    super(`${REASON_TEXT[reason]}: ${at === '' ? anchor : at}`);
    this.name = 'PathContainmentError';
  }
}

export function isPathContainmentError(
  err: unknown,
  reason?: ContainmentReason,
): err is PathContainmentError {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; reason?: unknown };
  return e.code === 'EPATHCONTAINMENT' && (reason === undefined || e.reason === reason);
}

/** `rel` as the primitives take it: relative, no `..`, no NUL; `.` and empty segments dropped, so
 *  `''` (or `.`) addresses the anchor itself. Throws `invalid-path` — the one refusal every mode
 *  throws, because it is a caller bug and never a property of the tree. */
export function toSafeRel(input: string): string {
  if (input.includes('\0') || path.posix.isAbsolute(input)) {
    throw new PathContainmentError('invalid-path', '', input, input);
  }
  const segs = input.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (segs.includes('..')) throw new PathContainmentError('invalid-path', '', input, input);
  return segs.join('/');
}

/** The rel of `absPath` under `anchor`, lexically. For call sites that hold an absolute path
 *  today: the trust still comes from the walk, this only turns the argument into the shape the
 *  walk takes. Throws `invalid-path` when `absPath` is not under `anchor`. */
export function relUnder(anchor: string, absPath: string): string {
  const rel = path.relative(path.resolve(anchor), path.resolve(absPath));
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    throw new PathContainmentError('invalid-path', anchor, absPath, absPath);
  }
  return toSafeRel(rel);
}

// O_PATH is not in node:fs constants. This is Linux's generic value (x86_64 and aarch64 share
// it; alpha, sparc and parisc do not), so the module refuses to load anywhere else rather than
// open with a wrong bit set.
const O_PATH = 0o10000000;
if (process.platform !== 'linux' || (process.arch !== 'x64' && process.arch !== 'arm64')) {
  throw new Error(
    `@haive/shared/fs-safe needs Linux x64/arm64 (O_PATH and /proc/self/fd); got ${process.platform}/${process.arch}`,
  );
}
const { O_RDONLY, O_RDWR, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_NOCTTY } = constants;

const fdPath = (fd: number): string => `/proc/self/fd/${fd}`;
/** `openat(dirfd, name)` as a path: the magic link resolves to the held directory inode and
 *  `name` is looked up inside it, so nothing between the anchor and here is resolved by name. */
const at = (dirFd: number, name: string): string => `${fdPath(dirFd)}/${name}`;
const below = (real: string, name: string): string =>
  real === '/' ? `/${name}` : `${real}/${name}`;
const errno = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
};
const closeQuietly = (fh: FileHandle): Promise<void> => fh.close().catch(() => undefined);
const segments = (rel: string): string[] => (rel === '' ? [] : rel.split('/'));

interface HeldDir {
  fh: FileHandle;
  /** The canonical path the walk expects the descriptor to be at. */
  real: string;
}

/** The held inode must still sit where the walk says it does — `out-of-tree` covers a directory
 *  renamed elsewhere inside the tree while held (an unlinked one reads ` (deleted)`). */
async function assertHeldAt(
  fh: FileHandle,
  expected: string,
  anchor: string,
  rel: string,
  atRel: string,
): Promise<void> {
  const real = await readlink(fdPath(fh.fd)).catch(() => null);
  if (real === expected) return;
  throw new PathContainmentError(
    real === null ? 'unverifiable' : 'out-of-tree',
    anchor,
    rel,
    atRel,
  );
}

/** Opens the directory `segs` below the anchor one component at a time. Only the anchor may be
 *  followed; every later lookup is relative to the descriptor just opened, and `O_NOFOLLOW` with
 *  `O_DIRECTORY` answers ENOTDIR for a link (an `O_PATH` open never says ELOOP). The caller closes
 *  the returned handle. Errnos other than a refused component (ENOENT, EACCES) propagate. */
async function walkDir(anchor: string, rel: string, segs: string[]): Promise<HeldDir> {
  let fh = await open(anchor, O_PATH | O_DIRECTORY);
  let real = await readlink(fdPath(fh.fd)).catch(() => null);
  if (real === null) {
    await closeQuietly(fh);
    throw new PathContainmentError('unverifiable', anchor, rel, '');
  }
  for (const [i, seg] of segs.entries()) {
    const here = segs.slice(0, i + 1).join('/');
    let next: FileHandle;
    try {
      next = await open(at(fh.fd, seg), O_PATH | O_DIRECTORY | O_NOFOLLOW);
    } catch (err) {
      const code = errno(err);
      let reason: ContainmentReason | null = null;
      if (code === 'ENOTDIR' || code === 'ELOOP') {
        const st = await lstat(at(fh.fd, seg)).catch(() => null);
        reason = st?.isSymbolicLink() ? 'link' : 'not-directory';
      }
      await closeQuietly(fh);
      if (reason) throw new PathContainmentError(reason, anchor, rel, here);
      throw err;
    }
    await closeQuietly(fh);
    fh = next;
    real = below(real, seg);
  }
  try {
    await assertHeldAt(fh, real, anchor, rel, segs.join('/'));
  } catch (err) {
    await closeQuietly(fh);
    throw err;
  }
  return { fh, real };
}

const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

/** The refusal rule for reads. `invalid-path` always throws; absence is `null`; a containment
 *  refusal is `null` unless `strict`, when it throws; any other errno is `null` when lenient and
 *  rethrown when strict. Mutations (later primitives) always throw. */
async function readResult<T>(strict: boolean | undefined, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (isPathContainmentError(err)) {
      if (strict || err.reason === 'invalid-path') throw err;
      return null;
    }
    if (ABSENT.has(errno(err) ?? '')) return null;
    if (strict) throw err;
    return null;
  }
}

export interface StrictOption {
  /** Throw containment refusals instead of folding them into `null`. Absence stays `null`. */
  strict?: boolean;
}

export type OpenMode = 'read' | 'read-write';

/** A descriptor on the regular file at `<anchor>/<rel>`, opened without following anything and
 *  verified through `/proc/self/fd` after the open, so a caller can stream from it or rewrite
 *  through it with no second path resolution. The `lstat` before the open plus `O_NONBLOCK` keep a
 *  FIFO or a device from ever being opened; `O_NOCTTY` keeps a terminal from becoming ours. */
export async function openFileNoFollow(
  anchor: string,
  rel: string,
  mode: OpenMode,
  opts: StrictOption = {},
): Promise<FileHandle | null> {
  const safe = toSafeRel(rel);
  return readResult(opts.strict, async () => {
    const segs = segments(safe);
    const leaf = segs.pop();
    if (leaf === undefined) throw new PathContainmentError('not-regular-file', anchor, safe, '');
    const dir = await walkDir(anchor, safe, segs);
    try {
      const st = await lstat(at(dir.fh.fd, leaf));
      if (st.isSymbolicLink()) throw new PathContainmentError('link', anchor, safe, safe);
      if (!st.isFile()) throw new PathContainmentError('not-regular-file', anchor, safe, safe);
      const flags = (mode === 'read' ? O_RDONLY : O_RDWR) | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY;
      let fh: FileHandle;
      try {
        fh = await open(at(dir.fh.fd, leaf), flags);
      } catch (err) {
        if (errno(err) === 'ELOOP') throw new PathContainmentError('link', anchor, safe, safe);
        throw err;
      }
      try {
        if (!(await fh.stat()).isFile()) {
          throw new PathContainmentError('not-regular-file', anchor, safe, safe);
        }
        await assertHeldAt(fh, below(dir.real, leaf), anchor, safe, safe);
        return fh;
      } catch (err) {
        await closeQuietly(fh);
        throw err;
      }
    } finally {
      await closeQuietly(dir.fh);
    }
  });
}

export interface ReadOptions extends StrictOption {
  /** Stop after this many bytes; `truncated` says so. A prompt or a preview never needs more than
   *  its own cap, and a small file swapped for a huge one must not exhaust memory. */
  maxBytes?: number;
}

export interface ReadResult {
  data: Buffer;
  /** The file's full size, whether or not `data` holds all of it. */
  size: number;
  truncated: boolean;
}

export async function readFileNoFollow(
  anchor: string,
  rel: string,
  opts: ReadOptions = {},
): Promise<ReadResult | null> {
  const fh = await openFileNoFollow(anchor, rel, 'read', { strict: opts.strict });
  if (fh === null) return null;
  try {
    const size = (await fh.stat()).size;
    const want = Math.min(size, opts.maxBytes ?? Number.POSITIVE_INFINITY);
    const buf = Buffer.allocUnsafe(want);
    let filled = 0;
    while (filled < want) {
      const { bytesRead } = await fh.read(buf, filled, want - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { data: filled === want ? buf : buf.subarray(0, filled), size, truncated: size > want };
  } finally {
    await closeQuietly(fh);
  }
}

export async function readTextNoFollow(
  anchor: string,
  rel: string,
  opts: ReadOptions = {},
): Promise<string | null> {
  const read = await readFileNoFollow(anchor, rel, opts);
  return read === null ? null : read.data.toString('utf8');
}

/** Entries of the directory at `<anchor>/<relDir>` (`''` for the anchor). The listing reopens the
 *  held inode through `/proc/self/fd`, so `Dirent.parentPath` is that `/proc` path: callers join
 *  `entry.name` onto their own rel, never read the parent off the entry. */
export async function readdirNoFollow(
  anchor: string,
  relDir: string,
  opts: StrictOption = {},
): Promise<Dirent[] | null> {
  const safe = toSafeRel(relDir);
  return readResult(opts.strict, async () => {
    const dir = await walkDir(anchor, safe, segments(safe));
    try {
      return await readdir(fdPath(dir.fh.fd), { withFileTypes: true });
    } finally {
      await closeQuietly(dir.fh);
    }
  });
}

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface EntryInfo {
  kind: EntryKind;
  stats: Stats;
}

function describe(stats: Stats): EntryInfo {
  const kind: EntryKind = stats.isSymbolicLink()
    ? 'symlink'
    : stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : 'other';
  return { kind, stats };
}

/** What sits at `<anchor>/<rel>` without following it; `null` when nothing does. The one read that
 *  reports a link instead of refusing it, so a caller can decide what to say about one. */
export async function lstatNoFollow(
  anchor: string,
  rel: string,
  opts: StrictOption = {},
): Promise<EntryInfo | null> {
  const safe = toSafeRel(rel);
  return readResult(opts.strict, async () => {
    const segs = segments(safe);
    const leaf = segs.pop();
    const dir = await walkDir(anchor, safe, segs);
    try {
      return describe(leaf === undefined ? await dir.fh.stat() : await lstat(at(dir.fh.fd, leaf)));
    } finally {
      await closeQuietly(dir.fh);
    }
  });
}
