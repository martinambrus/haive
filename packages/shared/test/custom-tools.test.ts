import { describe, expect, it } from 'vitest';
import {
  CUSTOM_TOOL_PROBLEM_KINDS,
  customToolArgsSchema,
  customToolInputSchema,
  customToolSchema,
  validateCustomTool,
  validateCustomTools,
  type CustomTool,
  type CustomToolParam,
  type CustomToolValidationContext,
  type HttpGetTool,
  type RagQueryTool,
} from '../src/modularity/custom-tools.js';

const ch = (code: number): string => String.fromCharCode(code);
const BEL = ch(7);
const TAB = ch(9);
const LF = ch(10);
const DEL = ch(0x7f);
const NEL = ch(0x85);
const LAST_C1 = ch(0x9f);
const NBSP = ch(0xa0);

const withRepo: CustomToolValidationContext = { requiresRepository: true };
const repoless: CustomToolValidationContext = { requiresRepository: false };

const stringParam = (name: string, over: Partial<CustomToolParam> = {}): CustomToolParam =>
  ({
    name,
    type: 'string',
    description: 'A value.',
    required: false,
    maxLength: 128,
    ...over,
  }) as CustomToolParam;
const boolParam = (name: string, over: Partial<CustomToolParam> = {}): CustomToolParam =>
  ({ name, type: 'boolean', description: 'A flag.', required: false, ...over }) as CustomToolParam;
const intParam = (name: string, over: Partial<CustomToolParam> = {}): CustomToolParam =>
  ({
    name,
    type: 'integer',
    description: 'A number.',
    required: false,
    ...over,
  }) as CustomToolParam;
const enumParam = (
  name: string,
  values: string[],
  over: Partial<CustomToolParam> = {},
): CustomToolParam =>
  ({
    name,
    type: 'enum',
    description: 'A choice.',
    required: false,
    values,
    ...over,
  }) as CustomToolParam;

const httpInput = {
  name: 'repo_status',
  description: 'Fetches the status of one repository from the status API.',
  action: 'http-get',
  url: 'https://api.example.com/v1/repos/{repo}/status',
  query: ['verbose'],
  params: [
    {
      name: 'repo',
      type: 'string',
      description: 'Repository slug.',
      required: true,
      maxLength: 64,
    },
    { name: 'verbose', type: 'boolean', description: 'Include details.' },
  ],
};
const httpBase = customToolSchema.parse(httpInput) as HttpGetTool;
const http = (over: Partial<HttpGetTool> = {}): HttpGetTool => ({ ...httpBase, ...over });
const SUFFIX = '/v1/repos/{repo}/status';
const atHost = (host: string): HttpGetTool => http({ url: `${host}${SUFFIX}` });
const noParams = { params: [], query: [] } satisfies Partial<HttpGetTool>;

const ragBase = customToolSchema.parse({
  name: 'house_rules',
  description: 'Searches the house rules.',
  action: 'rag-query',
  scope: 'global',
}) as RagQueryTool;
const rag = (over: Partial<RagQueryTool> = {}): RagQueryTool => ({ ...ragBase, ...over });

const kindsOf = (tool: CustomTool, ctx = withRepo): string[] =>
  validateCustomTool(tool, ctx).map((p) => p.kind);

