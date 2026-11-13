import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: (...args: Parameters<typeof real.open>) => {
      if (h.error) throw h.error;
      return real.open(...args);
    },
  };
});
vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      userNotificationSettings: {
        findFirst: async () => ({ soundPath: '/storage/_uploads/user/sound.mp3' }),
      },
    },
  }),
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', 'user');
    await next();
  },
  requireAuthAllowingPasswordChange: async (_c: unknown, next: () => unknown) => next(),
}));
import { Hono } from 'hono';
import { logger } from '@haive/shared';
import { KB_DIR } from '@haive/shared/knowledge-paths';
import type { AppEnv } from '../src/context.js';
import { HttpError } from '../src/context.js';
import { isWholeFile } from '../src/lib/upload-complete-claim.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { resolveWorkspaceRoot } from '../src/routes/tasks/_helpers.js';
import { openEditableKnowledgeFile } from '../src/routes/tasks/files.js';
import { userSettingsRoutes } from '../src/routes/user-settings.js';

const savedRoot = process.env.REPO_STORAGE_ROOT;
const app = new Hono<AppEnv>();
app.get('/knowledge', async (c) => {
  const fh = await openEditableKnowledgeFile('/storage', '/storage', `/storage/${KB_DIR}/a.md`);
  await fh.close();
  return c.json({ ok: true });
});
app.get('/whole', async (c) => {
  if (!(await isWholeFile('/storage', 'archive.zip', 10))) {
    throw new HttpError(409, 'archive size mismatch on disk');
  }
  return c.json({ ok: true });
});
app.get('/workspace', async (c) => {
  const db = {
    query: {
      tasks: {
        findFirst: async () => ({
          id: 'task',
          userId: 'user',
          repositoryId: 'repo',
          worktreePath: '/storage/.haive/worktrees/task',
          worktreeBranch: 'task',
        }),
      },
      repositories: { findFirst: async () => ({ storagePath: '/storage' }) },
      taskSteps: { findFirst: async () => undefined },
    },
  };
  await resolveWorkspaceRoot(db as never, 'task', 'user');
  return c.json({ ok: true });
});
app.route('/', userSettingsRoutes);
app.onError(errorHandler);

beforeEach(() => {
  process.env.REPO_STORAGE_ROOT = '/storage';
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  h.error = null;
  if (savedRoot === undefined) delete process.env.REPO_STORAGE_ROOT;
  else process.env.REPO_STORAGE_ROOT = savedRoot;
  vi.restoreAllMocks();
});

it.each(['/knowledge', '/notifications/sound', '/whole', '/workspace'])(
  '%s propagates descriptor exhaustion to the logged, generic 500',
  async (route) => {
    for (const code of ['EMFILE', 'ENFILE']) {
      h.error = Object.assign(new Error('injected /private/path'), { code });
      vi.mocked(logger.error).mockClear();
      const res = await app.request(route);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(logger.error).toHaveBeenCalledExactlyOnceWith({ err: h.error }, 'Unhandled API error');
    }
  },
);

it.each([
  ['/knowledge', 404],
  ['/notifications/sound', 404],
  ['/whole', 409],
  ['/workspace', 409],
] as const)('%s keeps its absence response', async (route, status) => {
  h.error = Object.assign(new Error('injected'), { code: 'ENOENT' });
  expect((await app.request(route)).status).toBe(status);
  expect(logger.error).not.toHaveBeenCalled();
});
