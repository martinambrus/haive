// Host and CI only: the clone goes over the smart-HTTP fixture, which needs `git http-backend`,
// and the alpine worker image (whose in-image job runs bundle-ingest.test.ts) does not ship it.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hardenGitArgs } from '@haive/shared/git-args';
import { fixtureBase, httpOrigin, networkGitArgs } from './support/git-http.js';
import { gitClone } from '../src/repo/clone.js';
import { gitRevParseHead } from '../src/repo/bundle-ingest.js';

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, cmd === 'git' ? hardenGitArgs(networkGitArgs(args)) : args, {
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

describe('bundle-ingest: git clone + rev-parse', () => {
  it('clones a bare HTTP repo and captures HEAD', async () => {
    const sourceRepo = path.join(tmpRoot, 'origin');
    const work = path.join(tmpRoot, 'work');
    const dest = path.join(tmpRoot, 'user-id', 'bundle-id', 'extracted');

    // Build an origin repo with a single commit on `main`.
    await mkdir(sourceRepo, { recursive: true });
    await run('git', ['init', '--bare', '-b', 'main'], sourceRepo);

    await mkdir(work, { recursive: true });
    await run('git', ['init', '-b', 'main'], work);
    await run('git', ['remote', 'add', 'origin', sourceRepo], work);
    await writeFile(path.join(work, 'agents', 'README.md'), '# bundle agents\n').catch(async () => {
      await mkdir(path.join(work, 'agents'), { recursive: true });
      await writeFile(path.join(work, 'agents', 'README.md'), '# bundle agents\n');
    });
    await run('git', ['add', '.'], work);
    await run('git', ['commit', '-m', 'init'], work);
    await run('git', ['push', 'origin', 'main'], work);

    await gitClone(httpOrigin(sourceRepo), dest, 'main');
    const head = await gitRevParseHead(dest);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect((await readdir(dest)).sort()).toContain('agents');
  });
});
