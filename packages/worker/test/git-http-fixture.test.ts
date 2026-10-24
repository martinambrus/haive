import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { gitRun } from '../src/repo/git-exec.js';
import { startGitHttpServer } from './support/git-http-fixture.js';

it('serves only the fixture base and rewrites paths independently of TMPDIR', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'git-http-bound-'));
  const base = path.join(root, 'base');
  await mkdir(base);
  const fixture = await startGitHttpServer(base);
  try {
    const bare = path.join(base, 'repo.git');
    const outside = path.join(root, 'outside.git');
    expect((await gitRun(root, ['init', '--bare', bare])).code).toBe(0);
    expect((await gitRun(root, ['init', '--bare', outside])).code).toBe(0);
    const url = fixture.httpOrigin(bare);
    expect(fixture.networkGitArgs(['remote', 'add', 'origin', bare])[3]).toBe(url);
    expect(fixture.networkGitArgs(['clone', `file://${bare}`, 'local'])[1]).toBe(url);
    expect(() => fixture.httpOrigin(outside)).toThrow('outside base');
    expect((await gitRun(root, ['ls-remote', url])).code).toBe(0);
    expect(
      (await gitRun(root, ['ls-remote', url.replace('/repo.git', '/outside.git')])).code,
    ).not.toBe(0);
    for (const traversal of ['/%2e%2e/outside.git', '/..%2foutside.git']) {
      expect(
        (await gitRun(root, ['ls-remote', url.replace('/repo.git', traversal)])).code,
      ).not.toBe(0);
    }
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('excludes the developer global and system git configs from the backend', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'git-http-config-'));
  const brokenConfig = path.join(root, 'broken.gitconfig');
  let fixture: Awaited<ReturnType<typeof startGitHttpServer>> | undefined;
  try {
    const bare = path.join(root, 'repo.git');
    expect((await gitRun(root, ['init', '--bare', bare])).code).toBe(0);
    await writeFile(brokenConfig, '[invalid config');
    vi.stubEnv('GIT_CONFIG_GLOBAL', brokenConfig);
    vi.stubEnv('GIT_CONFIG_SYSTEM', brokenConfig);
    try {
      fixture = await startGitHttpServer(root);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(
      (
        await gitRun(root, ['ls-remote', fixture.httpOrigin(bare)], {
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
        })
      ).code,
    ).toBe(0);
  } finally {
    vi.unstubAllEnvs();
    await fixture?.close();
    await rm(root, { recursive: true, force: true });
  }
});
