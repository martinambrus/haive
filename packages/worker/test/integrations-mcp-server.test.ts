import { afterEach, describe, expect, it } from 'vitest';
import {
  API_URL_ENV,
  SERVER_NAME,
  SERVER_PATH,
  TOKEN_PATH,
  integrationsServerModule,
} from './support/integrations-contract.js';
import { broker, content, listed, runCleanups, start } from './support/integrations-mcp-process.js';

const TOKEN = 'integrations-token-of-the-stub-run';
const LIST_URL = '/integration-mcp/tools/list';
const CALL_URL = '/integration-mcp/call';

const TOOLS = [
  {
    name: 'get_pull_request_state',
    description: 'Reads the state of one pull request.',
    inputSchema: {
      type: 'object',
      properties: { prNumber: { type: 'integer', minimum: 1 } },
      required: ['prNumber'],
    },
  },
  {
    name: 'open_pull_request',
    description: 'Opens a pull request.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', minLength: 1 } },
      required: ['title'],
    },
  },
];

const tools = (list: unknown[] = TOOLS) => ({ status: 200, body: JSON.stringify({ tools: list }) });

afterEach(runCleanups);

describe('the haive-integrations MCP server script, spawned as the sandbox spawns it', () => {
  it('[W5] exports the sandbox paths of the script and of the token file it reads', async () => {
    const mod = await integrationsServerModule();
    expect(mod.INTEGRATIONS_MCP_SERVER_PATH).toBe(SERVER_PATH);
    expect(mod.INTEGRATIONS_MCP_TOKEN_PATH).toBe(TOKEN_PATH);
    expect(typeof mod.INTEGRATIONS_MCP_SERVER_JS).toBe('string');
    expect(mod.INTEGRATIONS_MCP_SERVER_JS.length).toBeGreaterThan(0);
  });

  it('[W5+] answers initialize with the tools capability and its own name', async () => {
    const { ask } = await start();
    const init = await ask('initialize', { protocolVersion: '2024-11-05' });
    expect(init.error).toBeUndefined();
    expect(init.result).toMatchObject({
      protocolVersion: expect.any(String),
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME },
    });
  });

  it('[W5] answers initialize at once and makes no request, though its broker would never answer', async () => {
    const silent = await broker(() => ({ hang: true }));
    const { ask } = await start({ token: TOKEN, apiUrl: silent.url });
    const init = await ask('initialize', { protocolVersion: '2024-11-05' }, 3_000);
    expect(init.result).toMatchObject({ serverInfo: { name: SERVER_NAME } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(silent.seen).toEqual([]);
  });

  it.each([
    ['null params', null],
    ['array params', []],
    ['a string for params', 'junk'],
    ['a protocol version it does not know', { protocolVersion: '2099-01-01' }],
    ['a number for the protocol version', { protocolVersion: 99 }],
  ])('[W5] never answers initialize with an error, given %s', async (_label, params) => {
    const { ask } = await start();
    const init = await ask('initialize', params);
    expect(init.error).toBeUndefined();
    expect(init.result).toMatchObject({ serverInfo: { name: SERVER_NAME } });
  });

  it('[W5+] answers ping, ignores a notification and noise, and answers an unknown method with a JSON-RPC error', async () => {
    const { child, ask, send, noise } = await start({ token: TOKEN });
    send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    for (const junk of ['this is not json', 'null', '42', '[]', '"text"', '{}']) send(junk);
    const unknown = await ask('resources/list');
    expect(unknown.error?.code).toBe(-32601);
    expect((await ask('ping')).result).toEqual({});
    expect(child.exitCode).toBeNull();
    expect(noise).toEqual([]);
  });
});

describe('tools/list', () => {
  it('[W5] posts to /integration-mcp/tools/list with the token of its file as the bearer, and lists what the broker lists', async () => {
    const stub = await broker(() => tools());
    const { ask } = await start({ token: TOKEN, apiUrl: stub.url });
    await ask('initialize');
    const reply = await ask('tools/list');
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ tools: TOOLS });
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0]).toMatchObject({
      method: 'POST',
      url: LIST_URL,
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it('[W5+] keeps the broker order, and lists the empty list the broker lists', async () => {
    const reversed = [TOOLS[1], TOOLS[0]];
    const stub = await broker(() => tools(reversed));
    const { ask } = await start({ token: TOKEN, apiUrl: stub.url });
    expect(listed(await ask('tools/list'))).toEqual(reversed);

    const none = await broker(() => tools([]));
    const second = await start({ token: TOKEN, apiUrl: none.url });
    expect((await second.ask('tools/list')).result).toEqual({ tools: [] });
    expect(none.seen).toHaveLength(1);
  });

  it('[W5+] reaches the broker when the API address ends in a slash and the token file ends in a newline', async () => {
    const stub = await broker(() => tools());
    const { ask } = await start({ token: `${TOKEN}\n`, apiUrl: `${stub.url}/` });
    expect((await ask('tools/list')).result).toEqual({ tools: TOOLS });
    expect(stub.seen[0]).toMatchObject({ url: LIST_URL, authorization: `Bearer ${TOKEN}` });
  });

  it('[W5] passes only the entries with a string name, a string description and an object inputSchema', async () => {
    const invalid = [
      { name: 7, description: 'd', inputSchema: { type: 'object' } },
      { name: 'no_description', inputSchema: { type: 'object' } },
      { name: 'description_is_a_number', description: 5, inputSchema: { type: 'object' } },
      { name: 'schema_is_null', description: 'd', inputSchema: null },
      { name: 'schema_is_a_string', description: 'd', inputSchema: 'object' },
      { name: 'schema_is_a_number', description: 'd', inputSchema: 3 },
      { name: 'no_schema', description: 'd' },
      { description: 'no name', inputSchema: { type: 'object' } },
      null,
      'junk',
      42,
    ];
    const stub = await broker(() => tools([invalid[0], TOOLS[0], ...invalid.slice(1), TOOLS[1]]));
    const { ask } = await start({ token: TOKEN, apiUrl: stub.url });
    expect(listed(await ask('tools/list'))).toEqual(TOOLS);
  });

  it.each([
    [401, '{"error":"invalid or missing integrations token","code":null}'],
    [403, '{"error":"this invocation does not declare that tool","code":"undeclared-tool"}'],
    [404, 'Not Found'],
    [409, '{"error":"the tools of this invocation cannot be named","code":"tools-unlistable"}'],
    [429, '{"error":"slow down","code":null}'],
    [500, ''],
    [502, '<html>Bad Gateway</html>'],
    [503, 'Service Unavailable'],
  ])('[W5] lists no tools, and stays alive, when the broker answers %i', async (status, body) => {
    const stub = await broker(() => ({ status, body }));
    const { child, ask, noise } = await start({ token: TOKEN, apiUrl: stub.url });
    await ask('initialize');
    const reply = await ask('tools/list');
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ tools: [] });
    expect(stub.seen.length).toBeGreaterThanOrEqual(1);
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
    expect(noise).toEqual([]);
  });

  it.each([401, 409, 503])(
    '[W5] lists no tools when the broker answers %i with a well-formed list in its body',
    async (status) => {
      const stub = await broker(() => ({ status, body: JSON.stringify({ tools: TOOLS }) }));
      const { ask } = await start({ token: TOKEN, apiUrl: stub.url });
      expect((await ask('tools/list')).result).toEqual({ tools: [] });
    },
  );

  it.each([
    ['text that is not JSON', 'this is not json'],
    ['a JSON text cut short', '{"tools": ['],
    ['an empty body', ''],
    ['an object without tools', '{}'],
    ['tools that are not a list', '{"tools":"nope"}'],
    ['null tools', '{"tools":null}'],
    ['JSON null', 'null'],
    ['a JSON number', '42'],
  ])(
    '[W5] lists no tools, and stays alive, when the broker answers 200 with %s',
    async (_label, body) => {
      const stub = await broker(() => ({ status: 200, body }));
      const { child, ask } = await start({ token: TOKEN, apiUrl: stub.url });
      const reply = await ask('tools/list');
      expect(reply.error).toBeUndefined();
      expect(reply.result).toEqual({ tools: [] });
      expect(stub.seen.length).toBeGreaterThanOrEqual(1);
      expect(child.exitCode).toBeNull();
      expect((await ask('ping')).result).toEqual({});
    },
  );

  it.each([
    ['is missing', undefined],
    ['is empty', ''],
    ['holds only a newline', '\n'],
  ])('[W5] lists no tools, and makes no request, when its token file %s', async (_label, token) => {
    const stub = await broker(() => tools());
    const { child, ask } = await start({ token, apiUrl: stub.url });
    await ask('initialize');
    expect((await ask('tools/list')).result).toEqual({ tools: [] });
    expect(stub.seen).toEqual([]);
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  });

  it.each([
    ['is not set', undefined],
    ['is empty', ''],
  ])(`[W5] lists no tools when ${API_URL_ENV} %s`, async (_label, apiUrl) => {
    const { child, ask } = await start({ token: TOKEN, apiUrl });
    await ask('initialize');
    expect((await ask('tools/list')).result).toEqual({ tools: [] });
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  });

  it('[W5] lists no tools, and stays alive, when the API is down', async () => {
    const closed = await broker(() => tools());
    await closed.close();
    const { child, ask } = await start({ token: TOKEN, apiUrl: closed.url });
    const reply = await ask('tools/list');
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ tools: [] });
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  });

  it('[W5] lists no tools, and stays alive, when the connection is dropped under the request', async () => {
    const dropping = await broker(() => ({ destroy: true }));
    const { child, ask } = await start({ token: TOKEN, apiUrl: dropping.url });
    expect((await ask('tools/list')).result).toEqual({ tools: [] });
    expect(dropping.seen.length).toBeGreaterThanOrEqual(1);
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  });

  it('[W5] gives a broker that never answers 5 seconds, then lists no tools and stays alive', async () => {
    const silent = await broker(() => ({ hang: true }));
    const { child, ask } = await start({ token: TOKEN, apiUrl: silent.url });
    await ask('initialize');
    const startedAt = performance.now();
    const reply = await ask('tools/list', {}, 9_500);
    const waitedMs = performance.now() - startedAt;
    expect(reply.error).toBeUndefined();
    expect(reply.result).toEqual({ tools: [] });
    expect(silent.seen.length).toBeGreaterThanOrEqual(1);
    expect(waitedMs).toBeGreaterThanOrEqual(4_000);
    expect(waitedMs).toBeLessThan(9_000);
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  }, 30_000);
});

