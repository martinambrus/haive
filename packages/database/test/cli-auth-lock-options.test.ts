import { expect, it, vi } from 'vitest';
import type { Database } from '../src/index.js';
const h = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('postgres', () => ({ default: h.create }));
import {
  CLI_AUTH_ASSERT_TIMEOUT_MS,
  CliAuthLockLostError,
  tryCliAuthLock,
} from '../src/cli-auth-lock.js';
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

it('caps dedicated auth clients including concurrent acquisitions and frees slots on release', async () => {
  h.create.mockClear();
  h.create.mockImplementation(() =>
    Object.assign(
      vi.fn(async () => [{ held: true, pid: 1 }]),
      { end: vi.fn(async () => {}) },
    ),
  );
  const db = { $client: { options: { database: 'test', user: 'test' } } } as unknown as Database;
  const holders = await Promise.all(
    Array.from({ length: 40 }, (_, i) => tryCliAuthLock(db, String(i))),
  );
  try {
    expect(h.create).toHaveBeenCalledTimes(32);
    expect(holders.filter(Boolean)).toHaveLength(32);
    expect(await tryCliAuthLock(db, 'over-cap')).toBeNull();
  } finally {
    await Promise.all(holders.map((h) => h?.()));
  }
  const next = await tryCliAuthLock(db, 'freed');
  expect(next).not.toBeNull();
  await next?.();
});

it('treats a lock check that does not answer in time as a lost lock', async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    const client = Object.assign(
      vi.fn(() =>
        ++calls === 1 ? Promise.resolve([{ held: true, pid: 1 }]) : new Promise(() => {}),
      ),
      { end: vi.fn(async () => {}) },
    );
    h.create.mockReturnValue(client);
    const db = { $client: { options: { database: 'test', user: 'test' } } } as unknown as Database;
    const release = await tryCliAuthLock(db, 'hung');
    const check = release!.assertHeld();
    const outcome = expect(check).rejects.toBeInstanceOf(CliAuthLockLostError);
    await vi.advanceTimersByTimeAsync(CLI_AUTH_ASSERT_TIMEOUT_MS);
    await outcome;
    // Lost is permanent: a later check refuses without another query.
    await expect(release!.assertHeld()).rejects.toBeInstanceOf(CliAuthLockLostError);
    expect(calls).toBe(2);
    await release!();
  } finally {
    vi.useRealTimers();
  }
});
