import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
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
    expect(
      (await gitRun(root, ['ls-remote', url.replace('/repo.git', '/%2e%2e/outside.git')])).code,
    ).not.toBe(0);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
