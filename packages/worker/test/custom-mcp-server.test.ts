import { afterEach, describe, expect, it } from 'vitest';
import {
  CUSTOM_MCP_SERVER_JS,
  CUSTOM_MCP_SERVER_PATH,
  CUSTOM_MCP_TOKEN_PATH,
  CUSTOM_MCP_TOOLS_PATH,
} from '../src/sandbox/custom-mcp-server.js';
import { api, content, runCleanups, start } from './support/custom-mcp-process.js';

const TOOLS = [
  {
    name: 'repo_status',
    description: 'Fetches the status of one repository.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Repository slug.' } },
      required: ['repo'],
    },
  },
];

afterEach(runCleanups);

describe('the haive-custom MCP server script', () => {
  it('lives in the same directory as the two files it reads', () => {
    expect(CUSTOM_MCP_SERVER_PATH).toBe('/haive/haive-custom-mcp.mjs');
    expect(CUSTOM_MCP_TOOLS_PATH).toBe('/haive/haive-custom.tools.json');
    expect(CUSTOM_MCP_TOKEN_PATH).toBe('/haive/haive-custom.token');
  });

  it('answers initialize and lists the tools of its file as name, description and inputSchema', async () => {
    const { ask } = await start({ tools: JSON.stringify(TOOLS), token: 'tok' });
    const init = await ask('initialize', { protocolVersion: '2024-11-05' });
    expect(init.result).toMatchObject({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'haive-custom' },
    });
    expect((await ask('tools/list')).result).toEqual({ tools: TOOLS });
  });

  it('keeps only the three fields of each tool a client is told', async () => {
    const extra = [{ ...TOOLS[0], url: 'https://api.example.com/secret', maxResponseBytes: 5 }];
    const { ask } = await start({ tools: JSON.stringify(extra), token: 'tok' });
    expect((await ask('tools/list')).result).toEqual({ tools: TOOLS });
  });

  it.each([
    ['is missing', undefined],
    ['is empty', ''],
    ['is not JSON', '{"tools": ['],
    ['is JSON of the wrong shape', '{"tools": []}'],
    ['holds an array of junk', '[1, null, "repo_status", {"description": "no name"}]'],
  ])('lists no tools and still answers when its tools file %s', async (_label, tools) => {
    const { child, ask } = await start({ tools, token: 'tok' });
    expect((await ask('initialize')).result).toMatchObject({
      serverInfo: { name: 'haive-custom' },
    });
    expect((await ask('tools/list')).result).toEqual({ tools: [] });
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  });

  it('answers a call with an error, and stays alive, when its token file is missing', async () => {
    const server = await api(() => ({ status: 200, body: '{"ok":true,"text":"x"}' }));
    const { child, ask } = await start({ tools: JSON.stringify(TOOLS), apiUrl: server.url });
    const reply = await ask('tools/call', { name: 'repo_status', arguments: { repo: 'haive' } });
    expect(reply.result?.isError).toBe(true);
    expect(content(reply)).toMatch(/token/i);
    expect(server.seen).toEqual([]);
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  });

  it('answers a call with an error when it has no API address', async () => {
    const { ask } = await start({ tools: JSON.stringify(TOOLS), token: 'tok' });
    const reply = await ask('tools/call', { name: 'repo_status', arguments: {} });
    expect(reply.result?.isError).toBe(true);
  });

  it('posts a call to /custom-mcp/call with the token of its file and {tool, arguments}', async () => {
    const server = await api(() => ({
      status: 200,
      body: '{"ok":true,"text":"HTTP 200 text/plain"}',
    }));
    const { ask } = await start({
      tools: JSON.stringify(TOOLS),
      token: 'file-token\n',
      apiUrl: `${server.url}/`,
    });
    const reply = await ask('tools/call', { name: 'repo_status', arguments: { repo: 'haive' } });
    expect(server.seen).toEqual([
      {
        method: 'POST',
        url: '/custom-mcp/call',
        authorization: 'Bearer file-token',
        body: { tool: 'repo_status', arguments: { repo: 'haive' } },
      },
    ]);
    expect(reply.result).toEqual({
      content: [{ type: 'text', text: 'HTTP 200 text/plain' }],
      isError: false,
    });
  });

  it('sends empty arguments as an object when the call carries none', async () => {
    const server = await api(() => ({ status: 200, body: '{"ok":true,"text":"ok"}' }));
    const { ask } = await start({ tools: JSON.stringify(TOOLS), token: 't', apiUrl: server.url });
    await ask('tools/call', { name: 'repo_status' });
    expect(server.seen[0]!.body).toEqual({ tool: 'repo_status', arguments: {} });
  });

  it('refuses a tool that is not in its file without calling the API', async () => {
    const server = await api(() => ({ status: 200, body: '{"ok":true,"text":"x"}' }));
    const { ask } = await start({ tools: JSON.stringify(TOOLS), token: 't', apiUrl: server.url });
    const reply = await ask('tools/call', { name: 'rag_search', arguments: { query: 'x' } });
    expect(reply.result?.isError).toBe(true);
    expect(content(reply)).toContain('rag_search');
    expect(server.seen).toEqual([]);
  });

  it('turns a non-2xx answer into an error of at most 400 characters', async () => {
    const server = await api(() => ({ status: 500, body: 'e'.repeat(5000) }));
    const { ask } = await start({ tools: JSON.stringify(TOOLS), token: 't', apiUrl: server.url });
    const reply = await ask('tools/call', { name: 'repo_status', arguments: { repo: 'haive' } });
    expect(reply.result?.isError).toBe(true);
    expect(content(reply)).toContain('HTTP 500');
    expect(content(reply).length).toBeLessThanOrEqual(400);
  });

  it('carries the message the API gave for a refusal', async () => {
    const body = '{"error":"this step does not declare that tool","code":"undeclared-tool"}';
    const server = await api(() => ({ status: 403, body }));
    const { ask } = await start({ tools: JSON.stringify(TOOLS), token: 't', apiUrl: server.url });
    const reply = await ask('tools/call', { name: 'repo_status', arguments: { repo: 'haive' } });
    expect(reply.result?.isError).toBe(true);
    expect(content(reply)).toContain('does not declare that tool');
  });

  it('turns a network error into an error of at most 400 characters, and stays alive', async () => {
    const closed = await api(() => ({ status: 200, body: '{}' }));
    await closed.close();
    const { child, ask } = await start({
      tools: JSON.stringify(TOOLS),
      token: 't',
      apiUrl: closed.url,
    });
    const reply = await ask('tools/call', { name: 'repo_status', arguments: { repo: 'haive' } });
    expect(reply.result?.isError).toBe(true);
    expect(content(reply).length).toBeLessThanOrEqual(400);
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  });

  it('gives a fetch 45 seconds, and ends one that outlasts that with an error', async () => {
    expect(CUSTOM_MCP_SERVER_JS).toContain('AbortSignal.timeout(45000)');
    const script = CUSTOM_MCP_SERVER_JS.replace(
      'AbortSignal.timeout(45000)',
      'AbortSignal.timeout(150)',
    );
    expect(script).not.toBe(CUSTOM_MCP_SERVER_JS);
    const silent = await api(() => ({ status: 200, body: '' }), { never: true });
    const { child, ask } = await start({
      script,
      tools: JSON.stringify(TOOLS),
      token: 't',
      apiUrl: silent.url,
    });
    const reply = await ask('tools/call', { name: 'repo_status', arguments: { repo: 'haive' } });
    expect(reply.result?.isError).toBe(true);
    expect(content(reply)).toContain('request failed');
    expect(content(reply).length).toBeLessThanOrEqual(400);
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  });

  it('answers a method it does not know with a JSON-RPC error, and ignores a notification', async () => {
    const { child, ask } = await start({ tools: JSON.stringify(TOOLS), token: 't' });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const reply = await ask('resources/list');
    expect(reply.error?.code).toBe(-32601);
    expect((await ask('ping')).result).toEqual({});
  });
});
