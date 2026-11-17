import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { COMPOSED_LSP_PROBE } from '../src/lsp/composed-probe.js';
import { buildLspLayer } from '../src/sandbox/lsp-layer.js';

function initialize(
  response: unknown,
  mode: 'response' | 'exit' | 'timeout' = 'response',
  server = 'gopls',
  env: Record<string, string> = {},
) {
  const stdout = new EventEmitter(),
    stderr = new EventEmitter(),
    stdin = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn() });
  const messages: unknown[] = [];
  const log = vi.fn((line: string) => messages.push(JSON.parse(line)));
  let deadline: () => void = () => {};
  let request: Record<string, unknown> | null = null;
  Object.assign(stdin, {
    write: (chunk: Buffer | string) => {
      if (String(chunk).startsWith('Content-Length:')) return;
      request = JSON.parse(String(chunk));
      if (mode === 'exit') {
        child.emit('exit', 0);
        return;
      }
      if (mode === 'timeout') {
        deadline();
        return;
      }
      const body = Buffer.from(JSON.stringify(response));
      const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
      // Boundaries can split the header and the UTF-8 JSON body.
      stdout.emit('data', frame.subarray(0, 8));
      stdout.emit('data', frame.subarray(8, 25));
      stdout.emit('data', frame.subarray(25));
    },
  });
  const spawn = vi.fn((_command: string) => child);
  const execFileSync = vi.fn((command: string, args: string[]) => {
    if (command === 'npm' && args[0] === 'root') {
      const prefixIndex = args.indexOf('--prefix');
      const prefix =
        prefixIndex >= 0 ? args[prefixIndex + 1]! : (env.NPM_CONFIG_PREFIX ?? '/usr/local');
      return path.join(prefix, 'lib/node_modules');
    }
    return command === 'node' ? 'v22.0.0' : 'gopls v0.18.0';
  });
  const readFileSync = vi.fn((file: string) =>
    JSON.stringify({
      version: file.startsWith('/usr/local/lib/node_modules/') ? '1.2.3' : '0.0.0-other-prefix',
    }),
  );
  runInNewContext(COMPOSED_LSP_PROBE, {
    require: (name: string) =>
      name === 'node:child_process'
        ? { spawn, execFileSync }
        : name === 'node:fs'
          ? { mkdirSync: vi.fn(), readFileSync }
          : path,
    Buffer,
    process: { argv: ['node', server], env, exit: vi.fn() },
    console: { log },
    setTimeout: (fn: () => void) => {
      deadline = fn;
      return 1;
    },
    clearTimeout: vi.fn(),
  });
  return { messages, spawn, child, request, readFileSync };
}
describe('composed image protocol probe with process and clock seams', () => {
  it.each([
    ['intelephense', 'intelephense'],
    ['vtsls', '@vtsls/language-server'],
    ['pyright', 'pyright'],
  ])(
    'reads %s from the recipe prefix despite an image npm prefix override',
    (server, packageName) => {
      const result = initialize(
        { jsonrpc: '2.0', id: 1, result: { capabilities: {} } },
        'response',
        server,
        { NPM_CONFIG_PREFIX: '/opt/npm' },
      );
      expect(buildLspLayer([server])).toContain(
        `npm install -g --prefix /usr/local ${packageName}`,
      );
      expect(result.messages).toEqual([
        expect.objectContaining({
          server,
          passed: true,
          skipped: false,
          installedVersion: '1.2.3',
        }),
      ]);
      expect(result.readFileSync).toHaveBeenCalledWith(
        `/usr/local/lib/node_modules/${packageName}/package.json`,
        'utf8',
      );
    },
  );
  it('requires a framed initialize response, not an installed launcher alone', () => {
    const result = initialize({
      jsonrpc: '2.0',
      id: 1,
      result: { capabilities: {}, serverInfo: { name: 'stub é' } },
    });
    expect(result.request).toMatchObject({ method: 'initialize', id: 1 });
    expect(result.spawn.mock.calls[0]?.[0]).toBe('/usr/local/bin/gopls');
    expect(result.messages).toEqual([
      expect.objectContaining({
        server: 'gopls',
        passed: true,
        skipped: false,
        installedVersion: 'gopls v0.18.0',
      }),
    ]);
    expect(result.child.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it.each([
    { jsonrpc: '2.0', id: 1, result: {} },
    { jsonrpc: '2.0', id: 1, result: { capabilities: null } },
    { jsonrpc: '2.0', id: 1, error: { code: -32603 } },
    { jsonrpc: '1.0', id: 1, result: { capabilities: {} } },
  ])('refuses an incomplete/error response %j', (response) => {
    expect(initialize(response).messages).toEqual([expect.objectContaining({ passed: false })]);
  });
  it.each(['exit', 'timeout'] as const)(
    'cannot pass a successful launcher %s without initialize',
    (mode) => {
      expect(initialize(null, mode).messages).toEqual([expect.objectContaining({ passed: false })]);
    },
  );
});
