import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../src/context.js';

const state = vi.hoisted(() => ({ root: '' }));
const USER = '00000000-0000-4000-8000-000000000001';
const TASK = '00000000-0000-4000-8000-000000000002';
const REPO = '00000000-0000-4000-8000-000000000003';
const ATTACHMENT = '00000000-0000-4000-8000-000000000004';
const attachmentPath = () => join(state.root, 'repo', '.haive', 'task-uploads', TASK, 'note.txt');

vi.mock('../src/db.js', () => ({
  getDb: () => ({
    query: {
      tasks: { findFirst: async () => ({ id: TASK, userId: USER, repositoryId: REPO }) },
      taskSteps: { findFirst: async () => undefined },
      repositories: {
        findFirst: async () => ({
          id: REPO,
          userId: USER,
          name: 'fixture',
          status: 'ready',
          storagePath: join(state.root, 'repo'),
        }),
      },
      taskAttachments: {
        findFirst: async () => ({
          id: ATTACHMENT,
          taskId: TASK,
          userId: USER,
          filename: 'note.txt',
          storedPath: attachmentPath(),
          contentType: 'text/plain',
        }),
      },
      userNotificationSettings: {
        findFirst: async () => ({
          soundPath: join(state.root, '_uploads', USER, 'sound.mp3'),
          soundMime: 'audio/mpeg',
        }),
      },
    },
  }),
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (_c: unknown, next: () => Promise<void>) => next(),
  requireAuthAllowingPasswordChange: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {
  c.set('userId', USER);
  await next();
});

beforeAll(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'byte-headers-'));
  await mkdir(join(state.root, 'repo', '.haive', 'task-uploads', TASK), { recursive: true });
  await mkdir(join(state.root, '_uploads', USER), { recursive: true });
  await writeFile(attachmentPath(), 'attachment bytes');
  await writeFile(
    join(state.root, 'repo', 'image.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  await writeFile(join(state.root, '_uploads', USER, 'sound.mp3'), 'ID3 sound bytes');
  await writeFile(join(state.root, 'ca.pem'), 'certificate bytes');
  vi.stubEnv('REPO_STORAGE_ROOT', state.root);
  vi.stubEnv('DDEV_CA_PATH', join(state.root, 'ca.pem'));
  const [
    { fileRoutes },
    { repoRoutes },
    { browserAccessRoutes },
    { attachmentRoutes },
    { userSettingsRoutes },
    { errorHandler },
  ] = await Promise.all([
    import('../src/routes/tasks/files.js'),
    import('../src/routes/repos.js'),
    import('../src/routes/tasks/browser-access.js'),
    import('../src/routes/tasks/attachments.js'),
    import('../src/routes/user-settings.js'),
    import('../src/middleware/error-handler.js'),
  ]);
  app.route('/tasks', fileRoutes);
  app.route('/repos', repoRoutes);
  app.route('/tasks', browserAccessRoutes);
  app.route('/tasks', attachmentRoutes);
  app.route('/settings', userSettingsRoutes);
  app.onError(errorHandler);
}, 30_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(state.root, { recursive: true, force: true });
});

it.each([
  [`/tasks/${TASK}/files/archive`, 'application/zip', 'PK'],
  [`/repos/${REPO}/archive`, 'application/zip', 'PK'],
  [`/tasks/${TASK}/ddev-ca`, 'application/x-pem-file', 'certificate bytes'],
  [`/tasks/${TASK}/attachments/${ATTACHMENT}/raw`, 'text/plain', 'attachment bytes'],
  ['/settings/notifications/sound', 'audio/mpeg', 'ID3 sound bytes'],
  [`/tasks/${TASK}/files/raw`, 'image/svg+xml', '<svg'],
])('serves %s without sniffing or changing its media type and bytes', async (path, mime, bytes) => {
  const query = path.endsWith('/files/raw')
    ? `?path=${encodeURIComponent(join(state.root, 'repo', 'image.svg'))}`
    : '';
  const response = await app.request(path + query);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body.startsWith(bytes)).toBe(true);
  expect(response.headers.get('content-type')).toBe(mime);
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});
