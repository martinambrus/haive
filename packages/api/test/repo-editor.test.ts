import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { ideRunnerName, repoIdeSessionId } from '@haive/shared';
import type { AppEnv } from '../src/context.js';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const REPO = '00000000-0000-4000-8000-0000000000b1';
const TASK = '00000000-0000-4000-8000-0000000000c1';
const h = vi.hoisted(() => ({ db: undefined as unknown, add: vi.fn(), enabled: true }));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (
    c: { set: (key: string, value: string) => void },
    next: () => Promise<void>,
  ) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('../src/queues.js', () => ({
  getIdeEnsureQueue: () => ({ add: h.add }),
  getIdeEnsureQueueEvents: () => ({}),
}));
vi.mock('@haive/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@haive/shared')>()),
  configService: { getBoolean: async () => h.enabled },
}));

import { ideRoutes, repoIdeAccessRoutes } from '../src/routes/ide.js';
import { errorHandler } from '../src/middleware/error-handler.js';

const app = new Hono<AppEnv>();
app.onError(errorHandler);
app.route('/repos', repoIdeAccessRoutes);
app.route('/ide', ideRoutes);

beforeEach(() => {
  vi.unstubAllGlobals();
  h.enabled = true;
  h.add.mockReset().mockResolvedValue({ waitUntilFinished: async () => ({ ok: true }) });
  const fake = createFakeDb({ repositories: schema.repositories, tasks: schema.tasks });
  fake.insert(schema.repositories, { id: REPO, userId: USER });
  fake.insert(schema.tasks, { id: TASK, userId: USER });
  h.db = fake.db;
});

describe('repository editor access', () => {
  const open = (id = REPO) => app.request(`/repos/${id}/ensure-ide`, { method: 'POST' });

  it('starts an owned repository editor through the worker with its own coalesced job', async () => {
    const response = await open();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true, ready: true });
    expect(h.add).toHaveBeenCalledWith(
      'ensure-ide',
      { repositoryId: REPO, userId: USER },
      {
        jobId: `ensure-ide-repo-${REPO}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  });

  it('refuses another user’s repository without starting an editor', async () => {
    const fake = createFakeDb({ repositories: schema.repositories });
    fake.insert(schema.repositories, { id: REPO, userId: TASK });
    h.db = fake.db;
    expect((await open()).status).toBe(404);
    expect((await app.request(`/ide/repos/${REPO}/`)).status).toBe(404);
    expect(h.add).not.toHaveBeenCalled();
  });

  it('does not start an editor when disabled', async () => {
    h.enabled = false;
    expect(await (await open()).json()).toEqual({ enabled: false, ready: false });
    expect(h.add).not.toHaveBeenCalled();
  });

  it('reports a noneditable repository and a boot still in progress', async () => {
    h.add.mockResolvedValueOnce({
      waitUntilFinished: async () => ({ ok: false, reason: 'no-editable-repo' }),
    });
    expect((await open()).status).toBe(409);
    h.add.mockResolvedValueOnce({
      waitUntilFinished: async () => {
        throw new Error('timeout');
      },
    });
    expect((await open()).status).toBe(202);
  });

  it('proxies assets and query strings into the repository container without starting work on GET', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response('asset'));
    vi.stubGlobal('fetch', upstream);
    const response = await app.request(`/ide/repos/${REPO}/static/app.js?v=1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('asset');
    expect(upstream.mock.calls[0]?.[0]).toBe(
      `http://${ideRunnerName(repoIdeSessionId(REPO))}:8080/static/app.js?v=1`,
    );
    expect(h.add).not.toHaveBeenCalled();
  });

  it('keeps editor redirects inside the repository proxy', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 302, headers: { location: '/?folder=/workspace' } }),
        ),
    );
    const response = await app.request(`/ide/repos/${REPO}/`);
    expect(response.headers.get('location')).toBe(`/ide/repos/${REPO}/?folder=/workspace`);
  });

  it('continues to proxy task editors into their original container', async () => {
    const upstream = vi.fn().mockResolvedValue(new Response('task'));
    vi.stubGlobal('fetch', upstream);
    expect((await app.request(`/ide/${TASK}/`)).status).toBe(200);
    expect(upstream.mock.calls[0]?.[0]).toBe(`http://${ideRunnerName(TASK)}:8080/`);
  });
});