describe('tools/call', () => {
  const CALL = { name: 'get_pull_request_state', arguments: { prNumber: 7 } };

  it('[W5] posts {tool, arguments} to /integration-mcp/call with the token of its file, and answers the text of a 200', async () => {
    const stub = await broker(() => ({
      status: 200,
      body: JSON.stringify({ ok: true, text: '{"state":"open"}' }),
    }));
    const { ask } = await start({ token: `${TOKEN}\n`, apiUrl: `${stub.url}/` });
    const reply = await ask('tools/call', CALL);
    expect(stub.seen).toHaveLength(1);
    expect(stub.seen[0]).toMatchObject({
      method: 'POST',
      url: CALL_URL,
      authorization: `Bearer ${TOKEN}`,
      body: { tool: 'get_pull_request_state', arguments: { prNumber: 7 } },
    });
    expect(Object.keys(stub.seen[0]!.body as object).sort()).toEqual(['arguments', 'tool']);
    expect(reply.result?.isError ?? false).toBe(false);
    expect((reply.result?.content as Array<{ type: string }>)[0]!.type).toBe('text');
    expect(content(reply)).toBe('{"state":"open"}');
  });

  it('[W5] posts a call for every name, one it never listed and one Haive keeps for its own tools included', async () => {
    const stub = await broker(() => ({ status: 200, body: '{"ok":true,"text":"ran"}' }));
    const { ask } = await start({ token: TOKEN, apiUrl: stub.url });
    for (const name of ['open_pull_request', 'never_listed', 'rag_search', 'Not A Tool!']) {
      const reply = await ask('tools/call', { name, arguments: { x: 1 } });
      expect(content(reply)).toBe('ran');
    }
    expect(stub.seen.map((s) => (s.body as { tool: string }).tool)).toEqual([
      'open_pull_request',
      'never_listed',
      'rag_search',
      'Not A Tool!',
    ]);
    expect(stub.seen.every((s) => s.url === CALL_URL)).toBe(true);
  });

  it('[W5+] posts the arguments whole, however long: the broker takes a body of about 800 KiB', async () => {
    const stub = await broker(() => ({ status: 200, body: '{"ok":true,"text":"ok"}' }));
    const { ask } = await start({ token: TOKEN, apiUrl: stub.url });
    const args = { title: 't'.repeat(256), body: 'b'.repeat(300_000), branch: 'x'.repeat(244) };
    await ask('tools/call', { name: 'open_pull_request', arguments: args });
    expect(stub.seen[0]!.body).toEqual({ tool: 'open_pull_request', arguments: args });
  });

  it('[W5+] sends empty arguments as an object when the call carries none', async () => {
    const stub = await broker(() => ({ status: 200, body: '{"ok":true,"text":"ok"}' }));
    const { ask } = await start({ token: TOKEN, apiUrl: stub.url });
    await ask('tools/call', { name: 'get_pull_request_state' });
    expect(stub.seen[0]!.body).toEqual({ tool: 'get_pull_request_state', arguments: {} });
  });

  it('[W5] answers a refusal as an error reading "<tool> HTTP <status>: <the error field>"', async () => {
    const stub = await broker(() => ({
      status: 403,
      body: '{"error":"this invocation does not declare that tool","code":"undeclared-tool"}',
    }));
    const { ask } = await start({ token: TOKEN, apiUrl: stub.url });
    const reply = await ask('tools/call', CALL);
    expect(reply.result?.isError).toBe(true);
    expect(content(reply)).toBe(
      'get_pull_request_state HTTP 403: this invocation does not declare that tool',
    );
  });

  it.each([401, 409, 429, 502, 503])(
    '[W5] answers a %i as an error that names the tool and the status',
    async (status) => {
      const stub = await broker(() => ({
        status,
        body: `{"error":"refused with ${status}","code":null}`,
      }));
      const { child, ask } = await start({ token: TOKEN, apiUrl: stub.url });
      const reply = await ask('tools/call', CALL);
      expect(reply.result?.isError).toBe(true);
      expect(content(reply)).toBe(`get_pull_request_state HTTP ${status}: refused with ${status}`);
      expect(child.exitCode).toBeNull();
      expect((await ask('ping')).result).toEqual({});
    },
  );

  it('[W5] answers the body as it came when an error has no error field', async () => {
    const plain = await broker(() => ({
      status: 502,
      body: 'upstream exploded',
      contentType: 'text/plain',
    }));
    const first = await start({ token: TOKEN, apiUrl: plain.url });
    expect(content(await first.ask('tools/call', CALL))).toBe(
      'get_pull_request_state HTTP 502: upstream exploded',
    );

    const json = await broker(() => ({ status: 500, body: '{"message":"nope"}' }));
    const second = await start({ token: TOKEN, apiUrl: json.url });
    const reply = await second.ask('tools/call', CALL);
    expect(reply.result?.isError).toBe(true);
    expect(content(reply)).toBe('get_pull_request_state HTTP 500: {"message":"nope"}');
  });

  it('[W5] cuts an error to 400 characters, whether the long text is the body or the error field', async () => {
    const long = await broker(() => ({ status: 500, body: 'e'.repeat(5_000) }));
    const first = await start({ token: TOKEN, apiUrl: long.url });
    const fromBody = content(await first.ask('tools/call', CALL));
    expect(fromBody).toHaveLength(400);
    expect(fromBody.startsWith('get_pull_request_state HTTP 500: eee')).toBe(true);

    const field = await broker(() => ({
      status: 502,
      body: JSON.stringify({ error: 'f'.repeat(5_000), code: 'vendor-error' }),
    }));
    const second = await start({ token: TOKEN, apiUrl: field.url });
    const reply = await second.ask('tools/call', CALL);
    const fromField = content(reply);
    expect(reply.result?.isError).toBe(true);
    expect(fromField).toHaveLength(400);
    expect(fromField.startsWith('get_pull_request_state HTTP 502: fff')).toBe(true);
  });

  it('[W5] answers a network error as an error of at most 400 characters, and stays alive', async () => {
    const closed = await broker(() => tools());
    await closed.close();
    const { child, ask } = await start({ token: TOKEN, apiUrl: closed.url });
    const reply = await ask('tools/call', CALL);
    expect(reply.error).toBeUndefined();
    expect(reply.result?.isError).toBe(true);
    expect(content(reply).length).toBeGreaterThan(0);
    expect(content(reply).length).toBeLessThanOrEqual(400);
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  });

  it('[W5] answers a dropped connection as an error of at most 400 characters, and stays alive', async () => {
    const dropping = await broker(() => ({ destroy: true }));
    const { child, ask } = await start({ token: TOKEN, apiUrl: dropping.url });
    const reply = await ask('tools/call', CALL);
    expect(reply.result?.isError).toBe(true);
    expect(content(reply).length).toBeLessThanOrEqual(400);
    expect(dropping.seen.length).toBeGreaterThanOrEqual(1);
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  });

  it.each([
    ['its token file is missing', false, true],
    ['it has no API address', true, false],
  ])(
    '[W5+] answers a call with an error, makes no request, and stays alive when %s',
    async (_why, withToken, withUrl) => {
      const stub = await broker(() => ({ status: 200, body: '{"ok":true,"text":"x"}' }));
      const { child, ask } = await start({
        ...(withToken ? { token: TOKEN } : {}),
        ...(withUrl ? { apiUrl: stub.url } : {}),
      });
      const reply = await ask('tools/call', CALL);
      expect(reply.error).toBeUndefined();
      expect(reply.result?.isError).toBe(true);
      expect(stub.seen).toEqual([]);
      expect(child.exitCode).toBeNull();
      expect((await ask('ping')).result).toEqual({});
    },
  );

  it('[W5+] answers a call without a tool name with an error, and stays alive', async () => {
    const stub = await broker(() => ({
      status: 403,
      body: '{"error":"this invocation does not declare that tool","code":"undeclared-tool"}',
    }));
    const { child, ask } = await start({ token: TOKEN, apiUrl: stub.url });
    for (const params of [{}, { name: 7 }, { arguments: { a: 1 } }]) {
      const reply = await ask('tools/call', params);
      expect(reply.error).toBeUndefined();
      expect(reply.result?.isError).toBe(true);
    }
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  });

  it('[W5+] answers a 200 whose body is not JSON, and stays alive', async () => {
    const stub = await broker(() => ({ status: 200, body: 'not json' }));
    const { child, ask } = await start({ token: TOKEN, apiUrl: stub.url });
    const reply = await ask('tools/call', CALL);
    expect(reply.error).toBeUndefined();
    expect(typeof content(reply)).toBe('string');
    expect(child.exitCode).toBeNull();
    expect((await ask('ping')).result).toEqual({});
  });
});

