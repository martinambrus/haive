import { logger } from '@haive/shared/logger';
import { FALLBACK_API_URL } from './api-origin';

type ApiBaseCache = { value: string; base?: string; error?: Error };
const cacheKey = Symbol.for('haive.server-api-base');
// Next compiles route handlers and Server Components into separate bundles in one process.
const state = globalThis as typeof globalThis & { [cacheKey]?: ApiBaseCache };

/** One operator-selected upstream for proxying and server reads. Never log its value:
 * configuration can contain credentials. Invalid configuration is diagnosed once per value. */
export function resolveServerApiBase(): string {
  const value =
    process.env.API_URL_INTERNAL?.trim() ||
    process.env.HAIVE_PUBLIC_API_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    FALLBACK_API_URL;
  let cached = state[cacheKey];
  if (cached?.value !== value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid protocol');
      cached = state[cacheKey] = { value, base: value.replace(/\/$/, '') };
    } catch {
      const error = new Error(
        'Invalid server API URL: configure API_URL_INTERNAL, HAIVE_PUBLIC_API_URL or NEXT_PUBLIC_API_URL as an absolute HTTP(S) URL',
      );
      cached = state[cacheKey] = { value, error };
      logger.error(error.message);
    }
  }
  if (cached.error) throw cached.error;
  return cached.base!;
}
