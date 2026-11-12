import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTerminalWebSocket } from '../src/routes/terminal.js';
import { installTerminalShellWebSocket } from '../src/routes/terminal-shell.js';
import { installCliStreamWebSocket } from '../src/routes/cli-stream.js';
import { installCliLoginBannerWebSocket } from '../src/routes/cli-login-banner.js';
import { installBrowserVncWebSocket } from '../src/routes/browser-vnc.js';
import { installIdeWebSocket } from '../src/routes/ide.js';
import { upgradeListenerFiles } from './helpers/upgrade-listeners.js';

const ID = '11111111-2222-3333-4444-555555555555';

const HANDLERS: Array<{ file: string; install: (s: Server) => void; path: string }> = [
  { file: 'routes/terminal.ts', install: installTerminalWebSocket, path: `/terminal/${ID}` },
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
  for (const h of [
    ...HANDLERS,
    { file: 'repository editor', install: installIdeWebSocket, path: `/ide/repos/${ID}/` },
  ]) {
    it(`from another page is refused before auth (${h.file})`, async () => {
      const port = await listen(h.install);
      expect(await handshake(port, h.path, 'http://localhost:5173')).toBe('HTTP/1.1 403 Forbidden');
      expect(await handshake(port, h.path, 'null')).toBe('HTTP/1.1 403 Forbidden');
    });

    it(`from the app or no page reaches auth (${h.file})`, async () => {
      const port = await listen(h.install);
      for (const origin of ['http://localhost:3000', undefined]) {
        expect(await handshake(port, h.path, origin)).toBe('HTTP/1.1 401 Unauthorized');
      }
    });

    it(`from the editor public origin is refused except for ide (${h.file})`, async () => {
      vi.stubEnv('HAIVE_PUBLIC_API_URL', 'https://api.example.com');
      const port = await listen(h.install);
      expect(await handshake(port, h.path, 'https://api.example.com', 'api:3001')).toBe(
        h.file.includes('ide') || h.file === 'repository editor'
          ? 'HTTP/1.1 401 Unauthorized'
          : 'HTTP/1.1 403 Forbidden',
      );
    });

    it(`from the editor with a matching Host is refused except for ide (${h.file})`, async () => {
      vi.stubEnv('HAIVE_PUBLIC_API_URL', '');
      vi.stubEnv('HAIVE_API_PORT', '3001');
      const port = await listen(h.install);
      expect(await handshake(port, h.path, 'http://localhost:3001', 'localhost:3001')).toBe(
        h.file.includes('ide') || h.file === 'repository editor'
          ? 'HTTP/1.1 401 Unauthorized'
          : 'HTTP/1.1 403 Forbidden',
      );
    });

    it(`from the request host without public configuration is refused except for ide (${h.file})`, async () => {
      vi.stubEnv('HAIVE_PUBLIC_API_URL', '');
      vi.stubEnv('HAIVE_API_PORT', '');
      const port = await listen(h.install);
      expect(await handshake(port, h.path, `http://127.0.0.1:${port}`)).toBe(
        h.file.includes('ide') || h.file === 'repository editor'
          ? 'HTTP/1.1 401 Unauthorized'
          : 'HTTP/1.1 403 Forbidden',
      );
    });

    it(`preserves web and foreign origins through a different-host proxy (${h.file})`, async () => {
      vi.stubEnv('WEB_ORIGIN', 'https://web.example.com');
      vi.stubEnv('HAIVE_PUBLIC_API_URL', 'https://api.example.com');
      const port = await listen(h.install);
      expect(await handshake(port, h.path, 'https://web.example.com', 'api:3001')).toBe(
        'HTTP/1.1 401 Unauthorized',
      );
      expect(await handshake(port, h.path, 'https://foreign.example.com', 'api:3001')).toBe(
        'HTTP/1.1 403 Forbidden',
      );
    });
  }

  it('is listened for only by the handlers above', () => {
    const listening = upgradeListenerFiles();
    expect(listening).toEqual(HANDLERS.map((h) => h.file).sort());
  });
});
