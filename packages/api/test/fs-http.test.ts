import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { logger } from '@haive/shared';
import { PathContainmentError } from '@haive/shared/fs-safe';
import type { AppEnv } from '../src/context.js';
import { HttpError } from '../src/context.js';
import { containmentHttpError } from '../src/lib/fs-http.js';
import { errorHandler } from '../src/middleware/error-handler.js';

afterEach(() => vi.restoreAllMocks());

it.each(['EMFILE', 'ENFILE', 'EIO', 'ENOMEM', 'ESTALE', 'ETIMEDOUT', 'ENOSPC', undefined])(
  'lets server fault %s reach the generic 500 and structured error log',
  async (code) => {
    const err = Object.assign(new Error('injected /private/path'), { code });
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const app = new Hono<AppEnv>();
    app.get('/', () => containmentHttpError(err));
    app.onError(errorHandler);
    const res = await app.request('/');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(error).toHaveBeenCalledExactlyOnceWith({ err }, 'Unhandled API error');
  },
);

it.each(['EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG', 'EISDIR'])(
  'keeps path errno %s at 400',
  (code) => {
    expect(() => containmentHttpError({ code })).toThrow(
      expect.objectContaining({ status: 400, message: 'Path cannot be read' }),
    );
  },
);

it.each([
  ['link', 403, 'Path is a symlink'],
  ['not-regular-file', 400, 'Path is not a regular file'],
  ['not-directory', 404, 'File not found'],
  ['unverifiable', 403, 'Cannot verify the file path'],
  ['invalid-path', 403, 'outside'],
  ['out-of-tree', 403, 'outside'],
] as const)('keeps containment %s at %s', (reason, status, message) => {
  expect(() =>
    containmentHttpError(new PathContainmentError(reason, '/root', 'a', 'a'), 'outside'),
  ).toThrow(expect.objectContaining({ status, message }));
});

it('preserves an existing HttpError by identity', () => {
  const err = new HttpError(409, 'retry');
  expect(() => containmentHttpError(err)).toThrow(err);
});
