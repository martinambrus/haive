/** Where the haive-custom MCP server script sits in the sandbox, and the two files it reads beside it. */
export const CUSTOM_MCP_SERVER_PATH = '/haive/haive-custom-mcp.mjs';
export const CUSTOM_MCP_TOOLS_PATH = '/haive/haive-custom.tools.json';
export const CUSTOM_MCP_TOKEN_PATH = '/haive/haive-custom.token';

export const CUSTOM_MCP_SERVER_JS = String.raw`#!/usr/bin/env node
// Haive custom-tools MCP server (generated): a missing or garbled file lists no tools and never ends the process, since a server that fails to start discards the whole run.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const API_URL = process.env.CUSTOM_MCP_API_URL || '';
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

function readBeside(name) {
  try {
    return readFileSync(new URL(name, import.meta.url), 'utf8');
  } catch {
    return '';
  }
}

function loadTools() {
  try {
    const parsed = JSON.parse(readBeside('haive-custom.tools.json'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((tool) => typeof tool?.name === 'string' && typeof tool?.inputSchema === 'object' && tool.inputSchema !== null)
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  } catch {
    return [];
  }
}

const TOOLS = loadTools();
const TOKEN = readBeside('haive-custom.token').trim();

function failure(text) {
  return { isError: true, text: text.slice(0, 400) };
}

async function callApi(name, args) {
  if (!TOOLS.some((tool) => tool.name === name)) return failure('Unknown tool: ' + name);
  if (!API_URL || !TOKEN) return failure('custom tools are not configured (missing API URL or token).');
  let resp;
  try {
    resp = await fetch(API_URL.replace(/\/$/, '') + '/custom-mcp/call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify({ tool: name, arguments: args || {} }),
      signal: AbortSignal.timeout(45000),
    });
  } catch (e) {
    return failure(name + ' request failed: ' + (e?.message || String(e)));
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return failure(name + ' HTTP ' + resp.status + ': ' + t);
  }
  const data = await resp.json().catch(() => ({}));
  return { isError: false, text: typeof data?.text === 'string' ? data.text : JSON.stringify(data) };
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'haive-custom', version: '1.0.0' },
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
    const r = await callApi(params?.name, params?.arguments || {});
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
