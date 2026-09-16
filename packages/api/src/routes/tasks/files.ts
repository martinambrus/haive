import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { isReadOnlyLocalRepo } from '@haive/shared';
import { isPathContainmentError, openFileNoFollow, relUnder } from '@haive/shared/fs-safe';
import { KB_DIR, LEARNING_DRAFTS_DIR, LEARNINGS_DIR } from '@haive/shared/knowledge-paths';
import { getDb } from '../../db.js';
import { HttpError, type AppEnv } from '../../context.js';
import { createTaskArchiveStream } from '../../lib/task-archive.js';
import {
  MAX_FILE_CONTENT_BYTES,
  mimeForExtension,
  resolveWorkspaceRoot,
  TEXT_EXTENSIONS,
  validateWorkspacePath,
} from './_helpers.js';

export const fileRoutes = new Hono<AppEnv>();

fileRoutes.get('/:id/files/archive', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const { root } = await resolveWorkspaceRoot(db, id, userId);

  const { stream, filename } = await createTaskArchiveStream(root, id);

  c.header('Content-Type', 'application/zip');
  c.header('Content-Disposition', `attachment; filename="${filename}"`);
  c.header('Cache-Control', 'no-store');

  return c.body(Readable.toWeb(stream) as ReadableStream);
});

fileRoutes.get('/:id/files', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const { root } = await resolveWorkspaceRoot(db, id, userId);

  const requested = c.req.query('path') ?? root;
  const dir = validateWorkspacePath(root, requested);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new HttpError(404, 'Directory not found or unreadable');
  }

  const result = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      let size: number | null = null;
      try {
        const s = await stat(fullPath);
        size = entry.isFile() ? s.size : null;
      } catch {
        // ignore stat failures
      }
      return {
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        hidden: entry.name.startsWith('.'),
        size,
      };
    }),
  );

  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parent = dir === root ? null : dirname(dir);
  return c.json({ path: dir, parent, root, entries: result });
});

fileRoutes.get('/:id/files/content', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const { root } = await resolveWorkspaceRoot(db, id, userId);

  const requested = c.req.query('path');
  if (!requested) throw new HttpError(400, 'Missing path query parameter');
  const target = validateWorkspacePath(root, requested);

  let st;
  try {
    st = await stat(target);
  } catch {
    throw new HttpError(404, 'File not found');
  }
  if (st.isDirectory()) {
    throw new HttpError(400, 'Path is a directory, not a file');
  }

  const truncated = st.size > MAX_FILE_CONTENT_BYTES;
  const readSize = Math.min(st.size, MAX_FILE_CONTENT_BYTES);
  const buf = Buffer.alloc(readSize);
  const fh = await open(target, 'r');
  try {
    await fh.read({ buffer: buf, offset: 0, position: 0, length: readSize });
  } finally {
    await fh.close();
  }

  const ext = extname(target).toLowerCase();
  const name = basename(target);
  const isText =
    TEXT_EXTENSIONS.has(ext) ||
    TEXT_EXTENSIONS.has(name.toLowerCase()) ||
    name.toLowerCase() === 'claude.md' ||
    name.toLowerCase() === 'agents.md' ||
    name.toLowerCase() === 'readme' ||
    name.toLowerCase() === 'license';

  if (!isText) {
    return c.json({
      path: target,
      size: st.size,
      binary: true,
      truncated,
      content: null,
    });
  }

  const content = buf.toString('utf8');
  return c.json({
    path: target,
    size: st.size,
    binary: false,
    truncated,
    content,
  });
});

// Raw file bytes — backs inline image preview and the per-file download
// fallback in the Editor tab. Streams the whole file (no 512 KB cap) with a
// best-effort Content-Type; non-image types are octet-stream so the browser
// downloads rather than renders them inline.
fileRoutes.get('/:id/files/raw', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const { root } = await resolveWorkspaceRoot(db, id, userId);

  const requested = c.req.query('path');
  if (!requested) throw new HttpError(400, 'Missing path query parameter');
  const target = validateWorkspacePath(root, requested);

  let st;
  try {
    st = await stat(target);
  } catch {
    throw new HttpError(404, 'File not found');
  }
  if (st.isDirectory()) {
    throw new HttpError(400, 'Path is a directory, not a file');
  }

  c.header('Content-Type', mimeForExtension(extname(target).toLowerCase()));
  c.header('Content-Length', String(st.size));
  c.header('Cache-Control', 'no-store');

  return c.body(Readable.toWeb(createReadStream(target)) as ReadableStream);
});

// --- Inline knowledge-base editing -----------------------------------------
//
// The one WRITE path into a task workspace. It exists so the knowledge gates
// (11-phase-8-learning, 11b-kb-commit) can be reviewed AND corrected in the web
// UI, instead of the user opening the Terminal or the code-server Editor tab to
// fix a sentence in a drafted article.
//
// Deliberately narrow: it edits an EXISTING markdown file under the knowledge
// trees or under the git-excluded draft-staging dir, and nothing else. It cannot
// create a file, cannot reach code or config, and cannot walk out through a
// symlink. The Editor tab already grants full write access to this same
// worktree, so this adds no capability — it removes the reason to reach for one.

/** Repo-relative prefixes this endpoint may write inside. `.haive/` is the
 *  git-excluded dir where the learning gate stages drafts that are not files
 *  yet; the other two are the committed knowledge trees. */
