import { Hono } from 'hono';
import { z } from 'zod';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { requireAuth } from '../middleware/auth.js';
import { HttpError, type AppEnv } from '../context.js';
import { getFilesystemRoot, validateLocalPath, isGitRepository } from '../lib/filesystem.js';

export const filesystemRoutes = new Hono<AppEnv>();
filesystemRoutes.use('*', requireAuth);

filesystemRoutes.get('/', async (c) => {
  const requested = c.req.query('path') ?? getFilesystemRoot();
  const dir = validateLocalPath(requested);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new HttpError(404, 'Directory not found or unreadable');
  }

  const result = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      const isDirectory = entry.isDirectory();
      const hasGit = isDirectory ? await isGitRepository(fullPath) : false;
      return {
        name: entry.name,
        path: fullPath,
        isDirectory,
        hasGit,
        hidden: entry.name.startsWith('.'),
      };
    }),
  );

  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const root = getFilesystemRoot();
  const parent = dir === root ? null : dirname(dir);

  return c.json({ path: dir, parent, root, entries: result });
});

const validateGitSchema = z.object({ path: z.string() });

filesystemRoutes.post('/validate-git', async (c) => {
  const body = validateGitSchema.parse(await c.req.json());
  const dir = validateLocalPath(body.path);
  const valid = await isGitRepository(dir);
  return c.json({ path: dir, valid });
});
