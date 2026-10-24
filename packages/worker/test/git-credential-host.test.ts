// Host and CI only: requires git http-backend, absent from the worker image.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureDirNoFollow, lstatNoFollow, writeFileNoFollow } from '@haive/shared/fs-safe';
import {
  buildCredentialHelper,
  gitRun,
  originGitRun,
  taskRemoteUrl,
} from '../src/repo/git-push.js';
import { startGitHttpServer } from './support/git-http-fixture.js';

const h = vi.hoisted(() => ({ host: '' }));
vi.mock('../src/repo/credentials.js', () => ({
  getDecryptedCredentials: async () => ({
    username: 'fixture-user',
    secret: 'fixture-password',
    host: h.host,
  }),
}));
let root: string;
let right: Awaited<ReturnType<typeof startGitHttpServer>>;
let other: Awaited<ReturnType<typeof startGitHttpServer>>;
let work: string;
let bound: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'haive-host-binding-'));
  await ensureDirNoFollow(root, 'bare');
  await ensureDirNoFollow(root, 'work');
  work = path.join(root, 'work');
  expect((await gitRun(path.join(root, 'bare'), ['init', '--bare', '-b', 'main'])).code).toBe(0);
  expect((await gitRun(work, ['init', '-b', 'main'])).code).toBe(0);
  right = await startGitHttpServer(root, {
    username: 'fixture-user',
    password: 'fixture-password',
  });
  other = await startGitHttpServer(root, {
    username: 'fixture-user',
    password: 'fixture-password',
  });
  bound = right.httpOrigin(path.join(root, 'bare'));
  h.host = new URL(bound).host;
  expect((await gitRun(work, ['remote', 'add', 'origin', bound])).code).toBe(0);
});
afterEach(async () => {
  await Promise.all([right?.close(), other?.close()]);
  await rm(root, { recursive: true, force: true });
});
const helper = () => buildCredentialHelper({} as never, 'cred', 'user', bound);

it('authenticates on the bound host', async () => {
  const auth = await helper();
  const res = await originGitRun(work, [...auth.argv, 'ls-remote', 'origin'], {
    ...auth.env,
    GIT_TERMINAL_PROMPT: '0',
  });
  expect(res.code).toBe(0);
  expect(await right.authCount()).toBeGreaterThan(0);
});
it.each(['insteadOf', 'pushInsteadOf'])(
  'does not authenticate a %s rewrite to another fixture host',
  async (kind) => {
    const auth = await helper();
    const redirected = other.httpOrigin(path.join(root, 'bare'));
    expect((await gitRun(work, ['config', `url.${redirected}.${kind}`, bound])).code).toBe(0);
    // A push uses pushInsteadOf; an empty local branch is sufficient to reach the challenge.
    if (kind === 'pushInsteadOf') {
      await writeFileNoFollow(root, 'work/seed', 'seed');
      await gitRun(work, ['add', 'seed']);
      await gitRun(work, [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-m',
        'seed',
      ]);
    }
    const res = await originGitRun(
      work,
      [
        ...auth.argv,
        ...(kind === 'pushInsteadOf' ? ['push', 'origin', 'main'] : ['ls-remote', 'origin']),
      ],
      { ...auth.env, GIT_TERMINAL_PROMPT: '0' },
    );
    expect(res.code !== 0).toBe(true);
    expect(await other.authCount()).toBe(0);
  },
);
it('refuses a credential that does not fit the stored remote', async () => {
  h.host = 'other.example.test';
  const refused = await helper().then(
    () => false,
    (err: Error) => /credential.*remote/i.test(err.message),
  );
  expect(refused).toBe(true);
});
it('does not pass token environment variables to an SSH transport', async () => {
  bound = 'ssh://git@example.test/repo';
  h.host = 'example.test';
  const auth = await helper();
  expect(auth.argv).toHaveLength(0);
  expect('GIT_HAIVE_PASS' in auth.env).toBe(false);
  expect('GIT_HAIVE_USER' in auth.env).toBe(false);
});

it.each([true, false])(
  'uses only a stored user-approved origin for an unlinked local_path repo (approved=%s)',
  async (approved) => {
    const displayed = 'https://example.test/original/repo';
    const db = {
      query: {
        tasks: { findFirst: async () => ({ repositoryId: 'repo' }) },
        repositories: { findFirst: async () => ({ remoteUrl: null }) },
        taskSteps: {
          findMany: async () => [
            {
              stepId: '12-post-onboarding',
              formValues: { pushToOrigin: approved },
              detectOutput: { originUrl: displayed },
            },
          ],
        },
      },
    };
    expect(await taskRemoteUrl({ db: db as never, taskId: 'task', userId: 'user' })).toBe(
      approved ? displayed : null,
    );
  },
);
it('does not answer a protocol downgrade on the same host', async () => {
  bound = bound.replace('http:', 'https:');
  const auth = await helper();
  const res = await gitRun(work, [...auth.argv, 'ls-remote', 'origin'], {
    ...auth.env,
    GIT_TERMINAL_PROMPT: '0',
  });
  expect(res.code !== 0).toBe(true);
  expect(await right.authCount()).toBe(0);
});

it.each(['https://example.test:443/repo', 'https://EXAMPLE.TEST/repo'])(
  'authenticates Git credential requests for the bound spelling %s',
  async (url) => {
    bound = url;
    h.host = new URL(url).host;
    const auth = await helper();
    const res = await gitRun(work, [...auth.argv, 'credential', 'fill'], auth.env, {
      input: Buffer.from(`url=${url}\n\n`),
    });
    expect(res.code === 0).toBe(true);
  },
);

it('prevents an uploaded remote helper from inheriting the credential environment', async () => {
  const auth = await helper();
  await ensureDirNoFollow(root, 'bin');
  await writeFileNoFollow(root, 'bin/git-remote-haivefixture', '#!/bin/sh\n: > "$HAIVE_MARKER"\n', {
    fileMode: 0o755,
  });
  await gitRun(work, ['config', 'remote.origin.vcs', 'haivefixture']);
  await gitRun(work, ['config', 'protocol.haivefixture.allow', 'always']);
  const env = {
    ...auth.env,
    PATH: `${root}/bin:${process.env.PATH}`,
    HAIVE_MARKER: `${root}/marker`,
  };
  // Control: -c hardening alone does not stop an allowed repository-selected executable.
  const { GIT_ALLOW_PROTOCOL: _allow, ...unrestricted } = env;
  await originGitRun(work, [...auth.argv, 'ls-remote', 'origin'], unrestricted);
  expect(await lstatNoFollow(root, 'marker')).not.toBeNull();
  env.HAIVE_MARKER = `${root}/hardened-marker`;
  const res = await originGitRun(work, [...auth.argv, 'ls-remote', 'origin'], env);
  expect(res.code !== 0).toBe(true);
  expect(await lstatNoFollow(root, 'hardened-marker')).toBeNull();
});
