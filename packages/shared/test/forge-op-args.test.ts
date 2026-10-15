import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_FORGE_PROVIDER_SPECS,
  ForgeError,
  validateForgeOpArgs,
  resolveForgeProvider,
  type ForgeContext,
  type ForgeProviderName,
} from '../src/forge/index.js';

const refused = (opId: string, args: unknown) => {
  const result = validateForgeOpArgs(opId, args);
  if (result.ok) throw new Error(`accepted ${JSON.stringify(args)} for ${opId}`);
  return result.error;
};

describe('validateForgeOpArgs: get_pull_request_state', () => {
  it.each([
    '..',
    '../../user',
    '../../../../user',
    '%2e%2e',
    '1/2',
    '1?x=1',
    '1#x',
    '',
    'x',
    '0',
    '01',
    '-1',
    '1.5',
    '1e3',
    ' 1',
    '1 ',
    '1\n',
    '１２',
    '12345678901',
  ])('refuses prNumber %j, naming the field', (prNumber) => {
    expect(refused('get_pull_request_state', { prNumber })).toContain('prNumber');
  });

  it.each(['1', '42', '9999999999'])(
    'accepts prNumber %s and hands it back unchanged',
    (prNumber) => {
      expect(validateForgeOpArgs('get_pull_request_state', { prNumber })).toEqual({
        ok: true,
        args: { prNumber },
      });
    },
  );

  it.each([[42], [null], [undefined], [['1']], [{ toString: () => '1' }]])(
    'refuses a prNumber that is not a string: %j',
    (prNumber) => {
      expect(refused('get_pull_request_state', { prNumber })).toContain('prNumber');
    },
  );

  it.each([
    [null],
    [undefined],
    ['42'],
    [42],
    [['42']],
    [{}],
    [{ pr: '42' }],
    [{ prNumber: '1', x: '2' }],
  ])('refuses arguments that are not exactly { prNumber }: %j', (args) => {
    expect(refused('get_pull_request_state', args)).toBeTruthy();
  });

  it('refuses an extra key named __proto__', () => {
    expect(
      refused('get_pull_request_state', JSON.parse('{"prNumber":"1","__proto__":"x"}')),
    ).toBeTruthy();
  });
});

describe('validateForgeOpArgs: open_pull_request', () => {
  const valid = { head: 'feature/x', base: 'main', title: 'Add x', body: 'Details' };

  it('accepts a branch pair, a title and a body, and hands them back unchanged', () => {
    expect(validateForgeOpArgs('open_pull_request', valid)).toEqual({ ok: true, args: valid });
  });

  it('accepts an empty body and the title and body at their limits', () => {
    expect(validateForgeOpArgs('open_pull_request', { ...valid, body: '' }).ok).toBe(true);
    expect(validateForgeOpArgs('open_pull_request', { ...valid, title: 'x'.repeat(256) }).ok).toBe(
      true,
    );
    expect(
      validateForgeOpArgs('open_pull_request', { ...valid, body: 'x'.repeat(65_536) }).ok,
    ).toBe(true);
  });

  it.each(['head', 'base'] as const)('refuses a %s git would not take as a branch name', (key) => {
    for (const name of [
      '',
      '-x',
      '--upload-pack=x',
      'a..b',
      'a b',
      'x.lock',
      '@',
      'HEAD',
      'a/',
      '/a',
      'a:b',
      'a~1',
      'a^',
      'a\\b',
      'a@{1}',
      'a\n',
      '.hidden',
    ]) {
      expect(refused('open_pull_request', { ...valid, [key]: name })).toContain(key);
    }
  });

  it.each(['head', 'base'] as const)('accepts a %s of 255 characters', (key) => {
    expect(validateForgeOpArgs('open_pull_request', { ...valid, [key]: 'x'.repeat(255) }).ok).toBe(
      true,
    );
  });

  it.each([
    ['head', 256],
    ['base', 256],
    ['head', 1_000],
    ['base', 1_000],
  ] as const)('refuses a %s of %i characters, naming the limit', (key, length) => {
    const error = refused('open_pull_request', { ...valid, [key]: 'x'.repeat(length) });
    expect(error).toContain(key);
    expect(error).toContain('255');
  });

  it('refuses a title that is empty or longer than 256 characters', () => {
    expect(refused('open_pull_request', { ...valid, title: '' })).toContain('title');
    expect(refused('open_pull_request', { ...valid, title: 'x'.repeat(257) })).toContain('title');
  });

  it('refuses a body longer than 65536 characters', () => {
    expect(refused('open_pull_request', { ...valid, body: 'x'.repeat(65_537) })).toContain('body');
  });

  it.each(['head', 'base', 'title', 'body'] as const)(
    'refuses a missing or non-string %s',
    (key) => {
      const { [key]: _omitted, ...rest } = valid;
      expect(refused('open_pull_request', rest)).toBeTruthy();
      expect(refused('open_pull_request', { ...valid, [key]: 7 })).toContain(key);
      expect(refused('open_pull_request', { ...valid, [key]: null })).toContain(key);
    },
  );

  it('refuses a key the operation does not declare', () => {
    expect(refused('open_pull_request', { ...valid, draft: 'true' })).toBeTruthy();
    expect(refused('open_pull_request', { ...valid, owner: 'someone-else' })).toBeTruthy();
  });
});

