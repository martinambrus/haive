// Standalone smoke test for the terminal WebSocket route.
// Requires: postgres + redis available on localhost, docker daemon.
// Run from repo root: node --env-file=.env scripts/... OR
//   CONFIG_ENCRYPTION_KEY=<hex> DATABASE_URL=postgres://... REDIS_URL=redis://... \
//   pnpm --filter @haive/api exec tsx test/terminal-smoke.ts
//
// The test:
//   1) boots config/secrets/db
//   2) creates a throwaway alpine container via dockerode (tty sh)
//   3) inserts user + task + containers rows directly
//   4) signs an access token, spins up a Hono server + installs terminal WS
//   5) opens a WebSocket client, sends 'echo smoke_ok', expects it back
//   6) cleans up everything
// Exits 0 on success, 1 on failure.

import { createServer, type Server as HttpServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import Docker from 'dockerode';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { WebSocket } from 'ws';
import { configService, secretsService, userSecretsService, logger } from '@haive/shared';
import { schema } from '@haive/database';
import { initDatabase, getDb } from '../src/db.js';
import type { AppEnv } from '../src/context.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { installTerminalWebSocket } from '../src/routes/terminal.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { ACCESS_COOKIE } from '../src/auth/cookies.js';

const log = logger.child({ module: 'terminal-smoke' });

const REQUIRED_ENV = ['DATABASE_URL', 'REDIS_URL', 'CONFIG_ENCRYPTION_KEY'] as const;
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`[smoke] missing env ${k}`);
    process.exit(2);
  }
}

interface TestState {
  docker: Docker;
  containerDockerId?: string;
  userId?: string;
  taskId?: string;
  containerRowId?: string;
  httpServer?: HttpServer;
}

async function main() {
  const state: TestState = { docker: new Docker() };
  try {
    log.info('bootstrapping');
    await configService.initialize(process.env.REDIS_URL!);
    const db = initDatabase(process.env.DATABASE_URL!);
    await secretsService.initialize(db);
    const masterKek = await secretsService.getMasterKek();
    await userSecretsService.initialize(db, masterKek);
    await secretsService.getJwtSecret();

    await ensureAlpineImage(state.docker);

    log.info('creating alpine container');
    const alpine = await state.docker.createContainer({
      Image: 'alpine:3.20',
      name: `haive-smoke-${randomBytes(4).toString('hex')}`,
      Tty: true,
      OpenStdin: true,
      StdinOnce: false,
      Cmd: ['/bin/sh'],
    });
    await alpine.start();
    state.containerDockerId = alpine.id;
    log.info({ id: alpine.id }, 'alpine started');

    const now = new Date();
    const userId = randomUUID();
    state.userId = userId;
    await db.insert(schema.users).values({
      id: userId,
      emailEncrypted: 'smoke@test.local',
      emailBlindIndex: `smoke-${randomBytes(4).toString('hex')}`,
      passwordHash: 'smoke-not-real',
      role: 'user',
      status: 'active',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    });

    const [task] = await db
      .insert(schema.tasks)
      .values({
        userId,
        type: 'onboarding',
        title: 'smoke-test',
        status: 'running',
      })
      .returning();
    if (!task) throw new Error('task insert failed');
    state.taskId = task.id;

    const [containerRow] = await db
      .insert(schema.containers)
      .values({
        taskId: task.id,
        runtime: 'dockerode',
        dockerContainerId: alpine.id,
        name: `smoke.${task.id.slice(0, 8)}`,
        status: 'running',
      })
      .returning();
    if (!containerRow) throw new Error('container insert failed');
    state.containerRowId = containerRow.id;

    const accessToken = await signAccessToken({ sub: userId, role: 'user', tv: 0 });

    const app = new Hono<AppEnv>();
    app.onError(errorHandler);
    const httpServer = createServer((req, res) => {
      void app.fetch(toWebRequest(req)).then(async (resp) => {
        res.statusCode = resp.status;
        resp.headers.forEach((v, k) => res.setHeader(k, v));
        if (resp.body) {
          const reader = resp.body.getReader();
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            res.write(Buffer.from(chunk.value));
          }
        }
        res.end();
      });
    });
    installTerminalWebSocket(httpServer);
    state.httpServer = httpServer;
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    const port = addr.port;
    log.info({ port }, 'test server listening');

    const ws = new WebSocket(`ws://127.0.0.1:${port}/terminal/${containerRow.id}`, {
      headers: { Cookie: `${ACCESS_COOKIE}=${accessToken}` },
    });

    const frames: unknown[] = [];
    let sawConnected = false;
    let sawSmokeOk = false;

    const done = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('timeout waiting for smoke_ok'));
      }, 15_000);
      ws.on('message', (data) => {
        const text = data.toString();
        let frame: { type?: string; data?: string };
        try {
          frame = JSON.parse(text);
        } catch {
          return;
        }
        frames.push(frame);
        if (frame.type === 'connected') {
          sawConnected = true;
          ws.send(JSON.stringify({ type: 'input', data: 'echo smoke_ok\n' }));
        } else if (
          frame.type === 'output' &&
          typeof frame.data === 'string' &&
          frame.data.includes('smoke_ok')
        ) {
          sawSmokeOk = true;
          clearTimeout(timeout);
          resolve();
        } else if (frame.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(`error frame: ${JSON.stringify(frame)}`));
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      ws.on('close', (code, reason) => {
        if (!sawSmokeOk) {
          clearTimeout(timeout);
          reject(new Error(`socket closed early: ${code} ${reason.toString()}`));
        }
      });
    });

    await done;
    ws.close();
    await once(ws, 'close').catch(() => undefined);

    log.info({ sawConnected, sawSmokeOk, frameCount: frames.length }, 'SMOKE OK');
    await cleanup(state);
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'SMOKE FAIL');
    await cleanup(state).catch(() => undefined);
    process.exit(1);
  }
}

async function cleanup(state: TestState): Promise<void> {
  const db = (() => {
    try {
      return getDb();
    } catch {
      return null;
    }
  })();
  if (db) {
    if (state.containerRowId) {
      await db
        .delete(schema.containers)
        .where(eq(schema.containers.id, state.containerRowId))
        .catch(() => undefined);
    }
    if (state.taskId) {
      await db
        .delete(schema.tasks)
        .where(eq(schema.tasks.id, state.taskId))
        .catch(() => undefined);
    }
    if (state.userId) {
      await db
        .delete(schema.users)
        .where(eq(schema.users.id, state.userId))
        .catch(() => undefined);
    }
  }
  if (state.containerDockerId) {
    const c = state.docker.getContainer(state.containerDockerId);
    await c.stop({ t: 0 }).catch(() => undefined);
    await c.remove({ force: true }).catch(() => undefined);
  }
  if (state.httpServer) {
    await new Promise<void>((resolve) => state.httpServer!.close(() => resolve()));
  }
}

async function ensureAlpineImage(docker: Docker): Promise<void> {
  try {
    await docker.getImage('alpine:3.20').inspect();
    return;
  } catch {
    // pull below
  }
  log.info('pulling alpine:3.20');
  await new Promise<void>((resolve, reject) => {
    docker.pull('alpine:3.20', (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve()));
    });
  });
}

function toWebRequest(req: import('node:http').IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost';
  const url = `http://${host}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(', '));
    else if (typeof v === 'string') headers.set(k, v);
  }
  return new Request(url, { method: req.method, headers });
}

main();