describe('customToolSchema', () => {
  it('fills the defaults of a minimal http-get tool', () => {
    expect(
      customToolSchema.parse({
        name: 'ping',
        description: 'Pings.',
        action: 'http-get',
        url: 'https://api.example.com/ping',
      }),
    ).toEqual({
      name: 'ping',
      description: 'Pings.',
      action: 'http-get',
      url: 'https://api.example.com/ping',
      query: [],
      params: [],
      timeoutMs: 10_000,
      maxResponseBytes: 32_768,
    });
  });

  it('fills the defaults of a minimal rag-query tool', () => {
    expect(ragBase).toEqual({
      name: 'house_rules',
      description: 'Searches the house rules.',
      action: 'rag-query',
      scope: 'global',
      topK: 8,
      maxResponseBytes: 32_768,
    });
  });

  it('fills the defaults of each param type', () => {
    const parsed = customToolSchema.parse({
      ...httpInput,
      query: ['a', 'b', 'c', 'd'],
      url: 'https://api.example.com/x',
      params: [
        { name: 'a', type: 'string', description: 'A.' },
        { name: 'b', type: 'integer', description: 'B.' },
        { name: 'c', type: 'boolean', description: 'C.' },
        { name: 'd', type: 'enum', description: 'D.', values: ['x'] },
      ],
    }) as HttpGetTool;
    expect(parsed.params).toEqual([
      { name: 'a', type: 'string', description: 'A.', required: false, maxLength: 128 },
      { name: 'b', type: 'integer', description: 'B.', required: false },
      { name: 'c', type: 'boolean', description: 'C.', required: false },
      { name: 'd', type: 'enum', description: 'D.', required: false, values: ['x'] },
    ]);
  });

  it('keeps no field that could carry a method, a header or a body', () => {
    const parsed = customToolSchema.parse({
      ...httpInput,
      method: 'POST',
      headers: { Authorization: 'Bearer x' },
      body: '{}',
    });
    expect(Object.keys(parsed)).not.toContain('method');
    expect(Object.keys(parsed)).not.toContain('headers');
    expect(Object.keys(parsed)).not.toContain('body');
  });

  const refused: ReadonlyArray<readonly [label: string, input: Record<string, unknown>]> = [
    ['an unknown action', { ...httpInput, action: 'http-post' }],
    ['no action', { name: 'x', description: 'd', url: 'https://a.example.com/' }],
    ['a missing url', { ...httpInput, url: undefined }],
    ['an empty url', { ...httpInput, url: '' }],
    [
      'a url over 2048 characters',
      { ...httpInput, url: `https://a.example.com/${'a'.repeat(2048)}` },
    ],
    ['an uppercase name', { ...httpInput, name: 'Repo_status' }],
    ['a name with a dash', { ...httpInput, name: 'repo-status' }],
    ['a name that starts with a digit', { ...httpInput, name: '1repo' }],
    ['an empty name', { ...httpInput, name: '' }],
    ['a name of 41 characters', { ...httpInput, name: 'a'.repeat(41) }],
    ['a name with a control character', { ...httpInput, name: `repo${BEL}status` }],
    ['a name with a trailing newline', { ...httpInput, name: `repo${LF}` }],
    ['an empty description', { ...httpInput, description: '' }],
    ['a description of 1025 characters', { ...httpInput, description: 'd'.repeat(1025) }],
    ['a description with a C0 control', { ...httpInput, description: `a${BEL}b` }],
    ['a description with the last C0 control', { ...httpInput, description: `a${ch(0x1f)}b` }],
    ['a description with a newline', { ...httpInput, description: `a${LF}b` }],
    ['a description with DEL', { ...httpInput, description: `a${DEL}b` }],
    ['a description with a C1 control', { ...httpInput, description: `a${NEL}b` }],
    [
      '11 params',
      { ...httpInput, params: Array.from({ length: 11 }, (_, i) => boolParam(`p${i}`)) },
    ],
    [
      'a param type that does not exist',
      { ...httpInput, params: [{ name: 'a', type: 'object', description: 'd' }] },
    ],
    ['a param name outside the grammar', { ...httpInput, params: [{ ...boolParam('A') }] }],
    [
      'a param description over 300 characters',
      { ...httpInput, params: [boolParam('a', { description: 'd'.repeat(301) })] },
    ],
    [
      'a param description with a control character',
      { ...httpInput, params: [boolParam('a', { description: `a${TAB}b` })] },
    ],
    ['a string maxLength of 0', { ...httpInput, params: [stringParam('a', { maxLength: 0 })] }],
    ['a string maxLength of 513', { ...httpInput, params: [stringParam('a', { maxLength: 513 })] }],
    [
      'a fractional string maxLength',
      { ...httpInput, params: [stringParam('a', { maxLength: 1.5 })] },
    ],
    ['an enum with no value', { ...httpInput, params: [enumParam('a', [])] }],
    [
      'an enum of 21 values',
      {
        ...httpInput,
        params: [
          enumParam(
            'a',
            Array.from({ length: 21 }, (_, i) => `v${i}`),
          ),
        ],
      },
    ],
    [
      'an enum value of 65 characters',
      { ...httpInput, params: [enumParam('a', ['v'.repeat(65)])] },
    ],
    [
      'an enum value with a control character',
      { ...httpInput, params: [enumParam('a', [`a${BEL}`])] },
    ],
    ['a fractional integer bound', { ...httpInput, params: [intParam('a', { min: 1.5 })] }],
    ['a query entry outside the name grammar', { ...httpInput, query: ['Verbose'] }],
    [
      'more than 10 query entries',
      { ...httpInput, query: Array.from({ length: 11 }, (_, i) => `p${i}`) },
    ],
    ['a timeout of 999 ms', { ...httpInput, timeoutMs: 999 }],
    ['a timeout of 30001 ms', { ...httpInput, timeoutMs: 30_001 }],
    ['a fractional timeout', { ...httpInput, timeoutMs: 1500.5 }],
    ['a response cap of 1023 bytes', { ...httpInput, maxResponseBytes: 1023 }],
    ['a response cap of 65537 bytes', { ...httpInput, maxResponseBytes: 65_537 }],
    ['a fractional response cap', { ...httpInput, maxResponseBytes: 2048.5 }],
    ['a rag-query scope that does not exist', { ...ragBase, scope: 'everything' }],
    ['a rag-query without a scope', { name: 'q', description: 'd', action: 'rag-query' }],
    ['a rag-query topK of 0', { ...ragBase, topK: 0 }],
    ['a rag-query topK of 21', { ...ragBase, topK: 21 }],
    ['a rag-query topK that is not whole', { ...ragBase, topK: 2.5 }],
    ['a rag-query response cap of 1023 bytes', { ...ragBase, maxResponseBytes: 1023 }],
    ['a rag-query response cap of 65537 bytes', { ...ragBase, maxResponseBytes: 65_537 }],
  ];

  it.each(refused.map(([label, input]) => ({ label, input })))('refuses $label', ({ input }) => {
    expect(customToolSchema.safeParse(input).success).toBe(false);
  });

  it('accepts every bound exactly and refuses the value one past it', () => {
    const ok = (over: Record<string, unknown>) =>
      customToolSchema.safeParse({ ...httpInput, ...over }).success;
    expect(ok({ name: 'a' })).toBe(true);
    expect(ok({ name: 'a'.repeat(40) })).toBe(true);
    expect(ok({ description: 'd' })).toBe(true);
    expect(ok({ description: 'd'.repeat(1024) })).toBe(true);
    expect(ok({ description: `caf${ch(0xe9)} ${NBSP}` })).toBe(true);
    expect(ok({ timeoutMs: 1000 })).toBe(true);
    expect(ok({ timeoutMs: 30_000 })).toBe(true);
    expect(ok({ maxResponseBytes: 1024 })).toBe(true);
    expect(ok({ maxResponseBytes: 65_536 })).toBe(true);
    expect(
      ok({ url: `https://a.example.com/${'a'.repeat(2048 - 'https://a.example.com/'.length)}` }),
    ).toBe(true);
    expect(ok({ query: [], params: [stringParam('a', { maxLength: 1 })] })).toBe(true);
    expect(ok({ query: [], params: [stringParam('a', { maxLength: 512 })] })).toBe(true);
    expect(
      ok({
        query: [],
        params: [
          enumParam(
            'a',
            Array.from({ length: 20 }, (_, i) => `v${i}`),
          ),
        ],
      }),
    ).toBe(true);
    expect(ok({ query: [], params: [enumParam('a', ['v'.repeat(64)])] })).toBe(true);
    expect(
      ok({ query: [], params: Array.from({ length: 10 }, (_, i) => boolParam(`p${i}`)) }),
    ).toBe(true);
    const rq = (over: Record<string, unknown>) =>
      customToolSchema.safeParse({ ...ragBase, ...over }).success;
    expect(rq({ topK: 1 })).toBe(true);
    expect(rq({ topK: 20 })).toBe(true);
    for (const scope of ['project', 'global', 'all']) expect(rq({ scope })).toBe(true);
  });
});