describe('validateForgeOpArgs: the operation', () => {
  it('refuses an operation it does not know', () => {
    expect(refused('merge_pull_request', { prNumber: '1' })).toBeTruthy();
    expect(refused('__proto__', {})).toBeTruthy();
    expect(refused('constructor', {})).toBeTruthy();
  });

  it.each(CORE_FORGE_PROVIDER_SPECS.map((spec) => [spec.id, spec] as const))(
    'takes exactly the keys %s declares for each of its operations',
    (_id, spec) => {
      const sample: Record<string, Record<string, string>> = {
        get_pull_request_state: { prNumber: '1' },
        open_pull_request: { head: 'feat', base: 'main', title: 'T', body: 'B' },
      };
      for (const operation of spec.operations ?? []) {
        const schema = operation.inputSchema as { properties: object; required: string[] };
        const declared = Object.keys(schema.properties).sort();
        expect(Object.keys(sample[operation.opId]!).sort()).toEqual(declared);
        expect([...schema.required].sort()).toEqual(declared);
        expect(validateForgeOpArgs(operation.opId, sample[operation.opId]).ok).toBe(true);
      }
    },
  );
});

const PROVIDER_CASES: [ForgeProviderName, Partial<ForgeContext>, string][] = [
  [
    'github',
    { apiBase: 'https://api.github.com' },
    'https://api.github.com/repos/acme/app/pulls/42',
  ],
  [
    'gitea',
    { apiBase: 'https://gitea.acme.io/api/v1' },
    'https://gitea.acme.io/api/v1/repos/acme/app/pulls/42',
  ],
  [
    'gitlab',
    { apiBase: 'https://gitlab.com/api/v4' },
    'https://gitlab.com/api/v4/projects/acme%2Fapp/merge_requests/42',
  ],
  [
    'bitbucket_cloud',
    { apiBase: 'https://api.bitbucket.org/2.0' },
    'https://api.bitbucket.org/2.0/repositories/acme/app/pullrequests/42',
  ],
  [
    'bitbucket_server',
    { apiBase: 'https://bb.acme.io/rest/api/1.0' },
    'https://bb.acme.io/rest/api/1.0/projects/acme/repos/app/pull-requests/42',
  ],
];

describe('the adapters and a pull request number', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const contextFor = (provider: ForgeProviderName, over: Partial<ForgeContext>): ForgeContext => ({
    provider,
    apiBase: 'https://forge.example',
    host: 'forge.example',
    owner: 'acme',
    repo: 'app',
    token: 'tok',
    username: 'user',
    ...over,
  });

  const answerOpen = () =>
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ state: 'open' }), { status: 200 }),
    );

  it.each(PROVIDER_CASES)(
    '%s refuses a number that could leave the path, and sends nothing',
    async (provider, over) => {
      answerOpen();
      for (const prNumber of ['..', '../../../../user', '1/2', '', 'x', '0', '%2e%2e']) {
        const err = await resolveForgeProvider(provider)
          .getPullRequestState(contextFor(provider, over), prNumber)
          .then(
            () => null,
            (e: unknown) => e,
          );
        expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([]);
        expect(err).toBeInstanceOf(ForgeError);
      }
    },
  );

  it.each(PROVIDER_CASES)(
    '%s still reads a plain number at the same path',
    async (provider, over, url) => {
      answerOpen();

      await resolveForgeProvider(provider).getPullRequestState(contextFor(provider, over), '42');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe(url);
    },
  );
});
