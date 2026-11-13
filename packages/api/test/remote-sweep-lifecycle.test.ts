import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), serve: vi.fn() }));
vi.mock('../src/bootstrap.js', () => ({
  bootstrap: async () => ({ apiPort: 0, webOrigin: 'http://localhost:3000' }),
}));
vi.mock('../src/lib/remote-reconcile.js', async (original) => ({
  ...(await original<typeof import('../src/lib/remote-reconcile.js')>()),
  startRemoteReconcileSweep: h.start,
}));
vi.mock('../src/modules/loader.js', () => ({ installModules: vi.fn() }));
vi.mock('@hono/node-server', () => ({ serve: h.serve }));
vi.mock('../src/routes/terminal.js', () => ({ installTerminalWebSocket: vi.fn() }));
vi.mock('../src/routes/terminal-shell.js', () => ({ installTerminalShellWebSocket: vi.fn() }));
vi.mock('../src/routes/cli-stream.js', () => ({ installCliStreamWebSocket: vi.fn() }));
vi.mock('../src/routes/cli-login-banner.js', () => ({ installCliLoginBannerWebSocket: vi.fn() }));
vi.mock('../src/routes/browser-vnc.js', () => ({ installBrowserVncWebSocket: vi.fn() }));
vi.mock('../src/routes/ide.js', async (original) => ({
  ...(await original<typeof import('../src/routes/ide.js')>()),
  installIdeWebSocket: vi.fn(),
}));
import * as entry from '../src/index.js';

it('starts the remote sweep at API boot and stops it when the server closes', async () => {
  const server = new EventEmitter();
  h.start.mockReturnValue(h.stop);
  h.serve.mockReturnValue(server);
  expect(entry).toHaveProperty('main');
  await entry.main();
  expect(h.start).toHaveBeenCalledOnce();
  expect(h.stop).not.toHaveBeenCalled();
  server.emit('close');
  expect(h.stop).toHaveBeenCalledOnce();
  server.emit('close');
  expect(h.stop).toHaveBeenCalledOnce();
});