describe('validateCustomTool: what a clean tool looks like', () => {
  it('returns no problem for a valid tool of each action', () => {
    expect(validateCustomTool(httpBase, withRepo)).toEqual([]);
    expect(validateCustomTool(httpBase, repoless)).toEqual([]);
    expect(validateCustomTool(ragBase, withRepo)).toEqual([]);
    expect(validateCustomTool(ragBase, repoless)).toEqual([]);
  });

  it('accepts a tool that uses every param type, the path and the query', () => {
    const tool = http({
      url: 'https://api.example.com:8443/v1/{owner}/repos/{repo}/issues?format=json',
      query: ['state', 'limit', 'draft'],
      params: [
        stringParam('owner', { required: true }),
        stringParam('repo', { required: true }),
        enumParam('state', ['open', 'closed']),
        intParam('limit', { min: 1, max: 100 }),
        boolParam('draft'),
      ],
    });
    expect(kindsOf(tool)).toEqual([]);
  });

  it('accepts a tool with no params and a static query', () => {
    expect(
      kindsOf(http({ url: 'https://api.example.com/v1/status?pretty=1', ...noParams })),
    ).toEqual([]);
  });

  it.each([
    'https://api.example.com',
    'https://api.example.com:8443',
    'https://xn--bcher-kva.example',
    'https://local.example.com',
    'https://internal.example.com',
    'https://app.localhost.example.com',
    'https://localtest.me',
    'https://API.Example.COM',
  ])('accepts the public host %s', (host) => {
    expect(kindsOf(atHost(host))).toEqual([]);
  });

  it('carries the tool name and a sentence on every problem', () => {
    const problems = validateCustomTool(http({ url: `http://api.example.com${SUFFIX}` }), withRepo);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.tool).toBe('repo_status');
    expect(problems[0]!.message).toMatch(/\S/);
  });
});

