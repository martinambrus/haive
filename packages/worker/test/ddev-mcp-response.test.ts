import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DDEV_MCP_SERVER_JS } from '../src/sandbox/ddev-mcp-server.js';

const token = randomBytes(32).toString('hex');
let relay: { status: number; body: unknown } = { status: 200, body: {} };
let requests: string[] = [];
let directory = '';
let script = '';
let url = '';
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url} ${req.headers.authorization}`);
  req.resume();
  res.statusCode = relay.status;
  res.setHeader('content-type', 'application/json');
  res.end(typeof relay.body === 'string' ? relay.body : JSON.stringify(relay.body));
});

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'haive-ddev-proxy-'));
  script = join(directory, 'haive-ddev-mcp.mjs');
  await writeFile(script, DDEV_MCP_SERVER_JS);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

async function call(tool: string, status: number, body: unknown) {
  relay = { status, body };
  requests = [];
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, DDEV_API_URL: url, DDEV_TASK_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const closed = once(child, 'close');
  child.stdin.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: {} },
    }) + '\n',
  );
  const [code] = await closed;
  expect(code, stderr).toBe(0);
  expect(requests).toEqual([`POST /ddev/${tool.replace('ddev_', '')} Bearer ${token}`]);
  const result = JSON.parse(stdout).result as {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
  };
  return { isError: result.isError, text: result.content[0]!.text };
}

const tools = ['ddev_status', 'ddev_logs', 'ddev_restart'];

describe('standalone ddev MCP response', () => {
  it.each(tools)('%s: ok:false with an error and no output shows the error', async (tool) => {
    await expect(
      call(tool, 200, { ok: false, output: '', error: 'Database operation failed' }),
    ).resolves.toEqual({ isError: true, text: 'Database operation failed' });
  });

  it.each(tools)('%s: ok:false with nothing else shows the fixed line', async (tool) => {
    await expect(call(tool, 200, { ok: false, output: '' })).resolves.toEqual({
      isError: true,
      text: `${tool} failed`,
    });
  });

  it.each(tools)('%s: ok:false with output and error shows both', async (tool) => {
    await expect(
      call(tool, 200, { ok: false, output: 'ddev tail', error: 'ddev restart failed (exit 1)' }),
    ).resolves.toEqual({ isError: true, text: 'ddev restart failed (exit 1)\nddev tail' });
  });

  it.each(tools)(
    '%s: ok:false with output but no error leads with the fixed line',
    async (tool) => {
      await expect(call(tool, 200, { ok: false, output: 'ddev tail' })).resolves.toEqual({
        isError: true,
        text: `${tool} failed\nddev tail`,
      });
    },
  );

  it('shows a refusal once when output equals error', async () => {
    const message = 'The checkout is not available right now.';
    await expect(
      call('ddev_restart', 200, { ok: false, output: message, error: message }),
    ).resolves.toEqual({ isError: true, text: message });
  });

  it.each(tools)('%s: ok:true is unchanged, empty output stays empty', async (tool) => {
    await expect(call(tool, 200, { ok: true, output: 'fine' })).resolves.toEqual({
      isError: false,
      text: 'fine',
    });
    await expect(call(tool, 200, { ok: true, output: '' })).resolves.toEqual({
      isError: false,
      text: '',
    });
  });

  it('a body without ok (older relay) is unchanged', async () => {
    await expect(call('ddev_status', 200, { output: 'legacy' })).resolves.toEqual({
      isError: false,
      text: 'legacy',
    });
  });

  it('a non-2xx status is unchanged', async () => {
    const result = await call('ddev_restart', 500, 'upstream broke');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^ddev_restart HTTP 500/);
  });
});
