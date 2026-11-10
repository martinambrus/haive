import { expect, it, vi } from 'vitest';
import type { Database } from '../src/index.js';
const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('postgres', () => ({ default: h.create }));
import { tryCliAuthLock } from '../src/cli-auth-lock.js';
it('uses a fresh shared state and disables startup type fetching for each dedicated connection', async () => {
  const shared = { retries: 7, typeArrayMap: { 23: 1007 } };
  const options = {
    database: 'test',
    user: 'test',
    shared,
    fetch_types: true,
    host: ['localhost'],
    port: [5432],
  };
  const db = { $client: { options } } as unknown as Database;
  const client = Object.assign(
    vi.fn(async () => [{ held: true }]),
    { end: vi.fn(async () => {}) },
  );
  h.create.mockReturnValue(client);
  const release = await tryCliAuthLock(db, 'scope');
  const other = await tryCliAuthLock(db, 'other');
  for (const [actual] of h.create.mock.calls) {
    expect(actual).toMatchObject({
      fetch_types: false,
      max: 1,
      shared: { retries: 0, typeArrayMap: {} },
    });
    expect(actual.shared).not.toBe(shared);
  }
  expect(h.create.mock.calls[0]![0].shared).not.toBe(h.create.mock.calls[1]![0].shared);
  expect(shared.retries).toBe(7);
  await release?.();
  await other?.();
  expect(client.end).toHaveBeenCalledWith({ timeout: 5 });
});
