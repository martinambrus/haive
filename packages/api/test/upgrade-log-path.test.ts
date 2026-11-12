import { createServer, type IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@haive/shared';

vi.mock('../src/lib/upgrade-auth.js', async (original) => ({
  ...(await original<typeof import('../src/lib/upgrade-auth.js')>()),
  authenticateUpgrade: async () => ({ userId: 'user', session: { revoked: false } }),
}));
vi.mock('../src/db.js', () => ({
  getDb: () => {
    throw new Error('synthetic ownership read failure');
  },
}));
vi.mock('../src/redis.js', () => ({
  getPatientRedis: () => ({ scan: async () => ['0', []] }),
}));

import { installTerminalWebSocket } from '../src/routes/terminal.js';
import { installCliStreamWebSocket } from '../src/routes/cli-stream.js';
import { installTerminalShellWebSocket } from '../src/routes/terminal-shell.js';
import { installBrowserVncWebSocket } from '../src/routes/browser-vnc.js';

const ID = '00000000-0000-4000-8000-000000000003';
afterEach(() => vi.restoreAllMocks());

describe('upgrade error log paths', () => {
  it.each([
    {
      install: installTerminalWebSocket,
      path: `/terminal/${ID}`,
      message: 'upgrade handler failed',
    },
    {
      install: installCliStreamWebSocket,
      path: `/cli-stream/${ID}`,
      message: 'cli-stream upgrade failed',
    },
    {
      install: installTerminalShellWebSocket,
      path: `/terminal-shell/${ID}/${ID}`,
      message: 'shell upgrade failed',
    },
    {
      install: installBrowserVncWebSocket,
      path: `/browser-vnc/${ID}`,
      message: 'vnc upgrade handler failed',
    },
  ])('omits query values for $path', async ({ install, path, message }) => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const server = createServer();
    install(server);
    const socket = new PassThrough();
    const req = {
      url: path + '?secret=must-not-be-logged',
      headers: {},
      socket,
    } as unknown as IncomingMessage;
    server.emit('upgrade', req, socket, Buffer.alloc(0));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ path }), message);
    expect(JSON.stringify(error.mock.calls)).not.toContain('must-not-be-logged');
    server.close();
    socket.destroy();
  });
});
