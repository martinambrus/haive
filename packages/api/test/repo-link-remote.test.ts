import { beforeEach, describe, expect, it, vi } from 'vitest';
const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown, git: vi.fn(), entry: vi.fn() }));
vi.mock('@haive/shared/fs-safe', async (original) => ({
  ...(await original<typeof import('@haive/shared/fs-safe')>()),
  lstatNoFollow: h.entry,
}));
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(key: string, value: string): void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: h.git }) };
});
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const REPO = '00000000-0000-4000-8000-0000000000b1';
const app = new Hono<AppEnv>();
app.route('/', repoRoutes);
app.onError(errorHandler);
let fake: ReturnType<typeof createFakeDb>;
beforeEach(() => {
  fake = createFakeDb({
    repositories: schema.repositories,
    auditEvents: schema.auditEvents,
    repoCredentials: schema.repoCredentials,
  });
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    storagePath: '/repo',
    remoteUrl: null,
  });
  h.db = fake.db;
  h.entry.mockReset().mockResolvedValue({ kind: 'directory' });
  h.git.mockReset().mockResolvedValue({ stdout: '', stderr: '' });
});
const link = () =>
  app.request(`/${REPO}/remote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remoteUrl: 'https://example.test/r' }),
  });
const fail = (code: number | string, stderr: string) =>
  Object.assign(new Error(stderr), { code, stderr });
describe('link origin uses git exit codes', () => {
  it('updates after exit 3 regardless of human wording', async () => {
    h.git
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
      .mockRejectedValueOnce(fail(3, 'different language'))
      .mockResolvedValueOnce({ stdout: 'https://old.test/r', stderr: '' })
      .mockRejectedValueOnce(fail(1, 'no push URL'));
    expect((await link()).status).toBe(200);
    expect(h.git.mock.calls[4]![1]).toContain('--unset-all');
    expect(h.git.mock.calls[5]![1]).toContain('--replace-all');
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBe('https://example.test/r');
  });
  it('does not mistake an unrelated failure with already-exists words for exit 3', async () => {
    h.git
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
      .mockRejectedValueOnce(fail(128, 'remote origin already exists'));
    expect((await link()).status).toBe(409);
    expect(h.git).toHaveBeenCalledTimes(2);
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
  });
  it('fails a non-zero URL replacement without persisting the row', async () => {
    h.git
      .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
      .mockRejectedValueOnce(fail(3, 'remote origin already exists'))
      .mockResolvedValueOnce({ stdout: 'https://old.test/r', stderr: '' })
      .mockRejectedValueOnce(fail(1, 'no push URL'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(fail(128, 'broken config'));
    const res = await link();
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Could not update');
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
  });
});
it.each([0, 5])('accepts push URL cleanup exit %s', async (code) => {
  h.git
    .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
    .mockRejectedValueOnce(fail(3, 'different language'))
    .mockResolvedValueOnce({ stdout: 'https://old.test/r', stderr: '' })
    .mockRejectedValueOnce(fail(1, 'no push URL'));
  if (code === 5) h.git.mockRejectedValueOnce(fail(5, 'missing key'));
  expect((await link()).status).toBe(200);
  expect(h.git.mock.calls[4]![1]).toContain('--unset-all');
});
it('does not persist a relink whose push URL cleanup failed', async () => {
  h.git
    .mockResolvedValueOnce({ stdout: 'true\n', stderr: '' })
    .mockRejectedValueOnce(fail(3, 'different language'))
    .mockResolvedValueOnce({ stdout: 'https://old.test/r', stderr: '' })
    .mockRejectedValueOnce(fail(1, 'no push URL'))
    .mockRejectedValueOnce(fail(128, 'different language'));
  const response = await link();
  expect(response.status).toBe(409);
  expect(await response.text()).toContain("Could not clear the remote's push URLs");
  expect(h.git.mock.calls.at(-1)![1]).toEqual(
    expect.arrayContaining(['--unset-all', 'remote.origin.pushurl']),
  );
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
});

it.each([false, true])(
  'refuses a remote with a mismatched credential (retained=%s) before touching git',
  async (retained) => {
    const credentialId = '00000000-0000-4000-8000-0000000000c1';
    fake.insert(schema.repoCredentials, {
      id: credentialId,
      userId: USER,
      host: 'other.example.test',
    });
    if (retained)
      await fake.db
        .update(schema.repositories)
        .set({ credentialsSecretId: credentialId })
        .where(eq(schema.repositories.id, REPO));
    h.git.mockResolvedValueOnce({ stdout: 'true\n', stderr: '' });
    const res = await app.request(`/${REPO}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        remoteUrl: 'https://example.test/r',
        ...(retained ? {} : { credentialsId: credentialId }),
      }),
    });
    expect(res.status).toBe(400);
    expect(h.git).not.toHaveBeenCalled();
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
  },
);

