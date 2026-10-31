import { HttpError } from '../context.js';

export const INVALID_BODY_MESSAGE = 'The request body must be a JSON object';

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A request body can parse as JSON and still not be an object: `null`, a list, a string, a number
 *  and a boolean all parse, then fail on the first field read, which the api would answer 500.
 *  That is the caller's error, so it is answered 400 `invalid_body` here, once. */
export function requireJsonObject<T extends object = Record<string, unknown>>(value: unknown): T {
  if (!isJsonObject(value)) throw new HttpError(400, INVALID_BODY_MESSAGE, 'invalid_body');
  return value as T;
}
