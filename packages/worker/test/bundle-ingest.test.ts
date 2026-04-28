import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { extractArchive, gitClone } from '../src/repo/clone.js';
import { gitRevParseHead } from '../src/repo/bundle-ingest.js';

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
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'haive-bundle-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('bundle-ingest: zip extraction', () => {
  it('extracts a ZIP bundle into the bundle storage layout', async () => {
    const archivePath = path.join(tmpRoot, 'bundle.zip');
    const zip = new JSZip();
    zip.file('agents/code-reviewer.md', '---\nname: code-reviewer\n---\nbody\n');
    zip.file('skills/style-guide/SKILL.md', '---\nname: style-guide\n---\nbody\n');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(archivePath, buf);

    const dest = path.join(tmpRoot, 'user-id', 'bundle-id', 'extracted');
    await extractArchive(archivePath, 'zip', dest);

    expect(await readdir(dest)).toEqual(expect.arrayContaining(['agents', 'skills']));
    const agent = await readFile(path.join(dest, 'agents', 'code-reviewer.md'), 'utf8');
    expect(agent).toContain('name: code-reviewer');
  });

  it('extracts a tar.gz bundle (preserves agents/ + skills/ structure)', async () => {
    const src = path.join(tmpRoot, 'src');
    await mkdir(path.join(src, 'agents'), { recursive: true });
    await mkdir(path.join(src, 'skills'), { recursive: true });
    await writeFile(path.join(src, 'agents', 'foo.md'), '---\nname: foo\n---\n');
    await writeFile(path.join(src, 'skills', 'README.md'), 'skills index\n');
    const archivePath = path.join(tmpRoot, 'bundle.tar.gz');
    // Multiple top-level entries — flattenSingleTopLevel keeps both intact.
    await run('tar', ['-czf', archivePath, '-C', src, 'agents', 'skills']);

    const dest = path.join(tmpRoot, 'out');
    await extractArchive(archivePath, 'tar.gz', dest);

    expect((await readdir(dest)).sort()).toEqual(['agents', 'skills']);
    expect(await readdir(path.join(dest, 'agents'))).toContain('foo.md');
  });
});

describe('bundle-ingest: git clone + rev-parse', () => {
  it('clones a local bare repo and captures HEAD', async () => {
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

    await gitClone(`file://${sourceRepo}`, dest, 'main');
    const head = await gitRevParseHead(dest);
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect((await readdir(dest)).sort()).toContain('agents');
  });
});