it('rechecks a retained credential binding changed between the initial and locked reads', async () => {
  const fitting = '00000000-0000-4000-8000-0000000000c1';
  const changed = '00000000-0000-4000-8000-0000000000c2';
  fake.insert(schema.repoCredentials, { id: fitting, userId: USER, host: 'example.test' });
  fake.insert(schema.repoCredentials, { id: changed, userId: USER, host: 'other.example.test' });
  fake.patch(schema.repositories, REPO, { credentialsSecretId: fitting });
  const transaction = fake.db.transaction.bind(fake.db);
  vi.spyOn(fake.db, 'transaction').mockImplementation(async (fn) => {
    fake.patch(schema.repositories, REPO, { credentialsSecretId: changed });
    return transaction(fn);
  });
  h.git.mockResolvedValueOnce({ stdout: 'true\n', stderr: '' });
  const response = await link();
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: 'The Git credential does not fit the remote',
  });
  expect(h.git).toHaveBeenCalledTimes(1); // Only the pre-transaction checkout probe.
  expect(fake.rows(schema.repositories)[0]).toMatchObject({
    remoteUrl: null,
    credentialsSecretId: changed,
  });
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});

it('waits for a disconnected transaction callback before restoring the remote', async () => {
  const old = 'https://old.test/r';
  const next = 'https://example.test/r';
  fake.patch(schema.repositories, REPO, { remoteUrl: old });
  let checkout = old;
  const events: string[] = [];
  let reached!: () => void;
  let release!: () => void;
  let disconnect!: (error: Error) => void;
  const atWrite = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dropped = new Promise<never>((_resolve, reject) => {
    disconnect = reject;
  });
  const failure = new Error('connection closed');
  let callback!: Promise<unknown>;
  h.db = new Proxy(fake.db, {
    get(target, key) {
      if (key === 'transaction')
        return (fn: (tx: any) => Promise<unknown>) => {
          callback = target.transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(t, prop) {
                  if (prop === 'update')
                    return () => ({
                      set: () => ({
                        where: async () => {
                          throw failure;
                        },
                      }),
                    });
                  const value = Reflect.get(t, prop);
                  return typeof value === 'function' ? value.bind(t) : value;
                },
              }),
            ),
          );
          // postgres.js can reject on connection close before its callback finishes.
          return Promise.race([callback, dropped]);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  h.git.mockImplementation(async (_command, args: string[]) => {
    if (args.includes('rev-parse')) return { stdout: 'true', stderr: '' };
    if (args.includes('remote') && args.includes('add')) throw fail(3, 'exists');
    if (args.includes('--get-all')) {
      if (args.at(-1) === 'remote.origin.url') return { stdout: checkout, stderr: '' };
      throw fail(1, 'absent');
    }
    if (args.includes('--replace-all')) {
      const value = args.at(-1)!;
      if (value === next) {
        reached();
        await resume;
      }
      checkout = value;
      events.push(value === next ? 'write finished' : 'restored');
    }
    return { stdout: '', stderr: '' };
  });
  const response = Promise.resolve(link());
  try {
    await atWrite;
    disconnect(failure);
    // Drain the rejection continuation while the git child remains held.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    release();
  }
  await callback.catch(() => undefined);
  expect((await response).status).toBe(500);
  expect(events).toEqual(['write finished', 'restored']);
  expect(checkout).toBe(old);
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBe(old);
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});
