import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ db: undefined as unknown }));
const USER = '00000000-0000-4000-8000-0000000000a1';
const REPO = '00000000-0000-4000-8000-0000000000b1';
vi.mock('../src/db.js', () => ({ getDb: () => h.db }));
vi.mock('../src/middleware/auth.js', () => ({
  requireAuth: async (c: { set(key: string, value: string): void }, next: () => unknown) => {
    c.set('userId', '00000000-0000-4000-8000-0000000000a1');
    await next();
  },
}));
import { Hono } from 'hono';
import { logger } from '@haive/shared';
import { serializeError } from '@haive/shared/logger';
import { schema } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { hardenGitArgs } from '@haive/shared/git-args';
import { ensureDirNoFollow } from '@haive/shared/fs-safe';
import { repoRoutes } from '../src/routes/repos.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import type { AppEnv } from '../src/context.js';
const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const git = async (cwd: string, args: string[]) =>
  (await exec('git', hardenGitArgs(args), { cwd })).stdout.trim();
async function setup(nested = false) {
  const root = await mkdtemp(path.join(tmpdir(), 't417-api-'));
  dirs.push(root);
  await git(root, ['init']);
  await git(root, ['remote', 'add', 'origin', 'https://old.test/r']);
  const fake = createFakeDb({ repositories: schema.repositories, auditEvents: schema.auditEvents });
  if (nested) await ensureDirNoFollow(root, 'nested');
  fake.insert(schema.repositories, {
    id: REPO,
    userId: USER,
    name: 'repo',
    localPath: nested ? `${root}/nested` : root,
    remoteUrl: null,
  });
  // The list's unrelated aggregate reads have no task/artifact rows in this fixture.
  const noRows = () => {
    const query: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'groupBy', 'orderBy', 'limit'])
      query[method] = () => query;
    query.then = (ok: (rows: unknown[]) => unknown, bad: (err: unknown) => unknown) =>
      Promise.resolve([]).then(ok, bad);
    return query;
  };
  h.db = { ...fake.db, select: noRows };
  const app = new Hono<AppEnv>();
  app.route('/', repoRoutes);
  app.onError(errorHandler);
  const link = () =>
    app.request(`/${REPO}/remote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remoteUrl: 'https://new.test/r' }),
    });
  return { root, fake, link, app };
}

it.each(['list', 'detail'])(
  'preserves editable remote identity through the %s response and an unchanged save',
  async (source) => {
    const { root, fake, app } = await setup();
    for (const [stored, expected] of [
      ['git@github.com:owner/repo', 'git@github.com:owner/repo'],
      ['git@gitserver:repo', 'git@gitserver:repo'],
      ['ssh://git@gitserver:22/repo', 'ssh://git@gitserver:22/repo'],
      [
        'ssh://git:fixture-password@EXAMPLE.test:22/repo?fixture-query#fixture-fragment',
        'ssh://git@EXAMPLE.test:22/repo',
      ],
      [
        'https://user:fixture-password@EXAMPLE.test:443/repo?fixture-query#fixture-fragment',
        'https://EXAMPLE.test:443/repo',
      ],
      ['http://user:fixture-password@EXAMPLE.test:80/repo', 'http://EXAMPLE.test:80/repo'],
    ]) {
      fake.patch(schema.repositories, REPO, { remoteUrl: stored });
      const res = await app.request(source === 'list' ? '/' : `/${REPO}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        repositories?: { remoteUrl: string }[];
        repository?: { remoteUrl: string };
      };
      const currentUrl =
        source === 'list' ? body.repositories?.[0]?.remoteUrl : body.repository?.remoteUrl;
      expect(currentUrl === expected).toBe(true);
      if (typeof currentUrl !== 'string') throw new Error('Missing editable remote URL');
      // LinkOriginDialog seeds its controlled input from currentUrl and posts the
      // trimmed value. Exercise that unchanged save through the real route and Git.
      const saved = await app.request(`/${REPO}/remote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteUrl: currentUrl.trim() }),
      });
      expect(saved.status).toBe(200);
      expect(fake.rows(schema.repositories)[0]!.remoteUrl === expected).toBe(true);
      expect((await git(root, ['remote', 'get-url', 'origin'])) === expected).toBe(true);
    }
  },
);

it.each(['list', 'detail'])(
  'keeps malformed legacy userinfo out of the %s response',
  async (source) => {
    const { fake, app } = await setup();
    for (const stored of [
      'git:fixture-password@example.test:repo',
      'ftp://user:fixture-password@example.test/repo?fixture-query#fixture-fragment',
      'https://user:fixture-password@bad[host/repo?fixture-query#fixture-fragment',
      'file://user:fixture-password@example.test/repo',
    ]) {
      fake.patch(schema.repositories, REPO, { remoteUrl: stored });
      const res = await app.request(source === 'list' ? '/' : `/${REPO}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const secret of ['fixture-password', 'fixture-query', 'fixture-fragment'])
        expect(text.includes(secret)).toBe(false);
      // Reads sanitize the response, not the original stored configuration.
      expect(fake.rows(schema.repositories)[0]!.remoteUrl === stored).toBe(true);
    }
  },
);