describe('validateCustomTool: the url', () => {
  const cases: ReadonlyArray<readonly [label: string, kind: string, tool: HttpGetTool]> = [
    ['an http scheme', 'tool-url-not-https', atHost('http://api.example.com')],
    [
      'an uppercase scheme',
      'tool-url-not-https',
      http({ url: `HTTPS://api.example.com${SUFFIX}` }),
    ],
    ['an ftp scheme', 'tool-url-not-https', http({ url: 'ftp://api.example.com/x', ...noParams })],
    ['no scheme', 'tool-url-not-https', http({ url: `api.example.com${SUFFIX}` })],
    ['a protocol-relative url', 'tool-url-not-https', http({ url: `//api.example.com${SUFFIX}` })],
    [
      'a single slash after the scheme',
      'tool-url-not-https',
      http({ url: 'https:/api.example.com/x', ...noParams }),
    ],
    ['a user and password', 'tool-url-userinfo', atHost('https://user:secret@api.example.com')],
    ['a user alone', 'tool-url-userinfo', atHost('https://user@api.example.com')],
    ['an empty userinfo', 'tool-url-userinfo', atHost('https://@api.example.com')],
    [
      'a host spelled after an at sign',
      'tool-url-userinfo',
      atHost('https://api.example.com@evil.example.org'),
    ],
    ['a fragment', 'tool-url-fragment', http({ url: `https://api.example.com${SUFFIX}#top` })],
    ['an empty fragment', 'tool-url-fragment', http({ url: `https://api.example.com${SUFFIX}#` })],
    [
      'a fragment after a query',
      'tool-url-fragment',
      http({ url: `https://api.example.com${SUFFIX}?a=1#frag` }),
    ],
    ['an IPv4 address', 'tool-host-ip-literal', atHost('https://127.0.0.1')],
    ['a private IPv4 address', 'tool-host-ip-literal', atHost('https://10.1.2.3')],
    ['the metadata address', 'tool-host-ip-literal', atHost('https://169.254.169.254')],
    ['a public IPv4 address', 'tool-host-ip-literal', atHost('https://93.184.216.34')],
    ['an IPv4 address with a port', 'tool-host-ip-literal', atHost('https://127.0.0.1:8443')],
    ['an IPv6 address', 'tool-host-ip-literal', atHost('https://[::1]')],
    ['an IPv4-mapped IPv6 address', 'tool-host-ip-literal', atHost('https://[::ffff:127.0.0.1]')],
    ['a decimal IPv4 address', 'tool-host-ip-literal', atHost('https://2130706433')],
    ['a hex IPv4 address', 'tool-host-ip-literal', atHost('https://0x7f.0.0.1')],
    ['a short IPv4 address', 'tool-host-ip-literal', atHost('https://127.1')],
    ['an IPv4 address with a trailing dot', 'tool-host-ip-literal', atHost('https://127.0.0.1.')],
    ['localhost', 'tool-host-not-public', atHost('https://localhost')],
    ['LOCALHOST', 'tool-host-not-public', atHost('https://LOCALHOST')],
    ['localhost with a trailing dot', 'tool-host-not-public', atHost('https://localhost.')],
    [
      'a percent-encoded localhost',
      'tool-host-not-public',
      atHost('https://%6c%6f%63%61%6c%68%6f%73%74'),
    ],
    ['a single-label name', 'tool-host-not-public', atHost('https://intranet')],
    ['a .local name', 'tool-host-not-public', atHost('https://printer.local')],
    ['a .internal name', 'tool-host-not-public', atHost('https://wiki.internal')],
    [
      'a .internal name with a trailing dot',
      'tool-host-not-public',
      atHost('https://wiki.internal.'),
    ],
    ['a .localhost name', 'tool-host-not-public', atHost('https://app.localhost')],
    [
      'a placeholder in the host',
      'tool-placeholder-outside-path',
      http({ url: 'https://{repo}.example.com/v1/status' }),
    ],
    [
      'a placeholder glued to the host',
      'tool-placeholder-outside-path',
      http({ url: 'https://api.example.com{repo}/status' }),
    ],
    [
      'a placeholder that is the whole host',
      'tool-placeholder-outside-path',
      http({ url: 'https://{repo}/v1/status' }),
    ],
    [
      'a placeholder in the query',
      'tool-placeholder-outside-path',
      http({ url: 'https://api.example.com/v1/status?repo={repo}' }),
    ],
    [
      'a placeholder that no param declares',
      'tool-param-undeclared',
      http({ url: `https://api.example.com${SUFFIX}/{branch}` }),
    ],
    [
      'an empty placeholder',
      'tool-param-undeclared',
      http({ url: `https://api.example.com${SUFFIX}/{}` }),
    ],
    [
      'a placeholder with an uppercase name',
      'tool-param-undeclared',
      http({ url: `https://api.example.com${SUFFIX}/{Branch}` }),
    ],
    [
      'a query entry that no param declares',
      'tool-param-undeclared',
      http({ query: ['verbose', 'ghost'] }),
    ],
    [
      'a param the url and query never use',
      'tool-param-unused',
      http({ params: [...httpBase.params, stringParam('extra')] }),
    ],
    ['a query entry that was dropped', 'tool-param-unused', http({ query: [] })],
    [
      'a path placeholder written twice',
      'tool-param-reused',
      http({ url: `https://api.example.com${SUFFIX}/{repo}` }),
    ],
    [
      'a param in the path and in the query',
      'tool-param-reused',
      http({ query: ['verbose', 'repo'] }),
    ],
    ['a query entry written twice', 'tool-param-reused', http({ query: ['verbose', 'verbose'] })],
    ['an empty url', 'tool-url-invalid', http({ url: '', ...noParams })],
    [
      'a url with nothing after the scheme',
      'tool-url-invalid',
      http({ url: 'https://', ...noParams }),
    ],
    ['a url with no host', 'tool-url-invalid', http({ url: 'https:///v1/status', ...noParams })],
    [
      'a space in the path',
      'tool-url-invalid',
      http({ url: 'https://api.example.com/v1/my repo', ...noParams }),
    ],
    [
      'a space in the host',
      'tool-url-invalid',
      http({ url: 'https://exa mple.com/x', ...noParams }),
    ],
    [
      'a tab in the host',
      'tool-url-invalid',
      http({ url: `https://exa${TAB}mple.com/x`, ...noParams }),
    ],
    [
      'a control character in the path',
      'tool-url-invalid',
      http({ url: `https://api.example.com/v1/${BEL}`, ...noParams }),
    ],
    [
      'a C1 control in the path',
      'tool-url-invalid',
      http({ url: `https://api.example.com/v1/${NEL}`, ...noParams }),
    ],
    [
      'a backslash after the host',
      'tool-url-invalid',
      http({ url: 'https://api.example.com\\v1/status', ...noParams }),
    ],
    [
      'a port past 65535',
      'tool-url-invalid',
      http({ url: 'https://api.example.com:99999/v1/status', ...noParams }),
    ],
    [
      'five numeric labels',
      'tool-url-invalid',
      http({ url: 'https://1.2.3.4.5/v1/status', ...noParams }),
    ],
    [
      'a bracket in the host name',
      'tool-url-invalid',
      http({ url: 'https://exa[mple.com/x', ...noParams }),
    ],
    [
      'an unclosed brace',
      'tool-url-invalid',
      http({ url: 'https://api.example.com/v1/repos/{repo/status' }),
    ],
    [
      'a stray closing brace',
      'tool-url-invalid',
      http({ url: `https://api.example.com${SUFFIX}}` }),
    ],
    [
      'nested braces',
      'tool-url-invalid',
      http({ url: 'https://api.example.com/v1/repos/{{repo}}/status' }),
    ],
    [
      'a url over 2048 characters',
      'tool-url-invalid',
      http({ url: `https://api.example.com/${'a'.repeat(2048)}`, ...noParams }),
    ],
  ];

  it.each(cases.map(([label, kind, tool]) => ({ label, kind, tool })))(
    'refuses $label as $kind and as nothing else',
    ({ kind, tool }) => {
      expect(kindsOf(tool)).toEqual([kind]);
    },
  );

  it('keeps a static query', () => {
    expect(kindsOf(http({ url: `https://api.example.com${SUFFIX}?pretty=1&lang=en` }))).toEqual([]);
  });

  it('refuses each of several independent problems of one url', () => {
    const found = kindsOf(http({ url: `http://user@localhost${SUFFIX}#x` }));
    expect(new Set(found)).toEqual(
      new Set(['tool-url-not-https', 'tool-url-userinfo', 'tool-url-fragment']),
    );
  });
});

