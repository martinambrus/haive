import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { remoteRelinkKey } from '../src/remote-relink-lock.js';

// PostgreSQL reads a uuid in any letter case, in braces, and with hyphens omitted or after any group
// of four digits, and prints only the lowercase 8-4-4-4-12 form gate 4 keys from the database.
describe('remoteRelinkKey', () => {
  const id = randomUUID();
  const hex = id.replaceAll('-', '');

  it.each([
    ['canonical', id],
    ['uppercase', id.toUpperCase()],
    ['braced', `{${id}}`],
    ['braced uppercase', `{${id.toUpperCase()}}`],
    ['unhyphenated', hex],
    ['partly hyphenated', `${hex.slice(0, 8)}-${hex.slice(8)}`],
    ['regrouped by four', hex.replace(/(.{4})(?=.)/g, '$1-')],
  ])('keys the %s spelling as the canonical id', (_, spelling) => {
    expect(remoteRelinkKey(spelling)).toBe(`remote-relink:${id}`);
  });

  it('leaves a value that is not a uuid as written', () => {
    expect(remoteRelinkKey('not-a-uuid')).toBe('remote-relink:not-a-uuid');
  });
});