it.each([
  [
    'https://user:fixture-password@EXAMPLE.test:443/repo?fixture-query#fixture-fragment',
    'https://EXAMPLE.test:443/repo',
  ],
  [
    'ssh://git:fixture-password@EXAMPLE.test:22/repo?fixture-query#fixture-fragment',
    'ssh://git@EXAMPLE.test:22/repo',
  ],
  ['git@gitserver:repo', 'git@gitserver:repo'],
])(
  'keeps Retry capability and editable remote identity together for a linked upload: %s',
  async (stored, expected) => {
    const { fake, app } = await setup();
    fake.patch(schema.repositories, REPO, {
      source: 'upload',
      status: 'error',
      remoteUrl: stored,
      rootClaimedAt: new Date(),
      rootClaimKind: 'reset',
    });
    const response = await app.request('/');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      repositories: {
        remoteUrl: string;
        canRetry: boolean;
        retryUnavailableReason: string | null;
      }[];
    };
    expect(body.repositories[0]).toMatchObject({
      remoteUrl: expected,
      canRetry: true,
      retryUnavailableReason: null,
    });
    const text = JSON.stringify(body);
    for (const value of ['fixture-password', 'fixture-query', 'fixture-fragment'])
      expect(text).not.toContain(value);
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBe(stored);
  },
);

it('relink clears planted push URLs and extra fetch URLs in real git', async () => {
  const { root, link, fake } = await setup();
  await git(root, ['config', '--add', 'remote.origin.url', 'https://extra.test/r']);
  await git(root, ['config', '--add', 'remote.origin.pushurl', 'https://planted.test/r']);
  await git(root, ['config', '--add', 'remote.origin.pushurl', 'https://planted2.test/r']);
  const response = await link();
  expect(response.status, await response.text()).toBe(200);
  expect(await git(root, ['remote', 'get-url', '--all', 'origin'])).toBe('https://new.test/r');
  expect(await git(root, ['remote', 'get-url', '--push', '--all', 'origin'])).toBe(
    'https://new.test/r',
  );
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBe('https://new.test/r');
});
it('does not relink the parent of a nested non-repository', async () => {
  const { root, link, fake } = await setup(true);
  expect((await link()).status).toBe(409);
  expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://old.test/r');
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
});
it('relinks a nested directory when it has its own repository', async () => {
  const { root, link } = await setup(true);
  await git(`${root}/nested`, ['init']);
  const response = await link();
  expect(response.status, await response.text()).toBe(200);
  expect(await git(`${root}/nested`, ['remote', 'get-url', 'origin'])).toBe('https://new.test/r');
  expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://old.test/r');
});

it('does not discover a parent through an empty .git directory', async () => {
  const { root, link, fake } = await setup(true);
  await ensureDirNoFollow(root, 'nested/.git');
  expect((await link()).status).toBe(409);
  expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://old.test/r');
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
});
it.each(['worktree', 'submodule'])('links its own %s gitfile', async (kind) => {
  const { root, link } = await setup(true);
  await git(root, [
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.test',
    'commit',
    '--allow-empty',
    '-m',
    'seed',
  ]);
  if (kind === 'worktree') {
    await ensureDirNoFollow(root, 'owner');
    await git(`${root}/owner`, ['init']);
    await git(`${root}/owner`, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'seed',
    ]);
    await git(`${root}/owner`, ['worktree', 'add', '--detach', `${root}/nested`]);
  } else {
    await git(`${root}/nested`, ['init']);
    await git(`${root}/nested`, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'seed',
    ]);
    await git(root, ['submodule', 'add', 'https://submodule.test/r', 'nested']);
    await git(root, ['submodule', 'absorbgitdirs', 'nested']);
  }
  const response = await link();
  expect(response.status, await response.text()).toBe(200);
  expect(await git(`${root}/nested`, ['remote', 'get-url', 'origin'])).toBe('https://new.test/r');
  expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://old.test/r');
});

