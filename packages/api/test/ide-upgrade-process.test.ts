import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { describe, expect, it } from 'vitest';

// Run the production bridge in a disposable process: an uncaught connect-listener
// exception must fail this test rather than take down the test runner itself.
const source = readFileSync(new URL('../src/routes/ide.ts', import.meta.url), 'utf8');
const cookieSource = readFileSync(new URL('../src/auth/cookies.ts', import.meta.url), 'utf8');
const functions = stripTypeScriptTypes(
  cookieSource.slice(
    cookieSource.indexOf('export function withoutSessionCookies'),
    cookieSource.indexOf('export function isSessionSetCookie'),
  ) +
    source.slice(
      source.indexOf('function upstreamRequestHeaders'),
      source.indexOf('// ---- HTTP reverse proxy'),
    ) +
    source.slice(
      source.indexOf('const MAX_UPGRADE_RESPONSE_HEAD'),
      source.indexOf('// ---- IDE session registry'),
    ),
);

function runBridge(connection: string, brokenHeader = false) {
  return spawnSync(process.execPath, ['--input-type=module'], {
    encoding: 'utf8',
    timeout: 10_000,
    input: `
import net from 'node:net';
import { parse } from 'hono/utils/cookie';
import { createServer } from 'node:http';
const SESSION_COOKIES = new Set(['haive_access', 'haive_refresh']);
const log = { info() {}, warn() {} };
const acquireIdeSession = async () => {};
const releaseIdeSession = async () => {};
const isSessionSetCookie = () => false;
const ideRunnerName = () => '127.0.0.1';
const session = { revoked: false, onRevoke() {}, acceptRaw: () => true };
const upstream = net.createServer(socket => {
  let data = '';
  socket.on('data', chunk => {
    data += chunk.toString('latin1');
    if (data.includes('\\r\\n\\r\\n')) {
      process.stdout.write(JSON.stringify({ head: data }) + '\\n');
      socket.end('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n');
    }
  });
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const IDE_INTERNAL_PORT = upstream.address().port;
${functions}
const server = createServer((req, res) => res.end('alive'));
server.on('upgrade', (req, socket, head) => {
  ${brokenHeader ? "req.headers['x-broken'] = '\\u0100';" : ''}
  proxyWsUpgrade(req, socket, head, { sessionId: 'test', prefix: '/ide/test' }, session);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve, reject) => {
  const client = net.connect(port, '127.0.0.1', () => client.write([
    'GET /ide/test/socket HTTP/1.1', 'Host: localhost',
    ${JSON.stringify(`Connection: ${connection}`)}, 'Upgrade: websocket',
    'Sec-WebSocket-Key: key', 'Cookie: haive_access=secret; app=ok', '', ''
  ].join('\\r\\n')));
  client.on('data', () => {});
  client.on('end', resolve);
  client.on('error', reject);
});
const response = await fetch('http://127.0.0.1:' + port);
process.stdout.write(JSON.stringify({ health: await response.text() }) + '\\n');
server.closeAllConnections();
await Promise.all([new Promise(r => server.close(r)), new Promise(r => upstream.close(r))]);
`,
  });
}

describe('IDE upgrade process survival', () => {
  it.each(['Upgrade', 'Upgrade, a b', 'Upgrade, x/y', 'Upgrade, "q"'])(
    'replays %s and continues serving HTTP',
    (connection) => {
      const result = runBridge(connection);
      expect(result.status, result.stderr).toBe(0);
      expect(result.signal).toBeNull();
      const [replayed, health] = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(replayed.head).toContain('GET /socket HTTP/1.1\r\n');
      expect(replayed.head).toContain('connection: Upgrade\r\n');
      expect(replayed.head).toContain('cookie: app=ok\r\n');
      expect(replayed.head).not.toContain('secret');
      expect(health).toEqual({ health: 'alive' });
    },
  );

  it('closes only the bridge when building its request head throws', () => {
    const result = runBridge('Upgrade', true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('{"health":"alive"}');
  });
});