describe('validateCustomTool: the params', () => {
  const inQuery = (...params: CustomToolParam[]): HttpGetTool =>
    http({
      url: 'https://api.example.com/v1/status',
      query: params.map((p) => p.name),
      params,
    });

  it('refuses two params with one name, once', () => {
    const tool = http({ params: [...httpBase.params, stringParam('repo')] });
    expect(kindsOf(tool)).toEqual(['tool-param-duplicate']);
  });

  it('refuses 11 params and accepts 10', () => {
    const many = (n: number) => inQuery(...Array.from({ length: n }, (_, i) => boolParam(`p${i}`)));
    expect(kindsOf(many(11))).toEqual(['tool-too-many-params']);
    expect(kindsOf(many(10))).toEqual([]);
  });

  const invalid: ReadonlyArray<readonly [label: string, param: CustomToolParam]> = [
    ['an uppercase name', boolParam('Bad')],
    ['a name with a dash', boolParam('a-b')],
    ['a name that starts with a digit', boolParam('1a')],
    ['an empty name', boolParam('')],
    ['a name of 41 characters', boolParam('a'.repeat(41))],
    ['a name with a control character', boolParam(`a${BEL}`)],
    ['an empty description', boolParam('a', { description: '' })],
    ['a description over 300 characters', boolParam('a', { description: 'd'.repeat(301) })],
    ['a description with a control character', boolParam('a', { description: `a${LF}b` })],
    ['a string maxLength of 0', stringParam('a', { maxLength: 0 })],
    ['a string maxLength of 513', stringParam('a', { maxLength: 513 })],
    ['a fractional string maxLength', stringParam('a', { maxLength: 2.5 })],
    ['an integer min above its max', intParam('a', { min: 5, max: 1 })],
    ['a fractional integer min', intParam('a', { min: 1.5 })],
    ['a fractional integer max', intParam('a', { max: 9.5 })],
    ['an enum with no value', enumParam('a', [])],
    [
      'an enum of 21 values',
      enumParam(
        'a',
        Array.from({ length: 21 }, (_, i) => `v${i}`),
      ),
    ],
    ['an enum value of 65 characters', enumParam('a', ['v'.repeat(65)])],
    ['an empty enum value', enumParam('a', [''])],
    ['an enum value with a control character', enumParam('a', [`a${BEL}`])],
    ['an enum that repeats a value', enumParam('a', ['x', 'x'])],
  ];

  it.each(invalid.map(([label, param]) => ({ label, param })))(
    'refuses $label as tool-param-invalid and as nothing else',
    ({ param }) => {
      expect(kindsOf(inQuery(param))).toEqual(['tool-param-invalid']);
    },
  );

  it('accepts the edges of every param bound', () => {
    expect(kindsOf(inQuery(boolParam('a'.repeat(40))))).toEqual([]);
    expect(kindsOf(inQuery(boolParam('a', { description: 'd'.repeat(300) })))).toEqual([]);
    expect(kindsOf(inQuery(stringParam('a', { maxLength: 1 })))).toEqual([]);
    expect(kindsOf(inQuery(stringParam('a', { maxLength: 512 })))).toEqual([]);
    expect(kindsOf(inQuery(intParam('a', { min: 5, max: 5 })))).toEqual([]);
    expect(kindsOf(inQuery(intParam('a', { min: -10 })))).toEqual([]);
    expect(
      kindsOf(
        inQuery(
          enumParam(
            'a',
            Array.from({ length: 20 }, (_, i) => `v${i}`),
          ),
        ),
      ),
    ).toEqual([]);
    expect(kindsOf(inQuery(enumParam('a', ['v'.repeat(64)])))).toEqual([]);
  });
});

