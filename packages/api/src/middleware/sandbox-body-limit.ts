import { bodyLimit } from 'hono/body-limit';

export const SANDBOX_BODY_LIMIT_BYTES = 64 * 1024;

// A custom onError so the 413 is a JSON error naming the limit, not the default's plain-text one.
export const jsonBodyLimit = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: `Request body exceeds ${maxSize} bytes`, code: null }, 413),
  });

export const sandboxBodyLimit = jsonBodyLimit(SANDBOX_BODY_LIMIT_BYTES);
