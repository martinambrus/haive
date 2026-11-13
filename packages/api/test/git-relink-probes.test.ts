import { fork, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createServer, connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { Hono } from 'hono';
import { hardenGitArgs } from '@haive/shared/git-args';
import { createDatabase, schema, type Database } from '@haive/database';
import { cleanActor, makeActor } from './security-audit-db.js';

const h = vi.hoisted(() => ({ db: undefined as unknown, actor: '' }));
vi.mock('../src/db.js', () => ({
  getDb: () => h.db,
  withFreshDatabase: async (run: (fresh: Database) => Promise<unknown>) => {
    const fresh = createDatabase(url!);
    try {
      return await run(fresh);
    } finally {
      await fresh.$client.end({ timeout: 5 });
    }
  },
}));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(key: string, value: string): void }, next: () => unknown) => {
    c.set('userId', h.actor);
    await next();
  },
}));
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import {
  startRemoteReconcileSweep,
  REMOTE_SWEEP_INTERVAL_MS,
} from '../src/lib/remote-reconcile.js';
import type { AppEnv } from '../src/context.js';

const url = process.env.RELINK_DATABASE_URL;
const probe = describe.skipIf(!url);
const exec = promisify(execFile);
const oldUrl = 'https://old.example.test/repo';
const newUrl = 'https://new.example.test/repo';
const git = async (root: string, args: string[]) =>
  (await exec('git', hardenGitArgs(args), { cwd: root })).stdout.trim();
let db: Database;
let actor: string;
let root: string;
let template: string;
let repository: string;
let child: ChildProcess | undefined;
const app = new Hono<AppEnv>().route('/', repoRoutes).onError(errorHandler);
const stored = () =>
  db.query.repositories.findFirst({ where: eq(schema.repositories.id, repository) });
const audits = () =>
  db
    .select()
    .from(schema.auditEvents)
    .where(
      and(
        eq(schema.auditEvents.targetId, repository),
        eq(schema.auditEvents.action, 'repository.remote.update'),
      ),
    );

probe('remote relink at real PostgreSQL commit and process-death boundaries', () => {
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      !['localhost', '127.0.0.1'].includes(target.hostname) ||
      target.pathname !== '/relink_test' ||
      Number(target.port) < 1024
    )
      throw new Error(
        'Use only the disposable rlk-* container database relink_test on an ephemeral loopback port',
      );
    db = createDatabase(url!);
    template = await mkdtemp(join(tmpdir(), 'relink-template-'));
    await git(template, ['init', '-q']);
    await git(template, ['remote', 'add', 'origin', oldUrl]);
  });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    child = undefined;
    if (actor) await cleanActor(db, actor);
    if (root) await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    if (db) await db.$client.end({ timeout: 5 });
    if (template) await rm(template, { recursive: true, force: true });
  });

  async function fixture() {
    actor = (await makeActor(db)).id;
    h.actor = actor;
    root = await mkdtemp(join(tmpdir(), 'git-relink-'));
    await cp(template, root, { recursive: true });
    const [repo] = await db
      .insert(schema.repositories)
      .values({
        userId: actor,
        name: 'probe',
        source: 'local_path',
        localPath: root,
        remoteUrl: oldUrl,
        branch: 'main',
      })
      .returning();
    repository = repo!.id;
  }

  it('keeps Git aligned with a committed row when the actual COMMIT acknowledgement is lost', async () => {
    await fixture();
    const upstream = new URL(url!);
    const sockets = new Set<Socket>();
    let dropped = false;
    // PostgreSQL has committed before emitting CommandComplete(COMMIT). Drop that frame
    // and ReadyForQuery: the real postgres.js begin() receives CONNECTION_CLOSED.
    const server = createServer((client) => {
      const backend = connect({ host: upstream.hostname, port: Number(upstream.port) });
      sockets.add(client);
      sockets.add(backend);
      client.on('error', () => undefined);
      backend.on('error', () => client.destroy());
      client.on('close', () => {
        sockets.delete(client);
        backend.destroy();
      });
      backend.on('close', () => {
        sockets.delete(backend);
        client.destroy();
      });
      client.pipe(backend);
      let pending = Buffer.alloc(0);
      backend.on('data', (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 5) {
          const length = pending.readUInt32BE(1) + 1;
          if (pending.length < length) return;
          const frame = pending.subarray(0, length);
          pending = pending.subarray(length);
          if (frame[0] === 67 && frame.subarray(5).toString() === 'COMMIT\0') {
            dropped = true;
            client.destroy();
            backend.destroy();
            return;
          }
          client.write(frame);
        }
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No proxy port');
    const proxyUrl = new URL(url!);
    proxyUrl.port = String(address.port);
    const proxied = createDatabase(proxyUrl.href);
    let driverError: unknown;
    const transaction = proxied.transaction.bind(proxied);
    h.db = new Proxy(proxied, {
      get(target, key, receiver) {
        if (key !== 'transaction') return Reflect.get(target, key, receiver);
        return async (...args: Parameters<Database['transaction']>) => {
          try {
            return await transaction(...args);
          } catch (error) {
            driverError = error;
            throw error;
          }
        };
      },
    });
    try {
      const response = await app.request(`/${repository}/remote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteUrl: newUrl }),
      });
      expect(dropped).toBe(true);
      expect(driverError).toHaveProperty('code', 'CONNECTION_CLOSED');
      expect(response.status).toBe(500);
      expect((await stored())?.remoteUrl).toBe(newUrl);
      expect(await audits()).toHaveLength(1);
      expect(await git(root, ['remote', 'get-url', 'origin'])).toBe(newUrl);
    } finally {
      await proxied.$client.end({ timeout: 1 });
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reconciles Git after the API dies after the real git write and before COMMIT', async () => {
    await fixture();
    child = fork(
      fileURLToPath(new URL('./fixtures/git-relink-probe-child.ts', import.meta.url)),
      [url!, actor, repository, newUrl],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let output = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    await new Promise<void>((resolve, reject) => {
      child!.once('message', (message) => {
        if (message === 'before_commit') resolve();
        else reject(new Error(`Unexpected child phase: ${String(message)}`));
      });
      child!.once('error', reject);
      child!.once('exit', () =>
        reject(new Error(`Child exited before the commit boundary: ${output}`)),
      );
    });
    expect(await git(root, ['remote', 'get-url', 'origin'])).toBe(newUrl);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    expect((await stored())?.remoteUrl).toBe(oldUrl);
    expect(await audits()).toHaveLength(0);
    // A detail read stays passive. The bounded sweep repairs the interrupted relink.
    h.db = db;
    expect((await app.request(`/${repository}`)).status).toBe(200);
    expect(await git(root, ['remote', 'get-url', 'origin'])).toBe(newUrl);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const schedule = globalThis.setTimeout;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      ...args: Parameters<typeof setTimeout>
    ) => {
      const scheduled = schedule(...args);
      if (args[1] === REMOTE_SWEEP_INTERVAL_MS) finished();
      return scheduled;
    }) as typeof setTimeout);
    const stop = startRemoteReconcileSweep();
    try {
      await vi.advanceTimersByTimeAsync(0);
      await done;
    } finally {
      stop();
      timer.mockRestore();
      vi.useRealTimers();
    }
    expect(await git(root, ['remote', 'get-url', 'origin'])).toBe(oldUrl);
  });
});
