import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/context.js';
import { isJsonObject, readOptionalJsonObject, requireJsonObject } from '../src/lib/json-object.js';

const OBJECTS: [string, unknown][] = [
  ['an empty object', {}],
  ['an object with fields', { a: 1, b: [2], c: { d: null } }],
];

const NOT_OBJECTS: [string, unknown][] = [
  ['null', null],
  ['an empty list', []],
  ['a list of objects', [{}]],
  ['a string', 'x'],
  ['a number', 0],
  ['a boolean', true],
  ['undefined', undefined],
];

const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
};

describe('isJsonObject', () => {
  it.each(OBJECTS)('accepts %s', (_what, value) => {
    expect(isJsonObject(value)).toBe(true);
  });

  it.each(NOT_OBJECTS)('refuses %s', (_what, value) => {
    expect(isJsonObject(value)).toBe(false);
  });
});

describe('requireJsonObject', () => {
  it.each(OBJECTS)('returns %s as it was given', (_what, value) => {
    expect(requireJsonObject(value)).toBe(value);
  });

  it('types the object it returns as the caller says', () => {
    const body = requireJsonObject<{ a?: number }>({ a: 1 });

    expect(body.a).toBe(1);
  });

  it.each(NOT_OBJECTS)('throws a 400 invalid_body HttpError for %s', (_what, value) => {
    const err = thrownBy(() => requireJsonObject(value));

    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400, code: 'invalid_body' });
  });
});

describe('readOptionalJsonObject', () => {
  it.each([
    ['', {}],
    ['{}', {}],
    ['{"components":["rtk"]}', { components: ['rtk'] }],
  ] as const)('reads %j with empty-body defaults', async (text, expected) => {
    expect(await readOptionalJsonObject({ text: async () => text })).toEqual(expected);
  });

  it.each(['{"components":', '  \n'])('refuses malformed document %j', async (text) => {
    await expect(readOptionalJsonObject({ text: async () => text })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_json',
    });
  });

  it.each(['null', '[]', '"text"', '5', 'true'])('refuses non-object document %s', async (text) => {
    await expect(readOptionalJsonObject({ text: async () => text })).rejects.toMatchObject({
      status: 400,
      code: 'invalid_body',
    });
  });

  it('propagates a body-read failure instead of applying defaults', async () => {
    const error = new Error('body read failed');
    await expect(
      readOptionalJsonObject({
        text: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  });
});