describe('validateCustomTool: the name, the description and the limits', () => {
  it.each([
    ['an uppercase letter', 'Repo'],
    ['a dash', 'repo-status'],
    ['a leading digit', '1repo'],
    ['a leading underscore', '_repo'],
    ['an empty name', ''],
    ['41 characters', 'a'.repeat(41)],
    ['a space', 'repo status'],
    ['a control character', `repo${BEL}`],
    ['a trailing newline', `repo${LF}`],
    ['a dot', 'repo.status'],
  ])('refuses a name with %s as tool-name-invalid', (_label, name) => {
    expect(kindsOf(http({ name }))).toEqual(['tool-name-invalid']);
    expect(kindsOf(rag({ name }))).toEqual(['tool-name-invalid']);
  });

  it.each(['a', 'a'.repeat(40), 'get_2', 'a_', 'repo_status_v2'])('accepts the name %s', (name) => {
    expect(kindsOf(http({ name }))).toEqual([]);
  });

  it.each(['rag_search', 'ddev_status', 'ddev_logs', 'ddev_restart'])(
    'refuses the reserved name %s as tool-name-reserved',
    (name) => {
      expect(kindsOf(http({ name }))).toEqual(['tool-name-reserved']);
      expect(kindsOf(rag({ name }))).toEqual(['tool-name-reserved']);
    },
  );

  it.each([
    ['an empty description', ''],
    ['1025 characters', 'd'.repeat(1025)],
    ['a bell', `a${BEL}b`],
    ['the last C0 control', `a${ch(0x1f)}b`],
    ['a tab', `a${TAB}b`],
    ['a newline', `a${LF}b`],
    ['DEL', `a${DEL}b`],
    ['a C1 control', `a${NEL}b`],
    ['the last C1 control', `a${LAST_C1}b`],
    ['a leading control', `${BEL}ab`],
  ])('refuses a description with %s as tool-description-invalid', (_label, description) => {
    expect(kindsOf(http({ description }))).toEqual(['tool-description-invalid']);
    expect(kindsOf(rag({ description }))).toEqual(['tool-description-invalid']);
  });

  it('accepts a description from 1 to 1024 characters made of printable text', () => {
    for (const description of [
      'd',
      'd'.repeat(1024),
      `caf${ch(0xe9)}`,
      `a${ch(0x20)}b`,
      `a${ch(0x7e)}b`,
      `a${NBSP}b`,
    ]) {
      expect(kindsOf(http({ description })), JSON.stringify(description)).toEqual([]);
    }
  });

  it.each([0, 999, 30_001, 1500.5, Number.NaN, -1])('refuses a timeout of %s ms', (timeoutMs) => {
    expect(kindsOf(http({ timeoutMs }))).toEqual(['tool-timeout-out-of-range']);
  });

  it.each([1000, 30_000, 10_000])('accepts a timeout of %s ms', (timeoutMs) => {
    expect(kindsOf(http({ timeoutMs }))).toEqual([]);
  });

  it.each([0, 1023, 65_537, 2048.5, Number.NaN])(
    'refuses a response cap of %s bytes',
    (maxResponseBytes) => {
      expect(kindsOf(http({ maxResponseBytes }))).toEqual(['tool-response-cap-out-of-range']);
      expect(kindsOf(rag({ maxResponseBytes }))).toEqual(['tool-response-cap-out-of-range']);
    },
  );

  it.each([1024, 65_536, 32_768])('accepts a response cap of %s bytes', (maxResponseBytes) => {
    expect(kindsOf(http({ maxResponseBytes }))).toEqual([]);
    expect(kindsOf(rag({ maxResponseBytes }))).toEqual([]);
  });
});

describe('validateCustomTool: rag-query', () => {
  it.each(['project', 'all'] as const)(
    'refuses scope %s on a type with no repository, and only that',
    (scope) => {
      expect(kindsOf(rag({ scope }), repoless)).toEqual(['tool-scope-needs-repository']);
    },
  );

  it('accepts every scope on a type with a repository and global on one without', () => {
    for (const scope of ['project', 'global', 'all'] as const) {
      expect(kindsOf(rag({ scope }), withRepo)).toEqual([]);
    }
    expect(kindsOf(rag({ scope: 'global' }), repoless)).toEqual([]);
  });

  it.each([0, 21, 2.5, Number.NaN, -3])('refuses a topK of %s', (topK) => {
    expect(kindsOf(rag({ topK }))).toEqual(['tool-top-k-out-of-range']);
  });

  it.each([1, 8, 20])('accepts a topK of %s', (topK) => {
    expect(kindsOf(rag({ topK }))).toEqual([]);
  });
});

describe('validateCustomTools', () => {
  const named = (name: string): HttpGetTool => http({ name });
  const many = (n: number): CustomTool[] => Array.from({ length: n }, (_, i) => named(`tool_${i}`));

  it('refuses 9 tools once and accepts 8', () => {
    expect(validateCustomTools(many(8), withRepo)).toEqual([]);
    expect(validateCustomTools(many(9), withRepo).map((p) => p.kind)).toEqual(['too-many-tools']);
  });

  it('refuses a name used twice, once per name', () => {
    const found = validateCustomTools([named('a'), named('b'), named('a'), named('a')], withRepo);
    expect(found.map((p) => [p.kind, p.tool])).toEqual([['tool-name-duplicate', 'a']]);
  });

  it('puts each tool problem under the name of its own tool', () => {
    const found = validateCustomTools(
      [
        named('good'),
        http({ name: 'bad', url: `http://api.example.com${SUFFIX}` }),
        rag({ name: 'ddev_logs' }),
      ],
      withRepo,
    );
    expect(found.map((p) => [p.kind, p.tool])).toEqual([
      ['tool-url-not-https', 'bad'],
      ['tool-name-reserved', 'ddev_logs'],
    ]);
  });

  it('checks a tool against the type it sits on', () => {
    const tools = [rag({ scope: 'project' })];
    expect(validateCustomTools(tools, withRepo)).toEqual([]);
    expect(validateCustomTools(tools, repoless).map((p) => p.kind)).toEqual([
      'tool-scope-needs-repository',
    ]);
  });

  it('returns nothing for no tools', () => {
    expect(validateCustomTools([], withRepo)).toEqual([]);
    expect(validateCustomTools([], repoless)).toEqual([]);
  });
});

