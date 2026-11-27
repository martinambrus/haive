import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalUuid } from '../src/canonical-uuid.js';

// PostgreSQL reads a uuid in any letter case, in braces, and with hyphens omitted or after any group
// of four digits, and prints only the lowercase 8-4-4-4-12 form a row's own id is keyed from.
describe('canonicalUuid', () => {
  const id = randomUUID();
  const hex = id.replaceAll('-', '');

  it.each([
    ['canonical', id],
    ['uppercase', id.toUpperCase()],
    ['braced', `{${id}}`],
    ['braced uppercase', `{${id.toUpperCase()}}`],
    ['unhyphenated', hex],
    ['unhyphenated uppercase', hex.toUpperCase()],
    ['partly hyphenated', `${hex.slice(0, 8)}-${hex.slice(8)}`],
    ['regrouped by four', hex.replace(/(.{4})(?=.)/g, '$1-')],
  ])('maps the %s spelling to the canonical id', (_, spelling) => {
    expect(canonicalUuid(spelling)).toBe(id);
  });

  it('leaves a value that is not a uuid as written', () => {
    for (const value of [
      '',
      'not-a-uuid',
      `${hex}0`,
      hex.slice(1),
      `{${id}`,
      hex.replace(/./, 'g'),
    ]) {
      expect(canonicalUuid(value)).toBe(value);
    }
  });
});