const EDITABLE_PREFIXES = [`${KB_DIR}/`, `${LEARNINGS_DIR}/`, `${LEARNING_DRAFTS_DIR}/`] as const;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 403 unless the repo-relative path is shaped like an editable knowledge file.
 *  Pure, and only the FIRST half of the check — it says nothing about what is
 *  actually on disk at that path. The authoritative check runs after the open,
 *  against the path the kernel resolved for the inode we hold. */
export function assertEditableKnowledgeRelPath(root: string, target: string): void {
  const rel = relative(root, target);
  if (!EDITABLE_PREFIXES.some((p) => rel.startsWith(p))) {
    throw new HttpError(403, 'Only knowledge-base files can be edited here');
  }
  if (extname(target).toLowerCase() !== '.md') {
    throw new HttpError(403, 'Only markdown files can be edited here');
  }
}

/** Open an existing knowledge file for rewriting, or throw the HttpError that
 *  explains why not.
 *
 *  The validation and the write MUST land on the same inode. This process runs
 *  as root and the repo tree is writable by every task sandbox, so a
 *  check-then-write leaves a window in which an agent replaces the file with a
 *  symlink and has root write through it. `openFileNoFollow` walks the path one
 *  held directory descriptor at a time, refuses a link in ANY component, and
 *  proves the opened inode sits at `<anchor>/<rel>` through `/proc/self/fd`
 *  (Linux-only by construction; a `/proc` read that fails is a refusal). No
 *  `O_CREAT`: this endpoint rewrites files that exist and never creates one.
 *
 *  `anchor` is the repository root and `root` the workspace (the worktree when
 *  the task has one). The shape check is workspace-relative, but the walk
 *  starts at the repository root: a worktree lives under `.haive/worktrees/`,
 *  which the sandbox and the task terminal can rewrite, and the anchor is the
 *  one component the walk follows, so it must be a directory nothing untrusted
 *  can replace. */
export async function openEditableKnowledgeFile(
  anchor: string,
  root: string,
  target: string,
): Promise<FileHandle> {
  assertEditableKnowledgeRelPath(root, target);
  let fh: FileHandle | null;
  try {
    fh = await openFileNoFollow(anchor, relUnder(anchor, target), 'read-write', { strict: true });
  } catch (err) {
    if (isPathContainmentError(err, 'link')) throw new HttpError(403, 'Path is a symlink');
    if (isPathContainmentError(err, 'not-regular-file')) {
      throw new HttpError(400, 'Path is not a file');
    }
    if (isPathContainmentError(err, 'not-directory')) {
      throw new HttpError(404, 'File no longer exists');
    }
    if (isPathContainmentError(err, 'unverifiable')) {
      throw new HttpError(403, 'Cannot verify the file path');
    }
    if (isPathContainmentError(err)) throw new HttpError(403, 'Path is outside the task workspace');
    throw new HttpError(400, 'File cannot be opened for editing');
  }
  if (fh === null) throw new HttpError(404, 'File no longer exists');
  return fh;
}

/** 409 when the task's repository is read-only (mirrors the attachment upload
 *  route) — nothing may write into a user's own checkout. */
async function assertWritableRepo(
  db: ReturnType<typeof getDb>,
  repositoryId: string | null,
): Promise<void> {
  if (!repositoryId) return;
  const repo = await db.query.repositories.findFirst({
    where: eq(schema.repositories.id, repositoryId),
    columns: { source: true, writable: true },
  });
  if (repo && isReadOnlyLocalRepo(repo)) {
    throw new HttpError(409, 'This repository is read-only');
  }
}

fileRoutes.put('/:id/files/content', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const db = getDb();
  const { task, root, anchor } = await resolveWorkspaceRoot(db, id, userId);
  await assertWritableRepo(db, task.repositoryId);

  const body = (await c.req.json().catch(() => null)) as {
    path?: unknown;
    content?: unknown;
    expectedSha?: unknown;
  } | null;
  if (!body || typeof body.path !== 'string' || typeof body.content !== 'string') {
    throw new HttpError(400, 'path and content are required');
  }
  if (Buffer.byteLength(body.content, 'utf8') > MAX_FILE_CONTENT_BYTES) {
    throw new HttpError(413, 'File is too large to edit here');
  }

  const target = validateWorkspacePath(root, body.path);
  const fh = await openEditableKnowledgeFile(anchor, root, target);
  try {
    // Optimistic concurrency against the bytes the client actually rendered: an
    // agent re-run or a second tab can have rewritten the file since. Reported, not
    // resolved — a silent overwrite of either side is the wrong answer.
    const current = await fh.readFile({ encoding: 'utf8' });
    if (typeof body.expectedSha === 'string' && body.expectedSha !== sha256(current)) {
      throw new HttpError(
        409,
        'File changed since it was loaded; reload to see the current version',
      );
    }
    // Truncate first: a shorter body would otherwise leave the old tail behind.
    await fh.truncate(0);
    await fh.write(body.content, 0, 'utf8');
    // This process runs as root while the sandbox user is uid 1000: without
    // this the agent's next edit of its own file fails, and only inside a
    // container. Through the descriptor, like every other step here.
    await fh.chmod(0o644).catch(() => {});
    await fh.chown(1000, 1000).catch(() => {});
  } finally {
    await fh.close().catch(() => {});
  }

  return c.json({
    path: target,
    sha: sha256(body.content),
    size: Buffer.byteLength(body.content, 'utf8'),
  });
});
