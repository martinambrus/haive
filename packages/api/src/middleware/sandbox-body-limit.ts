import { bodyLimit } from 'hono/body-limit';

export const SANDBOX_BODY_LIMIT_BYTES = 64 * 1024;

// A custom onError because the default throws an HTTPException, which errorHandler answers 500.
export const sandboxBodyLimit = bodyLimit({
  maxSize: SANDBOX_BODY_LIMIT_BYTES,
  onError: (c) =>
    c.json({ error: `Request body exceeds ${SANDBOX_BODY_LIMIT_BYTES} bytes`, code: null }, 413),
});
