/** Where the haive-integrations MCP server script sits in the sandbox, and the token file it reads beside it. */
export const INTEGRATIONS_MCP_SERVER_PATH = '/haive/haive-integrations-mcp.mjs';
export const INTEGRATIONS_MCP_TOKEN_PATH = '/haive/haive-integrations.token';

export const INTEGRATIONS_MCP_SERVER_JS = String.raw`#!/usr/bin/env node
// Haive integrations MCP server (generated): a failure lists no tools or answers an error and never ends the process, since a server that fails to start discards the whole run.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const API_URL = process.env.INTEGRATIONS_MCP_API_URL || '';
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

const TOKEN = readBeside('haive-integrations.token').trim();

function post(path, body, timeoutMs) {
  return fetch(API_URL.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function failure(text) {
  return { isError: true, text: text.slice(0, 400) };
}

async function listTools() {
  if (!API_URL || !TOKEN) return [];
  try {
    const resp = await post('/integration-mcp/tools/list', {}, 5000);
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!Array.isArray(data?.tools)) return [];
    return data.tools
      .filter(
        (tool) =>
          typeof tool?.name === 'string' &&
          typeof tool?.description === 'string' &&
          typeof tool?.inputSchema === 'object' &&
          tool.inputSchema !== null,
      )
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  } catch {
    return [];
  }
}

async function callTool(name, args) {
  if (typeof name !== 'string' || !name) return failure('tools/call needs the name of a tool.');
  if (!API_URL || !TOKEN) return failure('integrations are not configured (missing API URL or token).');
  let resp;
  try {
    resp = await post('/integration-mcp/call', { tool: name, arguments: args || {} }, 45000);
  } catch (e) {
    return failure(name + ' request failed: ' + (e?.message || String(e)));
  }
  const text = await resp.text().catch(() => '');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (resp.ok && typeof data?.text === 'string') return { isError: false, text: data.text };
  return failure(name + ' HTTP ' + resp.status + ': ' + (typeof data?.error === 'string' ? data.error : text));
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'haive-integrations', version: '1.0.0' },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    result(id, {});
    return;
  }
  if (method === 'tools/list') {
    result(id, { tools: await listTools() });
    return;
  }
  if (method === 'tools/call') {
    const r = await callTool(params?.name, params?.arguments);
    result(id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
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
