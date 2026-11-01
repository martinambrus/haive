import { HttpError } from '../context.js';

export const INVALID_BODY_MESSAGE = 'The request body must be a JSON object';
export const INVALID_BODY_CODE = 'invalid_body';

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A request body can parse as JSON and still not be an object: `null`, a list, a string, a number
 *  and a boolean all parse. `null` then throws on the first field read, which the api would answer
 *  500; the rest read as an object with no fields, which a handler refuses for something unrelated
 *  or acts on as if it were `{}`. All of it is the caller's error, answered 400 `invalid_body` here,
 *  once. */
export function requireJsonObject<T extends object = Record<string, unknown>>(value: unknown): T {
  if (!isJsonObject(value)) throw new HttpError(400, INVALID_BODY_MESSAGE, INVALID_BODY_CODE);
  return value as T;
}

/** Only a zero-length body is absent. Invalid JSON and non-object roots must never
 *  become the defaults of a state-changing optional request. */
export async function readOptionalJsonObject(request: {
  text(): Promise<string>;
}): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new HttpError(400, 'The request body is not valid JSON', 'invalid_json');
    }
    throw err;
  }
  return requireJsonObject(value);
}
