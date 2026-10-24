import { fixtureBase, httpOrigin } from './support/git-http.js';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@haive/database';
import { createFakeDb } from '@haive/database/testing';
import { gitClone } from '../src/repo/clone.js';
import { gitRevParseHead, handleResyncGit } from '../src/repo/bundle-ingest.js';

const h = { user: '00000000-0000-4000-8000-0000000000a1' };
vi.mock('../src/bundle-parser/index.js', () => ({
  parseBundle: async () => ({ items: [], ambiguous: [], dropped: [] }),
  persistBundleItems: async () => ({ inserted: 0, updated: 0, removed: 0 }),
}));

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@haive.local',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@haive.local',
      },
    });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} failed (${code}): ${stderr.trim()}`));
    });
  });
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(fixtureBase, 'haive-bundle-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('handleResyncGit', () => {
  const BUNDLE = '00000000-0000-4000-8000-0000000000b2';
  /** A pull names every file it creates in full, so 60 under this print over 200 KiB. */
  const DEEP = Array.from({ length: 15 }, (_, i) => String(i).padEnd(240, 'd')).join('/');

  it('finishes a pull that prints more than a pipe holds', async () => {
    const origin = path.join(tmpRoot, 'origin');
    const work = path.join(tmpRoot, 'work');
    await mkdir(origin, { recursive: true });
    await run('git', ['init', '--bare', '-b', 'main'], origin);
    await mkdir(path.join(work, 'agents'), { recursive: true });
    await run('git', ['init', '-b', 'main'], work);
    await run('git', ['remote', 'add', 'origin', origin], work);
    await writeFile(path.join(work, 'agents', 'README.md'), '# bundle agents\n');
    await run('git', ['add', '.'], work);
    await run('git', ['commit', '-m', 'init'], work);
    await run('git', ['push', 'origin', 'main'], work);
    await gitClone(httpOrigin(origin), path.join(tmpRoot, h.user, BUNDLE, 'extracted'), 'main');

    await mkdir(path.join(work, 'docs', DEEP), { recursive: true });
    for (let i = 0; i < 60; i++) {
      await writeFile(path.join(work, 'docs', DEEP, `n${i}.md`), `note ${i}\n`);
    }
    await run('git', ['add', '.'], work);
    await run('git', ['commit', '-q', '-m', 'wide'], work);
    await run('git', ['push', 'origin', 'main'], work);

    const fake = createFakeDb({ customBundles: schema.customBundles });
    fake.insert(schema.customBundles, {
      id: BUNDLE,
      userId: h.user,
      repositoryId: '00000000-0000-4000-8000-0000000000c1',
      name: 'bundle',
      sourceType: 'git',
      gitUrl: httpOrigin(origin),
      gitBranch: 'main',
      storageRoot: '',
    });
    const resync = handleResyncGit(
      { bundleId: BUNDLE, userId: h.user } as never,
      fake.db as unknown as Database,
      tmpRoot,
    ).then(() => 'finished');
    const hung = new Promise((resolve) =>
      setTimeout(() => resolve('still pulling'), 15_000).unref(),
    );

    expect(await Promise.race([resync, hung])).toBe('finished');
    expect(fake.rows(schema.customBundles)[0]?.lastSyncCommit).toBe(await gitRevParseHead(work));
  }, 30_000);
});