describe('the process as a whole', () => {
  it('[W5] survives every kind of failure in turn, answers on, and writes nothing but JSON-RPC to stdout', async () => {
    const script = [
      { status: 503, body: 'Service Unavailable' },
      { status: 200, body: 'garbage' },
      { destroy: true as const },
      { status: 401, body: '{"error":"invalid or missing integrations token","code":null}' },
      { status: 409, body: '{"error":"the tools of this invocation cannot be named"}' },
      { status: 200, body: JSON.stringify({ tools: TOOLS }) },
    ];
    let served = 0;
    const stub = await broker(() => script[served++ % script.length]!);
    const { child, ask, noise } = await start({ token: TOKEN, apiUrl: stub.url });
    await ask('initialize');
    for (let round = 0; round < script.length; round++) {
      const list = await ask('tools/list');
      expect(list.error).toBeUndefined();
      const call = await ask('tools/call', { name: 'get_pull_request_state', arguments: {} });
      expect(call.error).toBeUndefined();
    }
    expect((await ask('ping')).result).toEqual({});
    expect(child.exitCode).toBeNull();
    expect(noise).toEqual([]);
  });

  it('[W5+] never writes the token to stdout or stderr, nor into an answer', async () => {
    const secret = 'secret-value-that-must-not-leak-0123456789';
    const stub = await broker((seen) =>
      seen.url === LIST_URL ? { status: 503, body: 'down' } : { status: 500, body: 'broken' },
    );
    const { ask, noise, stderr } = await start({ token: secret, apiUrl: stub.url });
    const replies = [
      await ask('initialize'),
      await ask('tools/list'),
      await ask('tools/call', { name: 'get_pull_request_state', arguments: {} }),
    ];
    expect(JSON.stringify(replies)).not.toContain(secret);
    expect(noise.join('\n')).not.toContain(secret);
    expect(stderr()).not.toContain(secret);
  });
});
