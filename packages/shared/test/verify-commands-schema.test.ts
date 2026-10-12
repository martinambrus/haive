import { describe, expect, it } from 'vitest';
import { verifyCommandsSchema } from '../src/schemas/repos.js';

describe('verifyCommandsSchema', () => {
  it('accepts a custom command, an Off slot and an empty object', () => {
    expect(verifyCommandsSchema.parse({ test: 'x', lint: null })).toEqual({
      test: 'x',
      lint: null,
    });
    expect(verifyCommandsSchema.parse({})).toEqual({});
  });

  it('trims a command', () => {
    expect(verifyCommandsSchema.parse({ typecheck: '  tsc --noEmit ' })).toEqual({
      typecheck: 'tsc --noEmit',
    });
  });

  it('accepts exactly 2000 characters', () => {
    expect(verifyCommandsSchema.safeParse({ test: 'a'.repeat(2000) }).success).toBe(true);
  });

  it.each([
    ['an unknown key', { build: 'make' }],
    ['a newline', { test: 'a\nb' }],
    ['a carriage return', { test: 'a\rb' }],
    ['a NUL', { test: 'a\u0000b' }],
    ['more than 2000 characters', { test: 'a'.repeat(2001) }],
    ['an empty string', { test: '' }],
    ['a blank string', { lint: '   ' }],
    ['a number', { test: 1 }],
    ['a non-object', 'make test'],
  ])('rejects %s', (_name, value) => {
    expect(verifyCommandsSchema.safeParse(value).success).toBe(false);
  });
});
