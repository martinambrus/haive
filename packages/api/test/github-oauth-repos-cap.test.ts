import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = vi.hoisted(() => '00000000-0000-4000-8000-0000000000a1');
const h = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set: (key: string, value: string) => void }, next: () => unknown) => {
    c.set('userId', USER);
    await next();
  },
}));

import { Hono } from 'hono';
import { encrypt, encryptDek, generateDek, secretsService } from '@haive/shared';
import { githubOauthRoutes } from '../src/routes/github-oauth.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';

const KEK = 'ab'.repeat(32);
const CREDENTIAL = '00000000-0000-4000-8000-0000000000c1';
const ALL_PAGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const app = new Hono<AppEnv>();
app.route('/', githubOauthRoutes);
app.onError(errorHandler);

let pagesRead: number[] = [];

function githubWith(total: number): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const page = Number(url.searchParams.get('page'));
    const perPage = Number(url.searchParams.get('per_page'));
    pagesRead.push(page);
    const from = (page - 1) * perPage;
    const count = Math.max(0, Math.min(perPage, total - from));
    const repos = Array.from({ length: count }, (_, i) => ({
      full_name: `acme/r${from + i}`,
      clone_url: `https://github.com/acme/r${from + i}.git`,
      default_branch: 'main',
      private: false,
      pushed_at: null,
    }));
    const last = Math.max(1, Math.ceil(total / perPage));
    const at = (p: number) => {
      const u = new URL(url);
      u.searchParams.set('page', String(p));
      return `<${u.href}>`;
    };
    const links: string[] = [];
    if (page > 1) links.push(`${at(page - 1)}; rel="prev"`);
    if (page < last) links.push(`${at(page + 1)}; rel="next"`, `${at(last)}; rel="last"`);
    if (page > 1) links.push(`${at(1)}; rel="first"`);
    const headers = new Headers({ 'content-type': 'application/json' });
    if (links.length > 0) headers.set('link', links.join(', '));
    return new Response(JSON.stringify(repos), { status: 200, headers });
  }) as typeof fetch;
}

async function listRepos(total: number) {
  vi.stubGlobal('fetch', githubWith(total));
  const res = await app.request(`/repos?credentialId=${CREDENTIAL}`);
  expect(res.status).toBe(200);
  return (await res.json()) as { repos: Array<{ fullName: string }>; truncated: boolean };
}

beforeEach(() => {
  pagesRead = [];
  vi.spyOn(secretsService, 'getMasterKek').mockResolvedValue(KEK);
  const dek = generateDek();
  h.db = {
    query: {
      repoCredentials: {
        findFirst: async () => ({
          id: CREDENTIAL,
          userId: USER,
          host: 'github.com',
          encryptedDek: encryptDek(dek, KEK),
          secretEncrypted: encrypt('gh-token', dek),
        }),
      },
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the GitHub repository list says it is cut only when a repository was left out', () => {
  it('lists exactly 1000 repositories without the flag', async () => {
    const body = await listRepos(1000);

    expect(body.repos).toHaveLength(1000);
    expect(body.truncated).toBe(false);
    expect(pagesRead).toEqual(ALL_PAGES);
  });

  it('flags 1001 repositories, lists the first 1000 and reads no page past the cap', async () => {
    const body = await listRepos(1001);

    expect(body.repos).toHaveLength(1000);
    expect(body.repos.at(-1)?.fullName).toBe('acme/r999');
    expect(body.truncated).toBe(true);
    expect(pagesRead).toEqual(ALL_PAGES);
  });
});

describe('a GitHub answer that is not a repository list', () => {
  it.each([
    ['a JSON object', JSON.stringify({ message: 'not a list' })],
    ['a body that is not JSON', '<html>maintenance</html>'],
  ])('answers 502 when GitHub sends %s', async (_kind, body) => {
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    );
    const res = await app.request(`/repos?credentialId=${CREDENTIAL}`);
    expect(res.status).toBe(502);
  });
});
