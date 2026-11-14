import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@haive/database', () => ({ createDatabase: h.create }));
beforeEach(() => {
  vi.resetModules();
  h.create.mockReset();
});
it('uses a separate pool for recovery and closes it after success or failure', async () => {
  const primary = { $client: { end: vi.fn() } };
  const fresh = { $client: { end: vi.fn() } };
  h.create.mockReturnValueOnce(primary).mockReturnValue(fresh);
  const { initDatabase, getDb, withFreshDatabase } = await import('../src/db.js');
  const url = 'postgres://localhost/recovery_test';
  initDatabase(url);
  expect(await withFreshDatabase(async (db) => db)).toBe(fresh);
  const failure = Object.assign(new Error('read failed'), { code: 'CONNECTION_CLOSED' });
  await expect(
    withFreshDatabase(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(h.create.mock.calls).toEqual([[url], [url], [url]]);
  expect(fresh.$client.end.mock.calls).toEqual([[{ timeout: 5 }], [{ timeout: 5 }]]);
  expect(getDb()).toBe(primary);
  expect(primary.$client.end).not.toHaveBeenCalled();
});
it('refuses recovery before database initialization', async () => {
  const { withFreshDatabase } = await import('../src/db.js');
  await expect(withFreshDatabase(async () => undefined)).rejects.toThrow('not initialized');
  expect(h.create).not.toHaveBeenCalled();
});
