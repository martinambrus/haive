import { describe, expect, it } from 'vitest';
import * as crypto from '../src/crypto/index.js';

const key = '11'.repeat(32);
const oldKey = '22'.repeat(32);

describe('lenient user-field decryption', () => {
  it('reads normalized email and phone under the current key', () => {
    expect(crypto.tryDecryptEmail(crypto.encryptEmail(' Admin@Example.com ', key), key)).toBe(
      'admin@example.com',
    );
    expect(crypto.tryDecrypt(crypto.encrypt('+33123456789', key), key)).toBe('+33123456789');
  });

  it('returns null for a lost key or a failed authentication tag', () => {
    const encrypted = crypto.encryptEmail('admin@example.com', oldKey);
    expect(crypto.tryDecryptEmail(encrypted, key)).toBeNull();
    const parts = encrypted.split(':');
    parts[1] = '00'.repeat(16);
    expect(crypto.tryDecryptEmail(parts.join(':'), oldKey)).toBeNull();
  });

  it.each([
    '',
    'not:ciphertext',
    'zz:00:aa',
    `${'00'.repeat(16)}:${'00'.repeat(16)}:a`,
    `${'00'.repeat(16)}:${'00'.repeat(16)}:ffzz`,
    `${'00'.repeat(16)}:00:aa`,
  ])('returns null for malformed ciphertext %s', (value) => {
    expect(crypto.tryDecryptEmail(value, key)).toBeNull();
  });

  it('does not hide an invalid configuration key', () => {
    expect(() =>
      crypto.tryDecryptEmail(crypto.encryptEmail('a@example.com', key), 'bad'),
    ).toThrow();
  });
});