it('keeps the old fetch URL and row when push URL cleanup fails', async () => {
  const { root, link, fake } = await setup();
  await git(root, ['config', 'remote.origin.pushurl', 'https://planted.test/r']);
  const shim = await mkdtemp(path.join(tmpdir(), 't417-relink-fail-'));
  dirs.push(shim);
  const real = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  await writeFile(
    path.join(shim, 'git'),
    `#!/bin/sh
for arg in "$@"; do if [ "$arg" = --unset-all ]; then exit 128; fi; done
exec ${quote(real)} "$@"
`,
  );
  await chmod(path.join(shim, 'git'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${shim}:${saved}`;
  try {
    expect((await link()).status).toBe(409);
  } finally {
    process.env.PATH = saved;
  }
  expect(await git(root, ['remote', 'get-url', 'origin'])).toBe('https://old.test/r');
  expect(await git(root, ['remote', 'get-url', '--push', 'origin'])).toBe('https://planted.test/r');
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
});

it('logs both causes in one error when real git cannot restore a failed remote update', async () => {
  const { root, link, fake, app } = await setup();
  await git(root, ['config', '--add', 'remote.origin.url', 'https://extra.test/r']);
  let routedError: Error | undefined;
  app.onError((err, c) => {
    routedError = err;
    return errorHandler(err, c);
  });
  const original = Object.assign(new Error('bound synthetic-secret'), {
    query: 'update repositories set remote_url = $1',
    params: ['synthetic-secret'],
  });
  h.db = new Proxy(fake.db, {
    get(target, key) {
      if (key === 'transaction')
        return (fn: (tx: any) => Promise<unknown>) =>
          target.transaction((tx) =>
            fn(
              new Proxy(tx, {
                get(t, prop) {
                  if (prop === 'update')
                    return () => ({
                      set: () => ({
                        where: async () => {
                          throw original;
                        },
                      }),
                    });
                  const value = Reflect.get(t, prop);
                  return typeof value === 'function' ? value.bind(t) : value;
                },
              }),
            ),
          );
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const shim = await mkdtemp(path.join(tmpdir(), 'remote-restore-fail-'));
  dirs.push(shim);
  const real = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  await writeFile(
    path.join(shim, 'git'),
    `#!/bin/sh
for arg in "$@"; do if [ "$arg" = --add ]; then exit 128; fi; done
exec ${quote(real)} "$@"
`,
  );
  await chmod(path.join(shim, 'git'), 0o755);
  const saved = process.env.PATH;
  const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
  process.env.PATH = `${shim}:${saved}`;
  try {
    const response = await link();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Remote update failed and the previous remote could not be restored',
      code: null,
    });
    expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
    expect(fake.rows(schema.auditEvents)).toEqual([]);
    expect(await git(root, ['config', '--get-all', 'remote.origin.url'])).toBe(
      'https://old.test/r',
    );
    const diagnostics = errors.mock.calls.map(([fields]) => fields as { err?: unknown });
    expect(diagnostics).toHaveLength(1);
    const failure = diagnostics[0]!.err as AggregateError;
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.cause).toBe(original);
    expect(failure.errors).toHaveLength(1);
    expect(failure.errors[0]).toBeInstanceOf(Error);
    expect(failure.errors[0].message).toBe('remote restore failed');
    expect(routedError?.cause).toBe(failure);
    expect(errors.mock.calls[0]![0]).toMatchObject({ repositoryId: REPO });
    expect(JSON.stringify(diagnostics.map(({ err }) => serializeError(err)))).not.toContain(
      'synthetic-secret',
    );
  } finally {
    process.env.PATH = saved;
    errors.mockRestore();
  }
});

it('restores fetch and push URLs when replace-all fails after push URL cleanup', async () => {
  const { root, link, fake } = await setup();
  await git(root, ['config', '--add', 'remote.origin.url', 'https://extra.test/r']);
  await git(root, ['config', '--add', 'remote.origin.pushurl', 'https://push.test/r']);
  await git(root, ['config', '--add', 'remote.origin.pushurl', 'https://push2.test/r']);
  const shim = await mkdtemp(path.join(tmpdir(), 'remote-replace-fail-'));
  dirs.push(shim);
  const real = (await exec('sh', ['-c', 'command -v git'])).stdout.trim();
  const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
  await writeFile(
    path.join(shim, 'git'),
    `#!/bin/sh
for arg in "$@"; do if [ "$arg" = 'https://new.test/r' ]; then
  for flag in "$@"; do if [ "$flag" = --replace-all ]; then exit 128; fi; done
fi; done
exec ${quote(real)} "$@"
`,
  );
  await chmod(path.join(shim, 'git'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${shim}:${saved}`;
  try {
    const response = await link();
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('Could not update the remote');
  } finally {
    process.env.PATH = saved;
  }
  expect(await git(root, ['config', '--get-all', 'remote.origin.url'])).toBe(
    'https://old.test/r\nhttps://extra.test/r',
  );
  expect(await git(root, ['config', '--get-all', 'remote.origin.pushurl'])).toBe(
    'https://push.test/r\nhttps://push2.test/r',
  );
  expect(fake.rows(schema.repositories)[0]!.remoteUrl).toBeNull();
  expect(fake.rows(schema.auditEvents)).toEqual([]);
});
