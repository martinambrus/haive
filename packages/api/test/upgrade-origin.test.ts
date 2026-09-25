import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTerminalWebSocket } from '../src/routes/terminal.js';
import { installTerminalShellWebSocket } from '../src/routes/terminal-shell.js';
import { installCliStreamWebSocket } from '../src/routes/cli-stream.js';
import { installCliLoginBannerWebSocket } from '../src/routes/cli-login-banner.js';
import { installBrowserVncWebSocket } from '../src/routes/browser-vnc.js';
import { installIdeWebSocket } from '../src/routes/ide.js';

const ID = '11111111-2222-3333-4444-555555555555';

const HANDLERS: Array<{ file: string; install: (s: Server) => void; path: string }> = [
  { file: 'routes/terminal.ts', install: installTerminalWebSocket, path: '/terminal/abc123' },
  {
    file: 'routes/terminal-shell.ts',
    install: installTerminalShellWebSocket,
    path: `/terminal-shell/${ID}/${ID}`,
  },
  { file: 'routes/cli-stream.ts', install: installCliStreamWebSocket, path: `/cli-stream/${ID}` },
  {
    file: 'routes/cli-login-banner.ts',
    install: installCliLoginBannerWebSocket,
    path: `/cli-login-banner/${ID}`,
  },
  {
    file: 'routes/browser-vnc.ts',
    install: installBrowserVncWebSocket,
    path: `/browser-vnc/${ID}`,
  },
  { file: 'routes/ide.ts', install: installIdeWebSocket, path: `/ide/${ID}/` },
];

let server: Server | null = null;

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function listen(install: (s: Server) => void): Promise<number> {
  server = createServer();
  install(server);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** The status line a raw WebSocket handshake gets back. */
function handshake(
  port: number,
  path: string,
  origin?: string,
  host = `127.0.0.1:${port}`,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ];
      if (origin) lines.push(`Origin: ${origin}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.on('data', (chunk) => (data += chunk.toString()));
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
    socket.on('error', reject);
  });
}

describe('a WebSocket handshake', () => {
  for (const h of HANDLERS) {
    it(`from another page is refused before auth (${h.file})`, async () => {
      const port = await listen(h.install);
      expect(await handshake(port, h.path, 'http://localhost:5173')).toBe('HTTP/1.1 403 Forbidden');
      expect(await handshake(port, h.path, 'null')).toBe('HTTP/1.1 403 Forbidden');
    });

    it(`from the app, the api itself or no page reaches auth (${h.file})`, async () => {
      const port = await listen(h.install);
      for (const origin of ['http://localhost:3000', `http://127.0.0.1:${port}`, undefined]) {
        expect(await handshake(port, h.path, origin)).toBe('HTTP/1.1 401 Unauthorized');
      }
    });

    it(`from the api's public origin behind a proxy that rewrites Host reaches auth (${h.file})`, async () => {
      vi.stubEnv('HAIVE_PUBLIC_API_URL', 'https://api.example.com');
      const port = await listen(h.install);
      expect(await handshake(port, h.path, 'https://api.example.com', 'api:3001')).toBe(
        'HTTP/1.1 401 Unauthorized',
      );
    });
  }

  it('is listened for only by the handlers above', () => {
    const src = join(__dirname, '../src');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const listening = walk(src)
      .filter((f) => f.endsWith('.ts') && readFileSync(f, 'utf8').includes("on('upgrade'"))
      .map((f) => relative(src, f))
      .sort();
    expect(listening).toEqual(HANDLERS.map((h) => h.file).sort());
  });
});
