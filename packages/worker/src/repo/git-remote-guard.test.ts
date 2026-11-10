import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { Database } from '@haive/database';
import * as egress from '@haive/shared/egress';
import * as gitExec from './git-exec.js';
import { gitClone } from './clone.js';
import { originGitRun, pushBranch } from './git-push.js';
import { startGitHttpServer } from '../../test/support/git-http-fixture.js';

const seams = vi.hoisted(() => ({
  resolve: vi.fn(),
  privateAllowlist: vi.fn(),
  isBlocked: vi.fn(),
}));
vi.mock('@haive/shared/egress', async (original) => {
  const real = await original<typeof egress>();
  return {
    ...real,
    resolveGuardedAddress: vi.fn((host: string) => real.resolveGuardedAddress(host, seams)),
  };
});
const exec = promisify(execFile);
const dbFor = (role?: string) =>
  ({
    query: { users: { findFirst: vi.fn().mockResolvedValue(role ? { role } : undefined) } },
  }) as unknown as Database;
let root: string;
let fixture: Awaited<ReturnType<typeof startGitHttpServer>>;
let url: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'remote-guard-'));
  await exec('/usr/bin/git', ['init', '--bare', '-b', 'main', `${root}/repo.git`]);
  await mkdir(`${root}/a=b`);
  await exec('/usr/bin/git', ['init', '--bare', `${root}/a=b/r.git`]);
  fixture = await startGitHttpServer(root);
  url = fixture.httpOrigin(`${root}/repo.git`);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  seams.resolve.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  seams.privateAllowlist.mockReturnValue(egress.EMPTY);
  seams.isBlocked.mockImplementation(egress.isBlockedAddress);
});
beforeAll(() => {
  seams.resolve.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  seams.privateAllowlist.mockReturnValue(egress.EMPTY);
  seams.isBlocked.mockImplementation(egress.isBlockedAddress);
});
afterAll(async () => {
  await fixture?.close();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5 });
});
async function stats() {
  return (await (await fetch(new URL('/__fixture_stats', url))).json()) as {
    requests: number;
    redirected: number;
  };
}
async function guardConfig(urls: string[], role?: string) {
  const guardPath = './git-remote-guard.js';
  const { gitRemoteGuardArgs } = await import(guardPath);
  return gitRemoteGuardArgs({ db: dbFor(role), userId: 'owner' }, urls);
}
async function guardArgs(urls: string[], role?: string) {
  return (await guardConfig(urls, role)).argv;
}
it.each(['user', 'Admin', 'owner', undefined])(
  'refuses loopback clone before connecting (role %s)',
  async (role) => {
    const before = await stats();
    const blocked = await gitClone(url, `${root}/blocked-${role}`, undefined, undefined, {
      db: dbFor(role),
      userId: 'owner',
    }).catch((e: Error) => e);
    seams.resolve.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOTFOUND' }));
    const missing = await gitClone(
      'http://absent.test/repo.git',
      `${root}/missing-${role}`,
      undefined,
      undefined,
      { db: dbFor(role), userId: 'owner' },
    ).catch((e: Error) => e);
    expect(blocked).toBeInstanceOf(Error);
    expect(missing).toBeInstanceOf(Error);
    expect((blocked as Error).message.replaceAll(url, 'URL').replaceAll('127.0.0.1', 'HOST')).toBe(
      (missing as Error).message
        .replaceAll('http://absent.test/repo.git', 'URL')
        .replaceAll('absent.test', 'HOST'),
    );
    expect((await stats()).requests).toBe(before.requests);
  },
);
it('refuses a backslash authority before a non-admin clone reaches the fixture', async () => {
  const before = await stats();
  const target = url.replace('http://', 'http://public.test\\@');
  const result = await gitClone(target, `${root}/ambiguous`, undefined, undefined, {
    db: dbFor('user'),
    userId: 'owner',
  }).catch((error: unknown) => error);
  expect((await stats()).requests).toBe(before.requests);
  expect(result).toBeInstanceOf(Error);
  expect(egress.resolveGuardedAddress).not.toHaveBeenCalled();
});
it('admin clones unchanged with no resolution or additional config', async () => {
  const run = vi.spyOn(gitExec, 'gitRun');
  await gitClone(url, `${root}/admin`, undefined, undefined, {
    db: dbFor('admin'),
    userId: 'owner',
  });
  expect(egress.resolveGuardedAddress).not.toHaveBeenCalled();
  expect(run.mock.calls.find(([, args]) => args.includes('clone'))![1]).toEqual([
    'clone',
    '--depth',
    '1',
    '--',
    url,
    `${root}/admin`,
  ]);
});
it('pins each public HTTP host and port and disables redirects', async () => {
  const args = await guardArgs(
    ['https://public.test/r', 'http://other.test:8080/r', 'https://public.test/second'],
    'user',
  );
  expect(args).toEqual(
    expect.arrayContaining([
      '-c',
      'http.curloptResolve=public.test:443:93.184.216.34',
      '-c',
      'http.curloptResolve=other.test:8080:93.184.216.34',
      '-c',
      'http.followRedirects=false',
    ]),
  );
  expect(seams.resolve).toHaveBeenCalledTimes(2);
});
it('keeps equals paths parseable by git for guarded HTTPS runs', async () => {
  const { argv: args, env } = await guardConfig(['https://public.test/a=b/r.git'], 'user');
  const result = await exec('/usr/bin/git', [...args, 'config', '--list'], {
    env: { ...process.env, ...env },
  });
  expect(result.stdout.split('\n')).toContain('http.curloptresolve=public.test:443:93.184.216.34');
  expect(args).toContain('http.followRedirects=false');
});
it('clones a guarded HTTP equals path through the fixture', async () => {
  seams.resolve.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  seams.isBlocked.mockReturnValue(false);
  const target = fixture
    .httpOrigin(`${root}/a=b/r.git`)
    .replace('%3D', '=')
    .replace('127.0.0.1', 'public.test');
  const before = await stats();
  vi.stubEnv('GIT_CONFIG_COUNT', '99');
  vi.stubEnv('GIT_CONFIG_PARAMETERS', `'http.${target}.followRedirects'='true'`);
  await gitClone(
    target,
    `${root}/equals-clone`,
    undefined,
    {
      argv: [],
      env: {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `http.${target}.proxy`,
        GIT_CONFIG_VALUE_0: 'http://127.0.0.1:1',
        GIT_CONFIG_PARAMETERS: `'http.${target}.curloptResolve'='public.test:${new URL(target).port}:127.0.0.2'`,
      },
      secret: '',
    },
    {
      db: dbFor('user'),
      userId: 'owner',
    },
  );
  expect((await stats()).requests).toBeGreaterThan(before.requests);
});
it('matches URL-specific overrides against the HTTP transport without userinfo', async () => {
  const { argv: args, env } = await guardConfig(['https://alice@public.test/r'], 'user');
  const proxy = await exec(
    '/usr/bin/git',
    [...args, 'config', '--get-urlmatch', 'http.proxy', 'https://public.test/r'],
    { env: { ...process.env, ...env } },
  );
  expect(proxy.stdout).toBe('\n');
  const pin = await exec(
    '/usr/bin/git',
    [...args, 'config', '--get-urlmatch', 'http.curloptResolve', 'https://public.test/r'],
    { env: { ...process.env, ...env } },
  );
  expect(pin.stdout.trim()).toBe('public.test:443:93.184.216.34');
});
it('pins every checked public address for HTTP failover and keeps the first for SSH', async () => {
  seams.resolve.mockResolvedValue([
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
  const { argv: args, env } = await guardConfig(
    ['https://public.test/r', 'git@public.test:r'],
    'user',
  );
  const pin = 'public.test:443:93.184.216.34,[2606:4700:4700::1111]';
  expect(args).toContain(`http.curloptResolve=${pin}`);
  expect(env.GIT_CONFIG_KEY_1).toBe('http.https://public.test/r.curloptResolve');
  expect(env.GIT_CONFIG_VALUE_1).toBe(pin);
  expect(args).toContain(
    'core.sshCommand=ssh -o HostName=93.184.216.34 -o HostKeyAlias=public.test',
  );
  expect(seams.resolve).toHaveBeenCalledTimes(1);
});
it('brackets a pinned IPv6 address', async () => {
  seams.resolve.mockResolvedValue([{ address: '2606:4700:4700::1111', family: 6 }]);
  expect(await guardArgs(['https://public.test/r'], 'user')).toContain(
    'http.curloptResolve=public.test:443:[2606:4700:4700::1111]',
  );
});
it('does not follow a public HTTP redirect to loopback', async () => {
  seams.resolve.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  seams.isBlocked.mockReturnValue(false);
  const target = new URL(url);
  target.hostname = 'public.test';
  target.pathname = '/__redirect/repo.git';
  const before = await stats();
  await expect(
    gitClone(target.href, `${root}/redirect`, undefined, undefined, {
      db: dbFor('user'),
      userId: 'owner',
    }),
  ).rejects.toThrow();
  const after = await stats();
  expect(after.redirected).toBe(before.redirected + 1);
  expect(after.requests).toBe(before.requests + 1);
});

it('repository URL-specific HTTP config cannot override the checked pin or redirect policy', async () => {
  seams.resolve.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  seams.isBlocked.mockReturnValue(false);
  const target = new URL(url);
  target.hostname = 'public.test';
  target.pathname = '/__redirect/repo.git';
  const work = `${root}/http-config`;
  await exec('/usr/bin/git', ['init', work]);
  await exec('/usr/bin/git', ['-C', work, 'remote', 'add', 'origin', target.href]);
  await exec('/usr/bin/git', ['-C', work, 'config', `http.${target.href}.followRedirects`, 'true']);
  await exec('/usr/bin/git', [
    '-C',
    work,
    'config',
    `http.${target.href}.proxy`,
    'http://127.0.0.1:1',
  ]);
  await exec('/usr/bin/git', [
    '-C',
    work,
    'config',
    `http.${target.href}.curloptResolve`,
    `public.test:${target.port}:127.0.0.2`,
  ]);
  const before = await stats();
  const result = await originGitRun(work, ['ls-remote', 'origin'], {
    db: dbFor('user'),
    userId: 'owner',
  });
  expect(result.code).not.toBe(0);
  const after = await stats();
  expect(after.redirected).toBe(before.redirected + 1);
  expect(after.requests).toBe(before.requests + 1);
});
it.each([
  ['process', 'config'],
  ['caller', 'config'],
  ['process', 'fetch'],
  ['caller', 'fetch'],
])(
  'keeps equals-path pins over repository and %s environment config during %s',
  async (source, check) => {
    const work = `${root}/equals-config-${source}-${check}`;
    await exec('/usr/bin/git', ['init', work]);
    const target = url.replace('127.0.0.1', 'public.test').replace('/repo.git', '/a=b/r.git');
    await exec('/usr/bin/git', ['-C', work, 'remote', 'add', 'origin', target]);
    const planted = {
      proxy: 'http://127.0.0.1:1',
      followRedirects: 'true',
      curloptResolve: `public.test:${new URL(target).port}:127.0.0.2`,
    };
    for (const [key, value] of Object.entries(planted)) {
      await exec('/usr/bin/git', ['-C', work, 'config', `http.${target}.${key}`, value]);
    }
    const ambient = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.${target}.proxy`,
      GIT_CONFIG_VALUE_0: planted.proxy,
      GIT_CONFIG_PARAMETERS: `'http.${target}.followRedirects'='true'`,
    };
    if (source === 'process') {
      for (const [key, value] of Object.entries(ambient)) vi.stubEnv(key, value);
    }
    const env = source === 'caller' ? ambient : undefined;
    seams.resolve.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    seams.isBlocked.mockReturnValue(false);
    const owner = { db: dbFor('user'), userId: 'owner' };
    const expected = {
      proxy: '',
      followRedirects: 'false',
      curloptResolve: `public.test:${new URL(target).port}:127.0.0.1`,
    };
    if (check === 'config') {
      for (const [key, value] of Object.entries(expected)) {
        const result = await originGitRun(
          work,
          ['config', '--get-urlmatch', `http.${key}`, target],
          owner,
          env,
        );
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe(value);
      }
      return;
    }
    const before = await stats();
    const fetched = await originGitRun(work, ['fetch', 'origin'], owner, env, {
      timeout: 2000,
      signal: new AbortController().signal,
    });
    expect(fetched.code, fetched.stderr).toBe(0);
    expect((await stats()).requests).toBeGreaterThan(before.requests);
  },
);
it('pushBranch refuses a private second push URL before network I/O', async () => {
  const work = `${root}/push`;
  await exec('/usr/bin/git', ['init', work]);
  await exec('/usr/bin/git', ['-C', work, 'remote', 'add', 'origin', 'https://public.test/r']);
  await exec('/usr/bin/git', [
    '-C',
    work,
    'config',
    '--add',
    'remote.origin.pushurl',
    'https://public.test/r',
  ]);
  await exec('/usr/bin/git', ['-C', work, 'config', '--add', 'remote.origin.pushurl', url]);
  const before = await stats();
  const run = vi.spyOn(gitExec, 'gitRun');
  await expect(
    pushBranch({
      cwd: work,
      branch: 'main',
      setUpstream: false,
      db: dbFor('user'),
      userId: 'owner',
    }),
  ).rejects.toThrow(/^git push failed:/);
  expect(run.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
  expect((await stats()).requests).toBe(before.requests);
});
it.each(['ssh://git@public.test:2222/r', 'git@public.test:r'])(
  'pins SSH host while keeping its host key alias: %s',
  async (url) => {
    expect(await guardArgs([url], 'user')).toContain(
      'core.sshCommand=ssh -o HostName=93.184.216.34 -o HostKeyAlias=public.test',
    );
  },
);
it('refuses private SSH before spawning', async () => {
  await expect(guardArgs(['ssh://git@127.0.0.1/r'], 'user')).rejects.toMatchObject({
    code: 'ENOTFOUND',
  });
});
it.each(['internal.test', '10.0.0.0/8'])('honors the admin allowlist: %s', async (entry) => {
  seams.resolve.mockResolvedValue([{ address: '10.2.3.4', family: 4 }]);
  seams.privateAllowlist.mockReturnValue(egress.parseAllowlist(entry));
  expect(await guardArgs(['https://internal.test/r'], 'user')).toContain(
    'http.curloptResolve=internal.test:443:10.2.3.4',
  );
});
it('hostname allowlist cannot lift metadata', async () => {
  seams.resolve.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
  seams.privateAllowlist.mockReturnValue(egress.parseAllowlist('internal.test'));
  await expect(guardArgs(['https://internal.test/r'], 'user')).rejects.toMatchObject({
    code: 'ENOTFOUND',
  });
});
it('origin transport requires an owner', () => {
  // @ts-expect-error every network caller must supply ownership
  void (() => originGitRun('/repo', ['fetch', 'origin']));
  // @ts-expect-error every clone caller must supply ownership
  void (() => gitClone('https://public.test/r', '/dest'));
});

it('git appends SSH port, login and remote command without an environment override', async () => {
  await mkdir(`${root}/bin`);
  await writeFile(`${root}/bin/ssh`, '#!/bin/sh\nprintf "ARG:%s\\n" "$@" >&2\nexit 1\n', {
    mode: 0o755,
  });
  const work = `${root}/ssh-work`;
  await exec('/usr/bin/git', ['init', work]);
  const remotes = ['ssh://git@public.test:2222/r', 'git@other.test:repo'];
  for (const urls of [[remotes[0]!], remotes]) {
    const guard = await guardConfig(urls, 'user');
    for (const remote of urls) {
      const res = await gitExec.gitRun(
        work,
        [...guard.argv, 'ls-remote', remote],
        {
          PATH: `${root}/bin:${process.env.PATH}`,
          GIT_SSH_COMMAND: 'exit 97',
          GIT_SSH: '/nonexistent-ssh',
        },
        { guardedRemote: guard.env },
      );
      const host = remote.includes('public.test') ? 'public.test' : 'other.test';
      expect(res.stderr).toContain('ARG:HostName=93.184.216.34');
      expect(res.stderr).toContain(`ARG:HostKeyAlias=${host}`);
      expect(res.stderr).toContain(`ARG:git@${host}`);
      expect(res.stderr).toContain('ARG:git-upload-pack');
      if (host === 'public.test') expect(res.stderr).toContain('ARG:-p\nARG:2222');
    }
  }
});
