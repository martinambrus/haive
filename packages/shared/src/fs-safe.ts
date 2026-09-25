import { randomUUID } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
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
const {
  O_RDONLY,
  O_RDWR,
  O_WRONLY,
  O_CREAT,
  O_EXCL,
  O_DIRECTORY,
  O_NOFOLLOW,
  O_NONBLOCK,
  O_NOCTTY,
} = constants;

const fdPath = (fd: number): string => `/proc/self/fd/${fd}`;
/** `openat(dirfd, name)` as a path: the magic link resolves to the held directory inode and
 *  `name` is looked up inside it, so nothing between the anchor and here is resolved by name. */
const at = (dirFd: number, name: string): string => `${fdPath(dirFd)}/${name}`;
const below = (real: string, name: string): string =>
  real === '/' ? `/${name}` : `${real}/${name}`;
/** A Node filesystem error's `code`, or undefined for anything that is not one. Exported because
 *  callers that turn an IO failure into a per-item outcome need the same test this module uses,
 *  and two copies of "is this an fs error" is the disagreement that makes one of them wrong. */
export const errno = (err: unknown): string | undefined => {
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

export interface Owner {
  uid: number;
  gid: number;
}

export interface EnsureDirOptions {
  /** Mode for the directories THIS call creates; an existing one is left as it is. Applied with an
   *  explicit `chmod`, because `mkdir`'s mode argument is masked by the process umask. */
  mode?: number;
  /** Owner for the directories THIS call creates. The worker runs as root and the sandbox as uid
   *  1000, so a directory an agent must write has to be handed over explicitly. */
  owner?: Owner;
}

/** Opens the directory `segs` below the anchor one component at a time. Only the anchor may be
 *  followed; every later lookup is relative to the descriptor just opened, and `O_NOFOLLOW` with
 *  `O_DIRECTORY` answers ENOTDIR for a link (an `O_PATH` open never says ELOOP). The caller closes
 *  the returned handle. Errnos other than a refused component (ENOENT, EACCES) propagate.
 *
 *  With `create`, a missing segment is made rather than refused — and a segment this call creates
 *  is the only one whose mode and owner are touched, so an existing directory's permissions are
 *  never rewritten as a side effect of walking to something below it. `mkdir` never follows a final
 *  link (a live or dangling one answers EEXIST), and the reopen then refuses that link, so the
 *  create path cannot be redirected either. */
async function walkDir(
  anchor: string,
  rel: string,
  segs: string[],
  create?: EnsureDirOptions,
): Promise<HeldDir> {
  let fh = await open(anchor, O_PATH | O_DIRECTORY);
  let real = await readlink(fdPath(fh.fd)).catch(() => null);
  if (real === null) {
    await closeQuietly(fh);
    throw new PathContainmentError('unverifiable', anchor, rel, '');
  }
  for (const [i, seg] of segs.entries()) {
    const here = segs.slice(0, i + 1).join('/');
    let next: FileHandle;
    let made = false;
    try {
      next = await open(at(fh.fd, seg), O_PATH | O_DIRECTORY | O_NOFOLLOW);
    } catch (err) {
      const code = errno(err);
      if (code === 'ENOENT' && create) {
        try {
          await mkdir(at(fh.fd, seg));
          made = true;
        } catch (mkErr) {
          if (errno(mkErr) !== 'EEXIST') {
            await closeQuietly(fh);
            throw mkErr;
          }
        }
        try {
          next = await open(at(fh.fd, seg), O_PATH | O_DIRECTORY | O_NOFOLLOW);
        } catch (reErr) {
          const reCode = errno(reErr);
          await closeQuietly(fh);
          if (reCode === 'ENOTDIR' || reCode === 'ELOOP') {
            throw new PathContainmentError('link', anchor, rel, here);
          }
          throw reErr;
        }
      } else {
        let reason: ContainmentReason | null = null;
        if (code === 'ENOTDIR' || code === 'ELOOP') {
          const st = await lstat(at(fh.fd, seg)).catch(() => null);
          reason = st?.isSymbolicLink() ? 'link' : 'not-directory';
        }
        await closeQuietly(fh);
        if (reason) throw new PathContainmentError(reason, anchor, rel, here);
        throw err;
      }
    }
    await closeQuietly(fh);
    fh = next;
    real = below(real, seg);
    if (made && create) {
      // Through `/proc/self/fd`, so both land on the inode just created rather than on whatever
      // the name resolves to now. Owner before mode: the kernel clears setuid on a chown.
      if (create.owner) {
        await chown(fdPath(fh.fd), create.owner.uid, create.owner.gid);
      }
      if (create.mode !== undefined) await chmod(fdPath(fh.fd), create.mode);
    }
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
/** The open half of every read, throwing rather than applying the refusal rule: the callers wrap
 *  it, so an open and a read of the same path cannot come to different verdicts. */
async function openVerified(anchor: string, safe: string, mode: OpenMode): Promise<FileHandle> {
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
}

export function openFileNoFollow(
  anchor: string,
  rel: string,
  mode: OpenMode,
  opts?: StrictOption,
): Promise<FileHandle | null>;
/** Creating is a MUTATION, so this overload never returns `null`: it either hands back a descriptor
 *  on a file it just created or it throws. */
export function openFileNoFollow(
  anchor: string,
  rel: string,
  mode: 'create-exclusive',
  opts?: CreateExclusiveOptions,
): Promise<FileHandle>;
export async function openFileNoFollow(
  anchor: string,
  rel: string,
  mode: OpenMode | 'create-exclusive',
  opts: StrictOption & CreateExclusiveOptions = {},
): Promise<FileHandle | null> {
  if (mode === 'create-exclusive') return createExclusive(anchor, rel, opts);
  const safe = toSafeRel(rel);
  return readResult(opts.strict, () => openVerified(anchor, safe, mode));
}

/** A readable descriptor on the DIRECTORY at `<anchor>/<rel>`, opened without following anything
 *  and verified through `/proc/self/fd`. What a caller hands a child process as a slot
 *  (`/proc/self/fd/N` there) instead of a path the child would resolve by name, and what it can
 *  `fchown` first. Strict: absence, a link and a non-directory all throw, as does an empty `rel` —
 *  the anchor itself is never handed out. The caller closes it. */
export async function openDirNoFollow(anchor: string, rel: string): Promise<FileHandle> {
  const safe = toSafeRel(rel);
  const segs = segments(safe);
  const leaf = segs.pop();
  if (leaf === undefined) throw new PathContainmentError('invalid-path', anchor, safe, '');
  const dir = await walkDir(anchor, safe, segs);
  try {
    let fh: FileHandle;
    try {
      fh = await open(at(dir.fh.fd, leaf), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    } catch (err) {
      const code = errno(err);
      if (code === 'ENOTDIR' || code === 'ELOOP') {
        const st = await lstat(at(dir.fh.fd, leaf)).catch(() => null);
        throw new PathContainmentError(
          st?.isSymbolicLink() ? 'link' : 'not-directory',
          anchor,
          safe,
          safe,
        );
      }
      throw err;
    }
    try {
      await assertHeldAt(fh, below(dir.real, leaf), anchor, safe, safe);
      return fh;
    } catch (err) {
      await closeQuietly(fh);
      throw err;
    }
  } finally {
    await closeQuietly(dir.fh);
  }
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

/** The whole read — open, size, allocation and the read loop — runs under the refusal rule, not
 *  just the open: an uncapped read of an untrusted file can fail after it (a size past Node's
 *  maximum buffer length makes the allocation throw), and a lenient caller must see that as
 *  `null` rather than a step failure. Pass `maxBytes` wherever a bound is known. */
export async function readFileNoFollow(
  anchor: string,
  rel: string,
  opts: ReadOptions = {},
): Promise<ReadResult | null> {
  const safe = toSafeRel(rel);
  return readResult(opts.strict, async () => {
    const fh = await openVerified(anchor, safe, 'read');
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
      return {
        data: filled === want ? buf : buf.subarray(0, filled),
        size,
        truncated: size > want,
      };
    } finally {
      await closeQuietly(fh);
    }
  });
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

/**
 * Create `<anchor>/<relDir>` and any missing parent, following nothing.
 *
 * A MUTATION, so the refusal rule is the strict one: a link anywhere in the path throws rather than
 * reading as absent. That is the whole difference from `mkdir(p, { recursive: true })`, which
 * follows every intermediate component and would create the tail inside whatever a planted link
 * points at. `mode` and `owner` apply only to the directories this call creates, so walking to a
 * deep path never rewrites the permissions of a directory that was already there.
 */
export async function ensureDirNoFollow(
  anchor: string,
  relDir: string,
  opts: EnsureDirOptions = {},
): Promise<void> {
  const safe = toSafeRel(relDir);
  const dir = await walkDir(anchor, safe, segments(safe), opts);
  await closeQuietly(dir.fh);
}

export interface CopyFileOptions extends EnsureDirOptions {
  /** Create the destination's missing parent directories (with `mode`/`owner` where given), the way
   *  `mkdir -p` would — except that a link in the chain is refused rather than followed. */
  createParents?: boolean;
  /** Refuse an existing destination with EEXIST instead of replacing it (default true). The
   *  exclusive create is what makes that refusal race-free — and it treats a planted link at the
   *  destination as "already there", so nothing is written through one. */
  noReplace?: boolean;
  /** Copy the source's permission bits (default true), setuid/setgid/sticky excluded. */
  preserveMode?: boolean;
  /** Refuse a source larger than this. */
  maxBytes?: number;
}

/**
 * Copy `<srcAnchor>/<srcRel>` to `<destAnchor>/<destRel>` without following a link on either side.
 *
 * Both ends are the problem this solves. The source is read through the same verified descriptor
 * `readFileNoFollow` uses, so a link there copies nothing (and a FIFO cannot stall the copy). The
 * destination is created with `O_CREAT|O_EXCL|O_NOFOLLOW`, so an existing entry — including a
 * dangling link, which `stat` reports as absent and `copyFile` would happily write through —
 * answers EEXIST rather than being followed. The bytes move in chunks through the two descriptors,
 * never by path.
 */
export async function copyFileNoFollow(
  srcAnchor: string,
  srcRel: string,
  destAnchor: string,
  destRel: string,
  opts: CopyFileOptions = {},
): Promise<void> {
  const safeSrc = toSafeRel(srcRel);
  const safeDest = toSafeRel(destRel);
  const destSegs = segments(safeDest);
  const leaf = destSegs.pop();
  if (leaf === undefined) {
    throw new PathContainmentError('invalid-path', destAnchor, destRel, destRel);
  }
  if (opts.noReplace === false) {
    // Not implemented rather than silently ignored: replacing a file safely needs the temp+rename
    // dance, which belongs with the write primitives.
    throw new Error('copyFileNoFollow: replacing an existing destination is not supported yet');
  }

  const src = await openVerified(srcAnchor, safeSrc, 'read');
  try {
    const size = (await src.stat()).size;
    if (opts.maxBytes !== undefined && size > opts.maxBytes) {
      throw new PathContainmentError('not-regular-file', srcAnchor, srcRel, srcRel);
    }
    const srcMode = (await src.stat()).mode & 0o777;
    const dir = await walkDir(
      destAnchor,
      safeDest,
      destSegs,
      opts.createParents ? { mode: opts.mode, owner: opts.owner } : undefined,
    );
    let dest: FileHandle;
    try {
      dest = await open(
        at(dir.fh.fd, leaf),
        O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NOCTTY,
        0o600,
      );
    } finally {
      await closeQuietly(dir.fh);
    }
    let ok = false;
    try {
      const buf = Buffer.allocUnsafe(Math.min(size || 1, 64 * 1024));
      let pos = 0;
      for (;;) {
        const { bytesRead } = await src.read(buf, 0, buf.length, pos);
        if (bytesRead === 0) break;
        let written = 0;
        while (written < bytesRead) {
          const res = await dest.write(buf, written, bytesRead - written, pos + written);
          written += res.bytesWritten;
        }
        pos += bytesRead;
      }
      await dest.chmod(
        opts.preserveMode === false ? (opts.mode ?? 0o644) : srcMode || (opts.mode ?? 0o644),
      );
      if (opts.owner) await dest.chown(opts.owner.uid, opts.owner.gid);
      ok = true;
    } finally {
      await closeQuietly(dest);
      // A half-written destination is worse than none: the caller was told the copy failed, and a
      // truncated `.env` reads as a valid one. Unlinked through the parent descriptor's path.
      if (!ok) {
        const cleanup = await walkDir(destAnchor, safeDest, destSegs).catch(() => null);
        if (cleanup) {
          await unlink(at(cleanup.fh.fd, leaf)).catch(() => undefined);
          await closeQuietly(cleanup.fh);
        }
      }
    }
  } finally {
    await closeQuietly(src);
  }
}

/** An `O_PATH` handle on `<anchor>/<rel>` (the anchor itself when `rel` is empty) plus its stats,
 *  for a metadata change and nothing else. `O_PATH` is what makes this work at all on the paths a
 *  repair has to reach: it needs no read or write permission, so a 0200 or 0000 entry is still
 *  addressable, and it never really opens the file, so a FIFO cannot stall and a device node cannot
 *  be touched. `O_PATH|O_NOFOLLOW` on a symlink SUCCEEDS and yields the link itself rather than
 *  ELOOP, which is why the refusal below reads the fstat instead of catching an errno. */
async function openForMeta(
  anchor: string,
  safe: string,
  rel: string,
): Promise<{ fh: FileHandle; stats: Stats }> {
  const segs = segments(safe);
  const leaf = segs.pop();
  const dir = await walkDir(anchor, safe, segs);
  // `rel === ''` addresses the anchor, and the walk already verified that handle.
  if (leaf === undefined) return { fh: dir.fh, stats: await dir.fh.stat() };
  try {
    const fh = await open(at(dir.fh.fd, leaf), O_PATH | O_NOFOLLOW);
    try {
      const stats = await fh.stat();
      if (stats.isSymbolicLink()) throw new PathContainmentError('link', anchor, rel, safe);
      await assertHeldAt(fh, below(dir.real, leaf), anchor, rel, safe);
      return { fh, stats };
    } catch (err) {
      await closeQuietly(fh);
      throw err;
    }
  } finally {
    await closeQuietly(dir.fh);
  }
}

/**
 * Set the mode of `<anchor>/<rel>`, following nothing.
 *
 * A MUTATION: a link anywhere in the path throws instead of reading as absent. The callback form
 * takes the current permission bits so a caller can express `u+rwX` — a relative change — without a
 * second stat of its own, and without the by-name `chmod` that shell form performs.
 */
export async function chmodNoFollow(
  anchor: string,
  rel: string,
  mode: number | ((current: number, isDir: boolean) => number),
): Promise<void> {
  const safe = toSafeRel(rel);
  const { fh, stats } = await openForMeta(anchor, safe, rel);
  try {
    const current = stats.mode & 0o7777;
    const want = (typeof mode === 'number' ? mode : mode(current, stats.isDirectory())) & 0o7777;
    if (want !== current) await chmod(fdPath(fh.fd), want);
  } finally {
    await closeQuietly(fh);
  }
}

/** Set the owner of `<anchor>/<rel>`, following nothing. A MUTATION, so a link throws. */
export async function chownNoFollow(anchor: string, rel: string, owner: Owner): Promise<void> {
  const safe = toSafeRel(rel);
  const { fh, stats } = await openForMeta(anchor, safe, rel);
  try {
    if (stats.uid !== owner.uid || stats.gid !== owner.gid) {
      await chown(fdPath(fh.fd), owner.uid, owner.gid);
    }
  } finally {
    await closeQuietly(fh);
  }
}

export interface ApplyTreeOptions {
  owner?: Owner;
  /** Receives the entry's current permission bits and whether it is a directory, so GNU's capital-X
   *  can be expressed: `u+rwX` is `m | 0o600 | ((isDir || m & 0o111) ? 0o100 : 0)`. */
  mode?: (current: number, isDir: boolean) => number;
}

export interface ApplyTreeResult {
  /** Entries visited, the tree root included. */
  entries: number;
  changed: number;
  /** Links found and left alone. Reported rather than silent: on a tree that has any, the caller's
   *  "everything under here is now uid N" is not true of those paths. */
  linksSkipped: number;
}

const APPLY_TREE_CONCURRENCY = 32;

function wantedOwner(stats: Stats, opts: ApplyTreeOptions): Owner | null {
  if (!opts.owner) return null;
  return stats.uid === opts.owner.uid && stats.gid === opts.owner.gid ? null : opts.owner;
}

function wantedMode(stats: Stats, isDir: boolean, opts: ApplyTreeOptions): number | null {
  if (!opts.mode) return null;
  const current = stats.mode & 0o7777;
  const want = opts.mode(current, isDir) & 0o7777;
  return want === current ? null : want;
}

const needsApply = (stats: Stats, isDir: boolean, opts: ApplyTreeOptions): boolean =>
  wantedOwner(stats, opts) !== null || wantedMode(stats, isDir, opts) !== null;

/** Owner BEFORE mode: the kernel clears setuid and setgid on a chown, so the opposite order can
 *  hand back a tree whose modes are not the ones this call just set. */
async function applyMeta(
  fh: FileHandle,
  stats: Stats,
  isDir: boolean,
  opts: ApplyTreeOptions,
): Promise<boolean> {
  const owner = wantedOwner(stats, opts);
  const mode = wantedMode(stats, isDir, opts);
  if (owner) await chown(fdPath(fh.fd), owner.uid, owner.gid);
  if (mode !== null) await chmod(fdPath(fh.fd), mode);
  return owner !== null || mode !== null;
}

/** Bounded fan-out over one directory's entries. The first failure stops the workers and is
 *  rethrown; without the latch the remaining promises would reject unobserved. */
async function forEachBounded<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: unknown;
  let failed = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed || next >= items.length) return;
      const item = items[next];
      next += 1;
      if (item === undefined) return;
      try {
        await fn(item);
      } catch (err) {
        if (!failed) {
          failed = true;
          failure = err;
        }
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
}

async function applyTreeAt(
  dirFh: FileHandle,
  dirStats: Stats,
  opts: ApplyTreeOptions,
  acc: ApplyTreeResult,
): Promise<void> {
  acc.entries += 1;
  if (await applyMeta(dirFh, dirStats, true, opts)) acc.changed += 1;

  const names = await readdir(fdPath(dirFh.fd));
  const dirs: string[] = [];

  // One `lstat` decides everything about an entry, so a tree that already matches costs exactly
  // that per entry and no open at all — this runs on repositories with 100k+ entries, repeatedly.
  await forEachBounded(names, APPLY_TREE_CONCURRENCY, async (name) => {
    const st = await lstat(at(dirFh.fd, name)).catch((err: unknown) => {
      if (ABSENT.has(errno(err) ?? '')) return null;
      throw err;
    });
    if (st === null) return;
    if (st.isSymbolicLink()) {
      acc.linksSkipped += 1;
      return;
    }
    if (st.isDirectory()) {
      dirs.push(name);
      return;
    }
    acc.entries += 1;
    if (!needsApply(st, false, opts)) return;
    const fh = await open(at(dirFh.fd, name), O_PATH | O_NOFOLLOW);
    try {
      // Re-read through the descriptor: an entry swapped for a link since the lstat is skipped
      // rather than chmodded. It cannot have been swapped for something OUTSIDE the tree, because
      // the lookup ran inside the directory this call holds open.
      const fresh = await fh.stat();
      if (fresh.isSymbolicLink()) {
        acc.linksSkipped += 1;
        return;
      }
      if (await applyMeta(fh, fresh, false, opts)) acc.changed += 1;
    } finally {
      await closeQuietly(fh);
    }
  });

  // Depth-first and sequential, so the descriptors held at once are the tree's DEPTH and not its
  // width; the bounded pass above is where the concurrency is spent.
  for (const name of dirs) {
    let child: FileHandle;
    try {
      child = await open(at(dirFh.fd, name), O_PATH | O_DIRECTORY | O_NOFOLLOW);
    } catch (err) {
      const code = errno(err);
      if (code === 'ENOTDIR' || code === 'ELOOP') {
        acc.linksSkipped += 1;
        continue;
      }
      if (ABSENT.has(code ?? '')) continue;
      throw err;
    }
    try {
      await applyTreeAt(child, await child.stat(), opts, acc);
    } finally {
      await closeQuietly(child);
    }
  }
}

/**
 * Apply owner and/or mode to `<anchor>/<relDir>` and everything under it, following nothing.
 *
 * This replaces every `chown -R` / `chmod -R` shell-out, and the reason is that the two tools this
 * code runs under do not agree. Production is BusyBox, where `chmod` at depth 0 changes a link's
 * TARGET and the recursion is by path; CI is GNU coreutils, where `chmod -R` follows a linked
 * argument through `FTS_COMFOLLOW`. So no test on CI can tell you what production does, and neither
 * behaviour is the one wanted here. Links are skipped and COUNTED instead — Linux ignores a link's
 * own permission bits, so nothing is lost by not touching them, and the count is what tells a
 * caller its blanket statement has exceptions.
 *
 * A MUTATION: a link on the way to `relDir` throws rather than reading as absent.
 */
export async function applyTreeNoFollow(
  anchor: string,
  relDir: string,
  opts: ApplyTreeOptions = {},
): Promise<ApplyTreeResult> {
  const safe = toSafeRel(relDir);
  const acc: ApplyTreeResult = { entries: 0, changed: 0, linksSkipped: 0 };
  const dir = await walkDir(anchor, safe, segments(safe));
  try {
    await applyTreeAt(dir.fh, await dir.fh.stat(), opts, acc);
  } finally {
    await closeQuietly(dir.fh);
  }
  return acc;
}

export interface RemoveOptions {
  /** Delete a directory's contents as well. Without it a non-empty directory fails ENOTEMPTY, as
   *  `rmdir` does. */
  recursive?: boolean;
  /** On EACCES/EPERM, grant the blocking DIRECTORY `u+rwx` once and retry. Drupal ships
   *  `sites/default` at 0555, where nothing may unlink inside it; this replaces the `chmod -R u+w`
   *  that a removal used to shell out to. */
  repairPermissions?: boolean;
  /**
   * Called once for each entry actually unlinked or rmdir'ed.
   *
   * Exists so a caller can tell a recursive removal that failed HAVING DELETED SOMETHING from one
   * that failed before touching anything — a distinction the thrown error cannot carry and the
   * return value never reaches, since a throw skips it. `walkDir`, the leaf `lstat` and
   * `removeChild`'s own `open` all raise before the first unlink, so "the call threw" and "the
   * tree changed" are independent facts. The onboarding reset needs both: superseding over an
   * INTACT tree is unrecoverable, and reporting an untouched tree over a HALF-DELETED one is
   * equally wrong in the other direction.
   *
   * Optional and unused by every other caller, so it changes nothing for them.
   */
  onRemoved?: (rel: string) => void;
}

/** Retry one operation after granting `u+rwx` on the directory that refused it. The chmod goes
 *  through the held descriptor, so it lands on the inode this call is working in rather than on
 *  whatever the name resolves to by the time the retry runs. */
async function withRepair<T>(
  dirFh: FileHandle,
  opts: RemoveOptions,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = errno(err);
    if (!opts.repairPermissions || (code !== 'EACCES' && code !== 'EPERM')) throw err;
    const st = await dirFh.stat();
    await chmod(fdPath(dirFh.fd), (st.mode & 0o7777) | 0o700);
    return await fn();
  }
}

/** Empty the directory `dirFh` holds. ENOTEMPTY is re-scanned rather than trusted: a concurrent
 *  writer can add an entry between the listing and the `rmdir`, and three passes is enough for that
 *  while still terminating on a directory something is actively filling. */
async function removeDirContents(
  dirFh: FileHandle,
  opts: RemoveOptions,
  relPrefix: string,
): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    const names = await withRepair(dirFh, opts, () => readdir(fdPath(dirFh.fd)));
    if (names.length === 0) return;
    for (const name of names) {
      await removeChild(dirFh, name, opts, relPrefix === '' ? name : `${relPrefix}/${name}`);
    }
  }
}

/** Remove one entry of the directory `dirFh` holds, by name, inside that held inode. A symlink is
 *  UNLINKED rather than followed — the link itself is what has to go — and a directory is recursed
 *  into only through a descriptor opened `O_NOFOLLOW`, so an entry swapped for a link mid-walk is
 *  unlinked instead of descended. */
async function removeChild(
  dirFh: FileHandle,
  name: string,
  opts: RemoveOptions,
  rel: string,
): Promise<void> {
  const st = await lstat(at(dirFh.fd, name)).catch((err: unknown) => {
    if (ABSENT.has(errno(err) ?? '')) return null;
    throw err;
  });
  if (st === null) return;

  if (!st.isDirectory()) {
    let unlinked = true;
    await withRepair(dirFh, opts, () => unlink(at(dirFh.fd, name))).catch((err: unknown) => {
      // Raced into a directory since the lstat; EISDIR re-dispatches rather than failing.
      if (errno(err) === 'EISDIR') {
        unlinked = false;
        return removeChild(dirFh, name, opts, rel);
      }
      // Already gone: something else removed it, so THIS call changed nothing.
      if (ABSENT.has(errno(err) ?? '')) {
        unlinked = false;
        return undefined;
      }
      throw err;
    });
    if (unlinked) opts.onRemoved?.(rel);
    return;
  }

  let child: FileHandle;
  try {
    child = await open(at(dirFh.fd, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  } catch (err) {
    const code = errno(err);
    if (ABSENT.has(code ?? '')) return;
    // Swapped for a link or a file since the lstat: unlink the name, never follow it.
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      await withRepair(dirFh, opts, () => unlink(at(dirFh.fd, name)));
      opts.onRemoved?.(rel);
      return;
    }
    if (code === 'EACCES' || code === 'EPERM') {
      if (!opts.repairPermissions) throw err;
      const st2 = await dirFh.stat();
      await chmod(fdPath(dirFh.fd), (st2.mode & 0o7777) | 0o700);
      child = await open(at(dirFh.fd, name), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    } else {
      throw err;
    }
  }
  try {
    await removeDirContents(child, opts, rel);
  } finally {
    await closeQuietly(child);
  }
  let removed = true;
  await withRepair(dirFh, opts, () => rmdir(at(dirFh.fd, name))).catch((err: unknown) => {
    if (ABSENT.has(errno(err) ?? '')) {
      removed = false;
      return undefined;
    }
    throw err;
  });
  if (removed) opts.onRemoved?.(rel);
}

/**
 * Delete `<anchor>/<rel>`, following nothing. `false` means it was already absent.
 *
 * A MUTATION, so a link on the way to `rel` throws. The leaf itself may be a link — a link is
 * deleted as a link, which is the one correct thing to do with one. What this does NOT do is what
 * `fs.rm({ recursive: true })` does: resolve intermediate components by name, so a directory
 * swapped for a link mid-walk sends the deletion somewhere else entirely. Every child here is
 * looked up inside a descriptor this call holds open.
 *
 * `rel === ''` is refused: the anchor is a trusted directory and deleting it is never what a caller
 * means, so asking for it is a bug rather than a request.
 */
export async function removeNoFollow(
  anchor: string,
  rel: string,
  opts: RemoveOptions = {},
): Promise<boolean> {
  const safe = toSafeRel(rel);
  const segs = segments(safe);
  const leaf = segs.pop();
  if (leaf === undefined) throw new PathContainmentError('invalid-path', anchor, rel, rel);
  let dir: HeldDir;
  try {
    dir = await walkDir(anchor, safe, segs);
  } catch (err) {
    // A missing INTERMEDIATE component means the leaf is absent too, and absence is a value here
    // rather than a failure — the same rule the reads follow. A containment refusal still throws.
    if (!isPathContainmentError(err) && ABSENT.has(errno(err) ?? '')) return false;
    throw err;
  }
  try {
    const st = await lstat(at(dir.fh.fd, leaf)).catch((err: unknown) => {
      if (ABSENT.has(errno(err) ?? '')) return null;
      throw err;
    });
    if (st === null) return false;
    if (st.isDirectory() && !opts.recursive) {
      await withRepair(dir.fh, opts, () => rmdir(at(dir.fh.fd, leaf)));
      opts.onRemoved?.(safe);
      return true;
    }
    await removeChild(dir.fh, leaf, opts, safe);
    return true;
  } finally {
    await closeQuietly(dir.fh);
  }
}

/** Delete the regular file at `rel` only while its bytes pass `accept`, judged on the inode deleted:
 *  it is parked under a private name first, so a write landing at `rel` meanwhile is never taken. */
export async function removeFileIfNoFollow(
  anchor: string,
  rel: string,
  accept: (data: Buffer) => boolean | Promise<boolean>,
  opts: { maxBytes?: number } = {},
): Promise<'removed' | 'absent' | 'kept'> {
  const safe = toSafeRel(rel);
  const segs = segments(safe);
  const leaf = segs.pop();
  if (leaf === undefined) throw new PathContainmentError('invalid-path', anchor, rel, rel);
  let dir: HeldDir;
  try {
    dir = await walkDir(anchor, safe, segs);
  } catch (err) {
    if (!isPathContainmentError(err) && ABSENT.has(errno(err) ?? '')) return 'absent';
    throw err;
  }
  try {
    const st = await lstat(at(dir.fh.fd, leaf)).catch((err: unknown) => {
      if (ABSENT.has(errno(err) ?? '')) return null;
      throw err;
    });
    if (st === null) return 'absent';
    if (!st.isFile()) return 'kept';

    const parked = `.${leaf}.haive-rm-${process.pid}-${randomUUID()}`;
    try {
      await rename(at(dir.fh.fd, leaf), at(dir.fh.fd, parked));
    } catch (err) {
      if (ABSENT.has(errno(err) ?? '')) return 'absent';
      throw err;
    }
    const putBack = async (): Promise<void> => {
      try {
        await link(at(dir.fh.fd, parked), at(dir.fh.fd, leaf));
      } catch (err) {
        throw new Error(
          `${safe} was kept but could not be put back (${errno(err) ?? 'error'}); it is at ${[...segs, parked].join('/')}`,
          { cause: err },
        );
      }
      await unlink(at(dir.fh.fd, parked));
    };

    let accepted: boolean;
    try {
      accepted = await judgeParked(dir, parked, accept, opts.maxBytes, anchor, safe);
    } catch (err) {
      await putBack();
      throw err;
    }
    if (!accepted) {
      await putBack();
      return 'kept';
    }
    try {
      await unlink(at(dir.fh.fd, parked));
    } catch (err) {
      await putBack();
      throw err;
    }
    return 'removed';
  } finally {
    await closeQuietly(dir.fh);
  }
}

/** Whether the parked entry is a regular file within `maxBytes` whose bytes pass `accept`. */
async function judgeParked(
  dir: HeldDir,
  parked: string,
  accept: (data: Buffer) => boolean | Promise<boolean>,
  maxBytes: number | undefined,
  anchor: string,
  safe: string,
): Promise<boolean> {
  let fh: FileHandle;
  try {
    fh = await open(at(dir.fh.fd, parked), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY);
  } catch (err) {
    // Swapped for a link between the lstat and the rename.
    if (errno(err) === 'ELOOP') return false;
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > (maxBytes ?? Number.POSITIVE_INFINITY)) return false;
    await assertHeldAt(fh, below(dir.real, parked), anchor, safe, safe);
    const buf = Buffer.allocUnsafe(st.size);
    let filled = 0;
    while (filled < st.size) {
      const { bytesRead } = await fh.read(buf, filled, st.size - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return await accept(buf.subarray(0, filled));
  } finally {
    await closeQuietly(fh);
  }
}

export interface RenameOptions extends EnsureDirOptions {
  /** Anchor for the destination; defaults to the source's. */
  toAnchor?: string;
  /** Refuse an existing destination instead of replacing it. Node exposes no `RENAME_NOREPLACE`, so
   *  the name is CLAIMED first — `link` for a non-directory, `mkdir` for a directory — both of which
   *  answer EEXIST for any existing entry, a dangling link included. */
  noReplace?: boolean;
  /** Create the destination's missing parents, refusing a link in the chain rather than following it. */
  createParents?: boolean;
}

/**
 * Move `<anchor>/<fromRel>` to `<toAnchor ?? anchor>/<toRel>`, following nothing.
 *
 * `rename(2)` never follows the last component of either side, so the containment that matters here
 * is the PATH to each: both are walked one held descriptor at a time and both parents are verified.
 * A link at either leaf is refused rather than moved, because a caller moving `a` to `b` means the
 * files, and silently relocating a link is a different operation.
 *
 * EXDEV propagates: a caller staging across a filesystem boundary has to stage on the destination's
 * filesystem, which is a real constraint rather than something to paper over with a copy.
 */
export async function renameNoFollow(
  anchor: string,
  fromRel: string,
  toRel: string,
  opts: RenameOptions = {},
): Promise<void> {
  const safeFrom = toSafeRel(fromRel);
  const safeTo = toSafeRel(toRel);
  const toAnchor = opts.toAnchor ?? anchor;
  const fromSegs = segments(safeFrom);
  const fromLeaf = fromSegs.pop();
  const toSegs = segments(safeTo);
  const toLeaf = toSegs.pop();
  if (fromLeaf === undefined) {
    throw new PathContainmentError('invalid-path', anchor, fromRel, fromRel);
  }
  if (toLeaf === undefined) throw new PathContainmentError('invalid-path', toAnchor, toRel, toRel);

  const fromDir = await walkDir(anchor, safeFrom, fromSegs);
  try {
    const src = await lstat(at(fromDir.fh.fd, fromLeaf));
    if (src.isSymbolicLink()) {
      throw new PathContainmentError('link', anchor, fromRel, safeFrom);
    }
    const toDir = await walkDir(
      toAnchor,
      safeTo,
      toSegs,
      opts.createParents ? { mode: opts.mode, owner: opts.owner } : undefined,
    );
    try {
      if (opts.noReplace) {
        // Claim the name first so the refusal is race-free. `link` fails EEXIST on any existing
        // destination including a dangling link, which an `lstat` check would read as free.
        if (src.isDirectory()) {
          await mkdir(at(toDir.fh.fd, toLeaf), 0o700);
          try {
            await rename(at(fromDir.fh.fd, fromLeaf), at(toDir.fh.fd, toLeaf));
          } catch (err) {
            // The claim is this call's own empty directory, and leaving it would take the name for
            // good. Non-recursive, so anything written into it since is left where it is.
            await rmdir(at(toDir.fh.fd, toLeaf)).catch(() => undefined);
            throw err;
          }
          return;
        } else {
          await link(at(fromDir.fh.fd, fromLeaf), at(toDir.fh.fd, toLeaf));
          await unlink(at(fromDir.fh.fd, fromLeaf));
          return;
        }
      }
      await rename(at(fromDir.fh.fd, fromLeaf), at(toDir.fh.fd, toLeaf));
    } finally {
      await closeQuietly(toDir.fh);
    }
  } finally {
    await closeQuietly(fromDir.fh);
  }
}

export interface CreateExclusiveOptions {
  /** Permission bits once the content is written; the file is created 0600 and chmodded after, so a
   *  reader never sees a world-readable empty file. */
  fileMode?: number;
  owner?: Owner;
  createParents?: boolean;
}

/**
 * Create `<anchor>/<rel>` and hand back the descriptor, or fail.
 *
 * `O_CREAT|O_EXCL|O_NOFOLLOW` is what makes this safe AND race-free: any existing entry answers
 * EEXIST, a **dangling link included** — and that is the case worth naming, because `access` and
 * `stat` both report a dangling link as absent and a create through one lands on its target.
 */
async function createExclusive(
  anchor: string,
  rel: string,
  opts: CreateExclusiveOptions,
): Promise<FileHandle> {
  const safe = toSafeRel(rel);
  const segs = segments(safe);
  const leaf = segs.pop();
  if (leaf === undefined) throw new PathContainmentError('invalid-path', anchor, rel, rel);
  const dir = await walkDir(
    anchor,
    safe,
    segs,
    opts.createParents ? { owner: opts.owner } : undefined,
  );
  const dirReal = dir.real;
  let fh: FileHandle;
  try {
    fh = await open(
      at(dir.fh.fd, leaf),
      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NOCTTY,
      0o600,
    );
  } finally {
    await closeQuietly(dir.fh);
  }
  try {
    await assertHeldAt(fh, below(dirReal, leaf), anchor, rel, safe);
    await fh.chmod(opts.fileMode ?? 0o644);
    if (opts.owner) await fh.chown(opts.owner.uid, opts.owner.gid);
    return fh;
  } catch (err) {
    await closeQuietly(fh);
    // Leave nothing behind: a 0600 empty stub at a name a caller was told it could not have is
    // worse than no file, because the next attempt then fails EEXIST against our own leftover.
    const cleanup = await walkDir(anchor, safe, segs).catch(() => null);
    if (cleanup) {
      await unlink(at(cleanup.fh.fd, leaf)).catch(() => undefined);
      await closeQuietly(cleanup.fh);
    }
    throw err;
  }
}

/** Write every byte. `FileHandle.write` may write short, and a partial config file that parses is
 *  worse than one that does not. */
async function writeAll(fh: FileHandle, bytes: Buffer): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const res = await fh.write(bytes, written, bytes.length - written, written);
    written += res.bytesWritten;
  }
}

export type WriteMode = 'create-exclusive' | 'overwrite-in-place' | 'replace-atomic';

export interface WriteFileOptions {
  /** Default `replace-atomic`. */
  mode?: WriteMode;
  /** Permission bits. `replace-atomic` defaults to the REPLACED file's mode, then 0644. */
  fileMode?: number;
  /** Owner. `replace-atomic` defaults to the REPLACED file's owner — without that, every rewrite
   *  hands a uid-1000 file back to root and the agent that owned it can no longer write it. */
  owner?: Owner;
  createParents?: boolean;
  /** fsync the content before it becomes visible. */
  durable?: boolean;
  /** `replace-atomic` only: replace a symbolic link standing at the name instead of refusing it.
   *  For a file Haive GENERATES and nobody else may own, where a link planted at its name would
   *  otherwise block every later write. The final rename replaces the link as a link, so its target
   *  is never touched, and neither its owner nor its mode is inherited. Anything else at the name —
   *  a directory, a device — is still refused. */
  replaceLeafLink?: boolean;
}

/**
 * Write `<anchor>/<rel>`, following nothing. A MUTATION throughout: a link anywhere throws.
 *
 * Never `O_TRUNC`. That flag truncates as part of the open, i.e. before anything has verified what
 * was opened, so a file swapped for a link between the walk and the open is emptied through the
 * link. Truncation happens only after `fstat` and the descriptor check have passed.
 *
 * Three modes, because the right one depends on who else is reading the file:
 * - `replace-atomic` (default) — write a temp beside it and rename over. A concurrent reader sees
 *   the old bytes or the new ones, never a half-written file. For anything parsed by a machine.
 * - `overwrite-in-place` — keeps the inode, owner and mode, for a file something holds open or
 *   whose identity matters (the api's knowledge editor).
 * - `create-exclusive` — refuses to replace anything at all.
 */
export async function writeFileNoFollow(
  anchor: string,
  rel: string,
  data: string | Buffer,
  opts: WriteFileOptions = {},
): Promise<'created' | 'overwritten'> {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const mode = opts.mode ?? 'replace-atomic';

  if (mode === 'create-exclusive') {
    const fh = await createExclusive(anchor, rel, opts);
    try {
      await writeAll(fh, bytes);
      if (opts.durable) await fh.sync();
    } finally {
      await closeQuietly(fh);
    }
    return 'created';
  }

  const safe = toSafeRel(rel);

  if (mode === 'overwrite-in-place') {
    // `openVerified` refuses a link or a non-regular file and verifies the descriptor, so the
    // truncate below cannot reach anything but the file this call resolved.
    const fh = await openVerified(anchor, safe, 'read-write');
    try {
      await fh.truncate(0);
      await writeAll(fh, bytes);
      if (opts.durable) await fh.sync();
      if (opts.fileMode !== undefined) await fh.chmod(opts.fileMode);
      if (opts.owner) await fh.chown(opts.owner.uid, opts.owner.gid);
    } finally {
      await closeQuietly(fh);
    }
    return 'overwritten';
  }

  const segs = segments(safe);
  const leaf = segs.pop();
  if (leaf === undefined) throw new PathContainmentError('invalid-path', anchor, rel, rel);
  const found = await lstatNoFollow(anchor, safe, { strict: true });
  if (found !== null && found.kind === 'symlink' && !opts.replaceLeafLink) {
    throw new PathContainmentError('link', anchor, rel, safe);
  }
  // A link being replaced is not a file whose owner or mode the new one should carry on.
  const existing = found !== null && found.kind === 'symlink' ? null : found;
  if (existing !== null && existing.kind !== 'file') {
    throw new PathContainmentError('not-regular-file', anchor, rel, safe);
  }

  // Dotted and pid/uuid-suffixed so two writers cannot collide and a leftover is recognisable.
  const tmpRel = [...segs, `.${leaf}.haive-tmp-${process.pid}-${randomUUID()}`].join('/');
  const inherited = existing ? { uid: existing.stats.uid, gid: existing.stats.gid } : null;
  const fh = await createExclusive(anchor, tmpRel, {
    createParents: opts.createParents,
    owner: opts.owner,
    fileMode: opts.fileMode ?? (existing ? existing.stats.mode & 0o777 : 0o644),
  });
  // An INHERITED owner is a courtesy — it keeps a uid-1000 file out of root's hands across a
  // rewrite — so a writer that cannot set it proceeds instead of failing. An owner the CALLER asked
  // for stays strict, because there the hand-over is the whole point of passing it.
  if (!opts.owner && inherited) {
    await fh.chown(inherited.uid, inherited.gid).catch(() => undefined);
  }
  let renamed = false;
  try {
    await writeAll(fh, bytes);
    if (opts.durable) await fh.sync();
    await fh.close();
    await renameNoFollow(anchor, tmpRel, safe);
    renamed = true;
  } finally {
    await closeQuietly(fh);
    if (!renamed) await removeNoFollow(anchor, tmpRel).catch(() => undefined);
  }
  return found === null ? 'created' : 'overwritten';
}

export interface UpdateFileOptions {
  /** Create the file when it is absent, handing `update` a `null` current. Without this an absent
   *  file rethrows ENOENT, because a read-modify-write of a file nobody wrote is a caller bug. */
  create?: boolean;
  /** Only applied to a file this call CREATES; an existing file keeps its own mode and owner, which
   *  is the whole point of updating in place. */
  fileMode?: number;
  owner?: Owner;
  createParents?: boolean;
  /** Refuse a file larger than this rather than read part of it: `update` receives the WHOLE
   *  content and writes back what it returns, so a truncated read would delete the remainder. */
  maxBytes?: number;
}

/**
 * Read-modify-write `<anchor>/<rel>` over ONE descriptor, following nothing. A mutation: a link
 * anywhere throws.
 *
 * One descriptor is the point. Reading a path and then writing it are two resolutions, and between
 * them the file can become a link — so the read and the write here are the same open, verified once.
 * For the AGENTS.md marker upserts and the KB appends, which is what this exists for.
 *
 * NEVER `fh.writeFile` after `fh.readFile`: that writes at the handle's CURRENT offset, which the
 * read left at the old EOF, and `truncate` does not move it — so the file comes back with a hole in
 * front of the new content. `writeAll` writes at explicit positions from 0.
 *
 * Not crash-atomic, unlike `replace-atomic`: a crash mid-write leaves a truncated file. That is the
 * trade for keeping the inode, the owner and the mode, and it is why `replace-atomic` stays the
 * default for anything a machine parses. Node has no `flock`, so two concurrent updaters are
 * serialized at step level or not at all.
 *
 * `unchanged` is returned — and nothing written — when `update` returns `null` or the identical
 * string, so a re-run that has nothing to add does not touch the file's mtime.
 */
export async function updateFileNoFollow(
  anchor: string,
  rel: string,
  update: (current: string | null) => string | null | Promise<string | null>,
  opts: UpdateFileOptions = {},
): Promise<'created' | 'updated' | 'unchanged'> {
  const safe = toSafeRel(rel);

  let fh: FileHandle;
  try {
    fh = await openVerified(anchor, safe, 'read-write');
  } catch (err) {
    // A containment refusal is never softened: this is a mutation, so a link or an out-of-tree
    // component throws. Absence is the one case with another answer, and only when asked for.
    if (isPathContainmentError(err) || !ABSENT.has(errno(err) ?? '')) throw err;
    if (!opts.create) throw err;
    const next = await update(null);
    if (next === null) return 'unchanged';
    const created = await createExclusive(anchor, safe, {
      createParents: opts.createParents,
      fileMode: opts.fileMode,
      owner: opts.owner,
    });
    try {
      await writeAll(created, Buffer.from(next, 'utf8'));
    } finally {
      await closeQuietly(created);
    }
    return 'created';
  }

  try {
    const size = (await fh.stat()).size;
    if (opts.maxBytes !== undefined && size > opts.maxBytes) {
      throw new Error(`${rel} is ${size} bytes, over the ${opts.maxBytes} byte update cap`);
    }
    const buf = Buffer.allocUnsafe(size);
    let filled = 0;
    while (filled < size) {
      const { bytesRead } = await fh.read(buf, filled, size - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    const current = buf.subarray(0, filled).toString('utf8');
    const next = await update(current);
    if (next === null || next === current) return 'unchanged';
    await fh.truncate(0);
    await writeAll(fh, Buffer.from(next, 'utf8'));
    return 'updated';
  } finally {
    await closeQuietly(fh);
  }
}

/**
 * The link's own TARGET TEXT, or `null` when the entry is absent or is not a link.
 *
 * Reading a link is not following one. `readlink(2)` never resolves its last component, and the
 * parents are walked exactly as every other primitive walks them, so nothing here resolves a name
 * the caller did not hold. What it exists for is a convention check: onboarding may SKIP a
 * `CLAUDE.md` that is merely a link to `AGENTS.md`, because the target is handled at its own path,
 * while any other link stays refused by whatever mutation would have touched it.
 */
export async function readLinkNoFollow(
  anchor: string,
  rel: string,
  opts: StrictOption = {},
): Promise<string | null> {
  const safe = toSafeRel(rel);
  return readResult(opts.strict, async () => {
    const segs = segments(safe);
    const leaf = segs.pop();
    if (leaf === undefined) throw new PathContainmentError('not-regular-file', anchor, rel, '');
    const dir = await walkDir(anchor, safe, segs);
    try {
      const st = await lstat(at(dir.fh.fd, leaf));
      if (!st.isSymbolicLink()) return null;
      return await readlink(at(dir.fh.fd, leaf));
    } finally {
      await closeQuietly(dir.fh);
    }
  });
}
