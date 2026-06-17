import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
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
// fallback in the Source tab. Streams the whole file (no 512 KB cap) with a
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
