import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DDEV_MCP_SERVER_JS, DDEV_RELAY_RESULT_JS } from '../src/sandbox/ddev-mcp-server.js';

type ToolResult = { isError: boolean; text: string };

// The variants are unit tests of the one definition the script ships: its source text, evaluated here.
// Only what needs the real transport (a child that really posts and exits) runs a child. The script
// is an ES module, so its code is strict: the source is evaluated the same way.
const relayResult = new Function(
  `'use strict';\n${DDEV_RELAY_RESULT_JS}\nreturn relayResult;`,
)() as (action: string, data: unknown) => ToolResult;

const actions = ['status', 'logs', 'restart'];

describe('relayResult, the answer the agent is shown', () => {
  it('is the source the standalone script embeds, once', () => {
    expect(DDEV_MCP_SERVER_JS.split(DDEV_RELAY_RESULT_JS)).toHaveLength(2);
  });

  it.each(actions)('%s: ok:false with an error and no output shows the error', (action) => {
    expect(
      relayResult(action, { ok: false, output: '', error: 'Database operation failed' }),
    ).toEqual({ isError: true, text: 'Database operation failed' });
  });

  it.each(actions)('%s: ok:false with nothing else shows the fixed line', (action) => {
    expect(relayResult(action, { ok: false, output: '' })).toEqual({
      isError: true,
      text: `ddev_${action} failed`,
    });
  });

  it.each(actions)('%s: ok:false with output and error shows both', (action) => {
    expect(
      relayResult(action, {
        ok: false,
        output: 'ddev tail',
        error: 'ddev restart failed (exit 1)',
      }),
    ).toEqual({ isError: true, text: 'ddev restart failed (exit 1)\nddev tail' });
  });

  it.each(actions)('%s: ok:false with output but no error leads with the fixed line', (action) => {
    expect(relayResult(action, { ok: false, output: 'ddev tail' })).toEqual({
      isError: true,
      text: `ddev_${action} failed\nddev tail`,
    });
  });

  it('shows a refusal once when output equals error', () => {
    const message = 'The checkout is not available right now.';
    expect(relayResult('restart', { ok: false, output: message, error: message })).toEqual({
      isError: true,
      text: message,
    });
  });

  it.each(actions)('%s: ok:true is unchanged, empty output stays empty', (action) => {
    expect(relayResult(action, { ok: true, output: 'fine' })).toEqual({
      isError: false,
      text: 'fine',
    });
    expect(relayResult(action, { ok: true, output: '' })).toEqual({ isError: false, text: '' });
  });

  it('shows the body itself when it holds no output string', () => {
    expect(relayResult('status', { ok: true })).toEqual({
      isError: false,
      text: JSON.stringify({ ok: true }),
    });
  });

  it('a body without ok (older relay) is unchanged', () => {
    expect(relayResult('status', { output: 'legacy' })).toEqual({ isError: false, text: 'legacy' });
  });
});

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

/** One real child answers every named tool, so each tool's route is proven by a single launch. */
async function callTools(tools: string[], status: number, body: unknown): Promise<ToolResult[]> {
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
    tools
      .map((name, index) =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: index + 1,
          method: 'tools/call',
          params: { name, arguments: {} },
        }),
      )
      .join('\n') + '\n',
  );
  const [code] = await closed;
  expect(code, stderr).toBe(0);
  expect([...requests].sort()).toEqual(
    tools.map((name) => `POST /ddev/${name.replace('ddev_', '')} Bearer ${token}`).sort(),
  );
  const answers = new Map(
    stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: number; result: unknown })
      .map((message) => [message.id, message.result]),
  );
  return tools.map((_, index) => {
    const result = answers.get(index + 1) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    return { isError: result.isError, text: result.content[0]!.text };
  });
}

describe('standalone ddev MCP over a real child', () => {
  it('shows a relay failure to the agent as an error, for every tool', async () => {
    const tools = ['ddev_status', 'ddev_logs', 'ddev_restart'];
    await expect(
      callTools(tools, 200, {
        ok: false,
        output: 'ddev tail',
        error: 'ddev restart failed (exit 1)',
      }),
    ).resolves.toEqual(
      tools.map(() => ({ isError: true, text: 'ddev restart failed (exit 1)\nddev tail' })),
    );
  });

  it('a non-2xx status is unchanged', async () => {
    const [result] = await callTools(['ddev_restart'], 500, 'upstream broke');
    expect(result!.isError).toBe(true);
    expect(result!.text).toMatch(/^ddev_restart HTTP 500/);
  });
});
