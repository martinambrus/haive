import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import { saveCliLoginSecret, writeLoginTokenToSet } from '../src/lib/cli-login-secret.js';

// The DB has no methods: rejection must happen before any query, lock or write.
const db = {} as Database;
describe('blank captured and internal login tokens', () => {
  it.each(['', ' \t\n\u00a0'])(
    'rejects a captured blank token (%j) before touching the set',
    async (value) => {
      await expect(saveCliLoginSecret(db, 'user', 'provider', value)).rejects.toThrow(
        'CLAUDE_CODE_OAUTH_TOKEN needs a non-blank value',
      );
    },
  );
  it.each(['', ' \t\n\u00a0'])(
    'rejects an internal blank token (%j) before spreading it',
    async (value) => {
      const assertHeld = vi.fn();
      await expect(
        writeLoginTokenToSet(db as never, {
          userId: 'user',
          viaId: 'provider',
          members: [{ id: 'provider' }, { id: 'sibling' }],
          source: 'manual',
          value,
          masterKek: '',
          assertHeld,
        }),
      ).rejects.toThrow('CLAUDE_CODE_OAUTH_TOKEN needs a non-blank value');
      expect(assertHeld).not.toHaveBeenCalled();
    },
  );
});
