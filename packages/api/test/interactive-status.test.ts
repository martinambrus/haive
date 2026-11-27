import { Hono, type Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, type AppEnv } from '../src/context.js';
import { repoIdeAccessRoutes, taskIdeAccessRoutes } from '../src/routes/ide.js';

const ID = '11111111-2222-3333-4444-555555555555';
const mocks = vi.hoisted(() => ({ belongs: vi.fn(), state: vi.fn() }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: Context<AppEnv>, next: () => Promise<void>) => {
    c.set('userId', c.req.header('x-test-user') ?? 'owner');
    await next();
  },
}));
vi.mock('../src/lib/ide-target.js', async (original) => ({
  ...(await original<typeof import('../src/lib/ide-target.js')>()),
  targetBelongsToUser: mocks.belongs,
  ideCheckoutState: mocks.state,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.belongs.mockImplementation(async (target) => target.payload.userId === 'owner');
});

describe.each([
  { path: '/tasks', router: taskIdeAccessRoutes, repository: false },
  { path: '/repos', router: repoIdeAccessRoutes, repository: true },
])('$path interactive-status handler', ({ path, router, repository }) => {
  const app = new Hono<AppEnv>().route(path, router);
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.code }, error.status);
    throw error;
  });

  it.each([
    { status: 'ready', epoch: null },
    { status: 'ready', epoch: 'replacement' },
    { status: 'cloning', epoch: 'replacement' },
  ])('returns $status / $epoch for the owner without caching', async ({ status, epoch }) => {
    const state = { repositoryId: ID, status, epoch };
    mocks.state.mockResolvedValue(state);
    const response = await app.request(`${path}/${ID}/interactive-status`);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual(state);
    const payload = repository
      ? { repositoryId: ID, userId: 'owner' }
      : { taskId: ID, userId: 'owner' };
    expect(mocks.belongs).toHaveBeenCalledWith(expect.objectContaining({ payload }));
    expect(mocks.state).toHaveBeenCalledWith(expect.objectContaining({ payload }));
  });

  it("hides another user's target before reading its status or epoch", async () => {
    const response = await app.request(`${path}/${ID}/interactive-status`, {
      headers: { 'x-test-user': 'other' },
    });
    expect(response.status).toBe(404);
    expect(mocks.belongs).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ userId: 'other' }) }),
    );
    expect(mocks.state).not.toHaveBeenCalled();
  });

  it('refuses a non-UUID before ownership or state lookup', async () => {
    const response = await app.request(`${path}/not-a-uuid/interactive-status`);
    expect(response.status).toBe(404);
    expect(mocks.belongs).not.toHaveBeenCalled();
    expect(mocks.state).not.toHaveBeenCalled();
  });
});
