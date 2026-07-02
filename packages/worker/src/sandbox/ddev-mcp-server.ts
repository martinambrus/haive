/** Container path where the ddev-control MCP server file is bind-mounted, and the
 *  source of that file. The server is a dependency-free Node ESM script that speaks
 *  MCP over stdio (newline-delimited JSON-RPC) and proxies three tools —
 *  ddev_status / ddev_logs / ddev_restart — to the Haive API, which runs the matching
 *  `ddev` command in THIS task's isolated runner (docker access is worker-only). It
 *  holds NO docker access — only the API URL and a task-scoped token injected via env,
 *  so a task's agent can only inspect/recover its own DDEV. Clone of rag-mcp-server.ts. */
export const DDEV_MCP_SERVER_PATH = '/haive/haive-ddev-mcp.mjs';

export const DDEV_MCP_SERVER_JS = String.raw`#!/usr/bin/env node
// Haive DDEV-control MCP server (auto-generated, do not edit). Dependency-free stdio
// MCP proxy: exposes ddev_status / ddev_logs / ddev_restart, each forwarding to the
// Haive API, which runs the ddev command in this task's runner.
import { createInterface } from 'node:readline';

const API_URL = process.env.DDEV_API_URL || '';
const TOKEN = process.env.DDEV_TASK_TOKEN || '';
const PROTOCOL_VERSION = '2024-11-05';

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function result(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}
function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOLS = [
  {
    name: 'ddev_status',
    description:
      'Report whether THIS task\'s DDEV environment is running, plus its URLs and service health. Call this FIRST when the app returns 404/5xx, a blank page, or seems down — it tells an environment problem apart from a code bug.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ddev_logs',
    description:
      'Return recent DDEV logs for this task so you can see the real server-side error (PHP fatals, stack traces, web-server or DB errors) behind a failing page. Optional args: service ("web" default, or "db"), tail (max lines, default 200, max 2000).',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'DDEV service: "web" (default) or "db".' },
        tail: { type: 'integer', description: 'Max log lines to return (default 200, max 2000).' },
      },
    },
  },
  {
    name: 'ddev_restart',
    description:
      'Restart THIS task\'s DDEV environment: recovers a wedged or stopped runner and re-applies .ddev config. Use when ddev_status shows it down or the logs say it needs a restart, BEFORE assuming a code bug. Slow (up to ~15 min on a cold rebuild).',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callApi(action, body) {
  if (!API_URL || !TOKEN) {
    return { isError: true, text: 'ddev-control not configured (missing API URL or token).' };
  }
  let resp;
  try {
    resp = await fetch(API_URL.replace(/\/$/, '') + '/ddev/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(action === 'restart' ? 1200000 : 150000),
    });
  } catch (e) {
    return { isError: true, text: 'ddev_' + action + ' request failed: ' + (e?.message || String(e)) };
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return { isError: true, text: 'ddev_' + action + ' HTTP ' + resp.status + ': ' + t.slice(0, 400) };
  }
  const data = await resp.json().catch(() => ({}));
  return { isError: false, text: typeof data?.output === 'string' ? data.output : JSON.stringify(data) };
}

async function callTool(name, args) {
  if (name === 'ddev_status') return callApi('status', {});
  if (name === 'ddev_logs') {
    const body = {};
    if (typeof args?.service === 'string') body.service = args.service;
    if (Number.isInteger(args?.tail)) body.tail = args.tail;
    return callApi('logs', body);
  }
  if (name === 'ddev_restart') return callApi('restart', {});
  return { isError: true, text: 'Unknown tool: ' + name };
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'ddev-control', version: '1.0.0' },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    result(id, {});
    return;
  }
  if (method === 'tools/list') {
    result(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const r = await callTool(params?.name, params?.arguments || {});
    result(id, { content: [{ type: 'text', text: r.text }], isError: !!r.isError });
    return;
  }
  if (typeof id !== 'undefined') error(id, -32601, 'Method not found: ' + method);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  Promise.resolve(handle(msg)).catch((e) => {
    if (msg && typeof msg.id !== 'undefined') error(msg.id, -32603, 'Internal error: ' + (e?.message || String(e)));
  });
});
`;