describe('CUSTOM_TOOL_PROBLEM_KINDS', () => {
  it('names every kind the validator can raise, once', () => {
    expect(new Set(CUSTOM_TOOL_PROBLEM_KINDS).size).toBe(CUSTOM_TOOL_PROBLEM_KINDS.length);
    const raised = new Set<string>();
    const tools: CustomTool[] = [
      http({ name: 'Bad' }),
      http({ name: 'rag_search' }),
      http({ description: '' }),
      http({ url: '', ...noParams }),
      http({ url: 'http://api.example.com/x', ...noParams }),
      atHost('https://user@api.example.com'),
      http({ url: `https://api.example.com${SUFFIX}#x` }),
      atHost('https://127.0.0.1'),
      atHost('https://localhost'),
      http({ url: 'https://{repo}.example.com/x' }),
      http({ url: `https://api.example.com${SUFFIX}/{x}` }),
      http({ query: [] }),
      http({ query: ['verbose', 'repo'] }),
      http({ params: [...httpBase.params, stringParam('repo')] }),
      http({ params: [boolParam('Bad')], url: 'https://api.example.com/x', query: ['Bad'] }),
      http({
        url: 'https://api.example.com/x',
        query: Array.from({ length: 11 }, (_, i) => `p${i}`),
        params: Array.from({ length: 11 }, (_, i) => boolParam(`p${i}`)),
      }),
      http({ timeoutMs: 1 }),
      http({ maxResponseBytes: 1 }),
      rag({ topK: 99 }),
      rag({ scope: 'all' }),
    ];
    for (const tool of tools) {
      for (const problem of validateCustomTool(tool, repoless)) raised.add(problem.kind);
    }
    for (const problem of validateCustomTools(
      Array.from({ length: 9 }, () => http()),
      repoless,
    )) {
      raised.add(problem.kind);
    }
    expect([...raised].sort()).toEqual([...CUSTOM_TOOL_PROBLEM_KINDS].sort());
  });
});

describe('customToolInputSchema', () => {
  it('generates the MCP schema of an http-get tool from its params', () => {
    expect(customToolInputSchema(httpBase)).toEqual({
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository slug.', maxLength: 64 },
        verbose: { type: 'boolean', description: 'Include details.' },
      },
      required: ['repo'],
    });
  });

  it('writes each param type in the minimal subset, with its bounds', () => {
    const tool = http({
      url: 'https://api.example.com/v1/{owner}/issues',
      query: ['state', 'limit', 'count', 'draft'],
      params: [
        stringParam('owner', { required: true, maxLength: 40, description: 'The owner.' }),
        enumParam('state', ['open', 'closed'], { required: true, description: 'The state.' }),
        intParam('limit', { min: 1, max: 100, description: 'How many.' }),
        intParam('count', { description: 'Free count.' }),
        boolParam('draft', { description: 'Drafts too.' }),
      ],
    });
    expect(customToolInputSchema(tool)).toEqual({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner.', maxLength: 40 },
        state: { type: 'string', description: 'The state.', enum: ['open', 'closed'] },
        limit: { type: 'integer', description: 'How many.', minimum: 1, maximum: 100 },
        count: { type: 'integer', description: 'Free count.' },
        draft: { type: 'boolean', description: 'Drafts too.' },
      },
      required: ['owner', 'state'],
    });
  });

  it('lists a path param as required whatever its own flag says', () => {
    const tool = http({ params: [stringParam('repo', { required: false }), boolParam('verbose')] });
    expect(customToolInputSchema(tool).required).toEqual(['repo']);
  });

  it('leaves out required when no param is required, and keeps properties for a tool with no param', () => {
    const optionalOnly = http({
      url: 'https://api.example.com/v1/status',
      query: ['verbose'],
      params: [boolParam('verbose')],
    });
    expect(customToolInputSchema(optionalOnly)).toEqual({
      type: 'object',
      properties: { verbose: { type: 'boolean', description: 'A flag.' } },
    });
    expect('required' in customToolInputSchema(optionalOnly)).toBe(false);
    expect(
      customToolInputSchema(http({ url: 'https://api.example.com/v1/status', ...noParams })),
    ).toEqual({
      type: 'object',
      properties: {},
    });
  });

  it('generates the fixed schema of a rag-query tool', () => {
    const expected = {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to search for.', maxLength: 500 } },
      required: ['query'],
    };
    expect(customToolInputSchema(ragBase)).toEqual(expected);
    expect(customToolInputSchema(rag({ scope: 'all', topK: 3 }))).toEqual(expected);
  });

  it('writes the same bytes every time, in a fixed key order', () => {
    expect(JSON.stringify(customToolInputSchema(httpBase))).toBe(
      '{"type":"object","properties":{"repo":{"type":"string","description":"Repository slug.","maxLength":64},"verbose":{"type":"boolean","description":"Include details."}},"required":["repo"]}',
    );
    expect(JSON.stringify(customToolInputSchema(httpBase))).toBe(
      JSON.stringify(customToolInputSchema(structuredClone(httpBase))),
    );
  });

  it('uses no keyword outside the minimal subset', () => {
    const tools: CustomTool[] = [
      httpBase,
      ragBase,
      http({
        url: 'https://api.example.com/v1/x',
        query: ['a', 'b', 'c', 'd'],
        params: [
          stringParam('a', { required: true }),
          enumParam('b', ['x', 'y']),
          intParam('c', { min: 0, max: 9 }),
          boolParam('d'),
        ],
      }),
    ];
    for (const tool of tools) {
      const schema = customToolInputSchema(tool) as unknown as Record<string, unknown>;
      expect(Object.keys(schema).every((k) => ['type', 'properties', 'required'].includes(k))).toBe(
        true,
      );
      for (const prop of Object.values(schema.properties as Record<string, object>)) {
        expect(
          Object.keys(prop).every((k) =>
            ['type', 'description', 'enum', 'minimum', 'maximum', 'maxLength'].includes(k),
          ),
        ).toBe(true);
      }
    }
  });
});

