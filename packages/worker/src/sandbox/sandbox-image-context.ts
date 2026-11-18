import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Build context for SANDBOX_CORE_IMAGE, resolved the way ddev-runner resolves its own. */
export function sandboxImageContextDir(): string {
  if (process.env.SANDBOX_CORE_CONTEXT) return process.env.SANDBOX_CORE_CONTEXT;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'sandbox-image');
}
