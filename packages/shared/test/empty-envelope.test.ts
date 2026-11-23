import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { envelopeEncrypt, generateEncryptionKey, isEmptyEnvelope } from '../src/crypto/index.js';

describe('empty envelope ciphertext', () => {
  it('pins the real envelope format for empty, whitespace and one-byte values', () => {
    const kek = generateEncryptionKey();
    expect(isEmptyEnvelope(envelopeEncrypt('', kek).encryptedValue)).toBe(true);
    expect(isEmptyEnvelope(envelopeEncrypt(' ', kek).encryptedValue)).toBe(false);
    const value = String.fromCharCode(randomBytes(1)[0]! & 0x7f);
    expect(isEmptyEnvelope(envelopeEncrypt(value, kek).encryptedValue)).toBe(false);
  });

  it.each(['', 'missing:part', 'extra:parts:here:'])(
    'keeps malformed envelopes configured (%j)',
    (value) => {
      expect(isEmptyEnvelope(value)).toBe(false);
    },
  );
});