describe('customToolArgsSchema', () => {
  const args = customToolArgsSchema(httpBase);

  it('accepts exactly the arguments that were advertised', () => {
    expect(args.safeParse({ repo: 'haive' }).success).toBe(true);
    expect(args.safeParse({ repo: 'haive', verbose: true }).success).toBe(true);
    expect(args.parse({ repo: 'haive', verbose: false })).toEqual({
      repo: 'haive',
      verbose: false,
    });
  });

  it('refuses a key that was not advertised', () => {
    expect(args.safeParse({ repo: 'haive', extra: 1 }).success).toBe(false);
    expect(args.safeParse({ repo: 'haive', method: 'POST' }).success).toBe(false);
    expect(args.safeParse({ repo: 'haive', url: 'https://evil.example.com' }).success).toBe(false);
  });

  it('refuses a key spelled as an own __proto__ property', () => {
    const hostile = JSON.parse('{"repo":"haive","__proto__":{"polluted":true}}');
    expect(args.safeParse(hostile).success).toBe(false);
  });

  it('refuses a value longer than the param allows, and accepts one of the exact length', () => {
    expect(args.safeParse({ repo: 'a'.repeat(65) }).success).toBe(false);
    expect(args.safeParse({ repo: 'a'.repeat(64) }).success).toBe(true);
  });

  it('refuses an empty string, a wrong type, a missing required param and a non-object', () => {
    expect(args.safeParse({ repo: '' }).success).toBe(false);
    expect(args.safeParse({ repo: 5 }).success).toBe(false);
    expect(args.safeParse({ repo: 'haive', verbose: 'yes' }).success).toBe(false);
    expect(args.safeParse({}).success).toBe(false);
    expect(args.safeParse({ repo: null }).success).toBe(false);
    expect(args.safeParse(null).success).toBe(false);
    expect(args.safeParse('haive').success).toBe(false);
    expect(args.safeParse(['haive']).success).toBe(false);
  });

  it('requires a path param whatever its own flag says', () => {
    const optionalPath = customToolArgsSchema(
      http({ params: [stringParam('repo', { required: false }), boolParam('verbose')] }),
    );
    expect(optionalPath.safeParse({}).success).toBe(false);
    expect(optionalPath.safeParse({ repo: 'haive' }).success).toBe(true);
  });

  it('checks enum membership and integer bounds', () => {
    const schema = customToolArgsSchema(
      http({
        url: 'https://api.example.com/v1/x',
        query: ['state', 'limit'],
        params: [
          enumParam('state', ['open', 'closed'], { required: true }),
          intParam('limit', { min: 1, max: 100 }),
        ],
      }),
    );
    expect(schema.safeParse({ state: 'open', limit: 100 }).success).toBe(true);
    expect(schema.safeParse({ state: 'open', limit: 1 }).success).toBe(true);
    expect(schema.safeParse({ state: 'merged' }).success).toBe(false);
    expect(schema.safeParse({ state: 'open', limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ state: 'open', limit: 101 }).success).toBe(false);
    expect(schema.safeParse({ state: 'open', limit: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ state: 'open', limit: '5' }).success).toBe(false);
    expect(schema.safeParse({ state: 'open', limit: Number.NaN }).success).toBe(false);
  });

  it('takes any integer when none is bounded', () => {
    const schema = customToolArgsSchema(
      http({
        url: 'https://api.example.com/v1/x',
        query: ['n'],
        params: [intParam('n', { required: true })],
      }),
    );
    expect(schema.safeParse({ n: -5 }).success).toBe(true);
    expect(schema.safeParse({ n: 2 ** 40 }).success).toBe(true);
    expect(schema.safeParse({ n: 0.5 }).success).toBe(false);
  });

  it('takes an empty object for a tool with no param, and nothing else', () => {
    const schema = customToolArgsSchema(http({ url: 'https://api.example.com/v1/x', ...noParams }));
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ a: 1 }).success).toBe(false);
  });

  it('takes a rag-query tool one query of 1 to 500 characters', () => {
    const schema = customToolArgsSchema(ragBase);
    expect(schema.safeParse({ query: 'testing' }).success).toBe(true);
    expect(schema.safeParse({ query: 'q'.repeat(500) }).success).toBe(true);
    expect(schema.safeParse({ query: 'q'.repeat(501) }).success).toBe(false);
    expect(schema.safeParse({ query: '' }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ query: 'x', topK: 100 }).success).toBe(false);
    expect(schema.safeParse({ query: 'x', scope: 'all' }).success).toBe(false);
  });

  it('requires, per tool, exactly the keys its input schema lists as required', () => {
    for (const tool of [httpBase, ragBase]) {
      const advertised = customToolInputSchema(tool);
      const accepted = customToolArgsSchema(tool);
      const minimal = Object.fromEntries(
        (advertised.required ?? []).map((name) => {
          const prop = advertised.properties[name]!;
          return [name, prop.type === 'boolean' ? true : prop.type === 'integer' ? 1 : 'x'];
        }),
      );
      expect(accepted.safeParse(minimal).success, tool.name).toBe(true);
      for (const name of advertised.required ?? []) {
        const { [name]: _dropped, ...without } = minimal;
        expect(accepted.safeParse(without).success, `${tool.name} without ${name}`).toBe(false);
      }
    }
  });
});
