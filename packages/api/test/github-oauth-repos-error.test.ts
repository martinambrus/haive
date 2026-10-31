import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));

import { Hono } from 'hono';
import { encrypt, encryptDek, generateDek, secretsService } from '@haive/shared';
import { githubOauthRoutes } from '../src/routes/github-oauth.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const KEK = 'ab'.repeat(32);
const CREDENTIAL = '00000000-0000-4000-8000-0000000000c1';
const app = new Hono<AppEnv>();
app.route('/', githubOauthRoutes);
let thrown: Error | undefined;
app.onError((err, c) => {
  thrown = err;
  return errorHandler(err, c);
});

beforeEach(() => {
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
  const dek = generateDek();
  h.db = {
    query: {
      repoCredentials: {
        findFirst: async () => ({
          id: CREDENTIAL,
          userId: USER,
          host: 'github.com',
          encryptedDek: encryptDek(dek, KEK),
          secretEncrypted: encrypt('gh-token', dek),
        }),
      },
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('bounds and redacts a 100 KB vendor error before the response or error can expose it', async () => {
  const cancel = vi.fn();
  const bytes = new TextEncoder().encode('echo gh-token ' + 'x'.repeat(100 * 1024));
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
            cancel,
          }),
          { status: 503 },
        ),
    ),
  );
  const res = await app.request(`/repos?credentialId=${CREDENTIAL}`);
  expect(res.status).toBe(502);
  const body = (await res.json()) as { error: string };
  expect(body.error.length).toBeLessThan(600);
  expect(body.error).toContain('[redacted]');
  expect(body.error).not.toContain('gh-token');
  expect(cancel).toHaveBeenCalledOnce();
  expect(thrown?.message).toBe(body.error);
  expect(JSON.stringify({ err: thrown?.message })).not.toContain('gh-token');
});
