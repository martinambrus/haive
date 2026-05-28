/** Container path where the haive-rag MCP server file is bind-mounted, and the
 *  source of that file. The server is a dependency-free Node ESM script that
 *  speaks MCP over stdio (newline-delimited JSON-RPC) and proxies the single
 *  `rag_search` tool to the Haive API. It holds NO database credentials — only
 *  the API URL and a task-scoped token injected via env. This keeps DB access
 *  and embedding server-side and works for internal/external/ddev rag DBs
 *  uniformly. */
export const RAG_MCP_SERVER_PATH = '/haive/haive-rag-mcp.mjs';

export const RAG_MCP_SERVER_JS = String.raw`#!/usr/bin/env node
// Haive RAG MCP server (auto-generated, do not edit). Dependency-free stdio
// MCP proxy: exposes one tool, rag_search, forwarding to the Haive API.
import { createInterface } from 'node:readline';

const API_URL = process.env.RAG_API_URL || '';
const TOKEN = process.env.RAG_TASK_TOKEN || '';
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

const TOOL = {
  name: 'rag_search',
  description:
    'Semantic + lexical (hybrid) search over this project\'s indexed code and knowledge base. Use this FIRST when looking for where something is implemented, defined, or configured, before grep. Returns ranked code/KB snippets with source paths.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language or code-keyword query.' },
      top_k: { type: 'integer', description: 'Max results to return (default 8, max 50).' },
    },
    required: ['query'],
  },
};

async function ragSearch(args) {
  if (!API_URL || !TOKEN) {
    return { isError: true, text: 'haive-rag not configured (missing API URL or token).' };
  }
  const query = typeof args?.query === 'string' ? args.query : '';
  if (!query.trim()) return { isError: true, text: 'query is required.' };
  const body = { query };
  if (Number.isInteger(args?.top_k)) body.top_k = args.top_k;
  let resp;
  try {
    resp = await fetch(API_URL.replace(/\/$/, '') + '/rag/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    return { isError: true, text: 'rag_search request failed: ' + (e?.message || String(e)) };
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return { isError: true, text: 'rag_search HTTP ' + resp.status + ': ' + t.slice(0, 300) };
  }
  const data = await resp.json().catch(() => ({}));
  const hits = Array.isArray(data?.hits) ? data.hits : [];
  if (hits.length === 0) {
    return { isError: false, text: 'No RAG results. Fall through to KB/LSP/GREP.' };
  }
  const lines = hits.map((h, i) => {
    const loc = h.sourcePath + (h.sectionId ? ' #' + h.sectionId : '');
    const score = typeof h.rrf === 'number' ? h.rrf.toFixed(4) : '?';
    return (
      '### ' + (i + 1) + '. ' + loc + '  (rrf=' + score + ', dense=' +
      (typeof h.denseSim === 'number' ? h.denseSim.toFixed(3) : '?') + ')\n' +
      (h.content || '')
    );
  });
  return { isError: false, text: lines.join('\n\n---\n\n') };
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'haive-rag', version: '1.0.0' },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    result(id, {});
    return;
  }
  if (method === 'tools/list') {
    result(id, { tools: [TOOL] });
    return;
  }
  if (method === 'tools/call') {
    if (params?.name !== 'rag_search') {
      error(id, -32602, 'Unknown tool: ' + params?.name);
      return;
    }
    const r = await ragSearch(params?.arguments || {});
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
