import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { envelopeEncrypt, generateEncryptionKey, secretsService } from '@haive/shared';
import { seedJoinerFromSet } from '../src/lib/cli-login-secret.js';
import { insertAuditEvent } from '../src/lib/audit.js';

vi.mock('../src/lib/audit.js', () => ({ insertAuditEvent: vi.fn(), logAuditEvent: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
function candidate(value: string) {
  return {
    providerId: randomUUID(),
    ...envelopeEncrypt(value, generateEncryptionKey()),
    // A lost data key must not prevent byte-for-byte seeding.
    encryptedDek: randomUUID(),
    fingerprint: '****',
    authStatus: 'ok',
    authMessage: 'authenticated',
    authCheckedAt: '2020-01-01 00:00:00.123456',
    authGeneration: randomUUID(),
  };
}

function transaction(candidates: ReturnType<typeof candidate>[]) {
  const values = vi.fn((_value: Record<string, unknown>) => ({ onConflictDoUpdate: vi.fn() }));
  const set = vi.fn((_value: Record<string, unknown>) => ({
    where: () => ({ returning: async () => [{ id: 'joiner' }] }),
  }));
  const tx = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ orderBy: async () => candidates }) }),
      }),
    }),
    insert: () => ({ values }),
    update: () => ({ set }),
  };
  return { tx: tx as unknown as Transaction, values, set };
}

describe('login set seed without decryption', () => {
  it('does no per-candidate work after the first configured candidate', async () => {
    const source = candidate(randomBytes(1).toString('hex'));
    const later = candidate('');
    const laterRead = vi.fn((): string => {
      throw new Error('candidate after the selected source must not be inspected');
    });
    Object.defineProperty(later, 'encryptedValue', { get: laterRead });
    const { tx, values } = transaction([candidate(''), source, later]);
    const result = await seedJoinerFromSet(tx, {
      userId: 'user',
      joinerId: 'joiner',
      members: [{ id: 'joiner' }, { id: source.providerId }, { id: later.providerId }],
      assertHeld: vi.fn(),
    });
    expect(result.row?.id).toBe('joiner');
    expect(values.mock.calls[0]?.[0]?.encryptedValue === source.encryptedValue).toBe(true);
    expect(laterRead).not.toHaveBeenCalled();
  });

  it.each([' ', randomBytes(1).toString('hex')])(
    'skips an exact-empty candidate and copies the next envelope (%#)',
    async (value) => {
      const empty = candidate('');
      const source = candidate(value);
      const { tx, values, set } = transaction([empty, source]);
      const kek = vi
        .spyOn(secretsService, 'getMasterKek')
        .mockRejectedValue(new Error('KEK must not be loaded'));
      const assertHeld = vi.fn();
      const result = await seedJoinerFromSet(tx, {
        userId: 'user',
        joinerId: 'joiner',
        members: [{ id: 'joiner' }, { id: empty.providerId }, { id: source.providerId }],
        assertHeld,
      });
      expect(result.row?.id).toBe('joiner');
      const copied = values.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
      expect(copied.encryptedValue === source.encryptedValue).toBe(true);
      expect(copied.encryptedDek === source.encryptedDek).toBe(true);
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ authGeneration: source.authGeneration }),
      );
      expect(insertAuditEvent).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          metadata: expect.objectContaining({ viaProviderId: source.providerId }),
        }),
      );
      expect(assertHeld).toHaveBeenCalledTimes(2);
      expect(kek).not.toHaveBeenCalled();
    },
  );
});
