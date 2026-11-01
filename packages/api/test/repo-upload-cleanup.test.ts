import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock('../src/db.js', () => ({ getDb: h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    await next();
  },
}));
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

describe('retired single-shot repository upload', () => {
  it('returns 404 before reading the body or accessing repository state', async () => {
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new Uint8Array(64 * 1024));
      controller.close();
    });
    const body = new ReadableStream({ pull }, { highWaterMark: 0 });
    const app = new Hono<AppEnv>().route('/repos', repoRoutes).onError(errorHandler);
    const res = await app.request(
      new Request('http://localhost/repos/upload', {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=retired' },
        body,
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(404);
    expect(pull).not.toHaveBeenCalled();
    expect(h.db).not.toHaveBeenCalled();
    await body.cancel();
  });
});
