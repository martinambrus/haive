import type { Database } from '@haive/database';

/** Loopback HTTP fixtures represent remotes an administrator is allowed to dial. */
export const adminGitOwner = {
  db: { query: { users: { findFirst: async () => ({ role: 'admin' }) } } } as unknown as Database,
  userId: 'fixture-admin',
};
